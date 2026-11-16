import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openDb } from '../src/db.js';
import { createApp, extractTags } from '../src/app.js';
import { signToken, verifyToken } from '../src/auth.js';

const SECRET = 'test-secret-test-secret-test-secret-123';
let server, base, db;

before(async () => {
  db = openDb(':memory:');
  const app = createApp({ db, secret: SECRET, limits: { auth: 1000, global: 100000, write: 1000 } });
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  db.close();
});

async function call(method, path, { token, body, headers } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}

async function signup(username) {
  const r = await call('POST', '/api/auth/register', { body: { username, password: 'correct horse battery' } });
  assert.equal(r.status, 201);
  return r.body.token;
}

test('health endpoint is available for deployment checks', async () => {
  const r = await call('GET', '/health');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { status: 'ok' });
});

test('extractTags lowercases, dedupes and ignores text without tags', () => {
  assert.deepEqual(extractTags('Hello #Design and #design plus #dev_life'), ['design', 'dev_life']);
  assert.deepEqual(extractTags('no tags here'), []);
});

test('tokens reject tampering and expiry', () => {
  const good = signToken({ sub: 1, exp: Math.floor(Date.now() / 1000) + 60 }, SECRET);
  assert.equal(verifyToken(good, SECRET).sub, 1);
  assert.equal(verifyToken(good, 'another-secret-another-secret-12345'), null);
  assert.equal(verifyToken(good.slice(0, -2) + 'xx', SECRET), null);
  assert.equal(verifyToken(signToken({ sub: 1, exp: 1 }, SECRET), SECRET), null);
  assert.equal(verifyToken('garbage', SECRET), null);
});

test('register validates input and rejects duplicates case-insensitively', async () => {
  assert.equal((await call('POST', '/api/auth/register', { body: { username: 'ab', password: 'longenough1' } })).status, 400);
  assert.equal((await call('POST', '/api/auth/register', { body: { username: 'bad name!', password: 'longenough1' } })).status, 400);
  assert.equal((await call('POST', '/api/auth/register', { body: { username: 'okname', password: 'short' } })).status, 400);
  assert.equal((await call('POST', '/api/auth/register', { body: { username: 'Maya', password: 'longenough1' } })).status, 201);
  const dup = await call('POST', '/api/auth/register', { body: { username: 'maya', password: 'longenough1' } });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'username_taken');
});

test('password is never stored or returned in plain text', async () => {
  const r = await call('POST', '/api/auth/register', { body: { username: 'hashcheck', password: 'plain-secret-123' } });
  assert.ok(!JSON.stringify(r.body).includes('plain-secret-123'));
  const row = db.prepare("SELECT pw_hash FROM users WHERE username = 'hashcheck'").get();
  assert.ok(row.pw_hash.startsWith('scrypt$'));
  assert.ok(!row.pw_hash.includes('plain-secret-123'));
});

test('login accepts the right password and gives the same error for wrong password and unknown user', async () => {
  await signup('dev');
  const ok = await call('POST', '/api/auth/login', { body: { username: 'DEV', password: 'correct horse battery' } });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.token);
  const wrong = await call('POST', '/api/auth/login', { body: { username: 'dev', password: 'nope nope nope' } });
  const ghost = await call('POST', '/api/auth/login', { body: { username: 'nobody', password: 'nope nope nope' } });
  assert.equal(wrong.status, 401);
  assert.deepEqual(wrong.body, ghost.body);
});

test('protected routes demand a valid token', async () => {
  assert.equal((await call('POST', '/api/posts', { body: { body: 'hi' } })).status, 401);
  assert.equal((await call('GET', '/api/feed')).status, 401);
  const bad = await call('GET', '/api/me', { token: 'not.a.token' });
  assert.equal(bad.status, 401);
});

test('posts: create, validate, read, delete only by owner', async () => {
  const lena = await signup('lena');
  const omar = await signup('omar');
  assert.equal((await call('POST', '/api/posts', { token: lena, body: { body: '   ' } })).status, 400);
  assert.equal((await call('POST', '/api/posts', { token: lena, body: { body: 'x'.repeat(281) } })).status, 400);
  assert.equal((await call('POST', '/api/posts', { token: lena, body: { body: 123 } })).status, 400);

  const created = await call('POST', '/api/posts', { token: lena, body: { body: 'First post #Hello #hello' } });
  assert.equal(created.status, 201);
  assert.deepEqual(created.body.tags, ['hello']);
  assert.equal(created.body.author.username, 'lena');

  const id = created.body.id;
  assert.equal((await call('GET', `/api/posts/${id}`)).status, 200);
  const stolen = await call('DELETE', `/api/posts/${id}`, { token: omar });
  assert.equal(stolen.status, 403);
  assert.equal((await call('GET', `/api/posts/${id}`)).status, 200);
  assert.equal((await call('DELETE', `/api/posts/${id}`, { token: lena })).status, 204);
  assert.equal((await call('GET', `/api/posts/${id}`)).status, 404);
});

test('post text is stored as text and not interpreted', async () => {
  const t = await signup('xss');
  const evil = `<script>alert(1)</script> ' OR 1=1 --`;
  const r = await call('POST', '/api/posts', { token: t, body: { body: evil } });
  assert.equal(r.status, 201);
  assert.equal(r.body.body, evil);
  assert.equal(r.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
});

test('likes are idempotent and counted once per user', async () => {
  const a = await signup('likea');
  const b = await signup('likeb');
  const { body: post } = await call('POST', '/api/posts', { token: a, body: { body: 'like me' } });
  await call('POST', `/api/posts/${post.id}/like`, { token: a });
  await call('POST', `/api/posts/${post.id}/like`, { token: a });
  const second = await call('POST', `/api/posts/${post.id}/like`, { token: b });
  assert.equal(second.body.likeCount, 2);
  assert.equal(second.body.likedByMe, true);
  const anon = await call('GET', `/api/posts/${post.id}`);
  assert.equal(anon.body.likeCount, 2);
  assert.equal(anon.body.likedByMe, false);
  const un = await call('DELETE', `/api/posts/${post.id}/like`, { token: b });
  assert.equal(un.body.likeCount, 1);
  assert.equal((await call('POST', '/api/posts/999999/like', { token: a })).status, 404);
});

test('comments: add, list, and delete by author or post owner only', async () => {
  const owner = await signup('cowner');
  const guest = await signup('cguest');
  const other = await signup('cother');
  const { body: post } = await call('POST', '/api/posts', { token: owner, body: { body: 'discuss' } });
  const c1 = await call('POST', `/api/posts/${post.id}/comments`, { token: guest, body: { body: 'nice' } });
  const c2 = await call('POST', `/api/posts/${post.id}/comments`, { token: guest, body: { body: 'really nice' } });
  assert.equal(c1.status, 201);
  assert.equal((await call('POST', `/api/posts/${post.id}/comments`, { token: guest, body: { body: '' } })).status, 400);

  const list = await call('GET', `/api/posts/${post.id}/comments`);
  assert.equal(list.body.items.length, 2);
  assert.equal((await call('GET', `/api/posts/${post.id}`)).body.commentCount, 2);

  assert.equal((await call('DELETE', `/api/comments/${c1.body.id}`, { token: other })).status, 403);
  assert.equal((await call('DELETE', `/api/comments/${c1.body.id}`, { token: guest })).status, 204);
  assert.equal((await call('DELETE', `/api/comments/${c2.body.id}`, { token: owner })).status, 204);
  assert.equal((await call('GET', `/api/posts/${post.id}/comments`)).body.items.length, 0);
});

test('follow graph drives the home feed', async () => {
  const me = await signup('fme');
  const friend = await signup('ffriend');
  const stranger = await signup('fstranger');
  await call('POST', '/api/posts', { token: friend, body: { body: 'from friend' } });
  await call('POST', '/api/posts', { token: stranger, body: { body: 'from stranger' } });
  await call('POST', '/api/posts', { token: me, body: { body: 'from me' } });

  let feed = await call('GET', '/api/feed', { token: me });
  assert.deepEqual(feed.body.items.map((p) => p.body), ['from me']);

  assert.equal((await call('POST', '/api/users/fme/follow', { token: me })).status, 400);
  const followed = await call('POST', '/api/users/ffriend/follow', { token: me });
  assert.equal(followed.status, 200);
  assert.equal(followed.body.followedByMe, true);
  assert.equal(followed.body.followerCount, 1);
  await call('POST', '/api/users/ffriend/follow', { token: me });
  assert.equal((await call('GET', '/api/users/ffriend')).body.followerCount, 1);

  feed = await call('GET', '/api/feed', { token: me });
  assert.deepEqual(feed.body.items.map((p) => p.body), ['from me', 'from friend']);

  await call('DELETE', '/api/users/ffriend/follow', { token: me });
  feed = await call('GET', '/api/feed', { token: me });
  assert.deepEqual(feed.body.items.map((p) => p.body), ['from me']);
  assert.equal((await call('POST', '/api/users/ghost-user/follow', { token: me })).status, 404);
});

test('pagination walks every post newest first with no overlap', async () => {
  const t = await signup('pager');
  for (let i = 1; i <= 7; i++) await call('POST', '/api/posts', { token: t, body: { body: `page post ${i}` } });
  const seen = [];
  let cursor = null;
  do {
    const r = await call('GET', `/api/users/pager/posts?limit=3${cursor ? `&before=${cursor}` : ''}`);
    assert.equal(r.status, 200);
    seen.push(...r.body.items.map((p) => p.body));
    cursor = r.body.nextCursor;
  } while (cursor);
  assert.deepEqual(seen, [7, 6, 5, 4, 3, 2, 1].map((n) => `page post ${n}`));
  assert.equal((await call('GET', '/api/users/pager/posts?limit=abc')).status, 400);
  assert.equal((await call('GET', '/api/users/pager/posts?before=-1')).status, 400);
});

test('search by tag, by text, and trending tags', async () => {
  const t = await signup('searcher');
  await call('POST', '/api/posts', { token: t, body: { body: 'golden light #photography' } });
  await call('POST', '/api/posts', { token: t, body: { body: 'more #photography and #travel' } });
  const byTag = await call('GET', '/api/posts?tag=%23Photography');
  assert.equal(byTag.body.items.length, 2);
  const byText = await call('GET', '/api/posts?q=golden');
  assert.equal(byText.body.items.length, 1);
  const wildcard = await call('GET', '/api/posts?q=%25');
  assert.equal(wildcard.body.items.length, 0);
  const trending = await call('GET', '/api/tags/trending');
  assert.equal(trending.body.items[0].tag, 'photography');
  assert.equal(trending.body.items[0].count, 2);
  const people = await call('GET', '/api/users?q=search');
  assert.equal(people.body.items[0].username, 'searcher');
});

test('profile edit validates and only changes the caller', async () => {
  const t = await signup('editor1');
  await signup('editor2');
  const r = await call('PATCH', '/api/me', { token: t, body: { displayName: 'Editor One', bio: 'Hello there' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.bio, 'Hello there');
  assert.equal((await call('GET', '/api/users/editor2')).body.bio, '');
  assert.equal((await call('PATCH', '/api/me', { token: t, body: { bio: 'x'.repeat(161) } })).status, 400);
  assert.equal((await call('PATCH', '/api/me', { token: t, body: {} })).status, 400);
  assert.ok(!('pw_hash' in r.body));
});

test('deleting a post removes its likes, comments and tags', async () => {
  const t = await signup('cleaner');
  const { body: post } = await call('POST', '/api/posts', { token: t, body: { body: 'bye #gone' } });
  await call('POST', `/api/posts/${post.id}/like`, { token: t });
  await call('POST', `/api/posts/${post.id}/comments`, { token: t, body: { body: 'c' } });
  await call('DELETE', `/api/posts/${post.id}`, { token: t });
  for (const table of ['likes', 'comments', 'post_tags']) {
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE post_id = ?`).get(post.id).n, 0, table);
  }
});

test('bad requests get clear errors', async () => {
  const t = await signup('badreq');
  assert.equal((await call('POST', '/api/posts', { token: t, body: '{not json' })).status, 400);
  assert.equal((await call('POST', '/api/posts', { token: t, body: '[1,2]' })).status, 400);
  const wrongType = await fetch(base + '/api/posts', { method: 'POST', headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'text/plain' }, body: 'hi' });
  assert.equal(wrongType.status, 415);
  const huge = await call('POST', '/api/posts', { token: t, body: { body: 'a'.repeat(40000) } });
  assert.equal(huge.status, 413);
  assert.equal((await call('GET', '/api/nope')).status, 404);
  assert.equal((await call('PUT', '/api/posts')).status, 405);
  assert.equal((await call('GET', '/api/posts/abc')).status, 400);
});

test('auth endpoints are rate limited', async () => {
  const d = openDb(':memory:');
  const app = createApp({ db: d, secret: SECRET, limits: { auth: 3, global: 1000 } });
  const s = http.createServer(app);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${s.address().port}/api/auth/login`;
  const codes = [];
  for (let i = 0; i < 5; i++) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'x', password: 'y' }) });
    codes.push(r.status);
  }
  s.close();
  d.close();
  assert.deepEqual(codes, [401, 401, 401, 429, 429]);
});

test('CORS only allows the configured origin', async () => {
  const d = openDb(':memory:');
  const s = http.createServer(createApp({ db: d, secret: SECRET, allowedOrigin: 'https://app.example.com' }));
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${s.address().port}/health`;
  const good = await fetch(url, { headers: { Origin: 'https://app.example.com' } });
  const bad = await fetch(url, { headers: { Origin: 'https://evil.example.com' } });
  s.close();
  d.close();
  assert.equal(good.headers.get('access-control-allow-origin'), 'https://app.example.com');
  assert.equal(bad.headers.get('access-control-allow-origin'), null);
});
