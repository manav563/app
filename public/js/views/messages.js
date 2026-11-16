import { api, qs } from '../api.js';
import { S, forms, views, every, guard, toast, go, rerender } from '../core.js';
import { av, backRow, threadHTML } from '../components.js';
import { esc, ago, svg } from '../util.js';
import { refreshCounts } from '../data.js';

const USERNAME = /^[A-Za-z0-9_]{3,20}$/;

// ---- inbox ----
views.inbox = {
  async load() {
    S.v.items = (await api('GET', '/api/dm')).items;
  },

  html() {
    const form = `<form class="newdm" data-form="newdm"><label class="sr" for="dmto">Username to message</label><input id="dmto" class="field" maxlength="20" placeholder="Message someone by username" autocomplete="off"><button class="btn sm" type="submit">Start</button></form>`;
    const rows = S.v.items
      .map(
        (c) => `<button class="dm-row" data-a="path" data-id="/inbox/${esc(c.peer.username)}">${av(c.peer)}<span class="who"><b>${esc(c.peer.displayName)}</b><span class="snip">${c.last.mine ? 'You: ' : ''}${esc(c.last.body)}</span></span>${
          c.unread ? `<span class="count" aria-label="${c.unread} unread">${c.unread}</span>` : `<span class="meta">${ago(c.last.createdAt)}</span>`
        }</button>`,
      )
      .join('');
    return `<div class="stream">${form}${rows || '<div class="empty"><b>No conversations yet</b>Only you and the person you message can read them.</div>'}</div>`;
  },
};

forms.newdm = (form) => {
  const name = form.querySelector('#dmto').value.trim().replace(/^@/, '');
  if (!USERNAME.test(name)) {
    toast('Enter a username: 3 to 20 letters, numbers or underscores.');
    return;
  }
  go(`/inbox/${name}`);
};

// ---- one conversation ----
const lastId = () => (S.v.items.length ? S.v.items[S.v.items.length - 1].id : 0);

const markRead = () =>
  api('POST', `/api/dm/${S.v.peer.username}/read`).then(refreshCounts, () => {}); // a failed mark leaves the badge until the next poll

async function pollThread() {
  if (S.route.name !== 'thread') return;
  const v = S.v;
  try {
    const res = await api('GET', `/api/dm/${v.peer.username}${qs({ after: lastId() })}`);
    if (v !== S.v) return; // the user opened another conversation while this request was in flight
    if (res.items.length) {
      S.v.items.push(...res.items);
      if (res.items.some((m) => !m.mine)) markRead();
      rerender();
    }
  } catch {
    // retried on the next tick
  }
}

views.thread = {
  async load(params) {
    const res = await api('GET', `/api/dm/${params.username}`);
    S.v.peer = res.peer;
    S.v.items = res.items;
    markRead();
    every(pollThread, 3000);
  },

  html() {
    const items = S.v.items.map((m) => ({ id: m.id, body: m.body, createdAt: m.createdAt, mine: m.mine, name: S.v.peer.displayName }));
    const form = `<form class="chatform" data-form="dm"><label class="sr" for="dmin">Message</label><input id="dmin" class="field" maxlength="1000" placeholder="Message ${esc(S.v.peer.displayName)}" autocomplete="off"><button class="btn sm" type="submit" aria-label="Send">${svg('send')}</button></form>`;
    return `<div class="stream">${backRow('/inbox', S.v.peer.displayName)}${threadHTML(items, 'Say hello.')}${form}</div>`;
  },
};

forms.dm = (form) => {
  const input = form.querySelector('input');
  const body = input.value.trim();
  if (!body) return undefined;
  return guard(async () => {
    const m = await api('POST', `/api/dm/${S.v.peer.username}`, { body });
    input.value = '';
    S.v.items.push(m);
    rerender();
  });
};
