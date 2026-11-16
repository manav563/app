import { hashPassword, verifyPassword } from '../auth.js';
import { HttpError } from '../http.js';
import { str, USERNAME } from '../validate.js';

export function register({ db, route, issueToken }) {
  let dummyHash;

  route('POST', '/api/auth/register', async (c) => {
    const b = await c.json();
    const username = str(b.username, 'username', { min: 3, max: 20 });
    if (!USERNAME.test(username)) throw new HttpError(400, 'invalid_username', 'Usernames use letters, numbers and underscores only.');
    const displayName = b.displayName === undefined ? username : str(b.displayName, 'displayName', { min: 1, max: 40 });
    const password = str(b.password, 'password', { min: 8, max: 128, trim: false });
    const hash = await hashPassword(password);
    try {
      const r = db
        .prepare('INSERT INTO users (username, display_name, pw_hash, created_at) VALUES (:u, :d, :h, :t)')
        .run({ u: username, d: displayName, h: hash, t: Date.now() });
      const id = Number(r.lastInsertRowid);
      return { status: 201, body: { token: issueToken(id), user: { id, username, displayName } } };
    } catch (err) {
      if (/UNIQUE/i.test(err.message)) throw new HttpError(409, 'username_taken', 'That username is taken.');
      throw err;
    }
  }, { bucket: 'auth' });

  route('POST', '/api/auth/login', async (c) => {
    const b = await c.json();
    const username = typeof b.username === 'string' ? b.username.trim() : '';
    const password = typeof b.password === 'string' ? b.password : '';
    const row = db.prepare('SELECT id, username, display_name AS displayName, pw_hash FROM users WHERE username = :u').get({ u: username });
    // Hash against a dummy when the user is missing so response time does not reveal which usernames exist.
    dummyHash ??= await hashPassword('not-a-real-password');
    const ok = await verifyPassword(password, row ? row.pw_hash : dummyHash);
    if (!row || !ok) throw new HttpError(401, 'invalid_credentials', 'Wrong username or password.');
    return { body: { token: issueToken(row.id), user: { id: row.id, username: row.username, displayName: row.displayName } } };
  }, { bucket: 'auth' });
}
