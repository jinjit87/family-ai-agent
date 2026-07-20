# Repository Audit — family-ai-agent

**Date:** 2026-07-20  
**Scope:** Read-only audit of the current tree and git history. No application code was edited, deleted, installed, or refactored.  
**Repo state audited:** `main` @ `3d27cfa` (branch created only to land this report)

---

## 1. Current architecture

### Inventory (entire tracked codebase)

| Path | Role |
|------|------|
| `index.js` | Single Express app: Baileys WhatsApp client, Anthropic AI, Google OAuth/Calendar, HTTP routes |
| `package.json` | Dependencies and `npm start` → `node index.js` |
| `Procfile` | Railway/Heroku-style process: `web: node index.js` |
| `README.md` | One-line project description |

There is **no** lockfile, `.gitignore`, tests, Dockerfile, `railway.toml`, `.env.example`, or multi-file module structure.

### Runtime shape

```
Incoming WhatsApp messages (Baileys / unofficial WhatsApp Web)
        │
        ▼
   index.js (Express + in-memory state)
        │
        ├── Anthropic Messages API  (draft / summarize / morning briefing)
        ├── Google Calendar API v3  (read next 7 days, query by kid name)
        └── WhatsApp outbox via Baileys (alerts + approved replies to Meytal / contacts)

HTTP (public Express):
  GET /qr              → Baileys pairing QR (HTML)
  GET /auth            → Google OAuth start
  GET /auth/callback   → OAuth code exchange (logs refresh token)
  GET /morning         → AI morning briefing → WhatsApp to Meytal
```

### Data / session storage

- **WhatsApp session:** `useMultiFileAuthState('/app/auth_info')` — multi-file creds on local disk (Railway container path). Not in git.
- **Pending approvals:** in-memory `Map` (`pendingApprovals`) — lost on restart.
- **Latest QR:** in-memory `latestQR`.

### Historical architecture (git)

Earlier commits used the **official Meta WhatsApp Cloud API** (`/webhook`, `WHATSAPP_TOKEN`, `PHONE_NUMBER_ID`, `META_APP_SECRET`) and **Groq** (`GROQ_API_KEY`) instead of Baileys + Anthropic. That path was fully replaced; none of the Meta webhook code remains in the current tree.

---

## 2. Baileys / unofficial WhatsApp Web — every related file & dependency

### Dependencies (`package.json`)

| Package | Purpose |
|---------|---------|
| `@whiskeysockets/baileys` `^6.7.0` | Unofficial WhatsApp Web multi-device client |
| `qrcode` `^1.5.3` | Render pairing QR as data-URL for `/qr` |
| `pino` `^8.0.0` | Logger passed to Baileys (`level: 'silent'`) |

### Code / config touchpoints

| Location | What it does |
|----------|----------------|
| `index.js` import of `makeWASocket`, `useMultiFileAuthState`, `DisconnectReason` | Baileys API |
| `index.js` `connectWhatsApp()` | Session load, socket, reconnect, message handlers |
| `index.js` `GET /qr` | Public HTML page with live pairing QR |
| `index.js` `MY_NUMBER` / `@s.whatsapp.net` / `@g.us` | WhatsApp JID addressing |
| `index.js` `sendToMeytal`, `createApproval`, `handleMeytalCommand`, `messages.upsert` | All messaging I/O via Baileys |
| `index.js` auth path `/app/auth_info` | Persistent Baileys creds directory (runtime) |
| `README.md` | Describes project as WhatsApp AI assistant |
| `package.json` `description` | "Family WhatsApp AI assistant" |

### Not present (but relevant)

- No committed `auth_info/` / session files in git (good).
- No `.gitignore` to exclude `auth_info/` if created locally (risk if someone runs locally and commits).

---

## 3. Reusable components

Worth keeping if Baileys is removed and messaging is re-homed:

| Component | Location | Notes |
|-----------|----------|-------|
| Family AI system prompt + strict approval rules | `askAI()` in `index.js` | Core product logic; extract to config/module |
| Approval workflow (`SEND` / `EDIT` / `SKIP` / `LIST`) | `createApproval`, `handleMeytalCommand` | Channel-agnostic if send/receive are abstracted |
| Calendar context builder | `getCalendarEvents()` | Reusable with any messaging channel |
| Morning briefing pipeline | `GET /morning` + `askAI` | Needs auth before production use |
| Google OAuth client setup | top of `index.js` | Reusable; redirect URI should be env-driven |
| Kid roster / constraints (Eli, ages) | system prompt | Product knowledge; consider config, not hardcode only |

Not reusable as-is for a compliant stack: Baileys socket lifecycle, `/qr`, JID string handling, `/app/auth_info`.

---

## 4. What currently works (by integration)

Status is **code-complete vs incomplete**, not live production verification (no env values inspected; secrets never printed).

### Anthropic — **implemented / likely works with key**

- Direct `fetch` to `https://api.anthropic.com/v1/messages`
- Model: `claude-sonnet-4-6`
- Header: `x-api-key: process.env.ANTHROPIC_API_KEY`
- Used for: DM drafting, group triage, morning briefing
- Gaps: no HTTP status / error handling; failures surface as vague text (`Could not process…` or empty content)

### Google Calendar — **partially implemented / works if OAuth refresh token present**

- Uses `googleapis` Calendar v3 `events.list` on `calendarId: 'primary'`
- Window: now → +7 days; `q` filter per kid name (`Avi`, `Rephael`, …)
- Wired into AI context for DMs, groups, `/morning`
- Gaps: silent `catch` returns `[]`; searches only **primary** by text query (not per-kid calendars); no write/create events despite earlier product intent in git history

### Gmail — **does not work (scope only)**

- OAuth scopes request `https://www.googleapis.com/auth/gmail.modify`
- **No** `google.gmail(...)` calls, no list/read/send/draft code
- Prompt historically mentioned Gmail; current prompt does not implement it

### Railway — **deployment scaffolding present; ops incomplete**

- `Procfile`: `web: node index.js`
- Listens on `process.env.PORT || 3000` (Railway-compatible)
- OAuth redirect hardcodes `https://web-production-a96f23.up.railway.app/auth/callback`
- Baileys auth path `/app/auth_info` assumes Linux container layout
- Gaps: no volume/docs for persisting `auth_info` across deploys; no Railway config in repo; restart wipes in-memory approvals

---

## 5. Incomplete or broken

| Area | Issue |
|------|--------|
| Gmail | Scope requested; zero implementation |
| Meta Cloud API | Removed; no official WhatsApp path remains |
| Groq | Removed; env `GROQ_API_KEY` unused |
| Calendar writes | Never implemented (study schedules → events was prompt-only historically) |
| Endpoint auth | `/qr`, `/auth`, `/auth/callback`, `/morning` are all unauthenticated |
| Approval persistence | Lost on process restart |
| Group replies | Groups only alert Meytal; no `createApproval` / SEND path for group replies |
| Error handling | Calendar and Anthropic errors largely swallowed or untyped |
| `EDIT` parsing | If `EDIT {id}` has no trailing text, `spaceIdx === -1` yields bad id/reply |
| `MY_PHONE_NUMBER` | Concatenated blindly; if unset becomes `undefined@s.whatsapp.net` |
| Lockfile / dotenv | No lockfile; `dotenv` removed from deps — local `.env` not auto-loaded |
| Tests / CI | None |
| Docs | README is one line; no setup or env docs |

---

## 6. Security concerns (ranked)

### Critical

1. **Public unauthenticated `/qr` pairing page**  
   Anyone who can hit the Railway URL can view a live WhatsApp linking QR and take over the account/session.

2. **Google refresh token logged to stdout**  
   `console.log('SAVE THIS REFRESH TOKEN:', tokens.refresh_token)` on `/auth/callback`. On Railway, logs are often retained/accessible → credential leak.

3. **Unauthenticated `/morning`**  
   Triggers Anthropic spend + WhatsApp message to the owner. Abusable for spam/cost.

### High

4. **Unauthenticated `/auth` OAuth start**  
   Anyone can start Google OAuth against the app’s client; combined with open callback and logged tokens, increases account-linking abuse risk.

5. **Overly broad Google OAuth scopes**  
   Requests full Calendar access **and** `gmail.modify` while only reading Calendar events. `gmail.modify` can change mailbox state if tokens leak.

6. **Baileys / unofficial WhatsApp Web**  
   Violates WhatsApp ToS; risk of account ban, session hijack via QR, and storing full WhatsApp session material on disk (`/app/auth_info`).

7. **Hardcoded production OAuth redirect URI**  
   Ties secrets flow to a specific Railway hostname; misconfig or hostname change breaks auth or points tokens at the wrong environment.

### Medium

8. **No authentication/authorization on any HTTP route**  
   Entire admin/surface area is internet-public if the service is deployed.

9. **No `.gitignore`**  
   Easy to accidentally commit `auth_info/`, `.env`, or local secrets.

10. **Family PII in source**  
    Kids’ names/ages, husband constraint, and personal workflow rules are committed in the system prompt.

11. **Historical hardcoded Meta verify token**  
    Git history contains `VERIFY_TOKEN = 'family-ai-verify-123'` (removed from current tree). Low current exploitability but shows weak secret hygiene pattern.

### Low

12. **QR length logged** (`QR CODE RECEIVED - length: …`) — minor info disclosure.  
13. **Empty calendar catch blocks** — hides auth failures; can mask broken Google setup.  
14. **No rate limiting** on AI/WhatsApp-triggering routes.

### Secrets committed to Git?

- **No actual API keys, OAuth client secrets, or refresh token values** found in the current tree or in scanned history diffs (only `process.env.*` references and the log *statement*).
- Hardcoded non-crypto verify string existed historically (`family-ai-verify-123`).
- Do **not** treat “not in git” as “not leaked” — refresh tokens may already be in Railway logs.

---

## 7. Baileys removal plan

### Goal

Eliminate unofficial WhatsApp Web automation while preserving the family-assistant approval workflow and Google/Anthropic integrations.

### Stepwise plan (do not execute in this audit)

1. **Freeze pairing surface**  
   Disable or protect `/qr` immediately (auth + network allowlist) before any refactor, to stop live hijack risk.

2. **Inventory session artifacts**  
   Locate Railway volume/filesystem `/app/auth_info`; plan secure deletion after cutover. Add `.gitignore` for `auth_info/`, `.env`, credentials.

3. **Choose replacement messaging channel** (product decision)  
   Prefer official Meta WhatsApp Cloud API (this repo already had a webhook + Graph send path in history), or another first-party channel (SMS, iMessage via other providers, Telegram Bot API, etc.). Do not replace Baileys with another unofficial WhatsApp library.

4. **Abstract I/O**  
   Extract `sendMessage(to, text)` and `onInboundMessage(handler)` interfaces. Keep `askAI`, `getCalendarEvents`, approval Map logic behind those interfaces.

5. **Remove Baileys stack**  
   - Delete Baileys imports, `connectWhatsApp`, `/qr`, JID helpers, `qrcode`/`pino` if unused  
   - Remove `@whiskeysockets/baileys`, `qrcode`, and unused `pino` from `package.json`  
   - Remove `/app/auth_info` usage and destroy session files on the host  
   - Update README/description so the product is not described as unofficial WhatsApp Web scraping

6. **Reintroduce official inbound/outbound** (if WhatsApp remains the channel)  
   Restore webhook verification (env-based verify token + Meta app secret HMAC), Graph send API, and env vars `WHATSAPP_TOKEN`, `PHONE_NUMBER_ID`, `META_APP_SECRET`, `VERIFY_TOKEN`.

7. **Verify**  
   End-to-end: inbound → AI draft → approval commands → outbound; morning briefing; no Baileys in `npm ls` / lockfile.

### Dependency removal checklist

- [ ] `@whiskeysockets/baileys`
- [ ] `qrcode` (if only used for Baileys QR page)
- [ ] `pino` (if only used as Baileys logger)
- [ ] Code: `connectWhatsApp`, `/qr`, `latestQR`, `useMultiFileAuthState`, `makeWASocket`
- [ ] Ops: delete `/app/auth_info` on Railway; revoke linked device in WhatsApp settings

---

## 8. Recommended next five implementation steps

1. **Lock down HTTP immediately** — require a shared secret (header/query) or disable `/qr` and `/morning` in production; stop logging Google refresh tokens; rotate Google refresh token if logs may have captured it.

2. **Add `.gitignore` + `.env.example`** — ignore `auth_info/`, `.env`, credentials; document every env var (names only).

3. **Remove Baileys and restore an official messaging path** (or explicitly pivot off WhatsApp) — see removal plan above.

4. **Narrow Google OAuth scopes** — drop `gmail.modify` until Gmail is implemented; prefer `calendar.readonly` if writes are not needed; make redirect URI an env var.

5. **Harden and finish core loops** — Anthropic error handling; persist approvals; authenticate `/auth`; implement Gmail only if still required; add a minimal health route and basic tests for approval parsing / calendar context formatting.

---

## 9. Environment variables referenced by code

**Current tree (`index.js`) — names only; values never printed:**

| Variable | Used for |
|----------|----------|
| `GOOGLE_CLIENT_ID` | Google OAuth2 client |
| `GOOGLE_CLIENT_SECRET` | Google OAuth2 client |
| `GOOGLE_REFRESH_TOKEN` | Offline Google API access |
| `MY_PHONE_NUMBER` | Owner WhatsApp number (suffixed with `@s.whatsapp.net`) |
| `MONITORED_GROUPS` | Optional comma-separated group JIDs to watch |
| `ANTHROPIC_API_KEY` | Anthropic Messages API |
| `PORT` | HTTP listen port (default `3000`) |

**Hardcoded (not env) but environment-related:**

| Item | Value pattern |
|------|----------------|
| OAuth redirect URI | Fixed Railway URL `https://web-production-a96f23.up.railway.app/auth/callback` |
| Baileys auth dir | `/app/auth_info` |

**Referenced in git history but not in current code:**

| Variable | Former use |
|----------|------------|
| `GROQ_API_KEY` | Groq chat completions |
| `WHATSAPP_TOKEN` | Meta Graph API bearer |
| `PHONE_NUMBER_ID` | Meta WhatsApp send endpoint |
| `META_APP_SECRET` | Webhook HMAC verification |
| (hardcoded) `VERIFY_TOKEN` | Meta webhook subscribe verify (`family-ai-verify-123`) |

**Railway-injected (typical, not referenced by name beyond `PORT`):** platform may also set `RAILWAY_*` vars; this app does not read them explicitly.

---

## 10. Audit constraints honored

- No application code edits, deletes, installs, or refactors  
- No secret values printed  
- Only deliverable from this pass: this `AUDIT.md` file
