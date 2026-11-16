import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, PNG_BASE64 } from './helpers.js';

let s;
before(async () => {
  s = await startServer();
});
after(() => s.close());

const call = (...args) => s.call(...args);

test('communities: validation, unique names, owner auto-joins, join and leave are idempotent', async () => {
  const owner = await s.signup('cowner1');
  const guest = await s.signup('cguest1');

  assert.equal((await call('POST', '/api/communities', { body: { name: 'Nope Anon' } })).status, 401);
  assert.equal((await call('POST', '/api/communities', { token: owner, body: { name: 'ab' } })).status, 400);
  assert.equal((await call('POST', '/api/communities', { token: owner, body: { name: 'bad <name>' } })).status, 400);
  assert.equal((await call('POST', '/api/communities', { token: owner, body: { name: 'x'.repeat(31) } })).status, 400);
  assert.equal((await call('POST', '/api/communities', { token: owner, body: { name: 'Fine Name', description: 'x'.repeat(101) } })).status, 400);

  const made = await call('POST', '/api/communities', { token: owner, body: { name: 'Night Owls', description: 'Late builders' } });
  assert.equal(made.status, 201);
  assert.equal(made.body.memberCount, 1);
  assert.equal(made.body.joinedByMe, true);
  assert.equal(made.body.owner, 'cowner1');
  const id = made.body.id;

  const dup = await call('POST', '/api/communities', { token: guest, body: { name: 'night owls' } });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'name_taken');

  const j1 = await call('POST', `/api/communities/${id}/join`, { token: guest });
  await call('POST', `/api/communities/${id}/join`, { token: guest });
  assert.equal(j1.body.memberCount, 2);
  assert.equal(j1.body.joinedByMe, true);
  assert.equal((await call('GET', `/api/communities/${id}`)).body.joinedByMe, false, 'anonymous viewers are not members');
  const left = await call('DELETE', `/api/communities/${id}/join`, { token: guest });
  assert.equal(left.body.memberCount, 1);
  assert.equal(left.body.joinedByMe, false);

  const found = await call('GET', '/api/communities?q=owls');
  assert.equal(found.body.items.length, 1);
  assert.equal((await call('GET', '/api/communities?q=%25')).body.items.length, 0, 'wildcards are escaped');
  assert.equal((await call('GET', '/api/communities/999999')).status, 404);
  assert.equal((await call('POST', '/api/communities/999999/join', { token: guest })).status, 404);
});

test('communities: only members can post, and posts filter by community', async () => {
  const owner = await s.signup('cposter');
  const outsider = await s.signup('coutsider');
  const { body: comm } = await call('POST', '/api/communities', { token: owner, body: { name: 'Street Photography' } });

  const blocked = await call('POST', '/api/posts', { token: outsider, body: { body: 'let me in', communityId: comm.id } });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.error.code, 'not_a_member');

  const ok = await call('POST', '/api/posts', { token: owner, body: { body: 'golden hour', communityId: comm.id } });
  assert.equal(ok.status, 201);
  assert.deepEqual(ok.body.community, { id: comm.id, name: 'Street Photography' });
  await call('POST', '/api/posts', { token: owner, body: { body: 'unrelated post' } });

  const list = await call('GET', `/api/posts?community=${comm.id}`);
  assert.deepEqual(list.body.items.map((p) => p.body), ['golden hour']);
});

test('communities: chat is members-only for both reading and writing, with polling by cursor', async () => {
  const owner = await s.signup('chatowner');
  const member = await s.signup('chatmember');
  const outsider = await s.signup('chatoutsider');
  const { body: comm } = await call('POST', '/api/communities', { token: owner, body: { name: 'Chat Room' } });
  const path = `/api/communities/${comm.id}/messages`;
  await call('POST', `/api/communities/${comm.id}/join`, { token: member });

  assert.equal((await call('GET', path)).status, 401);
  assert.equal((await call('GET', path, { token: outsider })).status, 403, 'non-members cannot read');
  assert.equal((await call('POST', path, { token: outsider, body: { body: 'hi' } })).status, 403, 'non-members cannot write');
  assert.equal((await call('POST', path, { token: member, body: { body: '' } })).status, 400);
  assert.equal((await call('POST', path, { token: member, body: { body: 'x'.repeat(281) } })).status, 400);

  const m1 = await call('POST', path, { token: owner, body: { body: 'first' } });
  const m2 = await call('POST', path, { token: member, body: { body: 'second <b>bold</b>' } });
  assert.equal(m1.status, 201);

  const all = await call('GET', path, { token: member });
  assert.deepEqual(all.body.items.map((m) => m.body), ['first', 'second <b>bold</b>'], 'oldest first, text kept as typed');
  const newer = await call('GET', `${path}?after=${m1.body.id}`, { token: member });
  assert.deepEqual(newer.body.items.map((m) => m.id), [m2.body.id]);
  const older = await call('GET', `${path}?before=${m2.body.id}`, { token: member });
  assert.deepEqual(older.body.items.map((m) => m.id), [m1.body.id]);
  assert.equal((await call('GET', `${path}?after=abc`, { token: member })).status, 400);

  await call('DELETE', `/api/communities/${comm.id}/join`, { token: member });
  assert.equal((await call('GET', path, { token: member })).status, 403, 'leaving removes chat access');
});

test('stories: validation, grouping, seen state, expiry and owner-only delete', async () => {
  const a = await s.signup('storya');
  const b = await s.signup('storyb');
  const { body: media } = await call('POST', '/api/media', { token: a, body: { data: PNG_BASE64 } });

  assert.equal((await call('POST', '/api/stories', { body: { body: 'anon' } })).status, 401);
  assert.equal((await call('POST', '/api/stories', { token: a, body: {} })).status, 400);
  assert.equal((await call('POST', '/api/stories', { token: a, body: { body: 'x'.repeat(121) } })).status, 400);
  assert.equal((await call('POST', '/api/stories', { token: a, body: { body: 'hi', color: 9 } })).status, 400);
  assert.equal((await call('POST', '/api/stories', { token: a, body: { body: 'hi', color: 'red' } })).status, 400);
  const stolen = await call('POST', '/api/stories', { token: b, body: { mediaId: media.id } });
  assert.equal(stolen.status, 400, 'cannot use someone else\'s image');

  const s1 = await call('POST', '/api/stories', { token: a, body: { body: 'first story', color: 1 } });
  const s2 = await call('POST', '/api/stories', { token: a, body: { mediaId: media.id } });
  assert.equal(s1.status, 201);
  assert.equal(s2.body.mediaUrl, media.url);
  const sb = await call('POST', '/api/stories', { token: b, body: { body: 'b story' } });

  let feed = await call('GET', '/api/stories', { token: b });
  assert.equal(feed.body.items[0].author.username, 'storyb', 'own stories come first');
  const ga = feed.body.items.find((g) => g.author.username === 'storya');
  assert.deepEqual(ga.stories.map((x) => x.id), [s1.body.id, s2.body.id], 'oldest first inside a group');
  assert.equal(ga.allSeen, false);

  assert.equal((await call('POST', `/api/stories/${s1.body.id}/view`, { token: b })).status, 204);
  await call('POST', `/api/stories/${s1.body.id}/view`, { token: b });
  await call('POST', `/api/stories/${s2.body.id}/view`, { token: b });
  feed = await call('GET', '/api/stories', { token: b });
  assert.equal(feed.body.items.find((g) => g.author.username === 'storya').allSeen, true);
  const anon = await call('GET', '/api/stories');
  assert.equal(anon.body.items.find((g) => g.author.username === 'storya').allSeen, false, 'seen state is per viewer');

  assert.equal((await call('DELETE', `/api/stories/${s1.body.id}`, { token: b })).status, 403);
  assert.equal((await call('DELETE', `/api/stories/${sb.body.id}`, { token: b })).status, 204);
  assert.equal((await call('DELETE', `/api/stories/${sb.body.id}`, { token: b })).status, 404);

  s.db.prepare('UPDATE stories SET created_at = :t WHERE id = :id').run({ t: Date.now() - 25 * 3600 * 1000, id: s1.body.id });
  const after = await call('GET', '/api/stories', { token: b });
  assert.deepEqual(after.body.items.find((g) => g.author.username === 'storya').stories.map((x) => x.id), [s2.body.id], 'stories expire after 24 hours');
  assert.equal((await call('POST', `/api/stories/${s1.body.id}/view`, { token: b })).status, 404);
});

test('direct messages: only the two people involved can read a conversation', async () => {
  const alice = await s.signup('dmalice');
  const bob = await s.signup('dmbob');
  const eve = await s.signup('dmeve');

  assert.equal((await call('POST', '/api/dm/dmbob', { body: { body: 'anon' } })).status, 401);
  assert.equal((await call('GET', '/api/dm')).status, 401);
  assert.equal((await call('POST', '/api/dm/dmalice', { token: alice, body: { body: 'me' } })).status, 400);
  assert.equal((await call('POST', '/api/dm/nobody123', { token: alice, body: { body: 'hi' } })).status, 404);
  assert.equal((await call('POST', '/api/dm/dmbob', { token: alice, body: { body: '' } })).status, 400);
  assert.equal((await call('POST', '/api/dm/dmbob', { token: alice, body: { body: 'x'.repeat(1001) } })).status, 400);

  const m1 = await call('POST', '/api/dm/dmbob', { token: alice, body: { body: 'hey bob' } });
  assert.equal(m1.status, 201);
  await call('POST', '/api/dm/dmalice', { token: bob, body: { body: 'hey alice <script>' } });
  await call('POST', '/api/dm/dmbob', { token: alice, body: { body: 'secret plans' } });

  const bobView = await call('GET', '/api/dm/dmalice', { token: bob });
  assert.deepEqual(bobView.body.items.map((m) => [m.body, m.mine]), [['hey bob', false], ['hey alice <script>', true], ['secret plans', false]]);
  const aliceView = await call('GET', '/api/dm/dmbob', { token: alice });
  assert.deepEqual(aliceView.body.items.map((m) => m.mine), [true, false, true]);

  // A third person asking for the same conversation only ever sees their own (empty) thread.
  const eveWithAlice = await call('GET', '/api/dm/dmalice', { token: eve });
  const eveWithBob = await call('GET', '/api/dm/dmbob', { token: eve });
  assert.deepEqual(eveWithAlice.body.items, []);
  assert.deepEqual(eveWithBob.body.items, []);
  assert.deepEqual((await call('GET', '/api/dm', { token: eve })).body.items, []);
  assert.ok(!JSON.stringify((await call('GET', '/api/dm', { token: eve })).body).includes('secret plans'));
  const eveRead = await call('POST', '/api/dm/dmalice/read', { token: eve });
  assert.equal(eveRead.status, 204);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM dm_messages WHERE read_at IS NOT NULL').get().n, 0, 'a stranger cannot mark anyone\'s messages read');

  const inbox = await call('GET', '/api/dm', { token: bob });
  assert.equal(inbox.body.items.length, 1);
  assert.equal(inbox.body.items[0].peer.username, 'dmalice');
  assert.equal(inbox.body.items[0].unread, 2);
  assert.equal(inbox.body.items[0].last.body, 'secret plans');
  assert.equal((await call('GET', '/api/me/counts', { token: bob })).body.messages, 2);

  const newer = await call('GET', `/api/dm/dmalice?after=${m1.body.id}`, { token: bob });
  assert.equal(newer.body.items.length, 2);
  assert.equal((await call('POST', '/api/dm/dmalice/read', { token: bob })).status, 204);
  assert.equal((await call('GET', '/api/dm', { token: bob })).body.items[0].unread, 0);
  assert.equal((await call('GET', '/api/me/counts', { token: bob })).body.messages, 0);
  assert.equal((await call('GET', '/api/dm', { token: alice })).body.items[0].unread, 1, 'alice still has bob\'s reply unread');
});

test('notifications: derived from activity on your posts, with read tracking', async () => {
  const owner = await s.signup('notifowner');
  const fan = await s.signup('notiffan');
  const { body: post } = await call('POST', '/api/posts', { token: owner, body: { body: 'notify me', poll: { options: ['yes', 'no'] } } });

  assert.equal((await call('GET', '/api/notifications')).status, 401);
  assert.deepEqual((await call('GET', '/api/notifications', { token: owner })).body.items, []);

  await call('POST', `/api/posts/${post.id}/like`, { token: owner }); // own activity is ignored
  await call('POST', `/api/posts/${post.id}/like`, { token: fan });
  await call('POST', `/api/posts/${post.id}/comments`, { token: fan, body: { body: 'nice one' } });
  await call('POST', `/api/posts/${post.id}/repost`, { token: fan });
  await call('POST', `/api/posts/${post.id}/vote`, { token: fan, body: { option: 1 } });
  await call('POST', '/api/users/notifowner/follow', { token: fan });

  const list = await call('GET', '/api/notifications', { token: owner });
  assert.deepEqual(list.body.items.map((n) => n.kind).sort(), ['follow', 'like', 'reply', 'repost', 'vote']);
  assert.ok(list.body.items.every((n) => n.actor.username === 'notiffan' && n.unread));
  assert.equal(list.body.items.find((n) => n.kind === 'reply').snippet, 'nice one');
  assert.equal(list.body.items.find((n) => n.kind === 'like').snippet, 'notify me');
  assert.equal((await call('GET', '/api/me/counts', { token: owner })).body.notifications, 5);
  assert.equal((await call('GET', '/api/notifications', { token: fan })).body.items.length, 0, 'the actor gets nothing');

  assert.equal((await call('POST', '/api/notifications/read', { token: owner })).status, 204);
  assert.equal((await call('GET', '/api/me/counts', { token: owner })).body.notifications, 0);
  assert.ok((await call('GET', '/api/notifications', { token: owner })).body.items.every((n) => !n.unread));

  await new Promise((r) => setTimeout(r, 5));
  await call('POST', `/api/posts/${post.id}/comments`, { token: fan, body: { body: 'one more' } });
  assert.equal((await call('GET', '/api/me/counts', { token: owner })).body.notifications, 1, 'only new activity counts as unread');
});
