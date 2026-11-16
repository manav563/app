import http from 'node:http';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';

export const SECRET = 'test-secret-test-secret-test-secret-123';

// Starts a real server on a random port with an in-memory database.
export async function startServer(options = {}) {
  const db = openDb(':memory:');
  const app = createApp({ db, secret: SECRET, limits: { auth: 100000, global: 100000, write: 100000, upload: 100000 }, ...options });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function call(method, path, { token, body, headers } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
    });
    const raw = Buffer.from(await res.arrayBuffer());
    const type = res.headers.get('content-type') || '';
    return { status: res.status, headers: res.headers, raw, body: type.includes('json') && raw.length ? JSON.parse(raw.toString('utf8')) : null };
  }

  async function signup(username) {
    const r = await call('POST', '/api/auth/register', { body: { username, password: 'correct horse battery' } });
    assert.equal(r.status, 201, `signup ${username}`);
    return r.body.token;
  }

  return {
    db,
    call,
    signup,
    close: () => {
      server.close();
      db.close();
    },
  };
}

// A real 1x1 PNG and a minimal JPEG header (the server checks the leading bytes of the file).
export const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
export const JPEG_BASE64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]).toString('base64');
