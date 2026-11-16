import { HttpError } from '../http.js';
import { intParam } from '../validate.js';

const MAX_BYTES = 1_000_000;
const MAX_BASE64_CHARS = Math.ceil((MAX_BYTES * 4) / 3) + 8;
const MAX_PER_USER = 300;

// Identify the real image type from its first bytes. The client-declared type is never trusted,
// and only raster formats are accepted (no SVG, which can carry script).
export function sniffImage(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.toString('ascii', 0, 6))) return 'image/gif';
  return null;
}

export function register({ db, route, requireAuth, writeLimit }) {
  // Body: {"data": "<base64 image bytes>"}. Images are stored in the database so one backup covers everything.
  route('POST', '/api/media', async (c) => {
    const me = requireAuth(c);
    writeLimit(c, 'upload');
    const b = await c.json();
    if (typeof b.data !== 'string' || !b.data) throw new HttpError(400, 'invalid_data', 'data must be a base64 string.');
    if (b.data.length > MAX_BASE64_CHARS) throw new HttpError(413, 'image_too_large', 'Images can be up to 1 MB.');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b.data)) throw new HttpError(400, 'invalid_data', 'data must be valid base64 without a data: prefix.');
    const buf = Buffer.from(b.data, 'base64');
    if (buf.length > MAX_BYTES) throw new HttpError(413, 'image_too_large', 'Images can be up to 1 MB.');
    const contentType = sniffImage(buf);
    if (!contentType) throw new HttpError(415, 'unsupported_image', 'Upload a JPEG, PNG, WebP or GIF image.');
    if (db.prepare('SELECT COUNT(*) AS n FROM media WHERE user_id = :u').get({ u: me.id }).n >= MAX_PER_USER) {
      throw new HttpError(409, 'media_quota', 'You have reached the upload limit.');
    }
    const r = db.prepare('INSERT INTO media (user_id, content_type, data, created_at) VALUES (:u, :t, :d, :c)').run({ u: me.id, t: contentType, d: buf, c: Date.now() });
    const id = Number(r.lastInsertRowid);
    return { status: 201, body: { id, url: `/api/media/${id}`, contentType } };
  }, { bodyLimit: MAX_BASE64_CHARS + 1024 });

  route('GET', '/api/media/:id', (c) => {
    const id = intParam(c.params.id, 'id');
    const row = db.prepare('SELECT content_type AS contentType, data FROM media WHERE id = :id').get({ id });
    if (!row) throw new HttpError(404, 'media_not_found', 'That image does not exist.');
    return {
      raw: {
        headers: {
          'Content-Type': row.contentType,
          'Cache-Control': 'public, max-age=31536000, immutable',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'; sandbox",
        },
        body: Buffer.from(row.data),
      },
    };
  });
}
