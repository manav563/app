import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

// The page loads nothing from other hosts and runs no inline script or style.
const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

// Serves files from `root`. Returns true when it handled the request, false to fall through to the API router.
// Only whitelisted extensions are served, dotfiles and anything outside `root` are refused.
export function createStaticHandler(root) {
  const base = path.resolve(root) + path.sep;

  return async function serve(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    let rel;
    try {
      rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
    } catch {
      return false;
    }
    if (rel.includes('\0') || rel.split('/').some((seg) => seg.startsWith('.'))) return false;
    const file = path.resolve(base, '.' + path.posix.normalize('/' + rel));
    if (!file.startsWith(base)) return false;
    const type = TYPES[path.extname(file).toLowerCase()];
    if (!type) return false;

    let data;
    try {
      data = await readFile(file);
    } catch {
      return false;
    }
    const etag = `"${createHash('sha1').update(data).digest('base64url')}"`;
    const headers = { 'Content-Type': type, ETag: etag, 'Cache-Control': 'no-cache' };
    if (type.startsWith('text/html')) headers['Content-Security-Policy'] = PAGE_CSP;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      res.end();
      return true;
    }
    res.writeHead(200, { ...headers, 'Content-Length': data.length });
    res.end(req.method === 'HEAD' ? undefined : data);
    return true;
  };
}
