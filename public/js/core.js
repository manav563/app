// Shared state and small helpers used by every view module.
export const S = {
  me: null, // { username, displayName }
  counts: { notifications: 0, messages: 0 },
  route: { name: 'home', params: {} },
  v: {}, // data for the current view, reset on every navigation
  aside: { trending: [], suggestions: [] },
  communities: [], // communities the user has joined
  exploreQ: '', // current Explore search text, kept across navigation
  homeTab: 'all', // 'all' or 'following'
};

// Click handlers keyed by data-a. Each is called as handler(id, element, extra).
export const actions = {};
// Submit handlers keyed by the form's data-form. Each is called as handler(form).
export const forms = {};
// View modules keyed by route name: { load(params), html(), mount?(), leave?() }.
export const views = {};

const hooks = { render() {}, reload() {} };
export const setHooks = (h) => Object.assign(hooks, h);
export const rerender = () => hooks.render();
export const reload = () => hooks.reload();

// Navigates to a hash route such as "/u/maya". Re-loads the view when the route is already open.
export function go(path) {
  if (location.hash === `#${path}`) reload();
  else location.hash = path;
}

export function toast(message) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    el.hidden = true;
  }, 3500);
}

export const fail = (err) => toast(err && err.message ? err.message : 'Something went wrong. Try again.');

// Runs fn and shows any API error as a toast instead of throwing.
export async function guard(fn) {
  try {
    return await fn();
  } catch (err) {
    fail(err);
    return undefined;
  }
}

const timers = new Set();
// Runs fn every ms while the tab is visible. Cleared automatically when the view changes.
export function every(fn, ms) {
  const id = setInterval(() => {
    if (!document.hidden) fn();
  }, ms);
  timers.add(id);
  return id;
}
export function stopTimers() {
  timers.forEach(clearInterval);
  timers.clear();
}

// Two-step destructive actions: the first click arms the button, the second within 4 seconds confirms.
export function confirmKey(key) {
  if (S.v.confirm === key) {
    S.v.confirm = null;
    return true;
  }
  S.v.confirm = key;
  clearTimeout(confirmKey.timer);
  confirmKey.timer = setTimeout(() => {
    S.v.confirm = null;
    rerender();
  }, 4000);
  rerender();
  return false;
}
