import { api } from './api.js';
import { S, actions, forms, views, go, guard, toast, rerender, reload, confirmKey } from './core.js';
import { refreshCommunities, refreshAside } from './data.js';

// ---- local post bookkeeping ----
const lists = () => [S.v.posts || []];

function findPost(id) {
  for (const list of lists()) {
    for (const p of list) {
      if (p.id === id) return p;
      if (p.repostOf && p.repostOf.id === id) return p.repostOf;
    }
  }
  return null;
}

// Replaces every copy of an updated post, whether it is a timeline item or the original inside a repost.
function patchPost(updated) {
  for (const list of lists()) {
    list.forEach((p, i) => {
      if (p.id === updated.id) list[i] = updated;
      else if (p.repostOf && p.repostOf.id === updated.id) list[i] = { ...p, repostOf: updated };
    });
  }
}

function dropPosts(originalId, byUsername) {
  const keep = (p) => !(p.id === originalId || (p.repostOf && p.repostOf.id === originalId && (!byUsername || p.author.username === byUsername)));
  S.v.posts = (S.v.posts || []).filter(keep);
}

// ---- navigation ----
actions.nav = (id) => go(id);
actions.path = (id) => go(id);
actions.go = (id) => go(`/u/${id}`);
actions.open = (id) => go(`/p/${id}`);
actions.comm = (id) => go(`/c/${id}`);
actions.tag = (id) => {
  S.exploreQ = `#${id}`;
  go('/explore');
};
actions.retry = () => reload();
actions.more = async () => {
  const view = views[S.route.name];
  if (view && view.more) await guard(() => view.more());
  rerender();
};
actions.logout = () => window.dispatchEvent(new Event('plaza:logout'));

// ---- posts ----
actions.like = (id) =>
  guard(async () => {
    const p = findPost(Number(id));
    patchPost(await api(p && p.likedByMe ? 'DELETE' : 'POST', `/api/posts/${id}/like`));
    rerender();
  });

actions.bm = (id) =>
  guard(async () => {
    const p = findPost(Number(id));
    patchPost(await api(p && p.bookmarkedByMe ? 'DELETE' : 'POST', `/api/posts/${id}/bookmark`));
    if (S.v.ptab === 'saved' && p && p.bookmarkedByMe) dropPosts(Number(id));
    rerender();
  });

actions.repost = (id) =>
  guard(async () => {
    const p = findPost(Number(id));
    patchPost(await api(p && p.repostedByMe ? 'DELETE' : 'POST', `/api/posts/${id}/repost`));
    toast(p && p.repostedByMe ? 'Repost removed' : 'Reposted');
    rerender();
  });

actions.unrepost = (id) =>
  guard(async () => {
    const updated = await api('DELETE', `/api/posts/${id}/repost`);
    dropPosts(Number(id), S.me.username);
    patchPost(updated);
    rerender();
  });

actions.vote = (id, el, option) =>
  guard(async () => {
    patchPost(await api('POST', `/api/posts/${id}/vote`, { option: Number(option) }));
    rerender();
  });

actions.delpost = (id) => {
  if (!confirmKey(`p${id}`)) return undefined;
  return guard(async () => {
    await api('DELETE', `/api/posts/${id}`);
    dropPosts(Number(id));
    toast('Post deleted');
    if (S.route.name === 'post') go('/home');
    else rerender();
  });
};

actions.comments = (id) =>
  guard(async () => {
    const v = S.v;
    v.open = v.open || {};
    v.comments = v.comments || {};
    v.open[id] = !v.open[id];
    rerender();
    if (v.open[id] && !v.comments[id]) {
      const items = (await api('GET', `/api/posts/${id}/comments`)).items;
      if (v !== S.v) return; // the user navigated away while the replies were loading
      v.comments[id] = items;
      rerender();
    }
  });

forms.comment = (form) => {
  const id = Number(form.dataset.id);
  const input = form.querySelector('input');
  const body = input.value.trim();
  if (!body) return undefined;
  return guard(async () => {
    const c = await api('POST', `/api/posts/${id}/comments`, { body });
    input.value = '';
    (S.v.comments[id] = S.v.comments[id] || []).push(c);
    const p = findPost(id);
    if (p) p.commentCount += 1;
    rerender();
  });
};

actions.delcmt = (id, el, postId) => {
  if (!confirmKey(`c${id}`)) return undefined;
  return guard(async () => {
    await api('DELETE', `/api/comments/${id}`);
    const pid = Number(postId);
    S.v.comments[pid] = (S.v.comments[pid] || []).filter((c) => c.id !== Number(id));
    const p = findPost(pid);
    if (p) p.commentCount = Math.max(0, p.commentCount - 1);
    rerender();
  });
};

// ---- people ----
actions.follow = (username) =>
  guard(async () => {
    const profile = S.v.profile && S.v.profile.username === username ? S.v.profile : null;
    const updated = await api(profile && profile.followedByMe ? 'DELETE' : 'POST', `/api/users/${username}/follow`);
    if (profile) S.v.profile = updated;
    S.aside.suggestions = S.aside.suggestions.filter((u) => u.username !== username);
    if (S.v.suggestions) S.v.suggestions = S.v.suggestions.filter((u) => u.username !== username);
    toast(updated.followedByMe ? `Following ${updated.displayName}` : `Unfollowed ${updated.displayName}`);
    rerender();
    refreshAside().then(rerender, () => {});
  });

// ---- communities ----
function replaceCommunity(c) {
  if (S.v.community && S.v.community.id === c.id) S.v.community = c;
  if (S.v.communities) S.v.communities = S.v.communities.map((x) => (x.id === c.id ? c : x));
  if (S.v.results && S.v.results.communities) S.v.results.communities = S.v.results.communities.map((x) => (x.id === c.id ? c : x));
}

async function setMembership(id, join) {
  const c = await api(join ? 'POST' : 'DELETE', `/api/communities/${id}/join`);
  replaceCommunity(c);
  await refreshCommunities();
  toast(join ? `Joined ${c.name}` : `Left ${c.name}`);
  const view = views[S.route.name];
  if (view && view.onMembership) await view.onMembership();
  rerender();
}
actions.join = (id) => guard(() => setMembership(id, true));
actions.leave = (id) => guard(() => setMembership(id, false));

forms.newcomm = (form) =>
  guard(async () => {
    const name = form.querySelector('#cname').value.trim();
    const description = form.querySelector('#cdesc').value.trim();
    const c = await api('POST', '/api/communities', { name, description });
    await refreshCommunities();
    toast('Community created');
    go(`/c/${c.id}`);
  });
actions.newcomm = (id) => {
  S.v.showNew = id === '1';
  rerender();
};

// ---- profile ----
forms.profile = (form) =>
  guard(async () => {
    const displayName = form.querySelector('#pname').value.trim();
    const bio = form.querySelector('#bio').value.trim();
    const updated = await api('PATCH', '/api/me', { displayName, bio });
    S.me.displayName = updated.displayName;
    S.v.profile = updated;
    toast('Profile saved');
    rerender();
  });

actions.ptab = (id) => {
  S.v.ptab = id;
  reload();
};

actions.tab = (id) => {
  S.homeTab = id;
  reload();
};

// Explore search is debounced so typing does not fire a request per key.
let searchTimer = null;
document.addEventListener('input', (e) => {
  if (e.target.id !== 'q' || S.route.name !== 'explore') return;
  S.exploreQ = e.target.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => views.explore.search(), 250);
});
