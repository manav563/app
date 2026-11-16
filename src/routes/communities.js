import { HttpError } from '../http.js';
import { str, intParam } from '../validate.js';

const NAME = /^[\p{L}\p{N} _-]{3,30}$/u;
const CHAT_MAX = 280;

export function register({ db, route, tx, requireAuth, writeLimit }) {
  const isMember = (communityId, userId) =>
    !!db.prepare('SELECT 1 AS x FROM community_members WHERE community_id = :c AND user_id = :u').get({ c: communityId, u: userId });

  function getCommunity(viewer, id) {
    const r = db
      .prepare(
        `SELECT c.id, c.name, c.description, c.created_at AS createdAt, u.username AS owner,
           (SELECT COUNT(*) FROM community_members m WHERE m.community_id = c.id) AS memberCount,
           EXISTS (SELECT 1 FROM community_members m WHERE m.community_id = c.id AND m.user_id = :me) AS joinedByMe
         FROM communities c JOIN users u ON u.id = c.owner_id WHERE c.id = :id`,
      )
      .get({ id, me: viewer ? viewer.id : null });
    if (!r) throw new HttpError(404, 'community_not_found', 'That community does not exist.');
    return { ...r, joinedByMe: !!r.joinedByMe };
  }

  route('GET', '/api/communities', (c) => {
    const q = (c.query.get('q') || '').trim().replace(/[\\%_]/g, '\\$&');
    const items = db
      .prepare(
        `SELECT c.id, c.name, c.description, c.created_at AS createdAt, u.username AS owner,
           (SELECT COUNT(*) FROM community_members m WHERE m.community_id = c.id) AS memberCount,
           EXISTS (SELECT 1 FROM community_members m WHERE m.community_id = c.id AND m.user_id = :me) AS joinedByMe
         FROM communities c JOIN users u ON u.id = c.owner_id
         WHERE :q = '' OR c.name LIKE '%' || :q || '%' ESCAPE '\\' OR c.description LIKE '%' || :q || '%' ESCAPE '\\'
         ORDER BY memberCount DESC, c.name LIMIT 50`,
      )
      .all({ me: c.user ? c.user.id : null, q })
      .map((r) => ({ ...r, joinedByMe: !!r.joinedByMe }));
    return { body: { items } };
  });

  route('POST', '/api/communities', async (c) => {
    const me = requireAuth(c);
    writeLimit(c);
    const b = await c.json();
    const name = str(b.name, 'name', { min: 3, max: 30 });
    if (!NAME.test(name)) throw new HttpError(400, 'invalid_name', 'Names use letters, numbers, spaces, hyphens and underscores.');
    const description = str(b.description ?? '', 'description', { min: 0, max: 100 });
    let id;
    try {
      id = tx(() => {
        const now = Date.now();
        const r = db.prepare('INSERT INTO communities (name, description, owner_id, created_at) VALUES (:n, :d, :o, :t)').run({ n: name, d: description, o: me.id, t: now });
        const communityId = Number(r.lastInsertRowid);
        db.prepare('INSERT INTO community_members (community_id, user_id, created_at) VALUES (:c, :u, :t)').run({ c: communityId, u: me.id, t: now });
        return communityId;
      });
    } catch (err) {
      if (/UNIQUE/i.test(err.message)) throw new HttpError(409, 'name_taken', 'A community with that name already exists.');
      throw err;
    }
    return { status: 201, body: getCommunity(c.user, id) };
  }, { auth: true });

  route('GET', '/api/communities/:id', (c) => ({ body: getCommunity(c.user, intParam(c.params.id, 'id')) }));

  route('POST', '/api/communities/:id/join', (c) => {
    const me = requireAuth(c);
    const id = intParam(c.params.id, 'id');
    getCommunity(c.user, id);
    db.prepare('INSERT OR IGNORE INTO community_members (community_id, user_id, created_at) VALUES (:c, :u, :t)').run({ c: id, u: me.id, t: Date.now() });
    return { body: getCommunity(c.user, id) };
  }, { auth: true });

  route('DELETE', '/api/communities/:id/join', (c) => {
    const me = requireAuth(c);
    const id = intParam(c.params.id, 'id');
    getCommunity(c.user, id);
    db.prepare('DELETE FROM community_members WHERE community_id = :c AND user_id = :u').run({ c: id, u: me.id });
    return { body: getCommunity(c.user, id) };
  }, { auth: true });

  // Chat is members-only for reading and writing. ?after=<id> returns newer messages (for polling),
  // ?before=<id> returns older ones. Items are always oldest first.
  route('GET', '/api/communities/:id/messages', (c) => {
    const me = requireAuth(c);
    const id = intParam(c.params.id, 'id');
    getCommunity(c.user, id);
    if (!isMember(id, me.id)) throw new HttpError(403, 'not_a_member', 'Join the community to read its chat.');
    const limit = c.query.has('limit') ? Math.min(100, Math.max(1, intParam(c.query.get('limit'), 'limit'))) : 50;
    const base = `SELECT m.id, m.body, m.created_at AS createdAt, u.username, u.display_name AS displayName
                  FROM community_messages m JOIN users u ON u.id = m.user_id WHERE m.community_id = :c`;
    let rows;
    if (c.query.has('after')) {
      rows = db.prepare(`${base} AND m.id > :a ORDER BY m.id ASC LIMIT :l`).all({ c: id, a: intParam(c.query.get('after'), 'after'), l: limit });
    } else {
      const before = c.query.has('before') ? intParam(c.query.get('before'), 'before') : Number.MAX_SAFE_INTEGER;
      rows = db.prepare(`${base} AND m.id < :b ORDER BY m.id DESC LIMIT :l`).all({ c: id, b: before, l: limit }).reverse();
    }
    return { body: { items: rows.map((r) => ({ id: r.id, body: r.body, createdAt: r.createdAt, author: { username: r.username, displayName: r.displayName } })) } };
  }, { auth: true });

  route('POST', '/api/communities/:id/messages', async (c) => {
    const me = requireAuth(c);
    writeLimit(c);
    const id = intParam(c.params.id, 'id');
    getCommunity(c.user, id);
    if (!isMember(id, me.id)) throw new HttpError(403, 'not_a_member', 'Join the community to chat in it.');
    const b = await c.json();
    const body = str(b.body, 'body', { min: 1, max: CHAT_MAX });
    const createdAt = Date.now();
    const r = db.prepare('INSERT INTO community_messages (community_id, user_id, body, created_at) VALUES (:c, :u, :b, :t)').run({ c: id, u: me.id, b: body, t: createdAt });
    return { status: 201, body: { id: Number(r.lastInsertRowid), body, createdAt, author: { username: me.username, displayName: me.displayName } } };
  }, { auth: true });
}
