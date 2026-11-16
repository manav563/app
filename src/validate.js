import { HttpError } from './http.js';

export const USERNAME = /^[a-z0-9_]{3,20}$/i;
export const POST_MAX = 280;

// Validates a string field by Unicode code point length and returns the (trimmed) value.
export function str(value, name, { min = 0, max, trim = true }) {
  if (typeof value !== 'string') throw new HttpError(400, `invalid_${name}`, `${name} must be a string.`);
  const s = trim ? value.trim() : value;
  const len = [...s].length;
  if (len < min || len > max) throw new HttpError(400, `invalid_${name}`, `${name} must be ${min} to ${max} characters.`);
  return s;
}

export function intParam(value, name) {
  if (!/^\d{1,15}$/.test(String(value))) throw new HttpError(400, `invalid_${name}`, `${name} must be a positive integer.`);
  return Number(value);
}

// Cursor pagination: ?limit=1..50 (default 20) and ?before=<id>.
export function paging(query) {
  const limit = query.has('limit') ? Math.min(50, Math.max(1, intParam(query.get('limit'), 'limit'))) : 20;
  const before = query.has('before') ? intParam(query.get('before'), 'before') : null;
  return { limit, before };
}
