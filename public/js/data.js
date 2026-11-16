import { api } from './api.js';
import { S } from './core.js';

// Communities the signed-in user has joined. Used by the composer's "Post to" menu.
export async function refreshCommunities() {
  const res = await api('GET', '/api/communities');
  S.communities = res.items.filter((c) => c.joinedByMe);
}

// Trending tags and people to follow, shown in the right-hand column on wide screens.
export async function refreshAside() {
  const [trending, suggestions] = await Promise.all([api('GET', '/api/tags/trending'), api('GET', '/api/users/suggestions')]);
  S.aside = { trending: trending.items, suggestions: suggestions.items };
}

function setBadge(id, n) {
  const el = document.getElementById(id);
  if (!el) return;
  el.hidden = !n;
  el.textContent = n > 9 ? '9+' : String(n);
}

export function renderBadges() {
  const onAlerts = S.route.name === 'alerts';
  setBadge('nb-alerts', onAlerts ? 0 : S.counts.notifications);
  setBadge('nb-inbox', S.counts.messages);
  const total = (onAlerts ? 0 : S.counts.notifications) + S.counts.messages;
  document.title = total ? `(${total}) Plaza` : 'Plaza';
}

export async function refreshCounts() {
  try {
    S.counts = await api('GET', '/api/me/counts');
  } catch {
    return; // badges are cosmetic: a failed refresh keeps the last known numbers
  }
  renderBadges();
}
