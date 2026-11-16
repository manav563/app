import { api, qs } from '../api.js';
import { S, actions, forms, views, every, stopTimers, rerender, guard } from '../core.js';
import { empty, moreRow, postsStream, communityRow, threadHTML } from '../components.js';
import { esc, plural, svg } from '../util.js';

// ---- community list ----
views.rooms = {
  async load() {
    S.v.communities = (await api('GET', '/api/communities')).items;
    S.v.showNew = false;
  },

  html() {
    const form = S.v.showNew
      ? `<form class="newc" data-form="newcomm"><label class="sr" for="cname">Community name</label><input id="cname" class="field" maxlength="30" placeholder="Name, 3 to 30 characters" autocomplete="off" required>
          <label class="sr" for="cdesc">Description</label><input id="cdesc" class="field" maxlength="100" placeholder="What is it about?" autocomplete="off">
          <div class="row-actions"><button class="btn sm" type="submit">Create</button><button class="btn ghost sm" type="button" data-a="newcomm" data-id="0">Cancel</button></div></form>`
      : '<div class="newc"><button class="btn sm" data-a="newcomm" data-id="1">Start a community</button></div>';
    const rows = S.v.communities.map(communityRow).join('') || '<div class="empty"><b>No communities yet</b>Start one and invite people to post and chat.</div>';
    return `<div class="stream"><div class="sect first">Communities</div>${form}${rows}</div>`;
  },
};

// ---- one community: posts and members-only chat ----
const lastChatId = () => (S.v.chat.length ? S.v.chat[S.v.chat.length - 1].id : 0);
const chatItem = (m) => ({ id: m.id, body: m.body, createdAt: m.createdAt, mine: m.author.username === S.me.username, name: m.author.displayName });

async function loadChat() {
  S.v.chat = (await api('GET', `/api/communities/${S.v.community.id}/messages`)).items;
}

async function pollChat() {
  if (S.route.name !== 'community' || S.v.ctab !== 'chat' || !S.v.community.joinedByMe) return;
  const v = S.v;
  try {
    const res = await api('GET', `/api/communities/${v.community.id}/messages${qs({ after: lastChatId() })}`);
    if (v !== S.v) return; // the user moved to another community while this request was in flight
    if (res.items.length) {
      S.v.chat.push(...res.items);
      rerender();
    }
  } catch {
    // a failed poll is retried on the next tick; send and load errors are reported to the user
  }
}

function startPolling() {
  if (S.v.ctab === 'chat' && S.v.community.joinedByMe) every(pollChat, 3000);
}

async function loadPosts(before) {
  const page = await api('GET', `/api/posts${qs({ community: S.v.community.id, limit: 20, before })}`);
  S.v.posts = before ? S.v.posts.concat(page.items) : page.items;
  S.v.cursor = page.nextCursor;
}

views.community = {
  composer: () => !!(S.v.community && S.v.community.joinedByMe && S.v.ctab === 'posts'),

  async load(params) {
    S.v.community = await api('GET', `/api/communities/${params.id}`);
    S.v.ctab = S.v.ctab || 'posts';
    S.v.posts = [];
    S.v.chat = [];
    await loadPosts();
    if (S.v.ctab === 'chat' && S.v.community.joinedByMe) await loadChat();
    startPolling();
  },

  async more() {
    await loadPosts(S.v.cursor);
  },

  // Joining while the chat tab is open loads the chat and starts polling.
  async onMembership() {
    stopTimers();
    if (S.v.community.joinedByMe && S.v.ctab === 'chat') await loadChat();
    startPolling();
  },

  html() {
    const c = S.v.community;
    const head = `<div class="stream"><div class="chead"><h2>${esc(c.name)}</h2><div class="meta">${plural(c.memberCount, 'member')} · started by @${esc(c.owner)}</div>
      ${c.description ? `<p class="txt">${esc(c.description)}</p>` : ''}<div><button class="btn sm${c.joinedByMe ? ' ghost' : ''}" data-a="${c.joinedByMe ? 'leave' : 'join'}" data-id="${c.id}" aria-pressed="${c.joinedByMe}">${c.joinedByMe ? 'Joined' : 'Join'}</button></div></div></div>`;
    const tab = (id, label) => `<button class="tab" role="tab" data-a="ctab" data-id="${id}" aria-selected="${S.v.ctab === id}">${label}</button>`;
    const tabs = `<div class="tabs" role="tablist">${tab('posts', 'Posts')}${tab('chat', 'Chat')}</div>`;
    if (S.v.ctab === 'chat') {
      if (!c.joinedByMe) return `${head}${tabs}${empty('Chat is for members', 'Join this community to read and send messages.')}`;
      const form = `<form class="chatform" data-form="chat"><label class="sr" for="chatin">Message</label><input id="chatin" class="field" maxlength="280" placeholder="Message ${esc(c.name)}" autocomplete="off"><button class="btn sm" type="submit" aria-label="Send">${svg('send')}</button></form>`;
      return `${head}${tabs}<div class="stream">${threadHTML(S.v.chat.map(chatItem), 'Say hello.')}${form}</div>`;
    }
    const none = empty('No posts yet', c.joinedByMe ? 'Write the first post above.' : 'Join the community to post.');
    return `${head}${tabs}${S.v.posts.length ? postsStream(S.v.posts) : none}${moreRow()}`;
  },
};

// Timers are cleared on navigation; switching tabs inside the view clears and restarts them here.
actions.ctab = (id) =>
  guard(async () => {
    stopTimers();
    S.v.ctab = id;
    if (id === 'chat' && S.v.community.joinedByMe) await loadChat();
    rerender();
    startPolling();
  });

forms.chat = (form) => {
  const input = form.querySelector('input');
  const body = input.value.trim();
  if (!body) return undefined;
  return guard(async () => {
    const m = await api('POST', `/api/communities/${S.v.community.id}/messages`, { body });
    input.value = '';
    S.v.chat.push(m);
    rerender();
  });
};
