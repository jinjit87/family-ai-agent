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
- **Auth:** shared admin secret (`ADMIN_API_KEY`) for operational HTTP routes
- **Hosting:** Railway-compatible (`Procfile`, `PORT`)

```
HTTP
 ├── GET /health                 public
 ├── GET /health/db              public → PostgreSQL connectivity
 ├── GET /auth                   admin Bearer required → Google OAuth
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
 └── POST /inbox/:id/*-suggestions/:suggestionId/{approve|reject|apply}
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
| `GOOGLE_CLIENT_ID` | yes | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | yes | Google OAuth client secret |
| `GOOGLE_REDIRECT_URI` | yes | Must match the authorized redirect URI in Google Cloud (e.g. `https://YOUR_HOST/auth/callback` or `http://localhost:3000/auth/callback`) |
| `ADMIN_API_KEY` | yes | Shared secret for operational endpoints |
| `GOOGLE_REFRESH_TOKEN` | no | Offline refresh token for Calendar access |
| `PORT` | no | Listen port (default `3000`) |
| `MY_WHATSAPP` | no | Reserved; unused while WhatsApp is disabled |
| `DATABASE_URL` | no* | PostgreSQL connection string (`postgresql://...`). Optional for app startup; required for migrations, seeds, Contacts/Tasks/Payments/Inbox APIs, and `/health/db` to report healthy |

### Run

```bash
export ANTHROPIC_API_KEY=...
export GOOGLE_CLIENT_ID=...
export GOOGLE_CLIENT_SECRET=...
export GOOGLE_REDIRECT_URI=http://localhost:3000/auth/callback
export ADMIN_API_KEY=...
export DATABASE_URL="postgresql://USER:PASSWORD@localhost:5432/family_ai_agent?schema=public"
# optional after first OAuth:
# export GOOGLE_REFRESH_TOKEN=...

npm start
```

Startup fails with a clear list of **missing variable names** if required env is incomplete. Values are never printed.

### Tests

```bash
export DATABASE_URL="postgresql://USER:PASSWORD@localhost:5432/family_ai_agent?schema=public"
npm test
```

Contacts, Tasks, Payments, and Inbox module coverage (target >95%):

```bash
npm run test:coverage
npm run test:coverage:tasks
npm run test:coverage:payments
npm run test:coverage:inbox
```

## Database (Phase 2 foundation)

Prisma models: `Contact`, `Conversation`, `Message`, `Task`, `CalendarProposal`, `Approval`, `Rule`, `AuditLog`, `Payment`, `InboxAccount`, `InboxItem`, `InboxTaskSuggestion`, `InboxPaymentSuggestion`, `InboxReplySuggestion`.

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

Gmail OAuth and polling are **not** implemented yet. Sync uses clean provider interfaces:

- `listNewMessages(account, cursor)`
- `fetchMessage(account, externalId)`
- `saveSyncCursor(account, cursor)`

Each account keeps its own cursor. Stub providers return empty message lists until real connectors are wired. Saving a cursor updates `syncCursor` and `lastSyncedAt` for that account only.

### Suggestion approval workflow

AI analysis **never** auto-creates Tasks or Payments.

1. `POST /inbox/:id/analyze` runs the mock analysis provider and persists `InboxTaskSuggestion` / `InboxPaymentSuggestion` / `InboxReplySuggestion` rows as `PENDING`.
2. `POST .../approve` → `APPROVED` (idempotent if already approved).
3. `POST .../reject` → `REJECTED` (cannot reject `APPLIED`).
4. `POST .../apply` creates a Task or Payment **only after approval**, links it back via `appliedTaskId` / `appliedPaymentId` and `Task.inboxItemId` / `Payment.inboxItemId`, and sets status `APPLIED`. Re-applying is **idempotent** and returns the same entity.

Reply suggestions have no outbound send yet — `apply` only marks them `APPLIED` after approval.

### Security rules

- Admin Bearer auth on every `/inbox` route.
- Zod validation on bodies, query params, and ids.
- List endpoints **omit `rawContent`** by default; detail (`GET /inbox/:id`) includes it.
- Responses never expose OAuth tokens, credentials, database/Prisma details, or raw provider errors.
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

## Railway environment variables

Set the same variables in the Railway project:

- `ANTHROPIC_API_KEY`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI` — use your Railway public URL, e.g. `https://YOUR_SERVICE.up.railway.app/auth/callback`
- `ADMIN_API_KEY` — long random secret
- `GOOGLE_REFRESH_TOKEN` — after completing `/auth` once
- `PORT` — usually injected by Railway
- `DATABASE_URL` — from the Railway PostgreSQL plugin (required for DB features and Contacts/Tasks/Payments/Inbox APIs)

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

### Contacts (protected)

See [Contacts API (Phase 3)](#contacts-api-phase-3) above.

### Tasks (protected)

See [Tasks API (Phase 4)](#tasks-api-phase-4) above.

### Payments (protected)

See [Payments Due Engine (Phase 5)](#payments-due-engine-phase-5) above.

### Inbox (protected)

See [Multi-Inbox AI Inbox (Phase 6)](#multi-inbox-ai-inbox-phase-6) above.

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
8. Confirm Contacts CRUD works with a Bearer token (list/create/get/patch/soft-delete).
9. Confirm Tasks API works with a Bearer token (list/create/get/patch/complete/reopen/archive).
10. Confirm Payments Due Engine works with a Bearer token (list/create/get/patch/approve/mark-paid/reopen/archive/soft-delete and weekly report).
11. Confirm Multi-Inbox AI Inbox works with a Bearer token (accounts, ingest, list without rawContent, analyze, suggestion approve/apply).
