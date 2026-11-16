import { HttpError } from '../http.js';
import { str, intParam } from '../validate.js';

const DM_MAX = 1000;

// Direct messages between two people. Only the sender and the recipient can ever read a message:
// every query below is scoped to the authenticated user's id.
export function register({ db, route, requireAuth, writeLimit, users }) {
  const shape = (r, me) => ({ id: r.id, body: r.body, createdAt: r.createdAt, mine: r.senderId === me, read: r.readAt !== null });

  route('GET', '/api/dm', (c) => {
    const me = requireAuth(c);
    const rows = db
      .prepare(
        `SELECT peer.username, peer.display_name AS displayName, m.id, m.body, m.created_at AS createdAt,
           m.sender_id AS senderId, m.read_at AS readAt,
           (SELECT COUNT(*) FROM dm_messages x WHERE x.sender_id = peer.id AND x.recipient_id = :me AND x.read_at IS NULL) AS unread
         FROM dm_messages m
         JOIN users peer ON peer.id = CASE WHEN m.sender_id = :me THEN m.recipient_id ELSE m.sender_id END
         WHERE m.id IN (
           SELECT MAX(id) FROM dm_messages WHERE sender_id = :me OR recipient_id = :me
           GROUP BY CASE WHEN sender_id = :me THEN recipient_id ELSE sender_id END
         )
         ORDER BY m.id DESC LIMIT 50`,
      )
      .all({ me: me.id });
    return {
      body: {
        items: rows.map((r) => ({
          peer: { username: r.username, displayName: r.displayName },
          last: shape(r, me.id),
          unread: r.unread,
        })),
      },
    };
  }, { auth: true });

  // Oldest first. ?after=<id> returns newer messages (polling), ?before=<id> returns older ones.
  route('GET', '/api/dm/:username', (c) => {
    const me = requireAuth(c);
    const peer = users.findUser(c.params.username);
    const limit = c.query.has('limit') ? Math.min(100, Math.max(1, intParam(c.query.get('limit'), 'limit'))) : 50;
    const base = `SELECT id, body, created_at AS createdAt, sender_id AS senderId, read_at AS readAt FROM dm_messages
                  WHERE ((sender_id = :me AND recipient_id = :peer) OR (sender_id = :peer AND recipient_id = :me))`;
    let rows;
    if (c.query.has('after')) {
      rows = db.prepare(`${base} AND id > :a ORDER BY id ASC LIMIT :l`).all({ me: me.id, peer: peer.id, a: intParam(c.query.get('after'), 'after'), l: limit });
    } else {
      const before = c.query.has('before') ? intParam(c.query.get('before'), 'before') : Number.MAX_SAFE_INTEGER;
      rows = db.prepare(`${base} AND id < :b ORDER BY id DESC LIMIT :l`).all({ me: me.id, peer: peer.id, b: before, l: limit }).reverse();
    }
    return { body: { peer: { username: peer.username, displayName: peer.displayName }, items: rows.map((r) => shape(r, me.id)) } };
  }, { auth: true });

  route('POST', '/api/dm/:username', async (c) => {
    const me = requireAuth(c);
    writeLimit(c);
    const peer = users.findUser(c.params.username);
    if (peer.id === me.id) throw new HttpError(400, 'cannot_message_self', 'You cannot message yourself.');
    const b = await c.json();
    const body = str(b.body, 'body', { min: 1, max: DM_MAX });
    const createdAt = Date.now();
    const r = db.prepare('INSERT INTO dm_messages (sender_id, recipient_id, body, created_at) VALUES (:s, :r, :b, :t)').run({ s: me.id, r: peer.id, b: body, t: createdAt });
    return { status: 201, body: { id: Number(r.lastInsertRowid), body, createdAt, mine: true, read: false } };
  }, { auth: true });

  route('POST', '/api/dm/:username/read', (c) => {
    const me = requireAuth(c);
    const peer = users.findUser(c.params.username);
    db.prepare('UPDATE dm_messages SET read_at = :t WHERE sender_id = :peer AND recipient_id = :me AND read_at IS NULL').run({ t: Date.now(), peer: peer.id, me: me.id });
    return { status: 204 };
  }, { auth: true });
}
