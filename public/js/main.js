import { api, session } from './api.js';
import { S, actions, forms, views, setHooks, stopTimers, toast, fail } from './core.js';
import { $, $$, esc, svg } from './util.js';
import { empty, applyFills, personRow, tagChip } from './components.js';
import { refreshCommunities, refreshAside, refreshCounts, renderBadges } from './data.js';
import { initComposer, syncComposer } from './composer.js';
import './actions.js';
import './stories.js';
import './views/home.js';
import './views/explore.js';
import './views/communities.js';
import './views/alerts.js';
import './views/messages.js';
import './views/profile.js';
import './views/post.js';

const USERNAME = /^[A-Za-z0-9_]{3,20}$/;
let countsTimer = null;
let composerReady = false;
let navToken = 0;
let pending = Promise.resolve();

// ---- routing ----
// Routes are hash based (#/u/maya) so the static server needs no fallback rules.
function parseRoute(hash) {
  let parts;
  try {
    parts = hash.replace(/^#/, '').split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    return { name: 'home', params: {} };
  }
  const [a, b] = parts;
  const digits = /^\d{1,15}$/;
  switch (a) {
    case 'explore':
      return { name: 'explore', params: {} };
    case 'rooms':
      return { name: 'rooms', params: {} };
    case 'c':
      return digits.test(b || '') ? { name: 'community', params: { id: b } } : { name: 'rooms', params: {} };
    case 'alerts':
      return { name: 'alerts', params: {} };
    case 'inbox':
      return b && USERNAME.test(b) ? { name: 'thread', params: { username: b } } : { name: 'inbox', params: {} };
    case 'u':
      return b && /^[A-Za-z0-9_]{1,20}$/.test(b) ? { name: 'profile', params: { username: b } } : { name: 'home', params: {} };
    case 'p':
      return digits.test(b || '') ? { name: 'post', params: { id: b } } : { name: 'home', params: {} };
    default:
      return { name: 'home', params: {} };
  }
}

const navKey = () => {
  const { name, params } = S.route;
  if (name === 'post') return 'home';
  if (name === 'community') return 'rooms';
  if (name === 'thread') return 'inbox';
  if (name === 'profile') return params.username.toLowerCase() === S.me.username.toLowerCase() ? 'me' : '';
  return name;
};

function buildNav() {
  const item = (key, path, icon, label, badge) =>
    `<button class="nav-btn" data-key="${key}" data-a="nav" data-id="${path}">${svg(icon)}<span>${label}</span>${badge ? `<span id="${badge}" class="badge" hidden></span>` : ''}</button>`;
  $('.nav').innerHTML =
    item('home', '/home', 'home', 'Home') +
    item('explore', '/explore', 'search', 'Explore') +
    item('rooms', '/rooms', 'users', 'Rooms') +
    item('inbox', '/inbox', 'mail', 'Inbox', 'nb-inbox') +
    item('alerts', '/alerts', 'bell', 'Alerts', 'nb-alerts') +
    item('me', `/u/${S.me.username}`, 'user', 'Profile');
}

// ---- rendering ----
// Swaps the markup but keeps what the user is typing in any field that has an id.
function setHTML(el, html) {
  if (el.dataset.h === html) return;
  const values = {};
  el.querySelectorAll('input[id],textarea[id],select[id]').forEach((x) => {
    values[x.id] = x.value;
  });
  const active = document.activeElement;
  const focus = active && el.contains(active) && active.id ? { id: active.id, s: active.selectionStart, e: active.selectionEnd } : null;
  el.innerHTML = html;
  el.dataset.h = html;
  for (const [id, value] of Object.entries(values)) {
    const x = document.getElementById(id);
    if (x) x.value = value;
  }
  if (focus) {
    const x = document.getElementById(focus.id);
    if (x) {
      x.focus();
      try {
        x.setSelectionRange(focus.s, focus.e);
      } catch {
        /* not a text field */
      }
    }
  }
}

function errorHTML(err) {
  const msg = err && err.message ? err.message : 'Something went wrong.';
  return `<div class="stream"><div class="empty"><b>Could not load this page</b>${esc(msg)}<div class="moreRow"><button class="btn sm" data-a="retry">Try again</button></div></div></div>`;
}

function asideHTML() {
  const tags = S.aside.trending.length ? `<div class="stream"><div class="sect first">Trending tags</div><div class="chips">${S.aside.trending.slice(0, 5).map(tagChip).join('')}</div></div>` : '';
  const people = S.aside.suggestions.length ? `<div class="stream"><div class="sect first">People to follow</div>${S.aside.suggestions.slice(0, 4).map((u) => personRow(u, { follow: true })).join('')}</div>` : '';
  return tags + people;
}

function render() {
  const view = views[S.route.name];
  const html = S.v.loading ? empty('Loading') : S.v.error ? errorHTML(S.v.error) : view.html();
  const main = $('#main');
  const box = $('#chatbox');
  const stick = !box || box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  setHTML(main, html);
  applyFills(main);
  const nb = $('#chatbox');
  if (nb && stick) nb.scrollTop = nb.scrollHeight;
  const key = navKey();
  $$('.nav-btn').forEach((b) => (b.dataset.key === key ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current')));
  syncComposer();
  setHTML($('#aside'), asideHTML());
  renderBadges();
}

// ---- navigation and loading ----
async function runLoad(view, params) {
  pending = view.load(params);
  try {
    await pending;
    S.v.error = null;
  } catch (err) {
    S.v.error = err;
  }
  S.v.loading = false;
}

async function navigate() {
  const my = ++navToken;
  // Let any load already in flight finish writing to the previous view's state before that state is replaced.
  await pending.catch(() => {});
  if (my !== navToken) return;
  stopTimers();
  S.route = parseRoute(location.hash);
  S.v = { loading: true };
  render();
  window.scrollTo({ top: 0 });
  await runLoad(views[S.route.name], S.route.params);
  if (my === navToken) render();
}

// Re-runs the current view's load without resetting its state (tabs, forms, scroll).
async function reloadCurrent() {
  await pending.catch(() => {});
  await runLoad(views[S.route.name], S.route.params);
  render();
}

// ---- auth ----
let mode = 'login';
function setMode(next) {
  mode = next;
  const login = next === 'login';
  $('#auth-title').textContent = login ? 'Log in' : 'Create your account';
  $('#a-name-wrap').hidden = login;
  $('#a-submit').textContent = login ? 'Log in' : 'Sign up';
  $('#a-switch').textContent = login ? 'Create an account' : 'I already have an account';
  $('#a-pass').autocomplete = login ? 'current-password' : 'new-password';
  $('#a-err').textContent = '';
}

function showAuth(message = '') {
  $('#app').hidden = true;
  $('#auth').hidden = false;
  $('#a-err').textContent = message;
  $('#a-pass').value = '';
  $('#a-user').focus();
}

async function submitAuth(e) {
  e.preventDefault();
  const username = $('#a-user').value.trim();
  const password = $('#a-pass').value;
  const err = $('#a-err');
  if (!USERNAME.test(username)) {
    err.textContent = 'Usernames are 3 to 20 letters, numbers or underscores.';
    return;
  }
  if (mode === 'register' && password.length < 8) {
    err.textContent = 'Use a password with at least 8 characters.';
    return;
  }
  const body = { username, password };
  if (mode === 'register' && $('#a-name').value.trim()) body.displayName = $('#a-name').value.trim();
  $('#a-submit').disabled = true;
  try {
    const res = await api('POST', `/api/auth/${mode === 'login' ? 'login' : 'register'}`, body);
    session.set(res.token);
    S.me = { username: res.user.username, displayName: res.user.displayName };
    await enterApp();
  } catch (error) {
    err.textContent = error.message;
  } finally {
    $('#a-submit').disabled = false;
  }
}

async function enterApp() {
  $('#auth').hidden = true;
  $('#app').hidden = false;
  buildNav();
  if (!composerReady) {
    initComposer();
    composerReady = true;
  }
  // These only fill menus and badges; the page works without them, so a failure is not fatal.
  await Promise.allSettled([refreshCommunities(), refreshAside(), refreshCounts()]);
  clearInterval(countsTimer);
  countsTimer = setInterval(() => {
    if (!document.hidden) refreshCounts();
  }, 20000);
  if (!location.hash) location.hash = '/home';
  await navigate();
}

function leaveApp(message) {
  clearInterval(countsTimer);
  stopTimers();
  navToken += 1;
  session.clear();
  // Nothing from this account may carry over to the next one that logs in on this page.
  S.me = null;
  S.v = {};
  S.counts = { notifications: 0, messages: 0 };
  S.aside = { trending: [], suggestions: [] };
  S.communities = [];
  S.exploreQ = '';
  S.homeTab = 'all';
  $('#main').dataset.h = '';
  $('#aside').dataset.h = '';
  location.hash = '';
  showAuth(message);
}

// ---- theme ----
const THEMES = ['system', 'light', 'dark'];
let theme = 'system';
try {
  theme = localStorage.getItem('plaza.theme') || 'system';
} catch {
  /* storage blocked: the theme follows the system */
}
if (!THEMES.includes(theme)) theme = 'system';
function applyTheme() {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
  $('#theme').textContent = `Theme: ${theme[0].toUpperCase()}${theme.slice(1)}`;
}

// ---- wiring ----
setHooks({ render, reload: reloadCurrent });

document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-a]');
  const handler = t && actions[t.dataset.a];
  if (handler) handler(t.dataset.id, t, t.dataset.x);
});

document.addEventListener('submit', (e) => {
  const form = e.target.closest('form[data-form]');
  if (!form) return;
  e.preventDefault();
  const handler = forms[form.dataset.form];
  if (handler) handler(form);
});

window.addEventListener('hashchange', () => {
  if (S.me) navigate();
});
window.addEventListener('plaza:expired', () => leaveApp('Your session ended. Log in again.'));
window.addEventListener('plaza:logout', () => leaveApp(''));
window.addEventListener('unhandledrejection', (e) => {
  fail(e.reason);
  e.preventDefault();
});

$('#authform').addEventListener('submit', submitAuth);
$('#a-switch').addEventListener('click', () => setMode(mode === 'login' ? 'register' : 'login'));
$('#theme').addEventListener('click', () => {
  theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
  try {
    localStorage.setItem('plaza.theme', theme);
  } catch {
    /* the choice lasts until the page closes */
  }
  applyTheme();
});

async function boot() {
  applyTheme();
  if (!session.get()) return showAuth();
  try {
    const me = await api('GET', '/api/me');
    S.me = { username: me.username, displayName: me.displayName };
  } catch (err) {
    if (err.status === 401) session.clear();
    return showAuth(err.status === 401 ? '' : err.message);
  }
  return enterApp();
}

boot().catch((err) => {
  toast('Plaza could not start. Reload the page.');
  console.error(err);
});
