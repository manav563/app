export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

// Escapes text for HTML. Apostrophes are deliberately left alone: attributes are always double-quoted,
// and encoding them as &#39; would make linkify() read "#39" as a hashtag.
export const esc = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

export const ICONS = {
  home: '<path d="M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 3-5.5 6.5-5.5s6.5 1.9 6.5 5.5"/><path d="M16 4.7a3.5 3.5 0 0 1 0 6.6M18 14.8c2.2.6 3.5 2.2 3.5 5.2"/>',
  bell: '<path d="M6 17V11a6 6 0 0 1 12 0v6l1.5 2h-15zM10 21h4"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  heart: '<path d="M12 20s-7-4.6-9-9.2C1.6 7.4 3.7 4 7 4c2 0 3.4 1 5 3 1.6-2 3-3 5-3 3.3 0 5.4 3.4 4 6.8-2 4.6-9 9.2-9 9.2z"/>',
  chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M21 16l-5-5-8 9"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  repost: '<path d="M17 3l4 4-4 4M3 11V9a2 2 0 0 1 2-2h16M7 21l-4-4 4-4M21 13v2a2 2 0 0 1-2 2H3"/>',
  bookmark: '<path d="M6 3h12v18l-6-4-6 4z"/>',
  poll: '<path d="M5 20V10M12 20V4M19 20v-7"/>',
  send: '<path d="M21 3L3 10.5l7 3 3 7z"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
};

export const svg = (name, fill = false) =>
  `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true" fill="${fill ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;

export function ago(ts) {
  const d = Date.now() - (ts || 0);
  const m = 60000;
  if (d < m) return 'now';
  if (d < 60 * m) return `${Math.floor(d / m)}m`;
  if (d < 24 * 60 * m) return `${Math.floor(d / (60 * m))}h`;
  if (d < 7 * 24 * 60 * m) return `${Math.floor(d / (24 * 60 * m))}d`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Escapes first, then turns #tags into buttons. Tag characters are restricted, so no markup can slip through.
export const linkify = (text) =>
  esc(text).replace(/#([\p{L}\p{N}_]{1,30})/gu, (_m, tag) => `<button class="tag" data-a="tag" data-id="${tag}">#${tag}</button>`);

const PALETTE = ['#2F6F62', '#7A4B86', '#A4572B', '#2B44E8', '#8A6D1F', '#B5432A', '#3B6E8F'];

// Generated initials avatar, stable per username. Rendered through <img>, so it cannot run script.
export function avatar(user) {
  const username = (user && user.username) || '?';
  const name = (user && (user.displayName || user.username)) || '?';
  let hash = 0;
  for (const ch of username) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const initial = esc([...String(name).trim()][0] || '?').toUpperCase();
  const svgText = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" fill="${PALETTE[hash % PALETTE.length]}"/><text x="20" y="27" font-size="18" font-family="sans-serif" font-weight="700" text-anchor="middle" fill="#fff">${initial}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svgText)}`;
}

// Only same-origin media URLs from this API are ever used as image sources.
export const safeMedia = (url) => (typeof url === 'string' && /^\/api\/media\/\d{1,15}$/.test(url) ? url : null);

export async function shrinkImage(file, max = 1280) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  for (const quality of [0.85, 0.7, 0.55]) {
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (blob && blob.size <= 900_000) return blob;
  }
  throw new Error('That image is too large. Try a smaller one.');
}

export const blobToBase64 = (blob) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error('Could not read the image.'));
    reader.readAsDataURL(blob);
  });
