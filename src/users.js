import { HttpError } from './http.js';

// Read-side queries for users and profiles.
export function createUserQueries(db) {
  const count = (sql, id) => db.prepare(sql).get({ id }).n;

  function findUser(username) {
    const u = db
      .prepare('SELECT id, username, display_name AS displayName, bio, created_at AS createdAt FROM users WHERE username = :u')
      .get({ u: username });
    if (!u) throw new HttpError(404, 'user_not_found', 'That user does not exist.');
    return u;
  }

  function profile(viewer, u) {
    return {
      username: u.username,
      displayName: u.displayName,
      bio: u.bio,
      createdAt: u.createdAt,
      postCount: count('SELECT COUNT(*) AS n FROM posts WHERE user_id = :id AND rp_of IS NULL', u.id),
      followerCount: count('SELECT COUNT(*) AS n FROM follows WHERE followee_id = :id', u.id),
      followingCount: count('SELECT COUNT(*) AS n FROM follows WHERE follower_id = :id', u.id),
      followedByMe: viewer
        ? !!db.prepare('SELECT 1 AS x FROM follows WHERE follower_id = :me AND followee_id = :id').get({ me: viewer.id, id: u.id })
        : false,
    };
  }

  return { findUser, profile };
}
