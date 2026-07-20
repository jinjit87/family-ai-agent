# family-ai-agent

Family AI assistant for calendar-aware briefings (Anthropic + Google Calendar).

## Current architecture

- **Runtime:** single Node.js Express server (`index.js`)
- **AI:** Anthropic Messages API
- **Calendar:** Google Calendar API (read-only)
- **Database:** PostgreSQL via Prisma (Phase 2 foundation)
- **Auth:** shared admin secret (`ADMIN_API_KEY`) for operational HTTP routes
- **Hosting:** Railway-compatible (`Procfile`, `PORT`)

```
HTTP
 ├── GET /health          public
 ├── GET /health/db       public → PostgreSQL connectivity
 ├── GET /auth            admin Bearer required → Google OAuth
 ├── GET /auth/callback   Google redirect (no tokens in response/logs)
 └── GET /morning         admin Bearer required → AI briefing (JSON)
```

## WhatsApp status (disabled)

Unofficial WhatsApp Web automation (**Baileys**) is **disabled** and must not run in production.

- `connectWhatsApp()` is never called
- `/qr` is removed
- Baileys dependencies are not in `package.json`
- The previous prototype is archived at `archive/baileys-prototype.js` for reference only — **do not import or execute it**

A later phase may add an official messaging provider. Optional env `MY_WHATSAPP` is reserved for that; it is unused today.

## Security warning

**Never commit secrets.** Do not put API keys, OAuth client secrets, refresh tokens, or `ADMIN_API_KEY` in git, screenshots, or chat logs. Use Railway variables or a local `.env` file (gitignored).

If a Google refresh token or admin key may have been exposed in older logs, rotate it.

## Local setup

### Requirements

- Node.js 18+
- Google Cloud OAuth client (Calendar API enabled)
- Anthropic API key

### Install

```bash
npm install
```

### Environment variables

Create a local `.env` file (never commit it), or export variables in your shell. The app reads `process.env` directly (no dotenv loader).

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | yes | Anthropic API key |
| `GOOGLE_CLIENT_ID` | yes | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | yes | Google OAuth client secret |
| `GOOGLE_REDIRECT_URI` | yes | Must match the authorized redirect URI in Google Cloud (e.g. `https://YOUR_HOST/auth/callback` or `http://localhost:3000/auth/callback`) |
| `ADMIN_API_KEY` | yes | Shared secret for operational endpoints |
| `GOOGLE_REFRESH_TOKEN` | no | Offline refresh token for Calendar access |
| `PORT` | no | Listen port (default `3000`) |
| `MY_WHATSAPP` | no | Reserved; unused while WhatsApp is disabled |
| `DATABASE_URL` | no* | PostgreSQL connection string (`postgresql://...`). Optional for app startup; required for migrations, seeds, and `/health/db` to report healthy |

### Run

```bash
export ANTHROPIC_API_KEY=...
export GOOGLE_CLIENT_ID=...
export GOOGLE_CLIENT_SECRET=...
export GOOGLE_REDIRECT_URI=http://localhost:3000/auth/callback
export ADMIN_API_KEY=...
# optional after first OAuth:
# export GOOGLE_REFRESH_TOKEN=...

npm start
```

Startup fails with a clear list of **missing variable names** if required env is incomplete. Values are never printed.

### Tests

```bash
npm test
```

## Database (Phase 2 foundation)

Prisma models: `Contact`, `Conversation`, `Message`, `Task`, `CalendarProposal`, `Approval`, `Rule`, `AuditLog`.

This phase adds the schema, migrations, seed data, and a DB health check only. Existing HTTP endpoints are unchanged. WhatsApp is not integrated yet.

### Local database

1. Install and start PostgreSQL locally.
2. Create a database (example):

```bash
createdb family_ai_agent
```

3. Set `DATABASE_URL` (never commit real credentials):

```bash
export DATABASE_URL="postgresql://USER:PASSWORD@localhost:5432/family_ai_agent?schema=public"
```

4. Install dependencies (also runs `prisma generate` via `postinstall`):

```bash
npm install
```

### Railway database

1. In the Railway project, add a **PostgreSQL** plugin/service.
2. Railway injects `DATABASE_URL` automatically for linked services. If the app and Postgres are separate services, reference the Postgres variable from the app service.
3. Confirm `DATABASE_URL` is present in the app service variables (alongside the existing Anthropic/Google/admin keys).
4. After deploy, run migrations against Railway (see below). Use Railway’s shell/one-off run, or a release command such as `npx prisma migrate deploy`.

### Running migrations

Development (creates/applies migrations interactively):

```bash
export DATABASE_URL="postgresql://USER:PASSWORD@localhost:5432/family_ai_agent?schema=public"
npm run db:migrate:dev
```

Production / Railway (applies committed migrations only):

```bash
export DATABASE_URL="postgresql://..."
npm run db:migrate
# equivalent: npx prisma migrate deploy
```

Regenerate the client after schema edits:

```bash
npm run db:generate
```

### Running seeds

Seed creates one `Contact`, one `Conversation`, and one `Task`:

```bash
export DATABASE_URL="postgresql://USER:PASSWORD@localhost:5432/family_ai_agent?schema=public"
npm run db:seed
```

Seeds are idempotent (fixed seed IDs via upsert). Safe to re-run locally.

### Database health check

```bash
curl https://YOUR_HOST/health/db
```

Returns `200` with `"database":"up"` when Prisma can reach PostgreSQL; `503` with `"database":"down"` otherwise. The existing `/health` endpoint is unchanged.

## Railway environment variables

Set the same variables in the Railway project:

- `ANTHROPIC_API_KEY`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI` — use your Railway public URL, e.g. `https://YOUR_SERVICE.up.railway.app/auth/callback`
- `ADMIN_API_KEY` — long random secret
- `GOOGLE_REFRESH_TOKEN` — after completing `/auth` once
- `PORT` — usually injected by Railway
- `DATABASE_URL` — from the Railway PostgreSQL plugin (required for DB features)

Also add the same redirect URI in Google Cloud Console → OAuth client → Authorized redirect URIs.

## Calling protected endpoints

Operational routes require:

```http
Authorization: Bearer <ADMIN_API_KEY>
```

Secrets are **not** accepted via URL query parameters.

### Health (public)

```bash
curl https://YOUR_HOST/health
curl https://YOUR_HOST/health/db
```

### Morning briefing (protected)

```bash
curl -H "Authorization: Bearer $ADMIN_API_KEY" https://YOUR_HOST/morning
```

### Start Google OAuth (protected)

```bash
curl -I -H "Authorization: Bearer $ADMIN_API_KEY" https://YOUR_HOST/auth
```

Follow the redirect in a browser session that can complete Google consent. After success, store any issued refresh token as `GOOGLE_REFRESH_TOKEN` in Railway. The callback page never displays token values.

## Google OAuth scopes

Only:

- `https://www.googleapis.com/auth/calendar.readonly`

Gmail scopes are not requested.

## Manual follow-ups after deploy

1. Set all required Railway env vars (including a new `ADMIN_API_KEY` and `GOOGLE_REDIRECT_URI`).
2. Complete `/auth` once and save `GOOGLE_REFRESH_TOKEN` if issued.
3. Rotate any Google refresh token that may appear in older Railway logs.
4. Delete any leftover `/app/auth_info` Baileys session files on the host and unlink the device in WhatsApp if it was previously paired.
5. Confirm `/qr` returns 404 and `/morning` returns 401 without a Bearer token.
6. Run `npx prisma migrate deploy` (or `npm run db:migrate`) so Postgres matches the schema, then optionally `npm run db:seed`.
7. Confirm `/health/db` returns `"database":"up"`.
