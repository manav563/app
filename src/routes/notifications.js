// Notifications are derived from existing activity on the user's posts, so no separate table can drift.
// "Unread" means newer than users.notif_seen_at, which the client advances with POST /api/notifications/read.
const ACTIVITY = `
  SELECT 'like' AS kind, l.user_id AS actorId, l.post_id AS postId, l.created_at AS ts, NULL AS snippet
    FROM likes l JOIN posts p ON p.id = l.post_id WHERE p.user_id = :me AND l.user_id <> :me
  UNION ALL
  SELECT 'reply', c.user_id, c.post_id, c.created_at, c.body
    FROM comments c JOIN posts p ON p.id = c.post_id WHERE p.user_id = :me AND c.user_id <> :me
  UNION ALL
  SELECT 'repost', r.user_id, r.rp_of, r.created_at, NULL
    FROM posts r JOIN posts p ON p.id = r.rp_of WHERE p.user_id = :me AND r.user_id <> :me
  UNION ALL
  SELECT 'vote', v.user_id, v.post_id, v.created_at, NULL
    FROM poll_votes v JOIN posts p ON p.id = v.post_id WHERE p.user_id = :me AND v.user_id <> :me
  UNION ALL
  SELECT 'follow', f.follower_id, NULL, f.created_at, NULL
    FROM follows f WHERE f.followee_id = :me`;

export function register({ db, route, requireAuth }) {
  const seenAt = (id) => db.prepare('SELECT notif_seen_at AS t FROM users WHERE id = :id').get({ id }).t;

  route('GET', '/api/notifications', (c) => {
    const me = requireAuth(c);
    const seen = seenAt(me.id);
    const rows = db
      .prepare(
        `SELECT a.kind, a.postId, a.ts, COALESCE(a.snippet, substr(pp.body, 1, 80)) AS snippet, u.username, u.display_name AS displayName
         FROM (${ACTIVITY}) a
         JOIN users u ON u.id = a.actorId
         LEFT JOIN posts pp ON pp.id = a.postId
         ORDER BY a.ts DESC LIMIT 50`,
      )
      .all({ me: me.id });
    return {
      body: {
        items: rows.map((r) => ({
          kind: r.kind,
          actor: { username: r.username, displayName: r.displayName },
          postId: r.postId,
          snippet: r.snippet,
          createdAt: r.ts,
          unread: r.ts > seen,
        })),
      },
    };
  }, { auth: true });

  route('POST', '/api/notifications/read', (c) => {
    const me = requireAuth(c);
    db.prepare('UPDATE users SET notif_seen_at = :t WHERE id = :id').run({ t: Date.now(), id: me.id });
    return { status: 204 };
  }, { auth: true });

  // Badge counts for the navigation bar.
  route('GET', '/api/me/counts', (c) => {
    const me = requireAuth(c);
    const notifications = db.prepare(`SELECT COUNT(*) AS n FROM (${ACTIVITY}) WHERE ts > :seen`).get({ me: me.id, seen: seenAt(me.id) }).n;
    const messages = db.prepare('SELECT COUNT(*) AS n FROM dm_messages WHERE recipient_id = :me AND read_at IS NULL').get({ me: me.id }).n;
    return { body: { notifications, messages } };
  }, { auth: true });
}
