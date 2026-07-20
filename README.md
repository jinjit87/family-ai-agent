# family-ai-agent

Family AI assistant for calendar-aware briefings (Anthropic + Google Calendar).

## Current architecture

- **Runtime:** single Node.js Express server (`index.js`)
- **AI:** Anthropic Messages API
- **Calendar:** Google Calendar API (read-only)
- **Database:** PostgreSQL via Prisma (Phase 2 foundation)
- **Contacts API:** CRUD over Prisma `Contact` (Phase 3)
- **Tasks API:** task management over Prisma `Task` (Phase 4)
- **Payments API:** payments due engine over Prisma `Payment` (Phase 5)
- **Inbox API:** multi-account AI inbox pipeline over Prisma `InboxAccount` / `InboxItem` (Phase 6)
- **Gmail connector:** multi-account Google OAuth + encrypted tokens + manual sync (MVP)
- **Auth:** shared admin secret (`ADMIN_API_KEY`) for operational HTTP routes
- **Hosting:** Railway-compatible (`Procfile`, `PORT`)

```
HTTP
 ├── GET /health                 public
 ├── GET /health/db              public → PostgreSQL connectivity
 ├── GET /auth                   admin Bearer required → Google OAuth (Calendar)
 ├── GET /auth/callback          Google redirect (no tokens in response/logs)
 ├── GET /morning                admin Bearer required → AI briefing (JSON)
 ├── GET /contacts               admin Bearer required → list/search contacts
 ├── GET /contacts/:id           admin Bearer required → get contact
 ├── POST /contacts              admin Bearer required → create contact
 ├── PATCH /contacts/:id         admin Bearer required → update contact
 ├── DELETE /contacts/:id        admin Bearer required → soft-delete contact
 ├── GET /tasks                  admin Bearer required → list/search/filter tasks
 ├── GET /tasks/:id              admin Bearer required → get task
 ├── POST /tasks                 admin Bearer required → create task
 ├── PATCH /tasks/:id            admin Bearer required → update task
 ├── POST /tasks/:id/complete    admin Bearer required → complete task
 ├── POST /tasks/:id/reopen      admin Bearer required → reopen task
 ├── POST /tasks/:id/archive     admin Bearer required → archive task
 ├── GET /payments               admin Bearer required → list/search/filter payments
 ├── GET /payments/reports/weekly admin Bearer required → weekly due/overdue report
 ├── GET /payments/:id           admin Bearer required → get payment
 ├── POST /payments              admin Bearer required → create payment
 ├── PATCH /payments/:id         admin Bearer required → update payment
 ├── POST /payments/:id/approve  admin Bearer required → approve payment
 ├── POST /payments/:id/mark-paid admin Bearer required → mark payment paid
 ├── POST /payments/:id/reopen   admin Bearer required → reopen paid payment
 ├── POST /payments/:id/archive  admin Bearer required → archive payment
 ├── DELETE /payments/:id        admin Bearer required → soft-delete payment
 ├── GET /inbox/accounts         admin Bearer required → list inbox accounts
 ├── POST /inbox/accounts        admin Bearer required → create inbox account
 ├── GET /inbox/accounts/:id     admin Bearer required → get inbox account
 ├── PATCH /inbox/accounts/:id   admin Bearer required → update inbox account
 ├── POST /inbox/accounts/:id/activate admin Bearer required → activate account
 ├── POST /inbox/accounts/:id/deactivate admin Bearer required → deactivate account
 ├── GET /inbox                  admin Bearer required → list/search inbox items
 ├── POST /inbox                 admin Bearer required → ingest inbox item
 ├── GET /inbox/:id              admin Bearer required → get inbox item (+ rawContent)
 ├── PATCH /inbox/:id            admin Bearer required → update inbox item
 ├── POST /inbox/:id/analyze     admin Bearer required → mock AI analysis
 ├── POST /inbox/:id/archive     admin Bearer required → archive inbox item
 ├── POST /inbox/:id/*-suggestions/:suggestionId/{approve|reject|apply}
 ├── GET /gmail/connect          admin Bearer required → start Gmail OAuth (no Bearer in browser URL)
 ├── GET /gmail/callback         public Google redirect → save encrypted credentials
 ├── GET /gmail/accounts         admin Bearer required → list connected Gmail accounts
 ├── POST /gmail/accounts/:id/disconnect admin Bearer required → remove credentials, deactivate
 ├── POST /gmail/accounts/:id/sync admin Bearer required → manual sync one account
 └── POST /gmail/sync-all        admin Bearer required → manual sync all active Gmail accounts
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
- PostgreSQL (for Contacts/Tasks/Payments/Inbox APIs and `/health/db`)

### Install

```bash
npm install
```

### Environment variables

Create a local `.env` file (never commit it), or export variables in your shell. The app reads `process.env` directly (no dotenv loader).

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | yes | Anthropic API key |
| `GOOGLE_CLIENT_ID` | yes | Google OAuth client ID (shared web client for Calendar + Gmail) |
| `GOOGLE_CLIENT_SECRET` | yes | Google OAuth client secret |
| `GOOGLE_CALENDAR_REDIRECT_URI` | yes* | Calendar OAuth callback. Production: `https://web-production-2a12a.up.railway.app/auth/callback` |
| `GOOGLE_GMAIL_REDIRECT_URI` | when Gmail enabled | Gmail OAuth callback. Production: `https://web-production-2a12a.up.railway.app/gmail/callback` |
| `ADMIN_API_KEY` | yes | Shared secret for operational endpoints |
| `TOKEN_ENCRYPTION_KEY` | when Gmail enabled | Exactly 32 bytes as **64-character hex** (`openssl rand -hex 32`). Validated at startup when Gmail is enabled; never log or print |
| `GOOGLE_REFRESH_TOKEN` | no | Offline refresh token for Calendar access (separate from per-account Gmail tokens) |
| `PORT` | no | Listen port (default `3000`) |
| `MY_WHATSAPP` | no | Reserved; unused while WhatsApp is disabled |
| `DATABASE_URL` | no* | PostgreSQL URL. Optional for bare app startup; **required when Gmail is enabled**, and for migrations/seeds/Inbox APIs/`/health/db` |
| `GOOGLE_REDIRECT_URI` | deprecated | Temporary **Calendar-only** fallback if `GOOGLE_CALENDAR_REDIRECT_URI` is unset. Never used for Gmail. Remove after migrating all environments |

\* Calendar redirect: set `GOOGLE_CALENDAR_REDIRECT_URI` (preferred) or temporarily `GOOGLE_REDIRECT_URI`. Gmail is fail-closed: if either `TOKEN_ENCRYPTION_KEY` or `GOOGLE_GMAIL_REDIRECT_URI` is set, **all** of `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_GMAIL_REDIRECT_URI`, `TOKEN_ENCRYPTION_KEY`, and `DATABASE_URL` are required.

Add **both** callback URIs to the same Google OAuth web client when using Calendar and Gmail.


### Run

```bash
export ANTHROPIC_API_KEY=...
export GOOGLE_CLIENT_ID=...
export GOOGLE_CLIENT_SECRET=...
export GOOGLE_CALENDAR_REDIRECT_URI=http://localhost:3000/auth/callback
export GOOGLE_GMAIL_REDIRECT_URI=http://localhost:3000/gmail/callback
export ADMIN_API_KEY=...
export TOKEN_ENCRYPTION_KEY=$(openssl rand -hex 32)
export DATABASE_URL="postgresql://USER:PASSWORD@localhost:5432/family_ai_agent?schema=public"
# optional after first Calendar OAuth:
# export GOOGLE_REFRESH_TOKEN=...

npm start
```

Startup fails with a clear list of **missing or invalid variable names** only (values are never printed). When Gmail is enabled, `TOKEN_ENCRYPTION_KEY` must be exactly 32 decoded bytes (documented format: 64-char hex).

### Tests

```bash
export DATABASE_URL="postgresql://USER:PASSWORD@localhost:5432/family_ai_agent?schema=public"
npm test
```

Contacts, Tasks, Payments, Inbox, and Gmail tests:

```bash
npm run test:inbox
npm run test:gmail
npm run test:coverage
npm run test:coverage:tasks
npm run test:coverage:payments
npm run test:coverage:inbox
npm run test:coverage:gmail
```

## Database (Phase 2 foundation)

Prisma models: `Contact`, `Conversation`, `Message`, `Task`, `CalendarProposal`, `Approval`, `Rule`, `AuditLog`, `Payment`, `InboxAccount`, `InboxItem`, `InboxTaskSuggestion`, `InboxPaymentSuggestion`, `InboxReplySuggestion`, `GmailCredential`, `GmailOAuthState`.

Phase 2 added the schema, migrations, seed data, and `GET /health/db`. The Contacts HTTP API is Phase 3. The Tasks API is Phase 4. The Payments Due Engine is Phase 5. The Multi-Inbox AI Inbox is Phase 6 (below). WhatsApp is not integrated.

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

Seed creates one `Contact`, one `Conversation`, one `Task`, and one `Payment`:

```bash
export DATABASE_URL="postgresql://USER:PASSWORD@localhost:5432/family_ai_agent?schema=public"
npm run db:seed
```

Seeds are idempotent (fixed seed IDs via upsert). Safe to re-run locally.

### Database health check

```bash
curl https://YOUR_HOST/health/db
```

Returns `200` when Prisma can reach PostgreSQL, or `503` when it cannot. The public JSON body contains only:

- `status` — `"ok"` or `"error"`
- `database` — `"up"` or `"down"`
- `latencyMs`
- `timestamp`
- `service`

Internal connection errors are logged server-side with a generic message and are **never** returned to clients (no hostnames, credentials, or driver messages). The existing `/health` endpoint is unchanged.

## Contacts API (Phase 3)

Admin-authenticated CRUD for the Prisma `Contact` model. Soft delete only (`deletedAt`); contacts are never permanently removed via the API.

All routes require:

```http
Authorization: Bearer <ADMIN_API_KEY>
```

### Fields

| Field | Type | Notes |
|-------|------|-------|
| `id` | string (cuid) | read-only |
| `name` | string | required on create |
| `phone` | string \| null | optional |
| `email` | string \| null | optional; validated when present |
| `company` | string \| null | optional; searchable |
| `role` | enum | `SELF` \| `FAMILY` \| `SCHOOL` \| `TUTOR` \| `OTHER` (default `OTHER`) |
| `notes` | string \| null | optional |
| `createdAt` / `updatedAt` | ISO datetime | read-only |
| `deletedAt` | ISO datetime \| null | set on soft delete |

Invalid bodies/queries return `400` with `{ error: "Validation failed", details: [...] }` (Zod). Missing or soft-deleted contacts return `404`.

### List / search / pagination / sort

```bash
curl -H "Authorization: Bearer $ADMIN_API_KEY" \
  "https://YOUR_HOST/contacts?q=smadar&page=1&limit=20&sort=name"
```

Query params:

| Param | Default | Description |
|-------|---------|-------------|
| `q` | — | Case-insensitive search across **name**, **email**, **phone**, and **company** |
| `page` | `1` | 1-based page index |
| `limit` | `20` | Page size (max `100`) |
| `sort` | `name` | `name` (asc) or `updatedAt` (desc) |

Response shape:

```json
{
  "data": [ /* contact objects */ ],
  "pagination": { "page": 1, "limit": 20, "total": 3, "totalPages": 1 }
}
```

Soft-deleted contacts are excluded from list and get-by-id.

### Create

```bash
curl -X POST -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"Smadar","email":"smadar@example.com","company":"School","role":"SCHOOL"}' \
  https://YOUR_HOST/contacts
```

Returns `201` with the created contact.

### Get by id

```bash
curl -H "Authorization: Bearer $ADMIN_API_KEY" https://YOUR_HOST/contacts/:id
```

### Update (partial)

```bash
curl -X PATCH -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"company":"Updated Co"}' \
  https://YOUR_HOST/contacts/:id
```

### Soft delete

```bash
curl -X DELETE -H "Authorization: Bearer $ADMIN_API_KEY" \
  https://YOUR_HOST/contacts/:id
```

Sets `deletedAt` and returns the contact. The row remains in PostgreSQL. A second delete returns `404`.

## Tasks API (Phase 4)

Admin-authenticated task management for the Prisma `Task` model. Completing sets `completedAt`; reopening clears it. Archived tasks are excluded from list results unless `includeArchived=true`.

All routes require:

```http
Authorization: Bearer <ADMIN_API_KEY>
```

### Lifecycle invariants (`completedAt`)

| Transition | `completedAt` behavior |
|------------|------------------------|
| Status becomes `COMPLETED` (create, patch, or `POST .../complete`) | Set (or preserved if already completed) |
| Task is reopened (`POST .../reopen`, or patch to `OPEN` / `IN_PROGRESS` / `WAITING`) | Cleared to `null` |
| Task is archived (`POST .../archive`, or patch to `ARCHIVED`) | **Preserved** — historical completion time is kept intentionally |

Invalid bodies/queries return `400` with `{ error: "Validation failed", details: [...] }` (Zod). Invalid `contactId` / `conversationId` foreign keys return `400` with a safe message (no Prisma details). Missing tasks return `404`. Unauthenticated requests return `401`.

### Fields

| Field | Type | Notes |
|-------|------|-------|
| `id` | string (cuid) | read-only |
| `title` | string | required on create |
| `description` | string \| null | optional |
| `priority` | enum | `LOW` \| `MEDIUM` \| `HIGH` \| `URGENT` (default `MEDIUM`) |
| `status` | enum | `OPEN` \| `IN_PROGRESS` \| `WAITING` \| `COMPLETED` \| `ARCHIVED` (default `OPEN`) |
| `dueDate` | ISO datetime \| null | optional |
| `completedAt` | ISO datetime \| null | see lifecycle invariants above |
| `source` | enum | `MANUAL` \| `EMAIL` \| `WHATSAPP` \| `CALENDAR` \| `AI` (default `MANUAL`) |
| `contactId` | string \| null | optional FK to `Contact` |
| `conversationId` | string \| null | optional FK to `Conversation` |
| `createdAt` / `updatedAt` | ISO datetime | read-only |

### List / search / filter / sort / pagination

```bash
curl -H "Authorization: Bearer $ADMIN_API_KEY" \
  "https://YOUR_HOST/tasks?q=school&status=OPEN&priority=HIGH&source=EMAIL&contactId=...&page=1&limit=20&sort=dueDate&includeArchived=false"
```

Query params:

| Param | Default | Description |
|-------|---------|-------------|
| `q` | — | Case-insensitive search across **title** and **description** |
| `status` | — | Filter by status enum |
| `priority` | — | Filter by priority enum |
| `source` | — | Filter by source enum |
| `contactId` | — | Filter by related contact id |
| `includeArchived` | `false` | When `false`, `ARCHIVED` tasks never appear (even if `status=ARCHIVED`) |
| `page` | `1` | 1-based page index |
| `limit` | `20` | Page size (max `100`) |
| `sort` | `updatedAt` | `dueDate` (asc, nulls last), `priority` (desc: URGENT first), or `updatedAt` (desc) |

Response shape:

```json
{
  "data": [ /* task objects */ ],
  "pagination": { "page": 1, "limit": 20, "total": 3, "totalPages": 1 }
}
```

### Create

```bash
curl -X POST -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"title":"Buy school supplies","priority":"HIGH","source":"MANUAL","dueDate":"2026-08-01T12:00:00.000Z"}' \
  https://YOUR_HOST/tasks
```

Returns `201` with the created task. Creating with `status: "COMPLETED"` sets `completedAt`.

### Get by id

```bash
curl -H "Authorization: Bearer $ADMIN_API_KEY" https://YOUR_HOST/tasks/:id
```

### Update (partial)

```bash
curl -X PATCH -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"status":"IN_PROGRESS","priority":"URGENT"}' \
  https://YOUR_HOST/tasks/:id
```

Patching `status` to `COMPLETED` sets `completedAt`. Patching to `OPEN` / `IN_PROGRESS` / `WAITING` clears `completedAt`. Patching to `ARCHIVED` preserves any existing `completedAt`.

### Complete

```bash
curl -X POST -H "Authorization: Bearer $ADMIN_API_KEY" \
  https://YOUR_HOST/tasks/:id/complete
```

Sets `status` to `COMPLETED` and sets `completedAt` (preserves existing `completedAt` if already completed).

### Reopen

```bash
curl -X POST -H "Authorization: Bearer $ADMIN_API_KEY" \
  https://YOUR_HOST/tasks/:id/reopen
```

Sets `status` to `OPEN` and clears `completedAt`.

### Archive

```bash
curl -X POST -H "Authorization: Bearer $ADMIN_API_KEY" \
  https://YOUR_HOST/tasks/:id/archive
```

Sets `status` to `ARCHIVED` and **preserves** `completedAt` when the task was previously completed (historical completion time is intentional). Archived tasks are hidden from `GET /tasks` unless `includeArchived=true`.

## Payments Due Engine (Phase 5)

Admin-authenticated payment tracking for the Prisma `Payment` model. Amounts are stored and returned as **Decimal strings** (never floating point). Overdue status for reports is computed from `dueDate` at read time — no scheduled database job is required.

All routes require:

```http
Authorization: Bearer <ADMIN_API_KEY>
```

### Lifecycle rules

| Action | Behavior |
|--------|----------|
| Create | Defaults: `status=DRAFT`, `source=MANUAL`. Creating as `PAID` / `APPROVED` sets `paidAt` / `approvedAt`. |
| Approve (`POST .../approve`) | Sets `status=APPROVED` and `approvedAt` (preserves existing). Conflict (`409`) if already `PAID` / `CANCELLED` / `ARCHIVED`. |
| Mark paid (`POST .../mark-paid`) | Sets `status=PAID` and `paidAt`. **Requires** `paymentMethod` **or** `notes` explaining the payment. Conflict if already paid / cancelled / archived. |
| Reopen (`POST .../reopen`) | Clears `paidAt`, sets `status=APPROVED`. Only paid payments can be reopened. |
| Archive (`POST .../archive`) | Sets `status=ARCHIVED` and **preserves** `paidAt` when previously paid (historical payment time is intentional). Archived (and cancelled) payments are hidden from normal lists and weekly reports unless `includeArchived=true`. |
| Soft delete (`DELETE .../:id`) | Sets `deletedAt`. Soft-deleted payments never appear in list/get/report. Rows are never hard-deleted via the API. |

**Overdue (reports):** a payment is overdue when `dueDate < now`, it is not soft-deleted, and it is not `PAID` / `CANCELLED` / `ARCHIVED`. The stored `status` does not need to be `OVERDUE` for the payment to appear in the overdue section of the weekly report.

**Weekly window boundary (inclusive ends for due-soon):**
- `dueInNext7Days`: `now <= dueDate <= now + 7 days` and status is not `PAID`
- `overdue`: `dueDate < now` (strictly before `now`) and not paid/cancelled/archived
- Due exactly at report `now` → `dueInNext7Days` (not overdue)
- Due exactly at `now + 7 days` → `dueInNext7Days`
- Due after the window end → excluded from both buckets

Invalid bodies/queries return `400` with `{ error: "Validation failed", details: [...] }` (Zod). Invalid `contactId` foreign keys return `400` with a safe message (no Prisma details). Missing payments return `404`. Unauthenticated requests return `401`. Invalid lifecycle transitions return `409`.

### Fields

| Field | Type | Notes |
|-------|------|-------|
| `id` | string (cuid) | read-only |
| `payeeName` | string | required on create |
| `contactId` | string \| null | optional FK to `Contact` |
| `businessUnit` | enum | `TERAMIND` \| `MILA` \| `TAURUS` \| `DOLCE_MILA` \| `HOUSE` \| `FAMILY` \| `OTHER` |
| `category` | string \| null | optional |
| `description` | string \| null | optional |
| `amount` | decimal string | required; **greater than zero**; up to 4 fractional digits; never a float. Zero and negative amounts are rejected. |
| `currency` | string | ISO 4217 three-letter code (`ILS`, `USD`, `EUR`, `GBP`, …) |
| `dueDate` | ISO datetime | required |
| `status` | enum | `DRAFT` \| `PENDING_APPROVAL` \| `APPROVED` \| `PAID` \| `OVERDUE` \| `CANCELLED` \| `ARCHIVED` (default `DRAFT`) |
| `isOverdue` | boolean | computed at read time (not stored) |
| `invoiceNumber` | string \| null | optional |
| `paymentMethod` | string \| null | optional; required (or notes) when marking paid |
| `paidAt` / `approvedAt` | ISO datetime \| null | set by lifecycle actions |
| `notes` | string \| null | optional |
| `source` | enum | `MANUAL` \| `EMAIL` \| `WHATSAPP` \| `INVOICE` \| `AI` (default `MANUAL`) |
| `createdAt` / `updatedAt` | ISO datetime | read-only |
| `deletedAt` | ISO datetime \| null | set on soft delete |

### List / search / filter / sort / pagination

```bash
curl -H "Authorization: Bearer $ADMIN_API_KEY" \
  "https://YOUR_HOST/payments?q=school&status=APPROVED&businessUnit=FAMILY&currency=ILS&contactId=...&dueFrom=2026-07-01T00:00:00.000Z&dueTo=2026-07-31T23:59:59.000Z&page=1&limit=20&sort=dueDate&includeArchived=false"
```

Query params:

| Param | Default | Description |
|-------|---------|-------------|
| `q` | — | Case-insensitive search across **payeeName**, **description**, **invoiceNumber**, and **notes** |
| `status` | — | Filter by status enum |
| `businessUnit` | — | Filter by business unit enum |
| `currency` | — | Filter by ISO 4217 code |
| `contactId` | — | Filter by related contact id |
| `dueFrom` / `dueTo` | — | Inclusive due-date range (ISO datetime) |
| `includeArchived` | `false` | When `false`, `ARCHIVED` and `CANCELLED` never appear |
| `page` | `1` | 1-based page index |
| `limit` | `20` | Page size (max `100`) |
| `sort` | `dueDate` | `dueDate` (asc), `amount` (asc), `updatedAt` (desc), or `payeeName` (asc) |

Response shape:

```json
{
  "data": [ /* payment objects */ ],
  "pagination": { "page": 1, "limit": 20, "total": 3, "totalPages": 1 }
}
```

### Create

```bash
curl -X POST -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"payeeName":"Electric Co","businessUnit":"HOUSE","amount":"450.50","currency":"ILS","dueDate":"2026-07-25T00:00:00.000Z"}' \
  https://YOUR_HOST/payments
```

Returns `201`. Prefer decimal **strings** for `amount` (e.g. `"450.50"`). Integer JSON numbers greater than zero are accepted; floating-point numbers, zero, and negatives are rejected.

### Get by id

```bash
curl -H "Authorization: Bearer $ADMIN_API_KEY" https://YOUR_HOST/payments/:id
```

### Update (partial)

```bash
curl -X PATCH -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"amount":"475.00","notes":"Adjusted estimate"}' \
  https://YOUR_HOST/payments/:id
```

### Approve

```bash
curl -X POST -H "Authorization: Bearer $ADMIN_API_KEY" \
  https://YOUR_HOST/payments/:id/approve
```

### Mark paid

```bash
curl -X POST -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"paymentMethod":"bank_transfer"}' \
  https://YOUR_HOST/payments/:id/mark-paid
```

Or with notes only:

```bash
curl -X POST -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"notes":"Paid in cash at office"}' \
  https://YOUR_HOST/payments/:id/mark-paid
```

### Reopen

```bash
curl -X POST -H "Authorization: Bearer $ADMIN_API_KEY" \
  https://YOUR_HOST/payments/:id/reopen
```

Clears `paidAt` and sets `status` to `APPROVED`.

### Archive

```bash
curl -X POST -H "Authorization: Bearer $ADMIN_API_KEY" \
  https://YOUR_HOST/payments/:id/archive
```

Sets `status` to `ARCHIVED` and **preserves** `paidAt` when the payment was previously paid.

### Soft delete

```bash
curl -X DELETE -H "Authorization: Bearer $ADMIN_API_KEY" \
  https://YOUR_HOST/payments/:id
```

Sets `deletedAt` and returns the payment. A second delete returns `404`.

### Weekly report

```bash
curl -H "Authorization: Bearer $ADMIN_API_KEY" \
  https://YOUR_HOST/payments/reports/weekly
```

Returns:

```json
{
  "generatedAt": "2026-07-20T12:00:00.000Z",
  "window": { "from": "...", "to": "..." },
  "dueInNext7Days": [ /* unpaid payments with now <= dueDate <= now+7days */ ],
  "overdue": [ /* unpaid past-due payments (dueDate < now, computed) */ ],
  "totalsByCurrency": [{ "currency": "ILS", "total": "1700.5000" }],
  "totalsByBusinessUnit": [
    { "businessUnit": "HOUSE", "currency": "ILS", "total": "15000.0000" },
    { "businessUnit": "HOUSE", "currency": "USD", "total": "4200.0000" }
  ],
  "pendingApprovalCount": 1,
  "overdueCount": 2
}
```

Archived, cancelled, and soft-deleted payments are excluded. `totalsByCurrency` groups the actionable set (due soon + overdue) by currency only. `totalsByBusinessUnit` groups by **both** `businessUnit` and `currency` so unlike currencies are never combined. Amounts are decimal strings.

## Multi-Inbox AI Inbox (Phase 6)

Central inbox pipeline that monitors **multiple accounts** (Gmail, Outlook, WhatsApp, SMS, Manual, API) with account isolation and later sync providers. Contacts, Tasks, and Payments APIs are unchanged.

All routes require:

```http
Authorization: Bearer <ADMIN_API_KEY>
```

### Multi-account design

- Each `InboxAccount` has its own `source`, optional `emailAddress` / `externalAccountId`, `isActive` flag, and independent `syncCursor` / `lastSyncedAt`.
- Every `InboxItem` stores `inboxAccountId` — the account provenance is never dropped.
- Messages from different accounts are **never merged** merely because they share an `externalId`.
- Unique protection is scoped per account: `@@unique([inboxAccountId, externalId])`. The same provider message id may exist on account A and account B; a duplicate within one account returns `409`.

### Sync cursor behavior

Gmail OAuth and **manual sync** are implemented (MVP). Each Gmail account keeps an independent `syncCursor` (Gmail `historyId`) and `lastSyncedAt`.

- Initial sync fetches up to the 50 most recent messages (`-in:spam -in:trash`).
- Later syncs use Gmail History to fetch only new messages.
- The cursor advances **only after** all fetched messages are successfully ingested (duplicates are idempotent skips).
- A partial failure leaves the cursor unchanged.
- Concurrent syncs for the same account return `409` with `code: SYNC_IN_PROGRESS` (DB lease lock with expiry so a crashed process cannot leave a permanent lock).
- Spam and Trash are never ingested.
- Stored bodies are sanitized (HTML scripts/styles/images/tracking stripped) and capped at 100,000 characters.
- OAuth tokens are stored encrypted in `GmailCredential` (never on `InboxAccount`, never in API responses/logs).

Stub sync providers remain for non-Gmail sources.

### Suggestion approval workflow

AI analysis **never** auto-creates Tasks or Payments.

1. `POST /inbox/:id/analyze` runs the mock analysis provider and persists `InboxTaskSuggestion` / `InboxPaymentSuggestion` / `InboxReplySuggestion` rows as `PENDING`.
2. `POST .../approve` → `APPROVED` (idempotent if already approved).
3. `POST .../reject` → `REJECTED` (cannot reject `APPLIED`).
4. `POST .../apply` creates a Task or Payment **only after approval**, links it back via `appliedTaskId` / `appliedPaymentId` and `Task.inboxItemId` / `Payment.inboxItemId`, and sets status `APPLIED`. Apply uses a DB row lock (`SELECT FOR UPDATE`) so concurrent requests create at most one entity and remain **idempotent**.

Reply suggestions have no outbound send yet — `apply` only marks them `APPLIED` after approval (also concurrency-safe).

### Repeated analysis

`POST /inbox/:id/analyze` may be called more than once. Chosen rule:

- Re-analysis **atomically replaces** non-applied suggestions (`PENDING`, `APPROVED`, `REJECTED`).
- **Never** deletes or overwrites `APPLIED` suggestions or their Task/Payment provenance.
- Accidental retries therefore do **not** duplicate pending suggestions.
- If analysis fails mid-flight, the write transaction rolls back (no partial new suggestion set) and the item is set to `FAILED` — it is never left stuck in `PROCESSING`.

### Inactive accounts

- `POST .../deactivate` is **non-destructive**: it flips `isActive=false` only. Items and suggestions are not deleted (there is no account DELETE endpoint).
- Inactive accounts **reject new ingestion** (`POST /inbox` → `409 Inbox account is inactive`), including future provider-style sync. Existing items remain readable.

### Security rules

- Admin Bearer auth on every `/inbox` route.
- Zod validation on bodies, query params, and ids.
- List endpoints **omit `rawContent`** by default; detail (`GET /inbox/:id`) includes it.
- Suggestion routes require `suggestionId` to belong to the inbox item in the URL; task/payment/reply suggestion types cannot be mixed across endpoints (`404`).
- Responses and logs never expose OAuth tokens, credentials, `DATABASE_URL`, SQL, Prisma codes, raw provider errors, or `rawContent` on list responses.
- Mock analysis returns concise user-facing reasons only (no chain-of-thought). Anthropic is not called from the inbox analyzer yet.

### Inbox accounts

```bash
curl -H "Authorization: Bearer $ADMIN_API_KEY" https://YOUR_HOST/inbox/accounts
curl -X POST -H "Authorization: Bearer $ADMIN_API_KEY" -H "Content-Type: application/json" \
  -d '{"name":"Personal Gmail","source":"GMAIL","emailAddress":"me@example.com"}' \
  https://YOUR_HOST/inbox/accounts
curl -X POST -H "Authorization: Bearer $ADMIN_API_KEY" \
  https://YOUR_HOST/inbox/accounts/:id/deactivate
```

Sources: `GMAIL` | `OUTLOOK` | `WHATSAPP` | `SMS` | `MANUAL` | `API`.

### Inbox items

```bash
curl -X POST -H "Authorization: Bearer $ADMIN_API_KEY" -H "Content-Type: application/json" \
  -d '{"inboxAccountId":"...","externalId":"msg-1","senderIdentifier":"a@b.com","subject":"Invoice","rawContent":"...","receivedAt":"2026-07-20T10:00:00.000Z"}' \
  https://YOUR_HOST/inbox

curl -H "Authorization: Bearer $ADMIN_API_KEY" \
  "https://YOUR_HOST/inbox?inboxAccountId=...&source=GMAIL&status=NEW&urgency=HIGH&senderIdentifier=a@b.com&receivedFrom=2026-07-01T00:00:00.000Z&receivedTo=2026-07-31T23:59:59.000Z&q=invoice&page=1&limit=20&sort=receivedAt"
```

| Param | Default | Description |
|-------|---------|-------------|
| `q` | — | Search `senderName`, `senderIdentifier`, `subject`, `summary` |
| `inboxAccountId` / `source` / `status` / `urgency` / `senderIdentifier` | — | Filters |
| `receivedFrom` / `receivedTo` | — | Inclusive received-at range |
| `page` / `limit` | `1` / `20` | Pagination (`limit` max `100`) |
| `sort` | `receivedAt` | `receivedAt` \| `updatedAt` \| `urgency` |

Statuses: `NEW` | `PROCESSING` | `READY_FOR_REVIEW` | `APPROVED` | `REJECTED` | `ARCHIVED` | `FAILED`.  
Urgency: `LOW` | `MEDIUM` | `HIGH` | `URGENT`.

### Analyze + suggestions

```bash
curl -X POST -H "Authorization: Bearer $ADMIN_API_KEY" https://YOUR_HOST/inbox/:id/analyze
curl -X POST -H "Authorization: Bearer $ADMIN_API_KEY" \
  https://YOUR_HOST/inbox/:id/task-suggestions/:suggestionId/approve
curl -X POST -H "Authorization: Bearer $ADMIN_API_KEY" \
  https://YOUR_HOST/inbox/:id/task-suggestions/:suggestionId/apply
```

Same approve/reject/apply paths exist for `payment-suggestions` and `reply-suggestions`.

Mock analysis returns `{ summary, urgency, confidence, suggestedTasks, suggestedPayments, suggestedReplies }` with per-suggestion `confidence`, `reason`, and `evidence`.

## Gmail connector (MVP)

Connect one or more real Gmail accounts to the multi-inbox system. Tokens are encrypted at rest with `TOKEN_ENCRYPTION_KEY`. Sync is **manual** for this MVP (no Redis/queues/background workers).

### Google Cloud setup

1. Open [Google Cloud Console](https://console.cloud.google.com/) → APIs & Services.
2. Enable **Gmail API** (and Calendar API if you still use `/morning`).
3. Configure the **OAuth consent screen** (External or Internal). Add scopes:
   - `https://www.googleapis.com/auth/gmail.readonly`
   - `https://www.googleapis.com/auth/userinfo.email`
   - `openid`
   - (optional, Calendar) `https://www.googleapis.com/auth/calendar.readonly`
4. Create an **OAuth 2.0 Client ID** (Web application).
5. Under **Authorized redirect URIs**, add **exactly** (both required if using Calendar and Gmail):
   - Production Calendar: `https://web-production-2a12a.up.railway.app/auth/callback`
   - Production Gmail: `https://web-production-2a12a.up.railway.app/gmail/callback`
   - Local Calendar: `http://localhost:3000/auth/callback`
   - Local Gmail: `http://localhost:3000/gmail/callback`
6. Copy the client ID and client secret into Railway / local env (never commit them).

### Railway variables (exact)

Set these on the Railway app service:

| Variable | Example / notes |
|----------|-----------------|
| `GOOGLE_CLIENT_ID` | from Google Cloud OAuth client |
| `GOOGLE_CLIENT_SECRET` | from Google Cloud OAuth client |
| `GOOGLE_CALENDAR_REDIRECT_URI` | `https://web-production-2a12a.up.railway.app/auth/callback` |
| `GOOGLE_GMAIL_REDIRECT_URI` | `https://web-production-2a12a.up.railway.app/gmail/callback` |
| `TOKEN_ENCRYPTION_KEY` | `openssl rand -hex 32` (store once; rotating it invalidates stored Gmail tokens) |
| `ADMIN_API_KEY` | long random secret |
| `ANTHROPIC_API_KEY` | existing |
| `DATABASE_URL` | from Railway Postgres plugin (required for Gmail) |
| `GOOGLE_REFRESH_TOKEN` | optional; Calendar only |
| `PORT` | usually injected by Railway |

Do **not** set `GOOGLE_REDIRECT_URI` on new environments. If an old deploy still has it, migrate to `GOOGLE_CALENDAR_REDIRECT_URI` and remove the legacy variable (temporary Calendar-only fallback; planned removal).

Prisma migrations run via the existing Railway pre-deploy command (`npm run db:migrate` / `prisma migrate deploy`). Do **not** run production migrations manually before merge.

### Connect the first Gmail account

```bash
# 1) Get an authorization URL (Bearer stays in the API client — never put it in a browser URL)
curl -s -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Accept: application/json" \
  "https://web-production-2a12a.up.railway.app/gmail/connect?format=json"
# → { "authorizationUrl": "https://accounts.google.com/..." }

# 2) Open authorizationUrl in a browser, complete Google consent

# 3) Google redirects to /gmail/callback — you should see "Gmail connected"

# 4) Confirm the account
curl -H "Authorization: Bearer $ADMIN_API_KEY" \
  https://web-production-2a12a.up.railway.app/gmail/accounts
```

### Connect additional Gmail accounts

Repeat the same `/gmail/connect` flow while signed into a **different** Google account in the browser (or use an incognito window). Each distinct Google identity creates a separate `InboxAccount` (`source=GMAIL`) with its own encrypted credentials and sync cursor. Re-authorizing the same Google user updates that account instead of creating a duplicate.

### Manually sync

```bash
# One account
curl -X POST -H "Authorization: Bearer $ADMIN_API_KEY" \
  https://web-production-2a12a.up.railway.app/gmail/accounts/:id/sync

# All active Gmail accounts
curl -X POST -H "Authorization: Bearer $ADMIN_API_KEY" \
  https://web-production-2a12a.up.railway.app/gmail/sync-all
```

Synced messages appear as `InboxItem` rows with `status=NEW`, `source=GMAIL`. Tasks/Payments are **not** auto-created — use `POST /inbox/:id/analyze` and the existing suggestion approve/apply flow.

### Reconnect a revoked account

If Google revokes access, sync returns `409` with `code: RECONNECT_REQUIRED`. Existing inbox items are kept. Re-run `/gmail/connect` for that Google user to store new credentials (same `externalAccountId` updates the account). Or disconnect first:

```bash
curl -X POST -H "Authorization: Bearer $ADMIN_API_KEY" \
  https://web-production-2a12a.up.railway.app/gmail/accounts/:id/disconnect
```

Disconnect deletes stored credentials and sets `isActive=false`; inbox items remain.

### Security rules (Gmail)

- Admin Bearer on `/gmail/connect`, `/gmail/accounts`, sync, and disconnect — **never** as a query param or in the browser redirect URL.
- `/gmail/callback` is public but CSRF-protected via signed, DB-backed one-time `state` (10-minute TTL, bound to the Gmail flow).
- Tokens encrypted with AES-256-GCM (`TOKEN_ENCRYPTION_KEY`); never logged or returned by APIs.
- Safe errors only (`400` / `401` / `404` / `409` / `503`) — no raw Google errors, stack traces, or provider query parameters echoed to clients.

## Railway environment variables

Set these in the Railway project:

- `ANTHROPIC_API_KEY`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_CALENDAR_REDIRECT_URI` — `https://web-production-2a12a.up.railway.app/auth/callback`
- `GOOGLE_GMAIL_REDIRECT_URI` — `https://web-production-2a12a.up.railway.app/gmail/callback`
- `TOKEN_ENCRYPTION_KEY` — 64-char hex (`openssl rand -hex 32`)
- `ADMIN_API_KEY` — long random secret
- `GOOGLE_REFRESH_TOKEN` — after completing `/auth` once (Calendar)
- `PORT` — usually injected by Railway
- `DATABASE_URL` — from the Railway PostgreSQL plugin

Add **both** redirect URIs in Google Cloud Console → OAuth client → Authorized redirect URIs when using Calendar and Gmail together.

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

### Contacts (protected)

See [Contacts API (Phase 3)](#contacts-api-phase-3) above.

### Tasks (protected)

See [Tasks API (Phase 4)](#tasks-api-phase-4) above.

### Payments (protected)

See [Payments Due Engine (Phase 5)](#payments-due-engine-phase-5) above.

### Inbox (protected)

See [Multi-Inbox AI Inbox (Phase 6)](#multi-inbox-ai-inbox-phase-6) above.

## Google OAuth scopes

Gmail connector requests **only**:

- `openid`
- `https://www.googleapis.com/auth/userinfo.email`
- `https://www.googleapis.com/auth/gmail.readonly`

Gmail must **not** request `gmail.modify`, `gmail.send`, `mail.google.com`, or Calendar scopes.

Calendar (`/auth`) requests **only**:

- `https://www.googleapis.com/auth/calendar.readonly`

## Manual follow-ups after deploy

1. Set Railway vars: `GOOGLE_CALENDAR_REDIRECT_URI`, `GOOGLE_GMAIL_REDIRECT_URI`, `TOKEN_ENCRYPTION_KEY`, `ADMIN_API_KEY`, and existing Anthropic/Google/DB keys. Remove deprecated `GOOGLE_REDIRECT_URI` if present.
2. Confirm Google Cloud authorized redirect URIs include both `/auth/callback` and `/gmail/callback` production URLs.
3. Complete `/gmail/connect` for the first Gmail account; confirm `/gmail/accounts` lists it.
4. Run `POST /gmail/accounts/:id/sync` and confirm `InboxItem` rows appear as `NEW`.
5. Optionally complete `/auth` once and save `GOOGLE_REFRESH_TOKEN` for Calendar.
6. Rotate any Google refresh token that may appear in older Railway logs.
7. Confirm `/qr` returns 404 and `/morning` returns 401 without a Bearer token.
8. Confirm `/health/db` returns `"database":"up"` after the pre-deploy Prisma migration.
9. Confirm Contacts, Tasks, Payments, and Inbox APIs still work with a Bearer token.
10. Confirm Multi-Inbox analyze still works on synced Gmail items without auto-creating Tasks/Payments.
