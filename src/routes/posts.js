import { HttpError } from '../http.js';
import { str, intParam, paging, POST_MAX } from '../validate.js';
import { extractTags } from '../posts.js';

const POLL_OPTIONS = { min: 2, max: 4, labelMax: 40 };

export function register({ db, route, tx, requireAuth, writeLimit, posts }) {
  const { listPosts, getPost, requirePost } = posts;

  const isUnique = (err) => /UNIQUE|PRIMARY KEY/i.test(err.message);

  function validatePoll(poll) {
    const opts = poll && typeof poll === 'object' ? poll.options : null;
    if (!Array.isArray(opts) || opts.length < POLL_OPTIONS.min || opts.length > POLL_OPTIONS.max) {
      throw new HttpError(400, 'invalid_poll', `A poll needs ${POLL_OPTIONS.min} to ${POLL_OPTIONS.max} options.`);
    }
    const labels = opts.map((o) => str(o, 'pollOption', { min: 1, max: POLL_OPTIONS.labelMax }));
    if (new Set(labels.map((l) => l.toLowerCase())).size !== labels.length) {
      throw new HttpError(400, 'invalid_poll', 'Poll options must be different from each other.');
    }
    return labels;
  }

  route('GET', '/api/posts', (c) => {
    const clauses = [];
    const params = {};
    const tag = (c.query.get('tag') || '').replace(/^#/, '').toLowerCase();
    if (tag) {
      clauses.push('p.id IN (SELECT post_id FROM post_tags WHERE tag = :tag)');
      params.tag = tag;
    }
    const q = (c.query.get('q') || '').trim();
    if (q) {
      clauses.push(`p.body LIKE :q ESCAPE '\\'`);
      params.q = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
    }
    if (tag || q) clauses.push('p.rp_of IS NULL');
    if (c.query.has('community')) {
      clauses.push('p.community_id = :community AND p.rp_of IS NULL');
      params.community = intParam(c.query.get('community'), 'community');
    }
    return { body: listPosts(c.user, { where: clauses.join(' AND ') || '1 = 1', params, ...paging(c.query) }) };
  });

  route('POST', '/api/posts', async (c) => {
    const me = requireAuth(c);
    writeLimit(c);
    const b = await c.json();
    const hasMedia = b.mediaId !== undefined && b.mediaId !== null;
    const hasPoll = b.poll !== undefined && b.poll !== null;
    const body = str(b.body ?? '', 'body', { min: hasMedia && !hasPoll ? 0 : 1, max: POST_MAX });

    let mediaId = null;
    if (hasMedia) {
      mediaId = intParam(b.mediaId, 'mediaId');
      const m = db.prepare('SELECT user_id FROM media WHERE id = :id').get({ id: mediaId });
      if (!m || m.user_id !== me.id) throw new HttpError(400, 'invalid_mediaId', 'That image was not uploaded by you.');
    }

    let communityId = null;
    if (b.communityId !== undefined && b.communityId !== null) {
      communityId = intParam(b.communityId, 'communityId');
      if (!db.prepare('SELECT 1 AS x FROM communities WHERE id = :id').get({ id: communityId })) {
        throw new HttpError(404, 'community_not_found', 'That community does not exist.');
      }
      if (!db.prepare('SELECT 1 AS x FROM community_members WHERE community_id = :c AND user_id = :u').get({ c: communityId, u: me.id })) {
        throw new HttpError(403, 'not_a_member', 'Join the community before posting in it.');
      }
    }

    const labels = hasPoll ? validatePoll(b.poll) : null;
    const id = tx(() => {
      const r = db
        .prepare('INSERT INTO posts (user_id, body, created_at, community_id, media_id) VALUES (:u, :b, :t, :c, :m)')
        .run({ u: me.id, b: body, t: Date.now(), c: communityId, m: mediaId });
      const postId = Number(r.lastInsertRowid);
      for (const tag of extractTags(body)) db.prepare('INSERT INTO post_tags (post_id, tag) VALUES (:p, :t)').run({ p: postId, t: tag });
      if (labels) labels.forEach((label, idx) => db.prepare('INSERT INTO post_poll_options (post_id, idx, label) VALUES (:p, :i, :l)').run({ p: postId, i: idx, l: label }));
      return postId;
    });
    return { status: 201, body: getPost(c.user, id) };
  }, { auth: true });

  route('GET', '/api/posts/:id', (c) => ({ body: requirePost(c.user, intParam(c.params.id, 'id')) }));

  route('DELETE', '/api/posts/:id', (c) => {
    const me = requireAuth(c);
    const id = intParam(c.params.id, 'id');
    const row = db.prepare('SELECT user_id FROM posts WHERE id = :id').get({ id });
    if (!row) throw new HttpError(404, 'post_not_found', 'That post does not exist.');
    if (row.user_id !== me.id) throw new HttpError(403, 'forbidden', 'You can only delete your own posts.');
    db.prepare('DELETE FROM posts WHERE id = :id').run({ id });
    return { status: 204 };
  }, { auth: true });

  route('POST', '/api/posts/:id/like', (c) => {
    const me = requireAuth(c);
    const id = intParam(c.params.id, 'id');
    requirePost(c.user, id);
    db.prepare('INSERT OR IGNORE INTO likes (user_id, post_id, created_at) VALUES (:u, :p, :t)').run({ u: me.id, p: id, t: Date.now() });
    return { body: getPost(c.user, id) };
  }, { auth: true });

  route('DELETE', '/api/posts/:id/like', (c) => {
    const me = requireAuth(c);
    const id = intParam(c.params.id, 'id');
    requirePost(c.user, id);
    db.prepare('DELETE FROM likes WHERE user_id = :u AND post_id = :p').run({ u: me.id, p: id });
    return { body: getPost(c.user, id) };
  }, { auth: true });

  // Reposting a repost resolves to the original, so every repost points at an original post.
  const repostTarget = (id) => {
    const row = db.prepare('SELECT id, rp_of AS rpOf FROM posts WHERE id = :id').get({ id });
    if (!row) throw new HttpError(404, 'post_not_found', 'That post does not exist.');
    return row.rpOf ?? row.id;
  };

  route('POST', '/api/posts/:id/repost', (c) => {
    const me = requireAuth(c);
    writeLimit(c);
    const target = repostTarget(intParam(c.params.id, 'id'));
    db.prepare("INSERT OR IGNORE INTO posts (user_id, body, created_at, rp_of) VALUES (:u, '', :t, :o)").run({ u: me.id, t: Date.now(), o: target });
    return { body: getPost(c.user, target) };
  }, { auth: true });

  route('DELETE', '/api/posts/:id/repost', (c) => {
    const me = requireAuth(c);
    const target = repostTarget(intParam(c.params.id, 'id'));
    db.prepare('DELETE FROM posts WHERE user_id = :u AND rp_of = :o').run({ u: me.id, o: target });
    return { body: getPost(c.user, target) };
  }, { auth: true });

  route('POST', '/api/posts/:id/vote', async (c) => {
    const me = requireAuth(c);
    writeLimit(c);
    const id = intParam(c.params.id, 'id');
    requirePost(c.user, id);
    const b = await c.json();
    const count = db.prepare('SELECT COUNT(*) AS n FROM post_poll_options WHERE post_id = :id').get({ id }).n;
    if (!count) throw new HttpError(400, 'not_a_poll', 'That post has no poll.');
    if (!Number.isInteger(b.option) || b.option < 0 || b.option >= count) {
      throw new HttpError(400, 'invalid_option', `option must be a whole number from 0 to ${count - 1}.`);
    }
    try {
      db.prepare('INSERT INTO poll_votes (post_id, user_id, option_idx, created_at) VALUES (:p, :u, :o, :t)').run({ p: id, u: me.id, o: b.option, t: Date.now() });
    } catch (err) {
      if (isUnique(err)) throw new HttpError(409, 'already_voted', 'You already voted in this poll.');
      throw err;
    }
    return { body: getPost(c.user, id) };
  }, { auth: true });

  route('POST', '/api/posts/:id/bookmark', (c) => {
    const me = requireAuth(c);
    const id = intParam(c.params.id, 'id');
    requirePost(c.user, id);
    db.prepare('INSERT OR IGNORE INTO bookmarks (user_id, post_id, created_at) VALUES (:u, :p, :t)').run({ u: me.id, p: id, t: Date.now() });
    return { body: getPost(c.user, id) };
  }, { auth: true });

  route('DELETE', '/api/posts/:id/bookmark', (c) => {
    const me = requireAuth(c);
    const id = intParam(c.params.id, 'id');
    requirePost(c.user, id);
    db.prepare('DELETE FROM bookmarks WHERE user_id = :u AND post_id = :p').run({ u: me.id, p: id });
    return { body: getPost(c.user, id) };
  }, { auth: true });

  // Bookmarks are private: only the owner can list them. Ordered by post id, newest first.
  route('GET', '/api/bookmarks', (c) => {
    requireAuth(c);
    return { body: listPosts(c.user, { where: 'p.id IN (SELECT post_id FROM bookmarks WHERE user_id = :me)', ...paging(c.query) }) };
  }, { auth: true });

  route('GET', '/api/posts/:id/comments', (c) => {
    const id = intParam(c.params.id, 'id');
    requirePost(c.user, id);
    const items = db
      .prepare(
        `SELECT c.id, c.body, c.created_at AS createdAt, u.username, u.display_name AS displayName
         FROM comments c JOIN users u ON u.id = c.user_id WHERE c.post_id = :p ORDER BY c.id LIMIT 200`,
      )
      .all({ p: id })
      .map((r) => ({ id: r.id, body: r.body, createdAt: r.createdAt, author: { username: r.username, displayName: r.displayName } }));
    return { body: { items } };
  });

  route('POST', '/api/posts/:id/comments', async (c) => {
    const me = requireAuth(c);
    writeLimit(c);
    const id = intParam(c.params.id, 'id');
    requirePost(c.user, id);
    const b = await c.json();
    const body = str(b.body, 'body', { min: 1, max: POST_MAX });
    const createdAt = Date.now();
    const r = db.prepare('INSERT INTO comments (post_id, user_id, body, created_at) VALUES (:p, :u, :b, :t)').run({ p: id, u: me.id, b: body, t: createdAt });
    return { status: 201, body: { id: Number(r.lastInsertRowid), body, createdAt, author: { username: me.username, displayName: me.displayName } } };
  }, { auth: true });

  route('DELETE', '/api/comments/:id', (c) => {
    const me = requireAuth(c);
    const id = intParam(c.params.id, 'id');
    const row = db
      .prepare('SELECT c.user_id AS author, p.user_id AS owner FROM comments c JOIN posts p ON p.id = c.post_id WHERE c.id = :id')
      .get({ id });
    if (!row) throw new HttpError(404, 'comment_not_found', 'That reply does not exist.');
    if (row.author !== me.id && row.owner !== me.id) throw new HttpError(403, 'forbidden', 'Only the author or the post owner can delete a reply.');
    db.prepare('DELETE FROM comments WHERE id = :id').run({ id });
    return { status: 204 };
  }, { auth: true });

  route('GET', '/api/tags/trending', () => {
    const since = Date.now() - 7 * 24 * 3600 * 1000;
    const items = db
      .prepare(
        `SELECT t.tag, COUNT(*) AS count FROM post_tags t JOIN posts p ON p.id = t.post_id
         WHERE p.created_at > :since GROUP BY t.tag ORDER BY count DESC, t.tag LIMIT 10`,
      )
      .all({ since });
    return { body: { items } };
  });
}
