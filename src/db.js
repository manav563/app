import { DatabaseSync } from 'node:sqlite';

// Each entry runs once, in order. The applied count is kept in PRAGMA user_version,
// so add new migrations to the end of this list and never edit an old one.
const MIGRATIONS = [
  `
  CREATE TABLE users (
    id           INTEGER PRIMARY KEY,
    username     TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    pw_hash      TEXT NOT NULL,
    bio          TEXT NOT NULL DEFAULT '',
    created_at   INTEGER NOT NULL
  );

  CREATE TABLE posts (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body       TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_posts_user ON posts(user_id, id DESC);

  CREATE TABLE post_tags (
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    tag     TEXT NOT NULL,
    PRIMARY KEY (post_id, tag)
  );
  CREATE INDEX idx_post_tags_tag ON post_tags(tag, post_id DESC);

  CREATE TABLE likes (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, post_id)
  );
  CREATE INDEX idx_likes_post ON likes(post_id);

  CREATE TABLE comments (
    id         INTEGER PRIMARY KEY,
    post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body       TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_comments_post ON comments(post_id, id);

  CREATE TABLE follows (
    follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    followee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (follower_id, followee_id),
    CHECK (follower_id <> followee_id)
  );
  CREATE INDEX idx_follows_followee ON follows(followee_id);
  `,

  // Migration 2: social suite (media, reposts, polls, communities and chat, stories, bookmarks, DMs, notifications).
  `
  ALTER TABLE users ADD COLUMN notif_seen_at INTEGER NOT NULL DEFAULT 0;

  CREATE TABLE media (
    id           INTEGER PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content_type TEXT NOT NULL,
    data         BLOB NOT NULL,
    created_at   INTEGER NOT NULL
  );
  CREATE INDEX idx_media_user ON media(user_id);

  CREATE TABLE communities (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
    description TEXT NOT NULL DEFAULT '',
    owner_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE community_members (
    community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at   INTEGER NOT NULL,
    PRIMARY KEY (community_id, user_id)
  );
  CREATE INDEX idx_members_user ON community_members(user_id);

  CREATE TABLE community_messages (
    id           INTEGER PRIMARY KEY,
    community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body         TEXT NOT NULL,
    created_at   INTEGER NOT NULL
  );
  CREATE INDEX idx_cmsg_community ON community_messages(community_id, id);

  ALTER TABLE posts ADD COLUMN rp_of INTEGER REFERENCES posts(id) ON DELETE CASCADE;
  ALTER TABLE posts ADD COLUMN community_id INTEGER REFERENCES communities(id) ON DELETE SET NULL;
  ALTER TABLE posts ADD COLUMN media_id INTEGER REFERENCES media(id) ON DELETE SET NULL;
  CREATE INDEX idx_posts_rp ON posts(rp_of);
  CREATE INDEX idx_posts_community ON posts(community_id, id DESC);
  CREATE UNIQUE INDEX uq_posts_repost ON posts(user_id, rp_of) WHERE rp_of IS NOT NULL;

  CREATE TABLE post_poll_options (
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    idx     INTEGER NOT NULL,
    label   TEXT NOT NULL,
    PRIMARY KEY (post_id, idx)
  );

  CREATE TABLE poll_votes (
    post_id    INTEGER NOT NULL,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    option_idx INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (post_id, user_id),
    FOREIGN KEY (post_id, option_idx) REFERENCES post_poll_options(post_id, idx) ON DELETE CASCADE
  );

  CREATE TABLE bookmarks (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, post_id)
  );

  CREATE TABLE stories (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body       TEXT NOT NULL DEFAULT '',
    color      INTEGER NOT NULL DEFAULT 0,
    media_id   INTEGER REFERENCES media(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_stories_created ON stories(created_at);

  CREATE TABLE story_views (
    story_id INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
    user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (story_id, user_id)
  );

  CREATE TABLE dm_messages (
    id           INTEGER PRIMARY KEY,
    sender_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body         TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    read_at      INTEGER,
    CHECK (sender_id <> recipient_id)
  );
  CREATE INDEX idx_dm_pair ON dm_messages(sender_id, recipient_id, id);
  CREATE INDEX idx_dm_inbox ON dm_messages(recipient_id, read_at);
  `,
];

export function openDb(file = ':memory:') {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const { user_version: applied } = db.prepare('PRAGMA user_version').get();
  for (let i = applied; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[i]);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return db;
}
