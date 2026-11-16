import { HttpError } from './http.js';

const TAG = /#([\p{L}\p{N}_]{1,30})/gu;

export const extractTags = (text) => [...new Set([...text.matchAll(TAG)].map((m) => m[1].toLowerCase()))];

const SELECT_POST = `
  SELECT p.id, p.body, p.created_at AS createdAt, p.rp_of AS rpOf, p.media_id AS mediaId,
    u.username, u.display_name AS displayName, c.id AS communityId, c.name AS communityName,
    (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS likeCount,
    (SELECT COUNT(*) FROM comments cm WHERE cm.post_id = p.id) AS commentCount,
    (SELECT COUNT(*) FROM posts r WHERE r.rp_of = p.id) AS repostCount,
    EXISTS (SELECT 1 FROM likes l WHERE l.post_id = p.id AND l.user_id = :me) AS likedByMe,
    EXISTS (SELECT 1 FROM posts r WHERE r.rp_of = p.id AND r.user_id = :me) AS repostedByMe,
    EXISTS (SELECT 1 FROM bookmarks b WHERE b.post_id = p.id AND b.user_id = :me) AS bookmarkedByMe,
    (SELECT pv.option_idx FROM poll_votes pv WHERE pv.post_id = p.id AND pv.user_id = :me) AS myVote
  FROM posts p
  JOIN users u ON u.id = p.user_id
  LEFT JOIN communities c ON c.id = p.community_id`;

// Builds ":i0, :i1, ..." placeholders and the matching parameter object for an IN list.
function inList(ids) {
  return { sql: ids.map((_, i) => `:i${i}`).join(', '), params: Object.fromEntries(ids.map((id, i) => [`i${i}`, id])) };
}

// Read-side queries for posts. Every list goes through here so counts and viewer flags stay consistent.
// A page of posts costs a fixed number of queries (rows, polls, reposted originals), not one per post.
export function createPostQueries(db) {
  function loadPolls(ids) {
    if (!ids.length) return new Map();
    const { sql, params } = inList(ids);
    const rows = db
      .prepare(
        `SELECT o.post_id AS postId, o.idx, o.label,
           (SELECT COUNT(*) FROM poll_votes v WHERE v.post_id = o.post_id AND v.option_idx = o.idx) AS votes
         FROM post_poll_options o WHERE o.post_id IN (${sql}) ORDER BY o.post_id, o.idx`,
      )
      .all(params);
    const polls = new Map();
    for (const r of rows) {
      if (!polls.has(r.postId)) polls.set(r.postId, []);
      polls.get(r.postId).push({ label: r.label, votes: r.votes });
    }
    return polls;
  }

  function shape(r, polls) {
    const options = polls.get(r.id);
    return {
      id: r.id,
      body: r.body,
      createdAt: r.createdAt,
      author: { username: r.username, displayName: r.displayName },
      likeCount: r.likeCount,
      commentCount: r.commentCount,
      repostCount: r.repostCount,
      likedByMe: !!r.likedByMe,
      repostedByMe: !!r.repostedByMe,
      bookmarkedByMe: !!r.bookmarkedByMe,
      tags: extractTags(r.body),
      community: r.communityId ? { id: r.communityId, name: r.communityName } : null,
      mediaUrl: r.mediaId ? `/api/media/${r.mediaId}` : null,
      poll: options
        ? { options, total: options.reduce((n, o) => n + o.votes, 0), myVote: r.myVote === null || r.myVote === undefined ? null : r.myVote }
        : null,
      repostOf: null,
    };
  }

  function hydrate(viewer, rows) {
    const me = viewer ? viewer.id : null;
    const originalIds = [...new Set(rows.filter((r) => r.rpOf).map((r) => r.rpOf))];
    const originals = new Map();
    let originalRows = [];
    if (originalIds.length) {
      const { sql, params } = inList(originalIds);
      originalRows = db.prepare(`${SELECT_POST} WHERE p.id IN (${sql})`).all({ ...params, me });
    }
    const polls = loadPolls([...new Set([...rows.map((r) => r.id), ...originalRows.map((r) => r.id)])]);
    for (const o of originalRows) originals.set(o.id, shape(o, polls));
    return rows.map((r) => {
      const item = shape(r, polls);
      if (r.rpOf) item.repostOf = originals.get(r.rpOf) || null;
      return item;
    });
  }

  function listPosts(viewer, { where = '1 = 1', params = {}, limit = 20, before = null }) {
    const p = { ...params, me: viewer ? viewer.id : null, lim: limit + 1 };
    if (before !== null) p.before = before;
    const rows = db
      .prepare(`${SELECT_POST} WHERE ${where} ${before !== null ? 'AND p.id < :before' : ''} ORDER BY p.id DESC LIMIT :lim`)
      .all(p);
    const more = rows.length > limit;
    const items = hydrate(viewer, rows.slice(0, limit));
    return { items, nextCursor: more ? items[items.length - 1].id : null };
  }

  const getPost = (viewer, id) => listPosts(viewer, { where: 'p.id = :pid', params: { pid: id }, limit: 1 }).items[0] || null;

  function requirePost(viewer, id) {
    const post = getPost(viewer, id);
    if (!post) throw new HttpError(404, 'post_not_found', 'That post does not exist.');
    return post;
  }

  return { listPosts, getPost, requirePost };
}
