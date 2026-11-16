import { HttpError } from '../http.js';
import { str, paging } from '../validate.js';

export function register({ db, route, requireAuth, users, posts }) {
  const { findUser, profile } = users;

  route('GET', '/api/me', (c) => {
    const me = requireAuth(c);
    return { body: profile(c.user, findUser(me.username)) };
  }, { auth: true });

  route('PATCH', '/api/me', async (c) => {
    const me = requireAuth(c);
    const b = await c.json();
    const sets = {};
    if (b.displayName !== undefined) sets.display_name = str(b.displayName, 'displayName', { min: 1, max: 40 });
    if (b.bio !== undefined) sets.bio = str(b.bio, 'bio', { min: 0, max: 160 });
    const cols = Object.keys(sets);
    if (!cols.length) throw new HttpError(400, 'nothing_to_update', 'Send displayName or bio.');
    db.prepare(`UPDATE users SET ${cols.map((k) => `${k} = :${k}`).join(', ')} WHERE id = :id`).run({ ...sets, id: me.id });
    return { body: profile(c.user, findUser(me.username)) };
  }, { auth: true });

  route('GET', '/api/users', (c) => {
    const q = (c.query.get('q') || '').trim().replace(/[\\%_]/g, '\\$&');
    if (!q) return { body: { items: [] } };
    const items = db
      .prepare(`SELECT username, display_name AS displayName FROM users WHERE username LIKE :q ESCAPE '\\' OR display_name LIKE :q ESCAPE '\\' ORDER BY username LIMIT 10`)
      .all({ q: `${q}%` });
    return { body: { items } };
  });

  // Registered before /api/users/:username so "suggestions" is not read as a username.
  route('GET', '/api/users/suggestions', (c) => {
    const items = db
      .prepare(
        `SELECT u.username, u.display_name AS displayName,
           (SELECT COUNT(*) FROM follows f WHERE f.followee_id = u.id) AS followerCount
         FROM users u
         WHERE u.id <> COALESCE(:me, 0) AND u.id NOT IN (SELECT followee_id FROM follows WHERE follower_id = COALESCE(:me, 0))
         ORDER BY (SELECT COUNT(*) FROM posts p WHERE p.user_id = u.id AND p.rp_of IS NULL) DESC, u.username LIMIT 6`,
      )
      .all({ me: c.user ? c.user.id : null });
    return { body: { items } };
  });

  route('GET', '/api/users/:username', (c) => ({ body: profile(c.user, findUser(c.params.username)) }));

  route('GET', '/api/users/:username/posts', (c) => {
    const u = findUser(c.params.username);
    return { body: posts.listPosts(c.user, { where: 'p.user_id = :uid', params: { uid: u.id }, ...paging(c.query) }) };
  });

  route('POST', '/api/users/:username/follow', (c) => {
    const me = requireAuth(c);
    const u = findUser(c.params.username);
    if (u.id === me.id) throw new HttpError(400, 'cannot_follow_self', 'You cannot follow yourself.');
    db.prepare('INSERT OR IGNORE INTO follows (follower_id, followee_id, created_at) VALUES (:a, :b, :t)').run({ a: me.id, b: u.id, t: Date.now() });
    return { body: profile(c.user, u) };
  }, { auth: true });

  route('DELETE', '/api/users/:username/follow', (c) => {
    const me = requireAuth(c);
    const u = findUser(c.params.username);
    db.prepare('DELETE FROM follows WHERE follower_id = :a AND followee_id = :b').run({ a: me.id, b: u.id });
    return { body: profile(c.user, u) };
  }, { auth: true });

  route('GET', '/api/feed', (c) => {
    requireAuth(c);
    return {
      body: posts.listPosts(c.user, {
        where: '(p.user_id = :me OR p.user_id IN (SELECT followee_id FROM follows WHERE follower_id = :me))',
        ...paging(c.query),
      }),
    };
  }, { auth: true });
}
