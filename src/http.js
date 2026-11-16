export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function readJson(req, limit = 16 * 1024) {
  const tooBig = () => new HttpError(413, 'payload_too_large', 'Request body is too large.');
  if (Number(req.headers['content-length'] || 0) > limit) throw tooBig();
  if (!String(req.headers['content-type'] || '').includes('application/json')) {
    throw new HttpError(415, 'unsupported_media_type', 'Send JSON with Content-Type: application/json.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw tooBig();
    chunks.push(chunk);
  }
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid_json', 'Body must be valid JSON.');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'invalid_json', 'Body must be a JSON object.');
  }
  return value;
}

export function send(res, status, body) {
  if (status === 204 || body === undefined) {
    res.writeHead(status);
    res.end();
    return;
  }
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

// Fixed-window counter held in memory. Fine for one process; use a shared store (Redis) behind several.
export class RateLimiter {
  constructor() {
    this.windows = new Map();
  }
  hit(key, max, windowMs) {
    const now = Date.now();
    let w = this.windows.get(key);
    if (!w || w.reset <= now) {
      w = { count: 0, reset: now + windowMs };
      this.windows.set(key, w);
      if (this.windows.size > 10000) this.prune(now);
    }
    w.count += 1;
    return { ok: w.count <= max, retryAfter: Math.max(1, Math.ceil((w.reset - now) / 1000)) };
  }
  prune(now) {
    for (const [k, w] of this.windows) if (w.reset <= now) this.windows.delete(k);
  }
}
