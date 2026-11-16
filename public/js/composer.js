import { api } from './api.js';
import { S, actions, views, guard, toast, rerender, fail } from './core.js';
import { $, esc, svg, shrinkImage, blobToBase64, avatar } from './util.js';

const MAX = 280;
let draft = null; // { blob, url }
let pollOn = false;
let busy = false;

function counter() {
  const left = MAX - $('#ctext').value.length;
  const el = $('#ccount');
  el.textContent = String(left);
  el.classList.toggle('warn', left < 20);
  $('#cpost').disabled = busy || left < 0 || (!$('#ctext').value.trim() && !draft);
}

function renderPreview() {
  $('#cprev').innerHTML = draft
    ? `<div class="prevwrap"><img class="pimg" src="${draft.url}" alt="Photo you are about to post"><button class="btn ghost sm" type="button" data-a="c-rmimg">Remove</button></div>`
    : '';
}

function clearDraft() {
  if (draft) URL.revokeObjectURL(draft.url);
  draft = null;
  renderPreview();
}

function syncPoll() {
  $('#cpollbox').hidden = !pollOn;
  $('#cpoll').setAttribute('aria-pressed', String(pollOn));
}

// Shows or hides the composer for the current view and refreshes the "Post to" menu.
export function syncComposer() {
  const view = views[S.route.name];
  const show = !!(S.me && !S.v.loading && !S.v.error && view && view.composer && view.composer());
  $('#composer').hidden = !show;
  if (!show) return;
  $('#cav').src = avatar(S.me);
  const wrap = $('#ctargetwrap');
  const joined = S.communities || [];
  wrap.hidden = !(S.route.name === 'home' && joined.length);
  const sel = $('#ctarget');
  const options = `<option value="">Everyone</option>${joined.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}`;
  if (sel.dataset.options !== options) {
    const keep = sel.value;
    sel.innerHTML = options;
    sel.dataset.options = options;
    sel.value = keep;
  }
  counter();
}

async function submit() {
  const body = $('#ctext').value.trim();
  let poll = null;
  if (pollOn) {
    const options = [0, 1, 2, 3].map((i) => $(`#po${i}`).value.trim()).filter(Boolean);
    if (!body || options.length < 2) {
      toast('A poll needs a question and at least two options.');
      return;
    }
    poll = { options };
  }
  if (!body && !draft) return;
  busy = true;
  counter();
  await guard(async () => {
    const payload = { body };
    if (draft) payload.mediaId = (await api('POST', '/api/media', { data: await blobToBase64(draft.blob) })).id;
    if (poll) payload.poll = poll;
    const communityId = S.route.name === 'community' ? S.v.community.id : Number($('#ctarget').value) || null;
    if (communityId) payload.communityId = communityId;
    const post = await api('POST', '/api/posts', payload);
    if (S.v.posts) S.v.posts.unshift(post);
    $('#ctext').value = '';
    [0, 1, 2, 3].forEach((i) => {
      $(`#po${i}`).value = '';
    });
    pollOn = false;
    syncPoll();
    clearDraft();
    toast('Posted');
    rerender();
  });
  busy = false;
  counter();
}

export function initComposer() {
  $('#cphoto').innerHTML = svg('image');
  $('#cpoll').innerHTML = svg('poll');
  $('#ctext').addEventListener('input', counter);
  $('#ctext').addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  });
  $('#cpost').addEventListener('click', submit);
  $('#cphoto').addEventListener('click', () => $('#cfile').click());
  $('#cpoll').addEventListener('click', () => {
    pollOn = !pollOn;
    syncPoll();
    if (pollOn) $('#po0').focus();
  });
  $('#cfile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const blob = await shrinkImage(file);
      clearDraft();
      draft = { blob, url: URL.createObjectURL(blob) };
      renderPreview();
      counter();
    } catch (err) {
      fail(err);
    }
  });
  actions['c-rmimg'] = () => {
    clearDraft();
    counter();
  };
}
