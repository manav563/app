import { HttpError } from '../http.js';
import { str, intParam } from '../validate.js';

const DAY_MS = 24 * 3600 * 1000;
const COLOR_COUNT = 5;

export function register({ db, route, requireAuth, writeLimit }) {
  const shape = (r) => ({
    id: r.id,
    body: r.body,
    color: r.color,
    mediaUrl: r.mediaId ? `/api/media/${r.mediaId}` : null,
    createdAt: r.createdAt,
    seen: !!r.seen,
  });

  route('POST', '/api/stories', async (c) => {
    const me = requireAuth(c);
    writeLimit(c);
    const b = await c.json();
    const body = str(b.body ?? '', 'body', { min: 0, max: 120 });
    const color = b.color === undefined ? 0 : b.color;
    if (!Number.isInteger(color) || color < 0 || color >= COLOR_COUNT) throw new HttpError(400, 'invalid_color', `color must be a whole number from 0 to ${COLOR_COUNT - 1}.`);
    let mediaId = null;
    if (b.mediaId !== undefined && b.mediaId !== null) {
      mediaId = intParam(b.mediaId, 'mediaId');
      const m = db.prepare('SELECT user_id FROM media WHERE id = :id').get({ id: mediaId });
      if (!m || m.user_id !== me.id) throw new HttpError(400, 'invalid_mediaId', 'That image was not uploaded by you.');
    }
    if (!body && !mediaId) throw new HttpError(400, 'empty_story', 'Add some text or a photo.');
    const now = Date.now();
    db.prepare('DELETE FROM stories WHERE created_at < :cut').run({ cut: now - DAY_MS }); // expired stories and their views
    const r = db.prepare('INSERT INTO stories (user_id, body, color, media_id, created_at) VALUES (:u, :b, :c, :m, :t)').run({ u: me.id, b: body, c: color, m: mediaId, t: now });
    return { status: 201, body: shape({ id: Number(r.lastInsertRowid), body, color, mediaId, createdAt: now, seen: 0 }) };
  }, { auth: true });

  // Active stories grouped by author. Own stories first, then unseen groups, then the most recently updated.
  route('GET', '/api/stories', (c) => {
    const rows = db
      .prepare(
        `SELECT s.id, s.body, s.color, s.media_id AS mediaId, s.created_at AS createdAt, u.username, u.display_name AS displayName,
           EXISTS (SELECT 1 FROM story_views v WHERE v.story_id = s.id AND v.user_id = :me) AS seen
         FROM stories s JOIN users u ON u.id = s.user_id
         WHERE s.created_at > :cut ORDER BY s.created_at ASC LIMIT 500`,
      )
      .all({ me: c.user ? c.user.id : null, cut: Date.now() - DAY_MS });
    const groups = new Map();
    for (const r of rows) {
      if (!groups.has(r.username)) groups.set(r.username, { author: { username: r.username, displayName: r.displayName }, stories: [] });
      groups.get(r.username).stories.push(shape(r));
    }
    const items = [...groups.values()].map((g) => ({ ...g, allSeen: g.stories.every((s) => s.seen) }));
    const mine = c.user ? c.user.username : null;
    items.sort(
      (a, b) =>
        (b.author.username === mine) - (a.author.username === mine) ||
        (a.allSeen ? 1 : 0) - (b.allSeen ? 1 : 0) ||
        b.stories[b.stories.length - 1].createdAt - a.stories[a.stories.length - 1].createdAt,
    );
    return { body: { items } };
  });

  route('POST', '/api/stories/:id/view', (c) => {
    const me = requireAuth(c);
    const id = intParam(c.params.id, 'id');
    const s = db.prepare('SELECT created_at AS createdAt FROM stories WHERE id = :id').get({ id });
    if (!s || s.createdAt <= Date.now() - DAY_MS) throw new HttpError(404, 'story_not_found', 'That story is gone.');
    db.prepare('INSERT OR IGNORE INTO story_views (story_id, user_id) VALUES (:s, :u)').run({ s: id, u: me.id });
    return { status: 204 };
  }, { auth: true });

  route('DELETE', '/api/stories/:id', (c) => {
    const me = requireAuth(c);
    const id = intParam(c.params.id, 'id');
    const s = db.prepare('SELECT user_id AS userId FROM stories WHERE id = :id').get({ id });
    if (!s) throw new HttpError(404, 'story_not_found', 'That story is gone.');
    if (s.userId !== me.id) throw new HttpError(403, 'forbidden', 'You can only delete your own stories.');
    db.prepare('DELETE FROM stories WHERE id = :id').run({ id });
    return { status: 204 };
  }, { auth: true });
}
