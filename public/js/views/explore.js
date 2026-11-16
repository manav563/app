import { api, qs } from '../api.js';
import { S, views, guard, rerender } from '../core.js';
import { empty, personRow, communityRow, postsStream, tagChip } from '../components.js';
import { esc, safeMedia } from '../util.js';

// Runs the current search text against people, communities and posts. "#tag" searches posts by tag only.
async function runSearch() {
  const q = S.exploreQ.trim();
  if (!q) {
    S.v.results = null;
    return;
  }
  if (q.startsWith('#')) {
    const posts = await api('GET', `/api/posts${qs({ tag: q.slice(1), limit: 30 })}`);
    S.v.results = { people: [], communities: [], posts: posts.items };
    return;
  }
  const [people, communities, posts] = await Promise.all([
    api('GET', `/api/users${qs({ q })}`),
    api('GET', `/api/communities${qs({ q })}`),
    api('GET', `/api/posts${qs({ q, limit: 30 })}`),
  ]);
  S.v.results = { people: people.items, communities: communities.items, posts: posts.items };
}

views.explore = {
  async load() {
    S.v.posts = [];
    if (S.exploreQ.trim()) {
      await runSearch();
      S.v.posts = S.v.results.posts;
      return;
    }
    const [trending, suggestions, recent] = await Promise.all([
      api('GET', '/api/tags/trending'),
      api('GET', '/api/users/suggestions'),
      api('GET', '/api/posts?limit=50'),
    ]);
    S.v.trending = trending.items;
    S.v.suggestions = suggestions.items;
    S.v.photos = recent.items.filter((p) => safeMedia(p.mediaUrl) && !p.repostOf).slice(0, 9);
    S.v.results = null;
  },

  // Called from the debounced search box in actions.js.
  search() {
    return guard(async () => {
      await runSearch();
      S.v.posts = S.v.results ? S.v.results.posts : [];
      if (!S.v.results) await views.explore.load();
      rerender();
    });
  },

  html() {
    const box = `<div class="stream sbar"><label class="sr" for="q">Search</label><input id="q" class="field" type="search" placeholder="Search posts, people, communities or #tags" autocomplete="off" value="${esc(S.exploreQ)}"></div>`;
    const r = S.v.results;
    if (r) {
      let h = box;
      if (r.people.length) h += `<div class="stream"><div class="sect first">People</div>${r.people.map((u) => personRow(u)).join('')}</div>`;
      if (r.communities.length) h += `<div class="stream"><div class="sect first">Communities</div>${r.communities.map(communityRow).join('')}</div>`;
      if (r.posts.length) h += postsStream(r.posts);
      else if (!r.people.length && !r.communities.length) h += empty('No matches', 'Try a different word, a name, or a #tag.');
      return h;
    }
    const tags = S.v.trending.length ? `<div class="stream"><div class="sect first">Trending tags</div><div class="chips">${S.v.trending.map(tagChip).join('')}</div></div>` : '';
    const people = S.v.suggestions.length ? `<div class="stream"><div class="sect first">People to follow</div>${S.v.suggestions.map((u) => personRow(u, { follow: true })).join('')}</div>` : '';
    const photos = S.v.photos.length
      ? `<div class="stream"><div class="sect first">Photos</div><div class="photos">${S.v.photos.map((p) => `<button data-a="open" data-id="${p.id}" aria-label="Photo by ${esc(p.author.displayName)}"><img src="${safeMedia(p.mediaUrl)}" alt="" loading="lazy"></button>`).join('')}</div></div>`
      : '';
    return box + (tags + people + photos || empty('Nothing to explore yet', 'Tags, people and photos show up here once there are posts.'));
  },
};
