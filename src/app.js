import { signToken, verifyToken } from './auth.js';
import { HttpError, readJson, send, RateLimiter } from './http.js';
import { createPostQueries, extractTags } from './posts.js';
import { createUserQueries } from './users.js';
import { createStaticHandler } from './static.js';
import { register as authRoutes } from './routes/auth.js';
import { register as userRoutes } from './routes/users.js';
import { register as postRoutes } from './routes/posts.js';
import { register as mediaRoutes } from './routes/media.js';
import { register as storyRoutes } from './routes/stories.js';
import { register as communityRoutes } from './routes/communities.js';
import { register as messageRoutes } from './routes/messages.js';
import { register as notificationRoutes } from './routes/notifications.js';

export { extractTags };

const TOKEN_TTL_SECONDS = 7 * 24 * 3600;

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

// Builds the request handler. Route modules receive a shared context and register their own routes.
export function createApp({ db, secret, allowedOrigin = '', trustProxy = false, limits = {}, staticDir = null, log = () => {} }) {
  if (!secret || secret.length < 32) throw new Error('A secret of at least 32 characters is required.');
  const serveStatic = staticDir ? createStaticHandler(staticDir) : null;
  const L = { global: 300, auth: 10, write: 30, upload: 10, ...limits };
  const limiter = new RateLimiter();
  const routes = [];

  const route = (method, path, handler, opts = {}) => {
    const keys = [];
    const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '/?$');
    routes.push({ method, re, keys, handler, bucket: opts.bucket, bodyLimit: opts.bodyLimit });
  };

  const tx = (fn) => {
    db.exec('BEGIN');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };

  const issueToken = (userId) => signToken({ sub: userId, exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS }, secret);

  function authenticate(req) {
    const header = req.headers.authorization;
    if (!header) return null;
    const m = /^Bearer (.+)$/.exec(header);
    const payload = m && verifyToken(m[1], secret);
    const user = payload && db.prepare('SELECT id, username, display_name AS displayName FROM users WHERE id = :id').get({ id: payload.sub });
    if (!user) throw new HttpError(401, 'invalid_token', 'Your session is not valid. Log in again.');
    return user;
  }

  const requireAuth = (c) => {
    if (!c.user) throw new HttpError(401, 'auth_required', 'Log in to do that.');
    return c.user;
  };

  // Per-user cap on write actions. `bucket` lets heavier actions (uploads) have a lower ceiling.
  function writeLimit(c, bucket = 'write') {
    const r = limiter.hit(`${bucket}:${c.user.id}`, L[bucket], 60_000);
    if (!r.ok) throw new HttpError(429, 'rate_limited', `Slow down. Try again in ${r.retryAfter}s.`);
  }

  const ctx = {
    db,
    route,
    tx,
    issueToken,
    requireAuth,
    writeLimit,
    users: createUserQueries(db),
    posts: createPostQueries(db),
  };
  [authRoutes, userRoutes, postRoutes, mediaRoutes, storyRoutes, communityRoutes, messageRoutes, notificationRoutes].forEach((register) => register(ctx));

  function clientIp(req) {
    if (trustProxy) {
      const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      if (fwd) return fwd;
    }
    return req.socket.remoteAddress || 'unknown';
  }

  return async function handler(req, res) {
    const started = Date.now();
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    res.on('finish', () => log({ method: req.method, path: req.url.split('?')[0], status: res.statusCode, ms: Date.now() - started }));

    try {
      const origin = req.headers.origin;
      if (allowedOrigin && origin === allowedOrigin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
        res.setHeader('Access-Control-Max-Age', '600');
      }
      if (req.method === 'OPTIONS') return send(res, 204);

      const ip = clientIp(req);
      const url = new URL(req.url, 'http://localhost');
      const global = limiter.hit(`g:${ip}`, L.global, 60_000);
      if (!global.ok) {
        res.setHeader('Retry-After', String(global.retryAfter));
        throw new HttpError(429, 'rate_limited', 'Too many requests. Slow down.');
      }

      if (serveStatic && !url.pathname.startsWith('/api/') && url.pathname !== '/health' && (await serveStatic(req, res, url.pathname))) return;

      let pathMatched = false;
      for (const r of routes) {
        const m = r.re.exec(url.pathname);
        if (!m) continue;
        pathMatched = true;
        if (r.method !== req.method) continue;
        if (r.bucket === 'auth') {
          const a = limiter.hit(`a:${ip}`, L.auth, 60_000);
          if (!a.ok) {
            res.setHeader('Retry-After', String(a.retryAfter));
            throw new HttpError(429, 'rate_limited', 'Too many attempts. Try again soon.');
          }
        }
        const params = {};
        r.keys.forEach((k, i) => {
          try {
            params[k] = decodeURIComponent(m[i + 1]);
          } catch {
            throw new HttpError(400, 'invalid_path', 'Malformed URL.');
          }
        });
        const c = { req, res, params, query: url.searchParams, user: authenticate(req), json: () => readJson(req, r.bodyLimit) };
        const out = await r.handler(c);
        if (out.raw) {
          res.writeHead(out.raw.status || 200, { ...out.raw.headers, 'Content-Length': out.raw.body.length });
          return res.end(out.raw.body);
        }
        return send(res, out.status || 200, out.body);
      }
      throw pathMatched ? new HttpError(405, 'method_not_allowed', 'Method not allowed.') : new HttpError(404, 'not_found', 'No such endpoint.');
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: { code: err.code, message: err.message } });
      log({ level: 'error', message: err.stack || String(err) });
      return send(res, 500, { error: { code: 'internal_error', message: 'Something went wrong on our side.' } });
    }
  };
}
