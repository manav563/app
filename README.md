# Plaza API

Plaza is a small social network that mixes ideas from several apps: Instagram-style photos and stories, X-style polls, reposts and trending tags, Reddit/Discord-style communities with live chat, plus bookmarks, private direct messages and notifications. This repository holds the REST API and the web client the same server hosts.

- Node 22.5 or newer, no npm dependencies (uses the built-in `node:sqlite`)
- SQLite database in WAL mode, versioned migrations
- Passwords hashed with scrypt, signed 7-day bearer tokens
- Permissions enforced on the server for every write
- Web client in `public/` (vanilla ES modules, no build step), served by the API at `/`

## Run it

```bash
cp .env.example .env        # set JWT_SECRET (openssl rand -hex 32)
export $(grep -v '^#' .env | xargs)
npm start
npm test                    # 33 API integration tests, in-memory database
npm run test:e2e            # 13 browser tests (needs Playwright, see below)
```

On Windows PowerShell, run these commands from the project folder:

```powershell
$env:JWT_SECRET = (node -p "require('node:crypto').randomBytes(32).toString('hex')")
npm start
```

Then open `http://localhost:3000` in your browser. Keep the PowerShell window open while using the app.

With Docker:

```bash
docker build -t plaza-api .
docker run -p 3000:3000 -v plaza-data:/data -e JWT_SECRET=$(openssl rand -hex 32) plaza-api
```

Settings (environment variables):

| Variable | Default | Purpose |
|---|---|---|
| `JWT_SECRET` | none | Required in production, 32+ characters. Without it a random one is used and sessions end on restart. |
| `DB_PATH` | `./plaza.db` | SQLite file. Keep it on a persistent volume. |
| `PORT` | `3000` | Listen port. |
| `ALLOWED_ORIGIN` | empty | Exact origin allowed to call the API from a browser. |
| `TRUST_PROXY` | `0` | Set to `1` behind your own reverse proxy so rate limits use the real client IP. |

## Endpoints

Everything is under `/api`. Writes need `Authorization: Bearer <token>`; reads of public data work signed out.

| Area | Endpoints |
|---|---|
| Auth | `POST /auth/register`, `POST /auth/login` |
| Me | `GET /me`, `PATCH /me`, `GET /me/counts` (unread alerts and messages) |
| People | `GET /users?q=`, `GET /users/suggestions`, `GET /users/:username`, `GET /users/:username/posts`, `POST/DELETE /users/:username/follow` |
| Posts | `GET/POST /posts` (filters `tag`, `q`, `community`; body text, optional `mediaId`, `poll`, `communityId`), `GET/DELETE /posts/:id`, `GET /feed` |
| Reactions | `POST/DELETE /posts/:id/like`, `/repost`, `/bookmark`; `POST /posts/:id/vote` (one vote per person) |
| Replies | `GET/POST /posts/:id/comments`, `DELETE /comments/:id` |
| Tags | `GET /tags/trending` |
| Media | `POST /media` (base64 JPEG, PNG, GIF or WebP, 1 MB), `GET /media/:id` |
| Stories | `GET/POST /stories`, `POST /stories/:id/view`, `DELETE /stories/:id` (expire after 24 hours) |
| Communities | `GET/POST /communities`, `GET /communities/:id`, `POST/DELETE /communities/:id/join`, `GET/POST /communities/:id/messages` (members only) |
| Messages | `GET /dm` (inbox), `GET/POST /dm/:username`, `POST /dm/:username/read` |
| Alerts | `GET /notifications`, `POST /notifications/read` |
| Saved | `GET /bookmarks` (private to you) |

Errors are `{error: {code, message}}` with a matching HTTP status.

## Web client

Hash-routed single page app: home, explore, rooms, a room, alerts, inbox and thread, profile, a single post. Chats and threads poll every 3 seconds and the badges every 20 seconds (no websockets). The page is served with a strict Content-Security-Policy, so there are no inline scripts or styles; post text is always inserted as text, never as markup.

Browser tests live in `e2e/`. Playwright is not a project dependency; install it separately (`npm i -D playwright && npx playwright install chromium`) or point `NODE_PATH` at an existing install. The suite starts its own server on a temporary database, drives two users in separate browser contexts, and fails on any console error, CSP violation or failed request.

Lists return `{items, nextCursor}`. Pass `?limit=` (1 to 50) and `?before=<nextCursor>` to page. `nextCursor` is `null` on the last page.

## Security notes

- Ownership checks live in the handlers: only the owner deletes a post or story, only the author or post owner deletes a reply, only members read or write community chat, and a direct message thread is visible only to its two participants.
- Login takes the same time and returns the same error for a wrong password and an unknown user.
- Rate limits per client: 300 requests/min overall, 10/min on register and login, 30/min on writes, 10/min on uploads. The counters live in memory, so run a single instance or move them to Redis.
- All SQL uses bound parameters. API responses carry `nosniff`, `no-store` and a locked-down CSP. Uploaded images are sniffed by magic bytes (not trusted from the client), served with `nosniff` and a sandbox CSP.
- JSON bodies are capped at 16 KB (uploads at about 1.4 MB of base64) with a 15 second request timeout.

## Known limits

- No password reset, email verification or token revocation. A token stays valid for 7 days.
- Images are stored as BLOBs in SQLite (1 MB each, 300 per user). Fine for a small deployment; move to object storage for more. Media of expired stories is not cleaned up yet.
- SQLite and the in-memory rate limiter suit a single instance. For several, move to Postgres and a shared limiter.
- Live updates are polling, not websockets. There is no ranked feed and no push notifications.
- Not deployed anywhere. No hosting has been chosen; pick one whose free tier supports a persistent disk for the SQLite file.
- The published Claude artifact of Plaza is a separate shared-database version without private messages or server-side permissions; this repository is the production-minded one.

## Layout

```
src/server.js          process start, env, graceful shutdown
src/app.js             router, security headers, error handling
src/routes/            one module per area (auth, users, posts, communities, stories, messages, notifications, media)
src/posts.js           post queries and shaping (reposts, polls, counts)
src/auth.js, db.js, http.js, validate.js, static.js
public/                web client (index.html, css/, js/ and js/views/)
test/                  API integration tests over real HTTP
e2e/                   browser tests (Playwright)
```

Migrations: append a new entry to `MIGRATIONS` in `src/db.js` and never edit an existing one. Version 1 is the original schema; version 2 adds media, polls, reposts, bookmarks, stories, communities and chat, direct messages and the notification read marker. Migration 2 was tested against a database created by version 1.
