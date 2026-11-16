import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, PNG_BASE64, JPEG_BASE64 } from './helpers.js';

let s;
before(async () => {
  s = await startServer();
});
after(() => s.close());

const call = (...args) => s.call(...args);

test('media: upload, serve with safe headers, and reject non-images', async () => {
  const t = await s.signup('mediaup');
  const up = await call('POST', '/api/media', { token: t, body: { data: PNG_BASE64 } });
  assert.equal(up.status, 201);
  assert.equal(up.body.contentType, 'image/png');

  const got = await call('GET', up.body.url);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('content-type'), 'image/png');
  assert.equal(got.headers.get('x-content-type-options'), 'nosniff');
  assert.match(got.headers.get('content-security-policy'), /sandbox/);
  assert.equal(got.raw.subarray(1, 4).toString('ascii'), 'PNG');

  const jpeg = await call('POST', '/api/media', { token: t, body: { data: JPEG_BASE64 } });
  assert.equal(jpeg.body.contentType, 'image/jpeg');

  const text = await call('POST', '/api/media', { token: t, body: { data: Buffer.from('hello world, not an image').toString('base64') } });
  assert.equal(text.status, 415);
  const svg = await call('POST', '/api/media', { token: t, body: { data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64') } });
  assert.equal(svg.status, 415);
  const prefixed = await call('POST', '/api/media', { token: t, body: { data: 'data:image/png;base64,' + PNG_BASE64 } });
  assert.equal(prefixed.status, 400);
  assert.equal((await call('POST', '/api/media', { token: t, body: {} })).status, 400);
  assert.equal((await call('POST', '/api/media', { body: { data: PNG_BASE64 } })).status, 401);
  assert.equal((await call('GET', '/api/media/99999')).status, 404);
});

test('media: oversized upload is rejected', async () => {
  const t = await s.signup('bigmedia');
  const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(1_100_000)]).toString('base64');
  const r = await call('POST', '/api/media', { token: t, body: { data: big } });
  assert.ok([413].includes(r.status), `status ${r.status}`);
});

test('posts can carry an image, and only the uploader may attach it', async () => {
  const a = await s.signup('imgowner');
  const b = await s.signup('imgthief');
  const { body: media } = await call('POST', '/api/media', { token: a, body: { data: PNG_BASE64 } });

  const stolen = await call('POST', '/api/posts', { token: b, body: { body: 'mine now', mediaId: media.id } });
  assert.equal(stolen.status, 400);
  assert.equal(stolen.body.error.code, 'invalid_mediaId');

  const photoOnly = await call('POST', '/api/posts', { token: a, body: { mediaId: media.id } });
  assert.equal(photoOnly.status, 201);
  assert.equal(photoOnly.body.mediaUrl, media.url);
  assert.equal(photoOnly.body.body, '');

  assert.equal((await call('POST', '/api/posts', { token: a, body: {} })).status, 400);
  assert.equal((await call('POST', '/api/posts', { token: a, body: { body: 'x', mediaId: 'abc' } })).status, 400);
  assert.equal((await call('POST', '/api/posts', { token: a, body: { body: 'x', mediaId: 424242 } })).status, 400);
});

test('polls: validation, one vote per person, counts and myVote', async () => {
  const owner = await s.signup('pollowner');
  const v1 = await s.signup('pollv1');
  const v2 = await s.signup('pollv2');

  const bad = (poll, body = 'Question?') => call('POST', '/api/posts', { token: owner, body: { body, poll } });
  assert.equal((await bad({ options: ['only one'] })).status, 400);
  assert.equal((await bad({ options: ['a', 'b', 'c', 'd', 'e'] })).status, 400);
  assert.equal((await bad({ options: ['same', 'SAME'] })).status, 400);
  assert.equal((await bad({ options: ['ok', ''] })).status, 400);
  assert.equal((await bad({ options: ['ok', 'x'.repeat(41)] })).status, 400);
  assert.equal((await bad({ options: 'nope' })).status, 400);
  assert.equal((await bad({ options: ['a', 'b'] }, '')).status, 400);

  const made = await bad({ options: ['SQLite', 'Postgres', 'JSON files'] });
  assert.equal(made.status, 201);
  assert.equal(made.body.poll.options.length, 3);
  assert.equal(made.body.poll.total, 0);
  assert.equal(made.body.poll.myVote, null);
  const id = made.body.id;

  assert.equal((await call('POST', `/api/posts/${id}/vote`, { body: { option: 0 } })).status, 401);
  for (const option of [-1, 3, 1.5, '0', null]) {
    assert.equal((await call('POST', `/api/posts/${id}/vote`, { token: v1, body: { option } })).status, 400, `option ${option}`);
  }

  const first = await call('POST', `/api/posts/${id}/vote`, { token: v1, body: { option: 1 } });
  assert.equal(first.status, 200);
  assert.equal(first.body.poll.myVote, 1);
  const again = await call('POST', `/api/posts/${id}/vote`, { token: v1, body: { option: 0 } });
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'already_voted');

  await call('POST', `/api/posts/${id}/vote`, { token: v2, body: { option: 1 } });
  const seen = await call('GET', `/api/posts/${id}`);
  assert.deepEqual(seen.body.poll.options.map((o) => o.votes), [0, 2, 0]);
  assert.equal(seen.body.poll.total, 2);
  assert.equal(seen.body.poll.myVote, null);

  const plain = await call('POST', '/api/posts', { token: owner, body: { body: 'no poll here' } });
  const notPoll = await call('POST', `/api/posts/${plain.body.id}/vote`, { token: v1, body: { option: 0 } });
  assert.equal(notPoll.status, 400);
  assert.equal(notPoll.body.error.code, 'not_a_poll');
  assert.equal((await call('POST', '/api/posts/999999/vote', { token: v1, body: { option: 0 } })).status, 404);
});

test('reposts: idempotent, resolve to the original, appear in feeds, and cascade on delete', async () => {
  const author = await s.signup('rpauthor');
  const fan = await s.signup('rpfan');
  const other = await s.signup('rpother');
  await call('POST', '/api/users/rpfan/follow', { token: other });

  const { body: post } = await call('POST', '/api/posts', { token: author, body: { body: 'original thought #repost' } });
  const r1 = await call('POST', `/api/posts/${post.id}/repost`, { token: fan });
  assert.equal(r1.status, 200);
  assert.equal(r1.body.id, post.id);
  assert.equal(r1.body.repostedByMe, true);
  assert.equal(r1.body.repostCount, 1);
  await call('POST', `/api/posts/${post.id}/repost`, { token: fan });
  assert.equal((await call('GET', `/api/posts/${post.id}`)).body.repostCount, 1);

  const feed = await call('GET', '/api/feed', { token: other });
  assert.equal(feed.body.items.length, 1);
  assert.equal(feed.body.items[0].author.username, 'rpfan');
  assert.equal(feed.body.items[0].repostOf.id, post.id);
  assert.equal(feed.body.items[0].repostOf.body, 'original thought #repost');

  const repostId = feed.body.items[0].id;
  const chained = await call('POST', `/api/posts/${repostId}/repost`, { token: other });
  assert.equal(chained.body.id, post.id, 'reposting a repost points at the original');
  assert.equal(chained.body.repostCount, 2);

  const tagSearch = await call('GET', '/api/posts?tag=repost');
  assert.equal(tagSearch.body.items.length, 1, 'search lists only originals');
  assert.equal((await call('GET', '/api/users/rpfan')).body.postCount, 0, 'reposts do not count as posts');

  const undo = await call('DELETE', `/api/posts/${post.id}/repost`, { token: fan });
  assert.equal(undo.body.repostCount, 1);
  assert.equal(undo.body.repostedByMe, false);

  assert.equal((await call('POST', `/api/posts/${post.id}/repost`)).status, 401);
  assert.equal((await call('POST', '/api/posts/999999/repost', { token: fan })).status, 404);

  await call('DELETE', `/api/posts/${post.id}`, { token: author });
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM posts WHERE rp_of IS NOT NULL').get().n, 0);
});

test('bookmarks are private, idempotent and listed newest first', async () => {
  const a = await s.signup('bmalice');
  const b = await s.signup('bmbob');
  const { body: p1 } = await call('POST', '/api/posts', { token: a, body: { body: 'first' } });
  const { body: p2 } = await call('POST', '/api/posts', { token: a, body: { body: 'second' } });

  assert.equal((await call('POST', `/api/posts/${p1.id}/bookmark`)).status, 401);
  assert.equal((await call('GET', '/api/bookmarks')).status, 401);
  await call('POST', `/api/posts/${p1.id}/bookmark`, { token: b });
  const saved = await call('POST', `/api/posts/${p2.id}/bookmark`, { token: b });
  await call('POST', `/api/posts/${p2.id}/bookmark`, { token: b });
  assert.equal(saved.body.bookmarkedByMe, true);

  const mine = await call('GET', '/api/bookmarks', { token: b });
  assert.deepEqual(mine.body.items.map((p) => p.body), ['second', 'first']);
  assert.equal((await call('GET', '/api/bookmarks', { token: a })).body.items.length, 0, 'other people see nothing');
  assert.equal((await call('GET', `/api/posts/${p2.id}`)).body.bookmarkedByMe, false, 'anonymous view is not flagged');

  const removed = await call('DELETE', `/api/posts/${p1.id}/bookmark`, { token: b });
  assert.equal(removed.body.bookmarkedByMe, false);
  assert.equal((await call('GET', '/api/bookmarks', { token: b })).body.items.length, 1);
  assert.equal((await call('POST', '/api/posts/999999/bookmark', { token: b })).status, 404);
});

test('user suggestions skip yourself and people you follow, and work signed out', async () => {
  const me = await s.signup('sugme');
  await s.signup('sugfriend');
  const loud = await s.signup('sugloud');
  await s.signup('sugquiet');
  for (let i = 0; i < 30; i++) await call('POST', '/api/posts', { token: loud, body: { body: `suggestion fodder ${i}` } });
  await call('POST', '/api/users/sugfriend/follow', { token: me });

  const mine = await call('GET', '/api/users/suggestions', { token: me });
  assert.equal(mine.status, 200);
  const names = mine.body.items.map((u) => u.username);
  assert.ok(!names.includes('sugme'));
  assert.ok(!names.includes('sugfriend'));
  assert.equal(names[0], 'sugloud', 'the most active person who is not followed ranks first');
  const anon = await call('GET', '/api/users/suggestions');
  assert.equal(anon.status, 200);
  assert.ok(anon.body.items.length > 0);
});

test('tampered or malformed input to the new endpoints is rejected, not crashed on', async () => {
  const t = await s.signup('fuzzer');
  assert.equal((await call('POST', '/api/posts', { token: t, body: { body: 'x', communityId: 'abc' } })).status, 400);
  assert.equal((await call('POST', '/api/posts', { token: t, body: { body: 'x', communityId: 999999 } })).status, 404);
  assert.equal((await call('POST', '/api/posts', { token: t, body: { body: 'x', poll: 5 } })).status, 400);
  assert.equal((await call('GET', '/api/posts?community=abc')).status, 400);
  assert.equal((await call('GET', '/api/posts/1; DROP TABLE posts')).status, 400);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'posts'").get().n, 1);
});
