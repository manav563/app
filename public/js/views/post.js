import { api } from '../api.js';
import { S, views } from '../core.js';
import { backRow, postsStream } from '../components.js';

views.post = {
  async load(params) {
    const found = await api('GET', `/api/posts/${params.id}`);
    // A repost id opens the original post, so replies and counts stay with one post.
    const post = found.repostOf || found;
    const comments = await api('GET', `/api/posts/${post.id}/comments`);
    S.v.posts = [post];
    S.v.open = { [post.id]: true };
    S.v.comments = { [post.id]: comments.items };
  },

  html() {
    return `<div class="stream">${backRow('/home', 'Post')}</div>${postsStream(S.v.posts)}`;
  },
};
