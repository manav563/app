import { api } from './api.js';
import { S, actions, forms, guard, toast, rerender, fail } from './core.js';
import { $, esc, svg, ago, safeMedia, shrinkImage, blobToBase64 } from './util.js';
import { av } from './components.js';

const STORY_MS = 5000;
const COLOR_COUNT = 5;
let timer = null;
let viewer = null; // { username, i }
let creator = null; // { color, img: { blob, url } | null }

export async function loadStories() {
  S.v.stories = (await api('GET', '/api/stories')).items;
}

export function storiesHTML() {
  const groups = S.v.stories || [];
  const add = `<button class="story" role="listitem" data-a="addstory"><span class="ring add">${svg('plus')}</span><span>Your story</span></button>`;
  const rings = groups
    .map((g) => {
      const mine = g.author.username === S.me.username;
      const first = esc(g.author.displayName.split(' ')[0]);
      return `<button class="story" role="listitem" data-a="story" data-id="${esc(g.author.username)}" aria-label="View story by ${esc(g.author.displayName)}"><span class="ring${g.allSeen ? ' seen' : ''}">${av(g.author)}</span><span>${mine ? 'You' : first}</span></button>`;
    })
    .join('');
  return `<div class="stream"><div class="stories" role="list">${add}${rings}</div></div>`;
}

// ---- viewer ----
const currentGroup = () => (S.v.stories || []).find((g) => g.author.username === (viewer && viewer.username));

function closeViewer() {
  clearTimeout(timer);
  viewer = null;
  const el = $('#sv');
  el.hidden = true;
  el.innerHTML = '';
  rerender();
}

function showStory() {
  clearTimeout(timer);
  const g = currentGroup();
  if (!g || viewer.i >= g.stories.length) return closeViewer();
  if (viewer.i < 0) viewer.i = 0;
  const s = g.stories[viewer.i];
  if (!s.seen) {
    s.seen = true;
    g.allSeen = g.stories.every((x) => x.seen);
    api('POST', `/api/stories/${s.id}/view`).catch(() => {}); // a missed "seen" mark only leaves the ring highlighted
  }
  const mine = g.author.username === S.me.username;
  const media = safeMedia(s.mediaUrl);
  const bars = g.stories.map((_, i) => `<i class="${i < viewer.i ? 'done' : i === viewer.i ? 'on' : ''}"><b></b></i>`).join('');
  const el = $('#sv');
  el.innerHTML = `<div class="sv-in"><div class="bars">${bars}</div>
    <div class="svhd">${av(g.author)}<div><b>${mine ? 'You' : esc(g.author.displayName)}</b> <span class="meta">${ago(s.createdAt)}</span></div>
      <div class="x">${mine ? `<button data-a="sv-del" aria-label="Delete story">${svg('trash')}</button>` : ''}<button data-a="sv-close" aria-label="Close">${svg('x')}</button></div></div>
    <div class="svbody bg${s.color}${media ? ' hasimg' : ''}">${media ? `<img src="${media}" alt="Story photo by ${esc(g.author.displayName)}">` : ''}${s.body ? `<p>${esc(s.body)}</p>` : ''}
      <button class="hit l" data-a="sv-prev" aria-label="Previous story"></button><button class="hit r" data-a="sv-next" aria-label="Next story"></button></div></div>`;
  el.hidden = false;
  const close = el.querySelector('[data-a="sv-close"]');
  if (close) close.focus();
  timer = setTimeout(() => {
    viewer.i += 1;
    showStory();
  }, STORY_MS);
}

actions.story = (username) => {
  const g = (S.v.stories || []).find((x) => x.author.username === username);
  if (!g) return;
  const firstUnseen = g.stories.findIndex((s) => !s.seen);
  viewer = { username, i: firstUnseen < 0 ? 0 : firstUnseen };
  showStory();
};
actions['sv-close'] = closeViewer;
actions['sv-next'] = () => {
  viewer.i += 1;
  showStory();
};
actions['sv-prev'] = () => {
  viewer.i = Math.max(0, viewer.i - 1);
  showStory();
};
actions['sv-del'] = () =>
  guard(async () => {
    const g = currentGroup();
    const s = g && g.stories[viewer.i];
    if (!s) return;
    await api('DELETE', `/api/stories/${s.id}`);
    await loadStories();
    toast('Story deleted');
    showStory();
  });

// ---- creator ----
function renderCreator() {
  const el = $('#sc');
  if (!creator) {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }
  const typed = el.querySelector('#stext') ? el.querySelector('#stext').value : '';
  const swatches = Array.from({ length: COLOR_COUNT }, (_, i) => `<button type="button" class="sw c${i}" data-a="sc-col" data-id="${i}" aria-pressed="${creator.color === i}" aria-label="Color ${i + 1}"></button>`).join('');
  el.innerHTML = `<form class="sc" data-form="story"><div class="prev bg${creator.color}">${creator.img ? `<img src="${creator.img.url}" alt="Photo preview">` : ''}<p id="sprev"></p></div>
    <label class="sr" for="stext">Story text</label><input id="stext" class="field" maxlength="120" placeholder="Say something (optional)" autocomplete="off">
    <div class="swatches" role="group" aria-label="Background color">${swatches}</div>
    <div class="row-actions"><button type="button" class="btn ghost sm" data-a="sc-photo">${creator.img ? 'Change photo' : 'Add photo'}</button><span class="right"></span>
      <button type="button" class="btn ghost sm" data-a="sc-cancel">Cancel</button><button type="submit" class="btn sm">Share story</button></div>
    <p class="meta">Stories disappear after 24 hours.</p></form><input type="file" id="sfile" accept="image/*" hidden>`;
  const input = el.querySelector('#stext');
  input.value = typed;
  el.querySelector('#sprev').textContent = typed;
  el.hidden = false;
  input.focus();
}

function closeCreator() {
  if (creator && creator.img) URL.revokeObjectURL(creator.img.url);
  creator = null;
  renderCreator();
}

actions.addstory = () => {
  creator = { color: 0, img: null };
  renderCreator();
};
actions['sc-col'] = (i) => {
  creator.color = Number(i);
  renderCreator();
};
actions['sc-photo'] = () => $('#sfile').click();
actions['sc-cancel'] = closeCreator;

forms.story = () =>
  guard(async () => {
    const body = $('#stext').value.trim();
    if (!body && !creator.img) {
      toast('Add some text or a photo first.');
      return;
    }
    const payload = { body, color: creator.color };
    if (creator.img) payload.mediaId = (await api('POST', '/api/media', { data: await blobToBase64(creator.img.blob) })).id;
    await api('POST', '/api/stories', payload);
    closeCreator();
    await loadStories();
    toast('Story shared');
    rerender();
  });

document.addEventListener('input', (e) => {
  if (e.target.id === 'stext') $('#sprev').textContent = e.target.value;
});

document.addEventListener('change', async (e) => {
  if (e.target.id !== 'sfile' || !creator) return;
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const blob = await shrinkImage(file);
    if (creator.img) URL.revokeObjectURL(creator.img.url);
    creator.img = { blob, url: URL.createObjectURL(blob) };
    renderCreator();
  } catch (err) {
    fail(err);
  }
});

document.addEventListener('keydown', (e) => {
  if (viewer) {
    if (e.key === 'Escape') closeViewer();
    else if (e.key === 'ArrowRight') actions['sv-next']();
    else if (e.key === 'ArrowLeft') actions['sv-prev']();
  } else if (creator && e.key === 'Escape') closeCreator();
});
