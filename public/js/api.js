const TOKEN_KEY = 'plaza.token';

// The token lives in localStorage so a reload keeps you signed in. The page's strict CSP (no inline
// script, no third-party hosts) and the escaping in util.js are what protect it from script injection.
export const session = {
  get() {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set(token) {
    try {
      localStorage.setItem(TOKEN_KEY, token);
    } catch {
      /* storage blocked: the session lasts until the page closes */
    }
  },
  clear() {
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* nothing to clear */
    }
  },
};

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function api(method, path, body) {
  const headers = {};
  const token = session.get();
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, { method, headers, body: payload, signal: AbortSignal.timeout(15000) });
  } catch {
    throw new ApiError(0, 'network', 'Cannot reach the server. Check your connection.');
  }
  if (res.status === 204) {
    await res.text(); // an unread response is discarded as "aborted" by Chromium, even though the request succeeded
    return null;
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON error body */
  }
  if (!res.ok) {
    const err = data && data.error;
    if (res.status === 401 && token && err && err.code === 'invalid_token') window.dispatchEvent(new Event('plaza:expired'));
    throw new ApiError(res.status, (err && err.code) || 'error', (err && err.message) || 'Request failed.');
  }
  return data;
}

export function qs(params) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
}
