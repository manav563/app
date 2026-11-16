import { api, qs } from '../api.js';
import { S, views } from '../core.js';
import { empty, moreRow, postsStream } from '../components.js';
import { loadStories, storiesHTML } from '../stories.js';

const fetchPage = (before) => api('GET', (S.homeTab === 'following' ? '/api/feed' : '/api/posts') + qs({ limit: 20, before }));

views.home = {
  composer: () => true,

  async load() {
    const [page] = await Promise.all([fetchPage(), loadStories()]);
    S.v.posts = page.items;
    S.v.cursor = page.nextCursor;
  },

  async more() {
    const page = await fetchPage(S.v.cursor);
    S.v.posts.push(...page.items);
    S.v.cursor = page.nextCursor;
  },

  html() {
    const tab = (id, label) => `<button class="tab" role="tab" data-a="tab" data-id="${id}" aria-selected="${S.homeTab === id}">${label}</button>`;
    const none =
      S.homeTab === 'following'
        ? empty('Your following feed is empty', 'Follow people from Explore and their posts will appear here.')
        : empty('No posts yet', 'Write the first post above.');
    return `<div class="tabs" role="tablist" aria-label="Feed">${tab('all', 'For you')}${tab('following', 'Following')}</div>
      ${storiesHTML()}
      ${S.v.posts.length ? postsStream(S.v.posts) : none}${moreRow()}`;
  },
};
