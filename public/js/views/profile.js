import { api, qs } from '../api.js';
import { S, views } from '../core.js';
import { av, empty, handle, moreRow, postsStream } from '../components.js';
import { esc, plural } from '../util.js';

const isOwn = (profile) => profile.username.toLowerCase() === S.me.username.toLowerCase();

async function loadPosts(before) {
  const own = isOwn(S.v.profile);
  const path = own && S.v.ptab === 'saved' ? '/api/bookmarks' : `/api/users/${S.v.profile.username}/posts`;
  const page = await api('GET', path + qs({ limit: 20, before }));
  S.v.posts = before ? S.v.posts.concat(page.items) : page.items;
  S.v.cursor = page.nextCursor;
}

views.profile = {
  async load(params) {
    S.v.ptab = S.v.ptab || 'posts';
    S.v.profile = await api('GET', `/api/users/${params.username}`);
    await loadPosts();
  },

  async more() {
    await loadPosts(S.v.cursor);
  },

  html() {
    const p = S.v.profile;
    const own = isOwn(p);
    const stats = `<dl class="stats"><div><dt>Posts</dt><dd>${p.postCount}</dd></div><div><dt>Followers</dt><dd>${p.followerCount}</dd></div><div><dt>Following</dt><dd>${p.followingCount}</dd></div></dl>`;
    const about = own
      ? `<form class="editprofile" data-form="profile"><label class="sr" for="pname">Display name</label><input id="pname" maxlength="40" value="${esc(p.displayName)}" required>
          <label class="sr" for="bio">Bio</label><textarea id="bio" maxlength="160" rows="2" placeholder="Add a short bio">${esc(p.bio)}</textarea>
          <div class="row-actions"><button class="btn sm" type="submit">Save profile</button><button class="btn ghost sm" type="button" data-a="logout">Log out</button></div></form>`
      : `<p class="txt bio">${p.bio ? esc(p.bio) : '<span class="meta">No bio yet.</span>'}</p>`;
    const actionsRow = own
      ? ''
      : `<div class="pact row-actions"><button class="btn sm${p.followedByMe ? ' ghost' : ''}" data-a="follow" data-id="${esc(p.username)}" aria-pressed="${p.followedByMe}">${p.followedByMe ? 'Following' : 'Follow'}</button>
          <button class="btn ghost sm" data-a="path" data-id="/inbox/${esc(p.username)}">Message</button></div>`;
    const head = `<div class="stream"><div class="phead">${av(p, 'xl')}<div class="pinfo"><h2>${esc(p.displayName)}${own ? ' <span class="chip">You</span>' : ''}</h2><div class="meta">${handle(p)} · ${plural(p.postCount, 'post')}</div>${about}${stats}</div>${actionsRow}</div></div>`;
    const tab = (id, label) => `<button class="tab" role="tab" data-a="ptab" data-id="${id}" aria-selected="${S.v.ptab === id}">${label}</button>`;
    const tabs = own ? `<div class="tabs" role="tablist">${tab('posts', 'Posts')}${tab('saved', 'Saved')}</div>` : '';
    const saved = own && S.v.ptab === 'saved';
    const none = saved
      ? empty('Nothing saved yet', 'Tap the bookmark on any post to keep it here. Only you can see this list.')
      : empty('No posts yet', own ? 'Write your first post from Home.' : 'Nothing from this person so far.');
    return `${head}${tabs}${S.v.posts.length ? postsStream(S.v.posts) : none}${moreRow()}`;
  },
};
