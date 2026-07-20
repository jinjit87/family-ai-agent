const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const express = require('express');

const { createApp, loadEnv, requireAdmin } = require('../index');
const { getPrisma, disconnectPrisma } = require('../lib/db');
const schemas = require('../lib/inboxSchemas');
const inbox = require('../lib/inbox');
const {
  createInboxAccountSchema,
  updateInboxAccountSchema,
  createInboxItemSchema,
  updateInboxItemSchema,
  listInboxItemsQuerySchema,
  idParamSchema,
  suggestionParamSchema,
  formatZodError,
} = schemas;
const { createInboxRouter } = require('../lib/inboxRouter');
const {
  mockAnalyze,
  detectAmount,
  detectDueDate,
  createMockAnalysisProvider,
} = require('../lib/inboxAnalysis');
const {
  createSaveSyncCursor,
  createStubSyncProvider,
  resolveSyncProvider,
} = require('../lib/inboxSync');

const VALID_ENV = {
  ANTHROPIC_API_KEY: 'test-anthropic-key',
  GOOGLE_CLIENT_ID: 'test-google-client-id',
  GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
  GOOGLE_CALENDAR_REDIRECT_URI: 'https://example.com/auth/callback',
  ADMIN_API_KEY: 'test-admin-api-key',
};

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://family_ai:family_ai_dev@localhost:5432/family_ai_agent?schema=public';

function auth(req) {
  return req.set('Authorization', `Bearer ${VALID_ENV.ADMIN_API_KEY}`);
}

describe('inbox Zod schemas', () => {
  it('accepts valid account create and rejects unknowns', () => {
    const parsed = createInboxAccountSchema.parse({
      name: '  Personal Gmail  ',
      source: 'GMAIL',
      emailAddress: '  me@example.com  ',
      externalAccountId: '',
    });
    assert.equal(parsed.name, 'Personal Gmail');
    assert.equal(parsed.emailAddress, 'me@example.com');
    assert.equal(parsed.externalAccountId, null);

    assert.equal(createInboxAccountSchema.safeParse({ name: 'X', source: 'FAX' }).success, false);
    assert.equal(
      createInboxAccountSchema.safeParse({ name: 'X', source: 'GMAIL', unexpected: true }).success,
      false
    );
  });

  it('requires at least one field on account update', () => {
    assert.equal(updateInboxAccountSchema.safeParse({}).success, false);
    assert.equal(updateInboxAccountSchema.parse({ isActive: false }).isActive, false);
  });

  it('validates inbox item create/update payloads', () => {
    const ok = createInboxItemSchema.parse({
      inboxAccountId: 'acc1',
      externalId: 'msg-1',
      senderIdentifier: 'a@b.com',
      rawContent: 'Hello',
      receivedAt: '2026-07-20T10:00:00.000Z',
      recipients: ['x@y.com', '  '],
    });
    assert.deepEqual(ok.recipients, ['x@y.com']);

    assert.equal(createInboxItemSchema.safeParse({}).success, false);
    assert.equal(updateInboxItemSchema.safeParse({}).success, false);
    assert.equal(updateInboxItemSchema.parse({ status: 'ARCHIVED' }).status, 'ARCHIVED');
  });

  it('parses list query defaults and rejects invalid filters', () => {
    const defaults = listInboxItemsQuerySchema.parse({});
    assert.equal(defaults.page, 1);
    assert.equal(defaults.limit, 20);
    assert.equal(defaults.sort, 'receivedAt');

    assert.equal(listInboxItemsQuerySchema.safeParse({ page: 0 }).success, false);
    assert.equal(listInboxItemsQuerySchema.safeParse({ limit: 101 }).success, false);
    assert.equal(listInboxItemsQuerySchema.safeParse({ sort: 'subject' }).success, false);
    assert.equal(listInboxItemsQuerySchema.safeParse({ status: 'DONE' }).success, false);
  });

  it('formats zod errors and validates id params', () => {
    const bad = createInboxAccountSchema.safeParse({});
    const formatted = formatZodError(bad.error);
    assert.equal(formatted.error, 'Validation failed');
    assert.ok(formatted.details.length > 0);

    assert.equal(idParamSchema.safeParse({ id: '' }).success, false);
    assert.equal(suggestionParamSchema.safeParse({ id: 'a', suggestionId: '' }).success, false);
    assert.equal(suggestionParamSchema.safeParse({ id: 'a', suggestionId: 'b' }).success, true);
  });
});

describe('inbox helpers and providers', () => {
  it('buildListWhere and buildOrderBy cover filters/search/sort', () => {
    const where = inbox.buildListWhere({
      inboxAccountId: 'a1',
      source: 'GMAIL',
      status: 'NEW',
      urgency: 'HIGH',
      senderIdentifier: 'x@y.com',
      receivedFrom: '2026-07-01T00:00:00.000Z',
      receivedTo: '2026-07-31T00:00:00.000Z',
      q: 'invoice',
    });
    assert.equal(where.inboxAccountId, 'a1');
    assert.equal(where.source, 'GMAIL');
    assert.equal(where.status, 'NEW');
    assert.equal(where.urgency, 'HIGH');
    assert.equal(where.senderIdentifier, 'x@y.com');
    assert.ok(where.receivedAt.gte instanceof Date);
    assert.ok(where.receivedAt.lte instanceof Date);
    assert.equal(where.OR.length, 4);

    assert.deepEqual(inbox.buildListWhere({ q: '   ' }), {});
    assert.deepEqual(inbox.buildOrderBy('updatedAt'), { updatedAt: 'desc' });
    assert.deepEqual(inbox.buildOrderBy('urgency'), { urgency: 'desc' });
    assert.deepEqual(inbox.buildOrderBy('receivedAt'), { receivedAt: 'desc' });
  });

  it('detects unique/FK errors and suggestion transitions', () => {
    assert.equal(inbox.isUniqueConstraintError({ code: 'P2002' }), true);
    assert.equal(inbox.isForeignKeyError({ code: 'P2003' }), true);
    assert.equal(inbox.isUniqueConstraintError(null), false);
    assert.equal(inbox.canTransitionSuggestion('PENDING', 'APPROVED'), true);
    assert.equal(inbox.canTransitionSuggestion('APPLIED', 'APPROVED'), false);
  });

  it('mock analysis is deterministic and user-facing', async () => {
    const invoice = await mockAnalyze({
      id: '1',
      source: 'GMAIL',
      senderName: 'Electric Co',
      senderIdentifier: 'billing@electric.example',
      subject: 'Invoice INV-99 due 2026-08-01',
      rawContent: 'Please pay ILS 450.50 for invoice INV-99 by 2026-08-01. Urgent.',
      receivedAt: new Date(),
    });
    assert.equal(invoice.urgency, 'URGENT');
    assert.ok(invoice.suggestedPayments.length >= 1);
    assert.ok(invoice.suggestedPayments[0].reason.includes('invoice'));
    assert.ok(!JSON.stringify(invoice).toLowerCase().includes('chain-of-thought'));
    assert.ok(invoice.suggestedReplies.length >= 1);

    const amt = detectAmount('Total $1,200.00 owed');
    assert.equal(amt.currency, 'USD');
    assert.equal(detectDueDate('no date here').dueDate, null);
    assert.equal(detectDueDate('due 2026-09-15').dueDate, '2026-09-15T00:00:00.000Z');

    const provider = createMockAnalysisProvider();
    const mild = await provider.analyze({
      id: '2',
      source: 'MANUAL',
      senderName: null,
      senderIdentifier: 'friend@example.com',
      subject: 'FYI no rush',
      rawContent: 'Just saying hello whenever.',
      receivedAt: new Date(),
    });
    assert.equal(mild.urgency, 'LOW');
  });

  it('sync provider interfaces support independent cursors and stubs', async () => {
    const calls = [];
    const save = createSaveSyncCursor(async (accountId, cursor) => {
      calls.push({ accountId, cursor });
      return {
        id: accountId,
        name: 'A',
        source: 'GMAIL',
        emailAddress: null,
        externalAccountId: null,
        isActive: true,
        lastSyncedAt: new Date(),
        syncCursor: cursor,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    });
    const stub = createStubSyncProvider({ saveSyncCursor: save });
    const listed = await stub.listNewMessages({ id: 'a1' }, 'cursor-1');
    assert.deepEqual(listed.messages, []);
    assert.equal(listed.nextCursor, null);
    assert.equal(await stub.fetchMessage({ id: 'a1' }, 'ext'), null);
    await stub.saveSyncCursor({ id: 'acct-a' }, 'c-100');
    await stub.saveSyncCursor({ id: 'acct-b' }, 'c-200');
    assert.deepEqual(calls, [
      { accountId: 'acct-a', cursor: 'c-100' },
      { accountId: 'acct-b', cursor: 'c-200' },
    ]);
    assert.equal(resolveSyncProvider('GMAIL', stub), stub);
    assert.equal(resolveSyncProvider('UNKNOWN', stub), stub);
  });

  it('serializers omit rawContent from list shape by default', () => {
    const now = new Date('2026-07-20T12:00:00.000Z');
    const item = {
      id: 'i1',
      inboxAccountId: 'a1',
      source: 'GMAIL',
      externalId: 'e1',
      threadExternalId: null,
      senderName: 'Sam',
      senderIdentifier: 'sam@example.com',
      recipients: ['you@example.com'],
      subject: 'Hi',
      rawContent: 'SECRET BODY',
      summary: null,
      status: 'NEW',
      confidence: null,
      urgency: null,
      receivedAt: now,
      processedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    const listed = inbox.serializeInboxItem(item);
    assert.equal(listed.rawContent, undefined);
    const detail = inbox.serializeInboxItem(item, { includeRawContent: true });
    assert.equal(detail.rawContent, 'SECRET BODY');

    const account = inbox.serializeAccount({
      ...item,
      name: 'Acc',
      emailAddress: null,
      externalAccountId: null,
      isActive: true,
      lastSyncedAt: null,
      syncCursor: null,
    });
    assert.equal(account.name, 'Acc');
    assert.equal(Object.prototype.hasOwnProperty.call(account, 'oauthToken'), false);
  });
});

describe('Inbox API', () => {
  let app;
  let prisma;

  before(async () => {
    process.env.DATABASE_URL = DATABASE_URL;
    const env = loadEnv(VALID_ENV);
    app = createApp(env);
    prisma = getPrisma();
    await prisma.$queryRaw`SELECT 1`;
  });

  after(async () => {
    await cleanupFixtures();
    await disconnectPrisma();
  });

  async function cleanupFixtures() {
    await prisma.inboxReplySuggestion.deleteMany({
      where: { inboxItem: { subject: { startsWith: '[test-inbox]' } } },
    });
    await prisma.inboxPaymentSuggestion.deleteMany({
      where: { inboxItem: { subject: { startsWith: '[test-inbox]' } } },
    });
    await prisma.inboxTaskSuggestion.deleteMany({
      where: { inboxItem: { subject: { startsWith: '[test-inbox]' } } },
    });
    await prisma.task.deleteMany({
      where: { OR: [{ title: { startsWith: '[test-inbox]' } }, { inboxItem: { subject: { startsWith: '[test-inbox]' } } }] },
    });
    await prisma.payment.deleteMany({
      where: {
        OR: [
          { payeeName: { startsWith: '[test-inbox]' } },
          { inboxItem: { subject: { startsWith: '[test-inbox]' } } },
        ],
      },
    });
    await prisma.inboxItem.deleteMany({
      where: {
        OR: [
          { subject: { startsWith: '[test-inbox]' } },
          { senderIdentifier: { endsWith: '@inbox-test.example' } },
          { externalId: { startsWith: 'test-inbox-' } },
        ],
      },
    });
    await prisma.inboxAccount.deleteMany({
      where: {
        OR: [
          { name: { startsWith: '[test-inbox]' } },
          { emailAddress: { endsWith: '@inbox-test.example' } },
        ],
      },
    });
  }

  beforeEach(async () => {
    await cleanupFixtures();
    inbox.resetAnalysisProvider();
  });

  afterEach(async () => {
    await cleanupFixtures();
    inbox.resetAnalysisProvider();
  });

  async function createAccount(overrides = {}) {
    const res = await auth(request(app).post('/inbox/accounts'))
      .send({
        name: overrides.name || '[test-inbox] Account',
        source: overrides.source || 'GMAIL',
        emailAddress: overrides.emailAddress || `acc-${Date.now()}@inbox-test.example`,
        externalAccountId: overrides.externalAccountId || null,
        isActive: overrides.isActive,
      })
      .expect(201);
    return res.body;
  }

  async function createItem(accountId, overrides = {}) {
    const res = await auth(request(app).post('/inbox'))
      .send({
        inboxAccountId: accountId,
        externalId: overrides.externalId || `test-inbox-${Date.now()}-${Math.random()}`,
        senderName: overrides.senderName || 'Sender',
        senderIdentifier: overrides.senderIdentifier || `sender-${Date.now()}@inbox-test.example`,
        recipients: overrides.recipients || ['me@inbox-test.example'],
        subject: overrides.subject || '[test-inbox] Subject',
        rawContent: overrides.rawContent || 'Body content for tests',
        receivedAt: overrides.receivedAt || '2026-07-20T10:00:00.000Z',
        source: overrides.source,
        status: overrides.status,
        urgency: overrides.urgency,
        summary: overrides.summary,
      })
      .expect(201);
    return res.body;
  }

  it('rejects unauthenticated requests on inbox endpoints', async () => {
    await request(app).get('/inbox').expect(401);
    await request(app).post('/inbox').send({}).expect(401);
    await request(app).get('/inbox/accounts').expect(401);
    await request(app).post('/inbox/accounts').send({}).expect(401);
    await request(app).get('/inbox/accounts/x').expect(401);
    await request(app).patch('/inbox/accounts/x').send({ name: 'Y' }).expect(401);
    await request(app).post('/inbox/accounts/x/activate').expect(401);
    await request(app).post('/inbox/accounts/x/deactivate').expect(401);
    await request(app).get('/inbox/x').expect(401);
    await request(app).patch('/inbox/x').send({ status: 'NEW' }).expect(401);
    await request(app).post('/inbox/x/analyze').expect(401);
    await request(app).post('/inbox/x/archive').expect(401);
  });

  it('production mount order: /inbox hits auth/router before catch-all 404', async () => {
    const unauth = await request(app).get('/inbox');
    assert.equal(unauth.status, 401);
    assert.notEqual(unauth.status, 404);
    assert.equal(unauth.body.error, 'Unauthorized');

    const authed = await auth(request(app).get('/inbox')).expect(200);
    assert.ok(Array.isArray(authed.body.data));
    assert.equal(typeof authed.body.pagination, 'object');

    const missing = await request(app).get('/definitely-not-a-real-route').expect(404);
    assert.equal(missing.body.error, 'Not found');
  });

  it('does not alter existing contacts/tasks/payments routes', async () => {
    await auth(request(app).get('/contacts')).expect(200);
    await auth(request(app).get('/tasks')).expect(200);
    await auth(request(app).get('/payments')).expect(200);
  });

  it('manages multiple inbox accounts with activate/deactivate', async () => {
    const a = await createAccount({ name: '[test-inbox] Gmail A', source: 'GMAIL' });
    const b = await createAccount({ name: '[test-inbox] Outlook B', source: 'OUTLOOK' });
    assert.equal(a.isActive, true);
    assert.equal(b.source, 'OUTLOOK');

    const listed = await auth(request(app).get('/inbox/accounts')).expect(200);
    assert.ok(listed.body.data.some((row) => row.id === a.id));
    assert.ok(listed.body.data.some((row) => row.id === b.id));

    const got = await auth(request(app).get(`/inbox/accounts/${a.id}`)).expect(200);
    assert.equal(got.body.emailAddress.endsWith('@inbox-test.example'), true);

    const patched = await auth(request(app).patch(`/inbox/accounts/${a.id}`))
      .send({ name: '[test-inbox] Gmail A Renamed', syncCursor: 'cursor-1' })
      .expect(200);
    assert.equal(patched.body.name, '[test-inbox] Gmail A Renamed');
    assert.equal(patched.body.syncCursor, 'cursor-1');

    const deactivated = await auth(request(app).post(`/inbox/accounts/${a.id}/deactivate`)).expect(200);
    assert.equal(deactivated.body.isActive, false);
    const activated = await auth(request(app).post(`/inbox/accounts/${a.id}/activate`)).expect(200);
    assert.equal(activated.body.isActive, true);

    await auth(request(app).get('/inbox/accounts/missing-id')).expect(404);
    await auth(request(app).patch('/inbox/accounts/missing-id')).send({ name: 'X' }).expect(404);
    await auth(request(app).post('/inbox/accounts/missing-id/activate')).expect(404);
    await auth(request(app).post('/inbox/accounts/missing-id/deactivate')).expect(404);
  });

  it('isolates accounts and allows same externalId across accounts only', async () => {
    const a = await createAccount({ name: '[test-inbox] Iso A' });
    const b = await createAccount({ name: '[test-inbox] Iso B' });

    const sharedExternalId = `test-inbox-shared-${Date.now()}`;
    const itemA = await createItem(a.id, {
      externalId: sharedExternalId,
      subject: '[test-inbox] From A',
      senderIdentifier: 'shared@inbox-test.example',
    });
    const itemB = await createItem(b.id, {
      externalId: sharedExternalId,
      subject: '[test-inbox] From B',
      senderIdentifier: 'shared@inbox-test.example',
    });
    assert.notEqual(itemA.id, itemB.id);
    assert.equal(itemA.externalId, itemB.externalId);
    assert.equal(itemA.inboxAccountId, a.id);
    assert.equal(itemB.inboxAccountId, b.id);

    const dup = await auth(request(app).post('/inbox')).send({
      inboxAccountId: a.id,
      externalId: sharedExternalId,
      senderIdentifier: 'shared@inbox-test.example',
      subject: '[test-inbox] Dup',
      rawContent: 'dup',
      receivedAt: '2026-07-20T11:00:00.000Z',
    });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error.includes('externalId'), true);
    assert.equal(JSON.stringify(dup.body).includes('P2002'), false);
    assert.equal(JSON.stringify(dup.body).includes('Prisma'), false);

    const filteredA = await auth(request(app).get(`/inbox?inboxAccountId=${a.id}`)).expect(200);
    assert.ok(filteredA.body.data.every((row) => row.inboxAccountId === a.id));
    assert.ok(filteredA.body.data.some((row) => row.id === itemA.id));
    assert.equal(filteredA.body.data.some((row) => row.id === itemB.id), false);
  });

  it('hides rawContent from list responses but returns it on detail', async () => {
    const account = await createAccount({ name: '[test-inbox] Raw' });
    const created = await createItem(account.id, {
      subject: '[test-inbox] Secret mail',
      rawContent: 'TOP SECRET BODY CONTENT',
    });
    assert.equal(created.rawContent, 'TOP SECRET BODY CONTENT');

    const listed = await auth(request(app).get('/inbox?q=Secret%20mail')).expect(200);
    const row = listed.body.data.find((d) => d.id === created.id);
    assert.ok(row);
    assert.equal(Object.prototype.hasOwnProperty.call(row, 'rawContent'), false);

    const detail = await auth(request(app).get(`/inbox/${created.id}`)).expect(200);
    assert.equal(detail.body.rawContent, 'TOP SECRET BODY CONTENT');
  });

  it('supports filtering, search, pagination, and sorting', async () => {
    const account = await createAccount({ name: '[test-inbox] Filter Acc', source: 'API' });
    const early = await createItem(account.id, {
      subject: '[test-inbox] Alpha invoice',
      senderIdentifier: 'alpha@inbox-test.example',
      senderName: 'Alpha',
      summary: 'about payment',
      receivedAt: '2026-07-10T00:00:00.000Z',
      status: 'NEW',
      urgency: 'LOW',
      source: 'API',
    });
    await prisma.inboxItem.update({
      where: { id: early.id },
      data: { urgency: 'LOW', status: 'NEW' },
    });
    const late = await createItem(account.id, {
      subject: '[test-inbox] Beta reminder',
      senderIdentifier: 'beta@inbox-test.example',
      senderName: 'Beta',
      summary: 'school note',
      receivedAt: '2026-07-18T00:00:00.000Z',
      source: 'API',
    });
    await prisma.inboxItem.update({
      where: { id: late.id },
      data: { urgency: 'URGENT', status: 'READY_FOR_REVIEW' },
    });

    const bySender = await auth(
      request(app).get('/inbox?senderIdentifier=alpha@inbox-test.example')
    ).expect(200);
    assert.equal(bySender.body.data.length, 1);
    assert.equal(bySender.body.data[0].id, early.id);

    const byStatus = await auth(request(app).get('/inbox?status=READY_FOR_REVIEW')).expect(200);
    assert.ok(byStatus.body.data.some((d) => d.id === late.id));

    const byUrgency = await auth(request(app).get('/inbox?urgency=URGENT')).expect(200);
    assert.ok(byUrgency.body.data.some((d) => d.id === late.id));

    const bySource = await auth(request(app).get('/inbox?source=API')).expect(200);
    assert.ok(bySource.body.data.length >= 2);

    const search = await auth(request(app).get('/inbox?q=invoice')).expect(200);
    assert.ok(search.body.data.some((d) => d.id === early.id));

    const ranged = await auth(
      request(app).get(
        '/inbox?receivedFrom=2026-07-09T00:00:00.000Z&receivedTo=2026-07-11T00:00:00.000Z'
      )
    ).expect(200);
    assert.ok(ranged.body.data.some((d) => d.id === early.id));
    assert.equal(ranged.body.data.some((d) => d.id === late.id), false);

    const page1 = await auth(request(app).get('/inbox?limit=1&page=1&sort=receivedAt')).expect(200);
    assert.equal(page1.body.data.length, 1);
    assert.equal(page1.body.pagination.limit, 1);
    assert.ok(page1.body.pagination.total >= 2);

    const sortedUrgency = await auth(request(app).get('/inbox?sort=urgency&limit=50')).expect(200);
    assert.ok(Array.isArray(sortedUrgency.body.data));

    await auth(request(app).get('/inbox?sort=nope')).expect(400);
  });

  it('updates and archives inbox items', async () => {
    const account = await createAccount({ name: '[test-inbox] Lifecycle Acc' });
    const item = await createItem(account.id, { subject: '[test-inbox] Patch me' });

    const patched = await auth(request(app).patch(`/inbox/${item.id}`))
      .send({ subject: '[test-inbox] Patched', status: 'APPROVED', urgency: 'HIGH' })
      .expect(200);
    assert.equal(patched.body.subject, '[test-inbox] Patched');
    assert.equal(patched.body.status, 'APPROVED');
    assert.equal(patched.body.urgency, 'HIGH');

    const archived = await auth(request(app).post(`/inbox/${item.id}/archive`)).expect(200);
    assert.equal(archived.body.status, 'ARCHIVED');

    await auth(request(app).get('/inbox/missing-item')).expect(404);
    await auth(request(app).patch('/inbox/missing-item')).send({ status: 'NEW' }).expect(404);
    await auth(request(app).post('/inbox/missing-item/archive')).expect(404);
  });

  it('rejects invalid account id on create and validates bodies', async () => {
    const badAccount = await auth(request(app).post('/inbox')).send({
      inboxAccountId: 'missing-account',
      externalId: 'test-inbox-x',
      senderIdentifier: 'x@inbox-test.example',
      subject: '[test-inbox] bad',
      rawContent: 'x',
      receivedAt: '2026-07-20T10:00:00.000Z',
    });
    assert.equal(badAccount.status, 400);
    assert.equal(badAccount.body.error, 'Invalid inboxAccountId');

    await auth(request(app).post('/inbox/accounts')).send({ name: '' }).expect(400);
    await auth(request(app).post('/inbox')).send({}).expect(400);
    await auth(request(app).patch('/inbox/accounts/x')).send({}).expect(400);
  });

  it('runs mock AI analysis and persists pending suggestions without creating tasks/payments', async () => {
    const account = await createAccount({ name: '[test-inbox] Analyze Acc' });
    const item = await createItem(account.id, {
      subject: '[test-inbox] Invoice please pay ILS 120.00 by 2026-08-01',
      rawContent: 'Invoice INV-42. Please pay ILS 120.00 urgently. Can you confirm?',
    });

    const beforeTasks = await prisma.task.count({ where: { inboxItemId: item.id } });
    const beforePayments = await prisma.payment.count({ where: { inboxItemId: item.id } });

    const analyzed = await auth(request(app).post(`/inbox/${item.id}/analyze`)).expect(200);
    assert.equal(analyzed.body.item.status, 'READY_FOR_REVIEW');
    assert.ok(analyzed.body.item.summary);
    assert.ok(analyzed.body.analysis.suggestedPayments.length >= 1);
    assert.ok(analyzed.body.item.paymentSuggestions.length >= 1);
    assert.ok(analyzed.body.item.taskSuggestions.every((s) => s.status === 'PENDING'));
    assert.ok(analyzed.body.item.paymentSuggestions.every((s) => s.status === 'PENDING'));
    assert.ok(analyzed.body.item.replySuggestions.every((s) => s.status === 'PENDING'));
    assert.ok(analyzed.body.analysis.suggestedPayments[0].confidence > 0);
    assert.ok(analyzed.body.analysis.suggestedPayments[0].reason.length > 0);

    const afterTasks = await prisma.task.count({ where: { inboxItemId: item.id } });
    const afterPayments = await prisma.payment.count({ where: { inboxItemId: item.id } });
    assert.equal(afterTasks, beforeTasks);
    assert.equal(afterPayments, beforePayments);

    await auth(request(app).post('/inbox/missing/analyze')).expect(404);
  });

  it('supports suggestion approve/reject/apply with idempotent application', async () => {
    const account = await createAccount({ name: '[test-inbox] Suggest Acc' });
    const item = await createItem(account.id, {
      subject: '[test-inbox] Please schedule pickup and pay ILS 99.00 due 2026-08-10',
      rawContent: 'Please schedule the pickup today. Invoice INV-7 amount ILS 99.00 due 2026-08-10?',
    });
    const analyzed = await auth(request(app).post(`/inbox/${item.id}/analyze`)).expect(200);
    const taskSug = analyzed.body.item.taskSuggestions[0];
    const paySug = analyzed.body.item.paymentSuggestions[0];
    const replySug = analyzed.body.item.replySuggestions[0];
    assert.ok(taskSug);
    assert.ok(paySug);
    assert.ok(replySug);

    // Cannot apply while pending
    const premature = await auth(
      request(app).post(`/inbox/${item.id}/task-suggestions/${taskSug.id}/apply`)
    ).expect(409);
    assert.equal(premature.body.error.includes('approved'), true);

    await auth(request(app).post(`/inbox/${item.id}/task-suggestions/${taskSug.id}/approve`)).expect(
      200
    );
    const appliedTask = await auth(
      request(app).post(`/inbox/${item.id}/task-suggestions/${taskSug.id}/apply`)
    ).expect(200);
    assert.equal(appliedTask.body.suggestion.status, 'APPLIED');
    assert.equal(appliedTask.body.idempotent, false);
    assert.ok(appliedTask.body.task.id);
    assert.equal(appliedTask.body.task.inboxItemId, item.id);
    assert.equal(appliedTask.body.task.source, 'AI');

    const appliedAgain = await auth(
      request(app).post(`/inbox/${item.id}/task-suggestions/${taskSug.id}/apply`)
    ).expect(200);
    assert.equal(appliedAgain.body.idempotent, true);
    assert.equal(appliedAgain.body.task.id, appliedTask.body.task.id);

    const taskRow = await prisma.task.findUnique({ where: { id: appliedTask.body.task.id } });
    assert.equal(taskRow.inboxItemId, item.id);
    const sugRow = await prisma.inboxTaskSuggestion.findUnique({ where: { id: taskSug.id } });
    assert.equal(sugRow.appliedTaskId, taskRow.id);

    await auth(request(app).post(`/inbox/${item.id}/payment-suggestions/${paySug.id}/approve`)).expect(
      200
    );
    const appliedPay = await auth(
      request(app).post(`/inbox/${item.id}/payment-suggestions/${paySug.id}/apply`)
    ).expect(200);
    assert.equal(appliedPay.body.suggestion.status, 'APPLIED');
    assert.equal(appliedPay.body.payment.source, 'AI');
    assert.equal(appliedPay.body.payment.inboxItemId, item.id);

    const appliedPayAgain = await auth(
      request(app).post(`/inbox/${item.id}/payment-suggestions/${paySug.id}/apply`)
    ).expect(200);
    assert.equal(appliedPayAgain.body.idempotent, true);
    assert.equal(appliedPayAgain.body.payment.id, appliedPay.body.payment.id);

    await auth(request(app).post(`/inbox/${item.id}/reply-suggestions/${replySug.id}/approve`)).expect(
      200
    );
    const appliedReply = await auth(
      request(app).post(`/inbox/${item.id}/reply-suggestions/${replySug.id}/apply`)
    ).expect(200);
    assert.equal(appliedReply.body.suggestion.status, 'APPLIED');
    const appliedReplyAgain = await auth(
      request(app).post(`/inbox/${item.id}/reply-suggestions/${replySug.id}/apply`)
    ).expect(200);
    assert.equal(appliedReplyAgain.body.idempotent, true);

    // Reject path on a fresh suggestion
    const item2 = await createItem(account.id, {
      subject: '[test-inbox] Reject path please confirm?',
      rawContent: 'Can you reply please?',
    });
    const analyzed2 = await auth(request(app).post(`/inbox/${item2.id}/analyze`)).expect(200);
    const reply2 = analyzed2.body.item.replySuggestions[0];
    await auth(request(app).post(`/inbox/${item2.id}/reply-suggestions/${reply2.id}/reject`)).expect(
      200
    );
    const rejectApplied = await auth(
      request(app).post(`/inbox/${item2.id}/reply-suggestions/${reply2.id}/apply`)
    ).expect(409);
    assert.equal(rejectApplied.body.error.includes('approved'), true);

    // Wrong item / missing suggestion
    await auth(
      request(app).post(`/inbox/${item.id}/task-suggestions/missing/approve`)
    ).expect(404);
    await auth(
      request(app).post(`/inbox/${item2.id}/task-suggestions/${taskSug.id}/approve`)
    ).expect(404);
  });

  it('persists independent sync cursors per account via service hooks', async () => {
    const a = await createAccount({ name: '[test-inbox] Sync A' });
    const b = await createAccount({ name: '[test-inbox] Sync B' });

    const provider = inbox.getStubSyncProvider();
    const savedA = await provider.saveSyncCursor(
      { id: a.id, source: a.source, name: a.name },
      'gmail-cursor-aaa'
    );
    const savedB = await provider.saveSyncCursor(
      { id: b.id, source: b.source, name: b.name },
      'gmail-cursor-bbb'
    );
    assert.equal(savedA.syncCursor, 'gmail-cursor-aaa');
    assert.equal(savedB.syncCursor, 'gmail-cursor-bbb');
    assert.ok(savedA.lastSyncedAt);
    assert.notEqual(savedA.syncCursor, savedB.syncCursor);

    const providerForSource = inbox.getSyncProviderForSource('GMAIL');
    const listed = await providerForSource.listNewMessages({ id: a.id }, savedA.syncCursor);
    assert.deepEqual(listed.messages, []);
  });

  it('marks item FAILED when analysis provider throws (safe error)', async () => {
    const account = await createAccount({ name: '[test-inbox] Fail Acc' });
    const item = await createItem(account.id, { subject: '[test-inbox] Will fail analyze' });

    inbox.setAnalysisProvider({
      analyze: async () => {
        throw new Error('provider boom with secret token xyz');
      },
    });

    const res = await auth(request(app).post(`/inbox/${item.id}/analyze`)).expect(500);
    assert.equal(res.body.error, 'Failed to analyze inbox item');
    assert.equal(JSON.stringify(res.body).includes('token'), false);
    assert.equal(JSON.stringify(res.body).includes('boom'), false);

    const detail = await auth(request(app).get(`/inbox/${item.id}`)).expect(200);
    assert.equal(detail.body.status, 'FAILED');
  });

  it('covers suggestion edge transitions, empty analysis, and update receivedAt', async () => {
    const account = await createAccount({ name: '[test-inbox] Edges Acc' });
    const item = await createItem(account.id, {
      subject: '[test-inbox] Edges please pay EUR 10.00 due 2026-08-01 and confirm?',
      rawContent: 'Please pay €10.00 due 2026-08-01. Reply?',
    });
    const analyzed = await auth(request(app).post(`/inbox/${item.id}/analyze`)).expect(200);
    const taskSug = analyzed.body.item.taskSuggestions[0];
    const paySug = analyzed.body.item.paymentSuggestions[0];
    const replySug = analyzed.body.item.replySuggestions[0];

    // Idempotent approve
    await auth(request(app).post(`/inbox/${item.id}/task-suggestions/${taskSug.id}/approve`)).expect(
      200
    );
    const approveAgain = await auth(
      request(app).post(`/inbox/${item.id}/task-suggestions/${taskSug.id}/approve`)
    ).expect(200);
    assert.equal(approveAgain.body.suggestion.status, 'APPROVED');

    await auth(request(app).post(`/inbox/${item.id}/payment-suggestions/${paySug.id}/approve`)).expect(
      200
    );
    await auth(
      request(app).post(`/inbox/${item.id}/payment-suggestions/${paySug.id}/approve`)
    ).expect(200);

    await auth(request(app).post(`/inbox/${item.id}/reply-suggestions/${replySug.id}/approve`)).expect(
      200
    );
    await auth(
      request(app).post(`/inbox/${item.id}/reply-suggestions/${replySug.id}/approve`)
    ).expect(200);

    // Reject pending/approved suggestions (fresh item)
    const itemReject = await createItem(account.id, {
      subject: '[test-inbox] Reject edges please?',
      rawContent: 'Please confirm?',
    });
    const analyzedReject = await auth(request(app).post(`/inbox/${itemReject.id}/analyze`)).expect(
      200
    );
    const taskR = analyzedReject.body.item.taskSuggestions[0];
    const payR = analyzedReject.body.item.paymentSuggestions[0] || null;
    const replyR = analyzedReject.body.item.replySuggestions[0];

    await auth(request(app).post(`/inbox/${itemReject.id}/task-suggestions/${taskR.id}/reject`)).expect(
      200
    );
    const rejectTaskAgain = await auth(
      request(app).post(`/inbox/${itemReject.id}/task-suggestions/${taskR.id}/reject`)
    ).expect(200);
    assert.equal(rejectTaskAgain.body.suggestion.status, 'REJECTED');

    if (payR) {
      await auth(
        request(app).post(`/inbox/${itemReject.id}/payment-suggestions/${payR.id}/reject`)
      ).expect(200);
      await auth(
        request(app).post(`/inbox/${itemReject.id}/payment-suggestions/${payR.id}/reject`)
      ).expect(200);
    }

    await auth(
      request(app).post(`/inbox/${itemReject.id}/reply-suggestions/${replyR.id}/reject`)
    ).expect(200);
    await auth(
      request(app).post(`/inbox/${itemReject.id}/reply-suggestions/${replyR.id}/reject`)
    ).expect(200);

    // Cannot reject applied
    await auth(request(app).post(`/inbox/${item.id}/task-suggestions/${taskSug.id}/apply`)).expect(200);
    const rejectApplied = await auth(
      request(app).post(`/inbox/${item.id}/task-suggestions/${taskSug.id}/reject`)
    ).expect(409);
    assert.equal(rejectApplied.body.error.includes('applied'), true);

    await auth(request(app).post(`/inbox/${item.id}/payment-suggestions/${paySug.id}/apply`)).expect(
      200
    );
    await auth(
      request(app).post(`/inbox/${item.id}/payment-suggestions/${paySug.id}/reject`)
    ).expect(409);

    await auth(request(app).post(`/inbox/${item.id}/reply-suggestions/${replySug.id}/apply`)).expect(
      200
    );
    await auth(
      request(app).post(`/inbox/${item.id}/reply-suggestions/${replySug.id}/reject`)
    ).expect(409);

    // Cannot approve applied
    await auth(
      request(app).post(`/inbox/${item.id}/task-suggestions/${taskSug.id}/approve`)
    ).expect(409);
    await auth(
      request(app).post(`/inbox/${item.id}/payment-suggestions/${paySug.id}/approve`)
    ).expect(409);
    await auth(
      request(app).post(`/inbox/${item.id}/reply-suggestions/${replySug.id}/approve`)
    ).expect(409);

    // Update receivedAt + patch sort/updatedAt
    const patched = await auth(request(app).patch(`/inbox/${item.id}`))
      .send({ receivedAt: '2026-07-21T08:00:00.000Z', summary: '[test-inbox] updated summary' })
      .expect(200);
    assert.equal(patched.body.receivedAt, '2026-07-21T08:00:00.000Z');

    const nullReceived = updateInboxItemSchema.parse({ receivedAt: null });
    assert.equal(nullReceived.receivedAt, null);
    await auth(request(app).patch(`/inbox/${item.id}`))
      .send({ receivedAt: null })
      .expect(200);

    // Empty analysis arrays still succeed
    inbox.setAnalysisProvider({
      analyze: async () => ({
        summary: 'Empty suggestions analysis',
        urgency: 'MEDIUM',
        confidence: 0.5,
        suggestedTasks: [],
        suggestedPayments: [],
        suggestedReplies: [],
      }),
    });
    const emptyItem = await createItem(account.id, {
      subject: '[test-inbox] Empty analysis',
      rawContent: 'plain note',
    });
    const emptyAnalyzed = await auth(request(app).post(`/inbox/${emptyItem.id}/analyze`)).expect(200);
    assert.equal(emptyAnalyzed.body.item.taskSuggestions.length, 0);
    assert.equal(emptyAnalyzed.body.item.paymentSuggestions.length, 0);
    assert.equal(emptyAnalyzed.body.item.replySuggestions.length, 0);
    assert.equal(emptyAnalyzed.body.item.status, 'READY_FOR_REVIEW');

    // Payment suggestion missing required apply fields
    const incomplete = await prisma.inboxPaymentSuggestion.create({
      data: {
        inboxItemId: emptyItem.id,
        status: 'APPROVED',
        confidence: 0.9,
        reason: 'incomplete',
        payeeName: '[test-inbox] Incomplete Payee',
        amount: null,
        currency: null,
        dueDate: null,
        businessUnit: null,
      },
    });
    const missingFields = await auth(
      request(app).post(`/inbox/${emptyItem.id}/payment-suggestions/${incomplete.id}/apply`)
    ).expect(409);
    assert.equal(missingFields.body.error.includes('missing required'), true);

    // Currency detection helpers
    assert.equal(detectAmount('Total €25.00').currency, 'EUR');
    assert.equal(detectAmount('Total £12.50').currency, 'GBP');
    const noSubject = await mockAnalyze({
      id: 'x',
      source: 'SMS',
      senderName: null,
      senderIdentifier: 'sms:123',
      subject: null,
      rawContent: 'hello',
      receivedAt: new Date(),
    });
    assert.ok(noSubject.summary.includes('sms:123'));
  });

  it('covers service helpers for FK create failures and serializers with suggestions', async () => {
    const account = await createAccount({ name: '[test-inbox] Service Acc' });
    const created = await inbox.createInboxItem({
      inboxAccountId: account.id,
      externalId: `test-inbox-svc-${Date.now()}`,
      senderIdentifier: 'svc@inbox-test.example',
      subject: '[test-inbox] svc',
      rawContent: 'body',
      receivedAt: '2026-07-20T10:00:00.000Z',
    });
    assert.ok(created.item);

    // Force unique via service again
    const dup = await inbox.createInboxItem({
      inboxAccountId: account.id,
      externalId: created.item.externalId,
      senderIdentifier: 'svc@inbox-test.example',
      subject: '[test-inbox] svc dup',
      rawContent: 'body',
      receivedAt: '2026-07-20T10:00:00.000Z',
    });
    assert.ok(dup.conflict);

    // Serialize suggestions
    const now = new Date();
    const taskSer = inbox.serializeTaskSuggestion({
      id: 't',
      inboxItemId: 'i',
      status: 'PENDING',
      confidence: 0.5,
      reason: 'r',
      title: 'title',
      description: null,
      priority: null,
      dueDate: now,
      contactId: null,
      evidence: ['e'],
      appliedTaskId: null,
      createdAt: now,
      updatedAt: now,
    });
    assert.equal(taskSer.dueDate, now.toISOString());
    const paySer = inbox.serializePaymentSuggestion({
      id: 'p',
      inboxItemId: 'i',
      status: 'PENDING',
      confidence: 0.5,
      reason: 'r',
      payeeName: 'Payee',
      amount: null,
      currency: null,
      dueDate: null,
      businessUnit: null,
      category: null,
      description: null,
      invoiceNumber: null,
      evidence: null,
      appliedPaymentId: null,
      createdAt: now,
      updatedAt: now,
    });
    assert.equal(paySer.amount, null);
    const replySer = inbox.serializeReplySuggestion({
      id: 'r',
      inboxItemId: 'i',
      status: 'PENDING',
      confidence: 0.5,
      reason: 'r',
      replyText: 'hi',
      evidence: null,
      createdAt: now,
      updatedAt: now,
    });
    assert.equal(replySer.replyText, 'hi');

    const withSuggestions = inbox.serializeInboxItem(
      {
        id: 'i',
        inboxAccountId: account.id,
        source: 'GMAIL',
        externalId: 'e',
        threadExternalId: null,
        senderName: null,
        senderIdentifier: 's',
        recipients: null,
        subject: null,
        rawContent: 'raw',
        summary: null,
        status: 'NEW',
        confidence: null,
        urgency: null,
        receivedAt: now,
        processedAt: now,
        createdAt: now,
        updatedAt: now,
        taskSuggestions: [],
        paymentSuggestions: [],
        replySuggestions: [],
      },
      { includeRawContent: true, includeSuggestions: true }
    );
    assert.ok(Array.isArray(withSuggestions.taskSuggestions));
    assert.ok(withSuggestions.processedAt);

    // Direct service rejects/approves for missing
    assert.equal((await inbox.rejectTaskSuggestion('missing', 'missing')).notFound, true);
    assert.equal((await inbox.rejectPaymentSuggestion('missing', 'missing')).notFound, true);
    assert.equal((await inbox.rejectReplySuggestion('missing', 'missing')).notFound, true);
    assert.equal((await inbox.approveTaskSuggestion('missing', 'missing')).notFound, true);
    assert.equal((await inbox.approvePaymentSuggestion('missing', 'missing')).notFound, true);
    assert.equal((await inbox.approveReplySuggestion('missing', 'missing')).notFound, true);
    assert.equal((await inbox.applyTaskSuggestion('missing', 'missing')).notFound, true);
    assert.equal((await inbox.applyPaymentSuggestion('missing', 'missing')).notFound, true);
    assert.equal((await inbox.applyReplySuggestion('missing', 'missing')).notFound, true);
    assert.equal(await inbox.updateInboxItem('missing', { status: 'NEW' }), null);
    assert.equal(await inbox.archiveInboxItem('missing'), null);
    assert.equal(await inbox.getAccountById('missing'), null);
    assert.equal(await inbox.updateAccount('missing', { name: 'x' }), null);
    assert.equal(await inbox.activateAccount('missing'), null);
    assert.equal(await inbox.deactivateAccount('missing'), null);

    // FK-style create failure
    const originalCreate = prisma.inboxItem.create.bind(prisma.inboxItem);
    prisma.inboxItem.create = async () => {
      const err = new Error('fk');
      err.code = 'P2003';
      throw err;
    };
    try {
      const fk = await inbox.createInboxItem({
        inboxAccountId: account.id,
        externalId: `test-inbox-fk-${Date.now()}`,
        senderIdentifier: 'fk@inbox-test.example',
        subject: '[test-inbox] fk',
        rawContent: 'x',
        receivedAt: '2026-07-20T10:00:00.000Z',
      });
      assert.equal(fk.notFoundAccount, true);
    } finally {
      prisma.inboxItem.create = originalCreate;
    }

    // list sort fallback
    const listed = await inbox.listInboxItems({
      page: 1,
      limit: 5,
      sort: 'not-a-real-sort',
      inboxAccountId: account.id,
    });
    assert.ok(Array.isArray(listed.data));

    // Persist cursor + resolve providers
    const persisted = await inbox.persistSyncCursor(account.id, 'cursor-z');
    assert.equal(persisted.syncCursor, 'cursor-z');
    assert.ok(inbox.getSyncProviderForSource('OUTLOOK'));
    assert.ok(inbox.getSyncProviderForSource('WHATSAPP'));
    assert.ok(inbox.getSyncProviderForSource('SMS'));
    assert.ok(inbox.getSyncProviderForSource('MANUAL'));
    assert.ok(inbox.getSyncProviderForSource('API'));
    assert.ok(inbox.getSyncProviderForSource('OTHER'));

    // Branch helpers
    assert.equal(inbox.canTransitionSuggestion('PENDING', 'REJECTED'), true);
    assert.equal(inbox.canTransitionSuggestion('APPLIED', 'REJECTED'), false);
    assert.equal(inbox.canTransitionSuggestion('PENDING', 'APPLIED'), false);

    const { Prisma } = require('@prisma/client');
    const withDecimal = inbox.serializePaymentSuggestion({
      id: 'p2',
      inboxItemId: 'i',
      status: 'PENDING',
      confidence: 0.5,
      reason: 'r',
      payeeName: 'Payee',
      amount: new Prisma.Decimal('12.5'),
      currency: 'USD',
      dueDate: null,
      businessUnit: 'HOUSE',
      category: null,
      description: null,
      invoiceNumber: null,
      evidence: null,
      appliedPaymentId: null,
      createdAt: now,
      updatedAt: now,
    });
    assert.equal(withDecimal.amount, '12.5000');

    // create rethrows non-unique/non-fk errors
    const originalCreate2 = prisma.inboxItem.create.bind(prisma.inboxItem);
    prisma.inboxItem.create = async () => {
      throw new Error('unexpected db failure');
    };
    try {
      await assert.rejects(
        () =>
          inbox.createInboxItem({
            inboxAccountId: account.id,
            externalId: `test-inbox-rethrow-${Date.now()}`,
            senderIdentifier: 're@inbox-test.example',
            subject: '[test-inbox] rethrow',
            rawContent: 'x',
            receivedAt: '2026-07-20T10:00:00.000Z',
          }),
        /unexpected db failure/
      );
    } finally {
      prisma.inboxItem.create = originalCreate2;
    }

    // Reject payment suggestion paths + apply with deleted payment row
    const rejectPayItem = await createItem(account.id, {
      subject: '[test-inbox] reject payment item',
      rawContent: 'x',
    });
    const paySugReject = await prisma.inboxPaymentSuggestion.create({
      data: {
        inboxItemId: rejectPayItem.id,
        status: 'PENDING',
        confidence: 0.7,
        reason: 'r',
        payeeName: '[test-inbox] Reject Payee',
        amount: '10.0000',
        currency: 'USD',
        dueDate: new Date('2026-08-01T00:00:00.000Z'),
        businessUnit: 'HOUSE',
      },
    });
    assert.equal(
      (await inbox.rejectPaymentSuggestion(rejectPayItem.id, paySugReject.id)).suggestion.status,
      'REJECTED'
    );
    assert.equal(
      (await inbox.rejectPaymentSuggestion(rejectPayItem.id, paySugReject.id)).suggestion.status,
      'REJECTED'
    );

    const payApplied = await prisma.inboxPaymentSuggestion.create({
      data: {
        inboxItemId: rejectPayItem.id,
        status: 'APPROVED',
        confidence: 0.7,
        reason: 'r',
        payeeName: '[test-inbox] Apply Payee',
        amount: '10.0000',
        currency: 'USD',
        dueDate: new Date('2026-08-01T00:00:00.000Z'),
        businessUnit: 'HOUSE',
      },
    });
    const applied = await inbox.applyPaymentSuggestion(rejectPayItem.id, payApplied.id);
    assert.equal(applied.suggestion.status, 'APPLIED');
    await prisma.payment.delete({ where: { id: applied.payment.id } });
    // onDelete SetNull clears appliedPaymentId — recreate APPLIED with live payment then stub find
    const livePay = await prisma.payment.create({
      data: {
        payeeName: '[test-inbox] Live',
        businessUnit: 'HOUSE',
        amount: '1.0000',
        currency: 'USD',
        dueDate: new Date('2026-08-01T00:00:00.000Z'),
        source: 'AI',
        inboxItemId: rejectPayItem.id,
      },
    });
    await prisma.inboxPaymentSuggestion.update({
      where: { id: payApplied.id },
      data: { status: 'APPLIED', appliedPaymentId: livePay.id },
    });
    const originalFindPay = prisma.payment.findUnique.bind(prisma.payment);
    prisma.payment.findUnique = async () => null;
    try {
      const missingPay = await inbox.applyPaymentSuggestion(rejectPayItem.id, payApplied.id);
      assert.equal(missingPay.idempotent, true);
      assert.equal(missingPay.payment.id, livePay.id);
    } finally {
      prisma.payment.findUnique = originalFindPay;
    }
    assert.equal(
      (await inbox.rejectPaymentSuggestion(rejectPayItem.id, payApplied.id)).conflict.includes(
        'applied'
      ),
      true
    );

    // Analysis branch coverage
    const usd = await mockAnalyze({
      id: '1',
      source: 'GMAIL',
      senderName: 'A',
      senderIdentifier: 'a@b.com',
      subject: 'Bill',
      rawContent: 'Please pay $99.00 today for this bill',
      receivedAt: new Date(),
    });
    assert.equal(usd.urgency, 'HIGH');
    assert.ok(usd.suggestedPayments[0].amount);

    const gbp = detectAmount('Charge GBP 20');
    assert.equal(gbp.currency, 'GBP');

    const invoiceNoAmount = await mockAnalyze({
      id: '2',
      source: 'GMAIL',
      senderName: 'B',
      senderIdentifier: 'b@b.com',
      subject: 'Invoice reminder',
      rawContent: 'This invoice needs remittance whenever.',
      receivedAt: new Date(),
    });
    assert.ok(invoiceNoAmount.suggestedPayments[0].confidence < 0.9);

    // recipients null schema path
    assert.equal(createInboxItemSchema.parse({
      inboxAccountId: 'a',
      externalId: 'e',
      senderIdentifier: 's',
      rawContent: 'r',
      receivedAt: '2026-07-20T10:00:00.000Z',
      recipients: null,
    }).recipients, null);
  });
});

describe('Inbox concurrency, re-analysis, safety, and route order', () => {
  let app;
  let prisma;

  before(async () => {
    process.env.DATABASE_URL = DATABASE_URL;
    const env = loadEnv(VALID_ENV);
    app = createApp(env);
    prisma = getPrisma();
    await prisma.$queryRaw`SELECT 1`;
  });

  after(async () => {
    await cleanup();
    await disconnectPrisma();
  });

  async function cleanup() {
    await prisma.inboxReplySuggestion.deleteMany({
      where: { inboxItem: { subject: { startsWith: '[test-inbox-safe]' } } },
    });
    await prisma.inboxPaymentSuggestion.deleteMany({
      where: { inboxItem: { subject: { startsWith: '[test-inbox-safe]' } } },
    });
    await prisma.inboxTaskSuggestion.deleteMany({
      where: { inboxItem: { subject: { startsWith: '[test-inbox-safe]' } } },
    });
    await prisma.task.deleteMany({
      where: {
        OR: [
          { title: { startsWith: '[test-inbox-safe]' } },
          { inboxItem: { subject: { startsWith: '[test-inbox-safe]' } } },
        ],
      },
    });
    await prisma.payment.deleteMany({
      where: {
        OR: [
          { payeeName: { startsWith: '[test-inbox-safe]' } },
          { inboxItem: { subject: { startsWith: '[test-inbox-safe]' } } },
        ],
      },
    });
    await prisma.inboxItem.deleteMany({
      where: {
        OR: [
          { subject: { startsWith: '[test-inbox-safe]' } },
          { externalId: { startsWith: 'test-inbox-safe-' } },
        ],
      },
    });
    await prisma.inboxAccount.deleteMany({
      where: { name: { startsWith: '[test-inbox-safe]' } },
    });
  }

  beforeEach(async () => {
    await cleanup();
    inbox.resetAnalysisProvider();
  });

  afterEach(async () => {
    await cleanup();
    inbox.resetAnalysisProvider();
  });

  async function createAccount(overrides = {}) {
    const res = await auth(request(app).post('/inbox/accounts'))
      .send({
        name: overrides.name || '[test-inbox-safe] Acc',
        source: overrides.source || 'GMAIL',
        emailAddress: overrides.emailAddress || `safe-${Date.now()}@inbox-test.example`,
        isActive: overrides.isActive,
      })
      .expect(201);
    return res.body;
  }

  async function createItem(accountId, overrides = {}) {
    const res = await auth(request(app).post('/inbox'))
      .send({
        inboxAccountId: accountId,
        externalId: overrides.externalId || `test-inbox-safe-${Date.now()}-${Math.random()}`,
        senderIdentifier: overrides.senderIdentifier || `safe-${Date.now()}@inbox-test.example`,
        subject: overrides.subject || '[test-inbox-safe] Subject',
        rawContent: overrides.rawContent || 'Please pay ILS 50.00 due 2026-08-01 and confirm?',
        receivedAt: overrides.receivedAt || '2026-07-20T10:00:00.000Z',
      })
      .expect(201);
    return res.body;
  }

  it('createApp middleware order: auth before catch-all; /accounts not captured as :id', async () => {
    const unauth = await request(app).get('/inbox');
    assert.equal(unauth.status, 401);
    assert.notEqual(unauth.status, 404);

    const listed = await auth(request(app).get('/inbox')).expect(200);
    assert.ok(Array.isArray(listed.body.data));
    assert.ok(listed.body.pagination);

    const accounts = await auth(request(app).get('/inbox/accounts')).expect(200);
    assert.ok(Array.isArray(accounts.body.data));
    // Must not be treated as GET /inbox/:id ("accounts" as id → 404 item)
    assert.equal(accounts.body.error, undefined);

    const account = await createAccount({ name: '[test-inbox-safe] Route Acc' });
    const item = await createItem(account.id, { subject: '[test-inbox-safe] Analyze route' });
    const analyzed = await auth(request(app).post(`/inbox/${item.id}/analyze`)).expect(200);
    assert.equal(analyzed.body.item.status, 'READY_FOR_REVIEW');
    assert.ok(analyzed.body.analysis);

    const missing = await request(app).get('/no-such-route-inbox-order').expect(404);
    assert.equal(missing.body.error, 'Not found');
  });

  it('deactivating an account is non-destructive and rejects new ingestion', async () => {
    const account = await createAccount({ name: '[test-inbox-safe] Deactivate Acc' });
    const existing = await createItem(account.id, { subject: '[test-inbox-safe] Keep me' });

    const deactivated = await auth(request(app).post(`/inbox/accounts/${account.id}/deactivate`)).expect(
      200
    );
    assert.equal(deactivated.body.isActive, false);

    // Existing item still readable; account row still present (no destructive delete).
    const stillThere = await auth(request(app).get(`/inbox/${existing.id}`)).expect(200);
    assert.equal(stillThere.body.id, existing.id);
    const accountStill = await auth(request(app).get(`/inbox/accounts/${account.id}`)).expect(200);
    assert.equal(accountStill.body.id, account.id);
    assert.equal(accountStill.body.isActive, false);

    // No DELETE /inbox/accounts/:id route — falls through to item :id handler → 404 item.
    const deleteAttempt = await auth(request(app).delete(`/inbox/accounts/${account.id}`));
    assert.ok([404, 401].includes(deleteAttempt.status) || deleteAttempt.status >= 400);

    const rejected = await auth(request(app).post('/inbox')).send({
      inboxAccountId: account.id,
      externalId: `test-inbox-safe-inactive-${Date.now()}`,
      senderIdentifier: 'inactive@inbox-test.example',
      subject: '[test-inbox-safe] Should reject',
      rawContent: 'nope',
      receivedAt: '2026-07-20T10:00:00.000Z',
    });
    assert.equal(rejected.status, 409);
    assert.equal(rejected.body.error, 'Inbox account is inactive');
    assert.equal(JSON.stringify(rejected.body).includes('Prisma'), false);
  });

  it('enforces account isolation, suggestion ownership, and type separation', async () => {
    const a = await createAccount({ name: '[test-inbox-safe] Iso A' });
    const b = await createAccount({ name: '[test-inbox-safe] Iso B' });
    const sharedExt = `test-inbox-safe-shared-${Date.now()}`;

    const itemA = await createItem(a.id, {
      externalId: sharedExt,
      subject: '[test-inbox-safe] A item',
      rawContent: 'Please schedule pickup and pay ILS 10.00 due 2026-08-01?',
    });
    const itemB = await createItem(b.id, {
      externalId: sharedExt,
      subject: '[test-inbox-safe] B item',
    });
    assert.equal(itemA.externalId, itemB.externalId);
    assert.notEqual(itemA.id, itemB.id);

    const dup = await auth(request(app).post('/inbox')).send({
      inboxAccountId: a.id,
      externalId: sharedExt,
      senderIdentifier: 'dup@inbox-test.example',
      subject: '[test-inbox-safe] Dup',
      rawContent: 'dup',
      receivedAt: '2026-07-20T11:00:00.000Z',
    });
    assert.equal(dup.status, 409);
    assert.equal(JSON.stringify(dup.body).includes('P2002'), false);
    assert.equal(JSON.stringify(dup.body).includes('DATABASE_URL'), false);

    const listA = await auth(request(app).get(`/inbox?inboxAccountId=${a.id}`)).expect(200);
    assert.ok(listA.body.data.every((row) => row.inboxAccountId === a.id));
    assert.equal(
      listA.body.data.every((row) => !Object.prototype.hasOwnProperty.call(row, 'rawContent')),
      true
    );

    const analyzed = await auth(request(app).post(`/inbox/${itemA.id}/analyze`)).expect(200);
    const taskSug = analyzed.body.item.taskSuggestions[0];
    const paySug = analyzed.body.item.paymentSuggestions[0];
    const replySug = analyzed.body.item.replySuggestions[0];

    // suggestionId must belong to the item in the URL
    await auth(
      request(app).post(`/inbox/${itemB.id}/task-suggestions/${taskSug.id}/approve`)
    ).expect(404);

    // Cannot mix suggestion types across endpoints
    await auth(
      request(app).post(`/inbox/${itemA.id}/payment-suggestions/${taskSug.id}/approve`)
    ).expect(404);
    await auth(
      request(app).post(`/inbox/${itemA.id}/task-suggestions/${paySug.id}/approve`)
    ).expect(404);
    await auth(
      request(app).post(`/inbox/${itemA.id}/reply-suggestions/${taskSug.id}/approve`)
    ).expect(404);
    assert.ok(replySug);
  });

  it('applies task/payment suggestions concurrently with at most one entity each', async () => {
    const account = await createAccount({ name: '[test-inbox-safe] Concurrent Acc' });
    const item = await createItem(account.id, {
      subject: '[test-inbox-safe] Concurrent apply please pay ILS 75.00 due 2026-09-01',
      rawContent: 'Please schedule this and pay ILS 75.00 due 2026-09-01?',
    });
    const analyzed = await auth(request(app).post(`/inbox/${item.id}/analyze`)).expect(200);
    const taskSug = analyzed.body.item.taskSuggestions[0];
    const paySug = analyzed.body.item.paymentSuggestions[0];
    const replySug = analyzed.body.item.replySuggestions[0];
    assert.ok(taskSug && paySug && replySug);

    await auth(request(app).post(`/inbox/${item.id}/task-suggestions/${taskSug.id}/approve`)).expect(
      200
    );
    await auth(
      request(app).post(`/inbox/${item.id}/payment-suggestions/${paySug.id}/approve`)
    ).expect(200);
    await auth(
      request(app).post(`/inbox/${item.id}/reply-suggestions/${replySug.id}/approve`)
    ).expect(200);

    const [t1, t2, t3] = await Promise.all([
      auth(request(app).post(`/inbox/${item.id}/task-suggestions/${taskSug.id}/apply`)),
      auth(request(app).post(`/inbox/${item.id}/task-suggestions/${taskSug.id}/apply`)),
      auth(request(app).post(`/inbox/${item.id}/task-suggestions/${taskSug.id}/apply`)),
    ]);
    for (const res of [t1, t2, t3]) {
      assert.ok([200, 409].includes(res.status), `unexpected status ${res.status}`);
      assert.equal(JSON.stringify(res.body).includes('Prisma'), false);
      assert.equal(JSON.stringify(res.body).includes('P20'), false);
    }
    const taskBodies = [t1, t2, t3].filter((r) => r.status === 200);
    assert.ok(taskBodies.length >= 1);
    const taskIds = new Set(taskBodies.map((r) => r.body.task.id));
    assert.equal(taskIds.size, 1);
    const taskCount = await prisma.task.count({
      where: { inboxItemId: item.id, source: 'AI' },
    });
    assert.equal(taskCount, 1);
    const taskSugRow = await prisma.inboxTaskSuggestion.findUnique({ where: { id: taskSug.id } });
    assert.equal(taskSugRow.status, 'APPLIED');
    assert.equal(taskSugRow.appliedTaskId, [...taskIds][0]);

    const again = await auth(
      request(app).post(`/inbox/${item.id}/task-suggestions/${taskSug.id}/apply`)
    ).expect(200);
    assert.equal(again.body.idempotent, true);
    assert.equal(again.body.task.id, [...taskIds][0]);

    const [p1, p2, p3] = await Promise.all([
      auth(request(app).post(`/inbox/${item.id}/payment-suggestions/${paySug.id}/apply`)),
      auth(request(app).post(`/inbox/${item.id}/payment-suggestions/${paySug.id}/apply`)),
      auth(request(app).post(`/inbox/${item.id}/payment-suggestions/${paySug.id}/apply`)),
    ]);
    for (const res of [p1, p2, p3]) {
      assert.ok([200, 409].includes(res.status));
      assert.equal(JSON.stringify(res.body).includes('Prisma'), false);
    }
    const payBodies = [p1, p2, p3].filter((r) => r.status === 200);
    assert.ok(payBodies.length >= 1);
    const paymentIds = new Set(payBodies.map((r) => r.body.payment.id));
    assert.equal(paymentIds.size, 1);
    const paymentCount = await prisma.payment.count({
      where: { inboxItemId: item.id, source: 'AI' },
    });
    assert.equal(paymentCount, 1);

    const [r1, r2] = await Promise.all([
      auth(request(app).post(`/inbox/${item.id}/reply-suggestions/${replySug.id}/apply`)),
      auth(request(app).post(`/inbox/${item.id}/reply-suggestions/${replySug.id}/apply`)),
    ]);
    assert.ok([200, 409].includes(r1.status));
    assert.ok([200, 409].includes(r2.status));
    const replyRow = await prisma.inboxReplySuggestion.findUnique({ where: { id: replySug.id } });
    assert.equal(replyRow.status, 'APPLIED');
  });

  it('repeated analysis replaces non-applied suggestions and preserves APPLIED', async () => {
    const account = await createAccount({ name: '[test-inbox-safe] Reanalyze Acc' });
    const item = await createItem(account.id, {
      subject: '[test-inbox-safe] Reanalyze please pay ILS 20.00 due 2026-08-15',
      rawContent: 'Please pay ILS 20.00 due 2026-08-15 and reply?',
    });

    const first = await auth(request(app).post(`/inbox/${item.id}/analyze`)).expect(200);
    const firstTaskIds = first.body.item.taskSuggestions.map((s) => s.id).sort();
    const firstPendingCount =
      first.body.item.taskSuggestions.length +
      first.body.item.paymentSuggestions.length +
      first.body.item.replySuggestions.length;
    assert.ok(firstPendingCount >= 1);

    // Accidental repeated analysis — replaces pending, no duplicates of prior pending ids
    const second = await auth(request(app).post(`/inbox/${item.id}/analyze`)).expect(200);
    const secondTaskIds = second.body.item.taskSuggestions.map((s) => s.id).sort();
    assert.notDeepEqual(secondTaskIds, firstTaskIds);
    assert.ok(second.body.item.taskSuggestions.every((s) => s.status === 'PENDING'));

    // Apply one task suggestion, then re-analyze — APPLIED preserved
    const toApply = second.body.item.taskSuggestions[0];
    await auth(request(app).post(`/inbox/${item.id}/task-suggestions/${toApply.id}/approve`)).expect(
      200
    );
    const applied = await auth(
      request(app).post(`/inbox/${item.id}/task-suggestions/${toApply.id}/apply`)
    ).expect(200);
    assert.equal(applied.body.suggestion.status, 'APPLIED');

    const third = await auth(request(app).post(`/inbox/${item.id}/analyze`)).expect(200);
    const appliedStill = third.body.item.taskSuggestions.filter((s) => s.status === 'APPLIED');
    assert.equal(appliedStill.length, 1);
    assert.equal(appliedStill[0].id, toApply.id);
    assert.equal(appliedStill[0].appliedTaskId, applied.body.task.id);
    assert.ok(third.body.item.taskSuggestions.some((s) => s.status === 'PENDING'));
  });

  it('analysis failure rolls back suggestion writes and does not stay PROCESSING', async () => {
    const account = await createAccount({ name: '[test-inbox-safe] Fail Tx Acc' });
    const item = await createItem(account.id, {
      subject: '[test-inbox-safe] Fail tx',
      rawContent: 'Please confirm?',
    });

    // Seed pending suggestions via successful analysis first
    await auth(request(app).post(`/inbox/${item.id}/analyze`)).expect(200);
    const beforeTasks = await prisma.inboxTaskSuggestion.count({ where: { inboxItemId: item.id } });
    const beforePays = await prisma.inboxPaymentSuggestion.count({ where: { inboxItemId: item.id } });
    const beforeReplies = await prisma.inboxReplySuggestion.count({
      where: { inboxItemId: item.id },
    });
    assert.ok(beforeTasks + beforePays + beforeReplies > 0);

    const originalTx = prisma.$transaction.bind(prisma);
    prisma.$transaction = async () => {
      throw new Error('simulated mid-analysis failure with SELECT * FROM secret');
    };
    try {
      const failed = await auth(request(app).post(`/inbox/${item.id}/analyze`)).expect(500);
      assert.equal(failed.body.error, 'Failed to analyze inbox item');
      assert.equal(JSON.stringify(failed.body).includes('SELECT'), false);
      assert.equal(JSON.stringify(failed.body).includes('secret'), false);
      assert.equal(JSON.stringify(failed.body).includes('Prisma'), false);
    } finally {
      prisma.$transaction = originalTx;
    }

    const detail = await auth(request(app).get(`/inbox/${item.id}`)).expect(200);
    assert.equal(detail.body.status, 'FAILED');
    assert.notEqual(detail.body.status, 'PROCESSING');

    // Prior suggestions unchanged (transaction never applied deletes/creates)
    assert.equal(
      await prisma.inboxTaskSuggestion.count({ where: { inboxItemId: item.id } }),
      beforeTasks
    );
    assert.equal(
      await prisma.inboxPaymentSuggestion.count({ where: { inboxItemId: item.id } }),
      beforePays
    );
    assert.equal(
      await prisma.inboxReplySuggestion.count({ where: { inboxItemId: item.id } }),
      beforeReplies
    );
  });

  it('responses omit secrets and list omits rawContent', async () => {
    const account = await createAccount({ name: '[test-inbox-safe] Secret Acc' });
    const item = await createItem(account.id, {
      subject: '[test-inbox-safe] Secret body',
      rawContent: 'TOP-SECRET-RAW-BODY oauth_token=xyz DATABASE_URL=postgres://',
    });
    const listed = await auth(request(app).get('/inbox?q=Secret%20body')).expect(200);
    const row = listed.body.data.find((d) => d.id === item.id);
    assert.ok(row);
    assert.equal(Object.prototype.hasOwnProperty.call(row, 'rawContent'), false);
    assert.equal(JSON.stringify(listed.body).includes('TOP-SECRET-RAW-BODY'), false);
    assert.equal(JSON.stringify(listed.body).includes('oauth_token'), false);
    assert.equal(JSON.stringify(account).includes('refresh_token'), false);
  });

  it('apply failures return safe conflict without Prisma details', async () => {
    const account = await createAccount({ name: '[test-inbox-safe] Apply Fail Acc' });
    const item = await createItem(account.id, {
      subject: '[test-inbox-safe] Apply fail please pay ILS 5.00 due 2026-08-20',
      rawContent: 'Please pay ILS 5.00 due 2026-08-20?',
    });
    const analyzed = await auth(request(app).post(`/inbox/${item.id}/analyze`)).expect(200);
    const taskSug = analyzed.body.item.taskSuggestions[0];
    const paySug = analyzed.body.item.paymentSuggestions[0];
    const replySug = analyzed.body.item.replySuggestions[0];
    await auth(request(app).post(`/inbox/${item.id}/task-suggestions/${taskSug.id}/approve`)).expect(
      200
    );
    await auth(
      request(app).post(`/inbox/${item.id}/payment-suggestions/${paySug.id}/approve`)
    ).expect(200);
    await auth(
      request(app).post(`/inbox/${item.id}/reply-suggestions/${replySug.id}/approve`)
    ).expect(200);

    const originalTx = prisma.$transaction.bind(prisma);
    prisma.$transaction = async () => {
      throw new Error('PrismaClientKnownRequestError P2002 unique');
    };
    try {
      const taskFail = await auth(
        request(app).post(`/inbox/${item.id}/task-suggestions/${taskSug.id}/apply`)
      ).expect(409);
      assert.equal(taskFail.body.error, 'Failed to apply task suggestion');
      assert.equal(JSON.stringify(taskFail.body).includes('P2002'), false);
      assert.equal(JSON.stringify(taskFail.body).includes('Prisma'), false);

      const payFail = await auth(
        request(app).post(`/inbox/${item.id}/payment-suggestions/${paySug.id}/apply`)
      ).expect(409);
      assert.equal(payFail.body.error, 'Failed to apply payment suggestion');
      assert.equal(JSON.stringify(payFail.body).includes('P2002'), false);

      const replyFail = await auth(
        request(app).post(`/inbox/${item.id}/reply-suggestions/${replySug.id}/apply`)
      ).expect(409);
      assert.equal(replyFail.body.error, 'Failed to apply reply suggestion');
    } finally {
      prisma.$transaction = originalTx;
    }
  });
});

describe('Inbox API error paths', () => {
  let app;
  const originals = {};

  before(() => {
    process.env.DATABASE_URL = DATABASE_URL;
    const env = loadEnv(VALID_ENV);
    app = express();
    app.use(express.json());
    app.use('/inbox', createInboxRouter({ adminAuth: requireAdmin(env) }));
  });

  afterEach(() => {
    for (const key of Object.keys(originals)) {
      inbox[key] = originals[key];
      delete originals[key];
    }
  });

  function stubInboxFn(name, impl) {
    if (!(name in originals)) {
      originals[name] = inbox[name];
    }
    inbox[name] = impl;
  }

  it('returns 500 with safe messages when services throw', async () => {
    stubInboxFn('listAccounts', async () => {
      throw new Error('Prisma Client details');
    });
    const listAcc = await auth(request(app).get('/inbox/accounts')).expect(500);
    assert.equal(listAcc.body.error, 'Failed to list inbox accounts');
    assert.equal(JSON.stringify(listAcc.body).includes('Prisma'), false);

    stubInboxFn('createAccount', async () => {
      throw new Error('create boom');
    });
    await auth(request(app).post('/inbox/accounts'))
      .send({ name: 'X', source: 'MANUAL' })
      .expect(500);

    stubInboxFn('getAccountById', async () => {
      throw new Error('get boom');
    });
    await auth(request(app).get('/inbox/accounts/abc')).expect(500);

    stubInboxFn('updateAccount', async () => {
      throw new Error('update boom');
    });
    await auth(request(app).patch('/inbox/accounts/abc')).send({ name: 'Y' }).expect(500);

    stubInboxFn('activateAccount', async () => {
      throw new Error('activate boom');
    });
    await auth(request(app).post('/inbox/accounts/abc/activate')).expect(500);

    stubInboxFn('deactivateAccount', async () => {
      throw new Error('deactivate boom');
    });
    await auth(request(app).post('/inbox/accounts/abc/deactivate')).expect(500);

    stubInboxFn('listInboxItems', async () => {
      throw new Error('list boom');
    });
    await auth(request(app).get('/inbox')).expect(500);

    stubInboxFn('createInboxItem', async () => {
      throw new Error('create item boom');
    });
    await auth(request(app).post('/inbox'))
      .send({
        inboxAccountId: 'a',
        externalId: 'e',
        senderIdentifier: 's',
        rawContent: 'r',
        receivedAt: '2026-07-20T10:00:00.000Z',
      })
      .expect(500);

    stubInboxFn('getInboxItemById', async () => {
      throw new Error('get item boom');
    });
    await auth(request(app).get('/inbox/abc')).expect(500);

    stubInboxFn('updateInboxItem', async () => {
      throw new Error('patch boom');
    });
    await auth(request(app).patch('/inbox/abc')).send({ status: 'NEW' }).expect(500);

    stubInboxFn('analyzeInboxItem', async () => {
      throw new Error('analyze boom');
    });
    await auth(request(app).post('/inbox/abc/analyze')).expect(500);

    stubInboxFn('archiveInboxItem', async () => {
      throw new Error('archive boom');
    });
    await auth(request(app).post('/inbox/abc/archive')).expect(500);

    stubInboxFn('approveTaskSuggestion', async () => {
      throw new Error('approve boom');
    });
    await auth(request(app).post('/inbox/abc/task-suggestions/s1/approve')).expect(500);

    stubInboxFn('rejectTaskSuggestion', async () => {
      throw new Error('reject boom');
    });
    await auth(request(app).post('/inbox/abc/task-suggestions/s1/reject')).expect(500);

    stubInboxFn('applyTaskSuggestion', async () => {
      throw new Error('apply boom');
    });
    await auth(request(app).post('/inbox/abc/task-suggestions/s1/apply')).expect(500);

    stubInboxFn('approvePaymentSuggestion', async () => {
      throw new Error('pay approve boom');
    });
    await auth(request(app).post('/inbox/abc/payment-suggestions/s1/approve')).expect(500);

    stubInboxFn('rejectPaymentSuggestion', async () => {
      throw new Error('pay reject boom');
    });
    await auth(request(app).post('/inbox/abc/payment-suggestions/s1/reject')).expect(500);

    stubInboxFn('applyPaymentSuggestion', async () => {
      throw new Error('pay apply boom');
    });
    await auth(request(app).post('/inbox/abc/payment-suggestions/s1/apply')).expect(500);

    stubInboxFn('approveReplySuggestion', async () => {
      throw new Error('reply approve boom');
    });
    await auth(request(app).post('/inbox/abc/reply-suggestions/s1/approve')).expect(500);

    stubInboxFn('rejectReplySuggestion', async () => {
      throw new Error('reply reject boom');
    });
    await auth(request(app).post('/inbox/abc/reply-suggestions/s1/reject')).expect(500);

    stubInboxFn('applyReplySuggestion', async () => {
      throw new Error('reply apply boom');
    });
    await auth(request(app).post('/inbox/abc/reply-suggestions/s1/apply')).expect(500);
  });

  it('maps conflict/notFound suggestion results without leaking internals', async () => {
    stubInboxFn('approveTaskSuggestion', async () => ({
      conflict: 'Cannot approve a applied suggestion',
    }));
    const conflict = await auth(request(app).post('/inbox/abc/task-suggestions/s1/approve')).expect(
      409
    );
    assert.equal(conflict.body.error.includes('approve'), true);

    stubInboxFn('applyPaymentSuggestion', async () => ({ notFound: true }));
    await auth(request(app).post('/inbox/abc/payment-suggestions/s1/apply')).expect(404);

    stubInboxFn('rejectPaymentSuggestion', async () => ({
      suggestion: { id: 's1', status: 'REJECTED' },
    }));
    await auth(request(app).post('/inbox/abc/payment-suggestions/s1/reject')).expect(200);

    stubInboxFn('rejectReplySuggestion', async () => ({ notFound: true }));
    await auth(request(app).post('/inbox/abc/reply-suggestions/s1/reject')).expect(404);

    stubInboxFn('approveReplySuggestion', async () => ({
      suggestion: { id: 's1', status: 'APPROVED' },
    }));
    await auth(request(app).post('/inbox/abc/reply-suggestions/s1/approve')).expect(200);

    stubInboxFn('applyReplySuggestion', async () => ({
      suggestion: { id: 's1', status: 'APPLIED' },
      idempotent: true,
    }));
    await auth(request(app).post('/inbox/abc/reply-suggestions/s1/apply')).expect(200);
  });

  it('returns 400 when suggestion params fail validation', async () => {
    const original = schemas.suggestionParamSchema.safeParse;
    schemas.suggestionParamSchema.safeParse = () => ({
      success: false,
      error: {
        issues: [{ path: ['suggestionId'], message: 'suggestionId is required' }],
      },
    });
    try {
      await auth(request(app).post('/inbox/abc/task-suggestions/s1/approve')).expect(400);
      await auth(request(app).post('/inbox/abc/task-suggestions/s1/reject')).expect(400);
      await auth(request(app).post('/inbox/abc/task-suggestions/s1/apply')).expect(400);
      await auth(request(app).post('/inbox/abc/payment-suggestions/s1/approve')).expect(400);
      await auth(request(app).post('/inbox/abc/payment-suggestions/s1/reject')).expect(400);
      await auth(request(app).post('/inbox/abc/payment-suggestions/s1/apply')).expect(400);
      await auth(request(app).post('/inbox/abc/reply-suggestions/s1/approve')).expect(400);
      await auth(request(app).post('/inbox/abc/reply-suggestions/s1/reject')).expect(400);
      await auth(request(app).post('/inbox/abc/reply-suggestions/s1/apply')).expect(400);
    } finally {
      schemas.suggestionParamSchema.safeParse = original;
    }
  });

  it('returns 400 when id/body validation fails on item routes', async () => {
    const originalId = schemas.idParamSchema.safeParse;
    schemas.idParamSchema.safeParse = () => ({
      success: false,
      error: { issues: [{ path: ['id'], message: 'id is required' }] },
    });
    try {
      await auth(request(app).get('/inbox/abc')).expect(400);
      await auth(request(app).patch('/inbox/abc').send({ status: 'NEW' })).expect(400);
      await auth(request(app).post('/inbox/abc/analyze')).expect(400);
      await auth(request(app).post('/inbox/abc/archive')).expect(400);
      await auth(request(app).get('/inbox/accounts/abc')).expect(400);
      await auth(request(app).patch('/inbox/accounts/abc').send({ name: 'X' })).expect(400);
      await auth(request(app).post('/inbox/accounts/abc/activate')).expect(400);
      await auth(request(app).post('/inbox/accounts/abc/deactivate')).expect(400);
    } finally {
      schemas.idParamSchema.safeParse = originalId;
    }

    await auth(request(app).patch('/inbox/abc').send({})).expect(400);
  });
});
