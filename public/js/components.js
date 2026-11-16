import { S } from './core.js';
import { esc, svg, ago, plural, linkify, avatar, safeMedia } from './util.js';

export const av = (user, cls = '') => `<img class="av ${cls}" src="${esc(avatar(user))}" alt="">`;
export const handle = (user) => `@${esc(user.username)}`;

export const empty = (title, text = '') => `<div class="stream"><div class="empty"><b>${esc(title)}</b>${esc(text)}</div></div>`;
export const moreRow = () => (S.v.cursor ? '<div class="moreRow"><button class="btn ghost sm" data-a="more">Load more</button></div>' : '');

const isMe = (user) => !!S.me && user.username === S.me.username;

function pollHTML(p) {
  if (!p.poll) return '';
  const { options, total, myVote } = p.poll;
  const voted = myVote !== null;
  const rows = options
    .map((o, i) => {
      if (!voted) return `<button class="opt" data-a="vote" data-id="${p.id}" data-x="${i}"><span>${esc(o.label)}</span></button>`;
      const pc = total ? Math.round((o.votes * 100) / total) : 0;
      return `<div class="opt${myVote === i ? ' mine' : ''}"><span class="fill" data-w="${pc}"></span><span>${esc(o.label)}${myVote === i ? ' (your vote)' : ''}</span><span class="pc">${pc}%</span></div>`;
    })
    .join('');
  return `<div class="poll" role="group" aria-label="Poll">${rows}<span class="meta">${plural(total, 'vote')}</span></div>`;
}

function commentsHTML(p) {
  const list = (S.v.comments && S.v.comments[p.id]) || null;
  if (!list) return '<div class="cmts"><span class="meta">Loading replies</span></div>';
  const items = list
    .map((c) => {
      const can = isMe(c.author) || isMe(p.author);
      const key = `c${c.id}`;
      return `<div class="cmt">${av(c.author, 'sm')}<div><button class="name sm" data-a="go" data-id="${esc(c.author.username)}">${esc(c.author.displayName)}</button> <span class="meta">${ago(c.createdAt)}</span><p class="txt">${esc(c.body)}</p></div>${
        can ? `<button class="act del${S.v.confirm === key ? ' arm' : ''}" data-a="delcmt" data-id="${c.id}" data-x="${p.id}" aria-label="Delete reply">${S.v.confirm === key ? 'Delete?' : svg('trash')}</button>` : '<span></span>'
      }</div>`;
    })
    .join('');
  return `<div class="cmts">${items || '<span class="meta">No replies yet.</span>'}<form class="cform" data-form="comment" data-id="${p.id}"><label class="sr" for="c-${p.id}">Reply</label><input id="c-${p.id}" class="cin" maxlength="280" placeholder="Write a reply" autocomplete="off"><button class="btn sm" type="submit">Reply</button></form></div>`;
}

function card(p) {
  const open = !!(S.v.open && S.v.open[p.id]);
  const mine = isMe(p.author);
  const key = `p${p.id}`;
  const media = safeMedia(p.mediaUrl);
  return `<article class="post">
    <button class="av-btn" data-a="go" data-id="${esc(p.author.username)}" aria-label="Open profile of ${esc(p.author.displayName)}">${av(p.author)}</button>
    <div class="pbody"><div class="phd"><button class="name" data-a="go" data-id="${esc(p.author.username)}">${esc(p.author.displayName)}</button>
      <span class="meta">${handle(p.author)} · ${ago(p.createdAt)}</span>${p.community ? `<button class="cchip" data-a="comm" data-id="${p.community.id}">${esc(p.community.name)}</button>` : ''}</div>
      ${p.body ? `<p class="txt">${linkify(p.body)}</p>` : ''}
      ${pollHTML(p)}
      ${media ? `<img class="pimg" src="${media}" alt="Photo posted by ${esc(p.author.displayName)}" loading="lazy">` : ''}
      <div class="acts">
        <button class="act" data-a="comments" data-id="${p.id}" aria-expanded="${open}" aria-label="Replies">${svg('chat')}<span>${p.commentCount || ''}</span></button>
        <button class="act rp${p.repostedByMe ? ' on' : ''}" data-a="repost" data-id="${p.id}" aria-pressed="${p.repostedByMe}" aria-label="Repost">${svg('repost')}<span>${p.repostCount || ''}</span></button>
        <button class="act like${p.likedByMe ? ' on' : ''}" data-a="like" data-id="${p.id}" aria-pressed="${p.likedByMe}" aria-label="Like">${svg('heart', p.likedByMe)}<span>${p.likeCount || ''}</span></button>
        <button class="act bm${p.bookmarkedByMe ? ' on' : ''}" data-a="bm" data-id="${p.id}" aria-pressed="${p.bookmarkedByMe}" aria-label="Save">${svg('bookmark', p.bookmarkedByMe)}</button>
        ${mine ? `<button class="act del${S.v.confirm === key ? ' arm' : ''}" data-a="delpost" data-id="${p.id}" aria-label="Delete post">${S.v.confirm === key ? 'Delete?' : svg('trash')}</button>` : ''}
      </div>
      ${open ? commentsHTML(p) : ''}
    </div></article>`;
}

// A timeline item: an original post, or a repost wrapping the original it points to.
export function postHTML(p) {
  if (!p.repostOf) return card(p);
  const mine = isMe(p.author);
  const head = `<div class="rphd">${svg('repost')}<span><button class="name sm" data-a="go" data-id="${esc(p.author.username)}">${mine ? 'You' : esc(p.author.displayName)}</button> reposted · ${ago(p.createdAt)}</span>${
    mine ? `<button class="act right" data-a="unrepost" data-id="${p.repostOf.id}">Undo</button>` : ''
  }</div>`;
  return head + card(p.repostOf);
}

export const postsStream = (posts) => `<div class="stream">${posts.map(postHTML).join('')}</div>`;

export function personRow(u, { follow = false } = {}) {
  const meta = u.followerCount === undefined ? handle(u) : `${handle(u)} · ${plural(u.followerCount, 'follower')}`;
  return `<div class="prow"><button class="av-btn" data-a="go" data-id="${esc(u.username)}" aria-label="Open profile of ${esc(u.displayName)}">${av(u)}</button>
    <div class="who"><button class="name" data-a="go" data-id="${esc(u.username)}">${esc(u.displayName)}</button><span class="meta">${meta}</span></div>
    ${follow ? `<button class="btn sm" data-a="follow" data-id="${esc(u.username)}">Follow</button>` : '<span></span>'}</div>`;
}

export function communityRow(c) {
  const on = c.joinedByMe;
  return `<div class="crow2"><div class="who"><button class="name" data-a="comm" data-id="${c.id}">${esc(c.name)}</button><span class="meta">${plural(c.memberCount, 'member')}${c.description ? ` · ${esc(c.description)}` : ''}</span></div>
    <button class="btn sm${on ? ' ghost' : ''}" data-a="${on ? 'leave' : 'join'}" data-id="${c.id}" aria-pressed="${on}">${on ? 'Joined' : 'Join'}</button></div>`;
}

export const tagChip = (t) => `<button class="chipbtn" data-a="tag" data-id="${esc(t.tag)}">#${esc(t.tag)} <span class="meta">${t.count}</span></button>`;

// A chat or direct-message thread. items: [{id, body, createdAt, mine, name}]
export function threadHTML(items, emptyText) {
  const rows = items
    .map((m) => `<div class="msg${m.mine ? ' me' : ''}"><span class="meta">${m.mine ? 'You' : esc(m.name)} · ${ago(m.createdAt)}</span><span class="bubble">${esc(m.body)}</span></div>`)
    .join('');
  return `<div class="chat" id="chatbox" role="log" aria-live="polite">${rows || `<div class="empty"><b>No messages yet</b>${esc(emptyText)}</div>`}</div>`;
}

export const backRow = (path, title) => `<div class="backrow"><button class="act" data-a="path" data-id="${esc(path)}" aria-label="Back">${svg('back')}</button><b>${esc(title)}</b></div>`;

// The page's CSP forbids inline style attributes, so poll bar widths are applied here through the CSSOM.
export function applyFills(root = document) {
  root.querySelectorAll('.fill[data-w]').forEach((el) => {
    el.style.width = `${Number(el.dataset.w) || 0}%`;
  });
}
