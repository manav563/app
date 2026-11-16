import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { openDb } from './db.js';
import { createApp } from './app.js';

const env = process.env;
const production = env.NODE_ENV === 'production';

let secret = env.JWT_SECRET;
if (!secret) {
  if (production) {
    console.error('JWT_SECRET is required in production (at least 32 characters).');
    process.exit(1);
  }
  secret = randomBytes(32).toString('hex');
  console.warn('JWT_SECRET not set. Using a random one, so sessions end when the server restarts.');
}

const db = openDb(env.DB_PATH || './plaza.db');
const app = createApp({
  db,
  secret,
  allowedOrigin: env.ALLOWED_ORIGIN || '',
  trustProxy: env.TRUST_PROXY === '1',
  staticDir: new URL('../public/', import.meta.url).pathname,
  log: (entry) => console.log(JSON.stringify({ t: new Date().toISOString(), ...entry })),
});

const server = http.createServer(app);
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;

const port = Number(env.PORT || 3000);
server.listen(port, () => console.log(JSON.stringify({ t: new Date().toISOString(), message: `plaza-api listening on :${port}` })));

function shutdown(signal) {
  console.log(JSON.stringify({ t: new Date().toISOString(), message: `${signal} received, shutting down` }));
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
