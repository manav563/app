import { api } from '../api.js';
import { S, views } from '../core.js';
import { av, empty } from '../components.js';
import { esc, ago } from '../util.js';
import { renderBadges } from '../data.js';

const VERB = {
  like: 'liked your post',
  reply: 'replied to your post',
  repost: 'reposted your post',
  vote: 'voted in your poll',
  follow: 'followed you',
};

views.alerts = {
  async load() {
    S.v.items = (await api('GET', '/api/notifications')).items;
    // Opening this page counts as reading. A failure here only leaves the badge showing, so it is not fatal.
    api('POST', '/api/notifications/read').then(() => {
      S.counts.notifications = 0;
      renderBadges();
    }, () => {});
  },

  html() {
    if (!S.v.items.length) return empty('No alerts yet', 'When people like, reply to, repost or vote on your posts, or follow you, it appears here.');
    const rows = S.v.items
      .map((n) => {
        const target = n.postId ? `data-a="open" data-id="${n.postId}"` : `data-a="go" data-id="${esc(n.actor.username)}"`;
        return `<button class="alert${n.unread ? ' new' : ''}" ${target}>${av(n.actor)}<span><b>${esc(n.actor.displayName)}</b> ${VERB[n.kind] || 'interacted with you'}${
          n.snippet ? `<span class="snip">${esc(n.snippet)}</span>` : ''
        }</span><span class="meta">${ago(n.createdAt)}</span></button>`;
      })
      .join('');
    return `<div class="stream">${rows}</div>`;
  },
};
