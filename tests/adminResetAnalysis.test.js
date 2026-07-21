const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { createApp, loadEnv } = require('../index');
const { getPrisma, disconnectPrisma } = require('../lib/db');
const { isStagingAdminToolsEnabled } = require('../lib/adminRouter');
const inbox = require('../lib/inbox');

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

describe('staging admin tools gate', () => {
  it('allows non-production NODE_ENV by default', () => {
    assert.equal(isStagingAdminToolsEnabled({ NODE_ENV: 'development' }), true);
    assert.equal(isStagingAdminToolsEnabled({ NODE_ENV: 'test' }), true);
    assert.equal(isStagingAdminToolsEnabled({}), true);
  });

  it('blocks production unless STAGING_ADMIN_TOOLS=true', () => {
    assert.equal(isStagingAdminToolsEnabled({ NODE_ENV: 'production' }), false);
    assert.equal(
      isStagingAdminToolsEnabled({ NODE_ENV: 'production', STAGING_ADMIN_TOOLS: 'true' }),
      true
    );
    assert.equal(
      isStagingAdminToolsEnabled({ NODE_ENV: 'production', STAGING_ADMIN_TOOLS: 'false' }),
      false
    );
  });
});

describe('POST /admin/reset-analysis', () => {
  let app;
  let prisma;
  const previousNodeEnv = process.env.NODE_ENV;

  before(async () => {
    process.env.DATABASE_URL = DATABASE_URL;
    process.env.NODE_ENV = 'test';
    prisma = getPrisma();
    app = createApp(loadEnv(VALID_ENV));
  });

  after(async () => {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    await disconnectPrisma();
  });

  beforeEach(async () => {
    await prisma.inboxReplySuggestion.deleteMany({
      where: { inboxItem: { subject: { startsWith: '[test-reset-analysis]' } } },
    });
    await prisma.inboxPaymentSuggestion.deleteMany({
      where: { inboxItem: { subject: { startsWith: '[test-reset-analysis]' } } },
    });
    await prisma.inboxTaskSuggestion.deleteMany({
      where: { inboxItem: { subject: { startsWith: '[test-reset-analysis]' } } },
    });
    await prisma.inboxItem.deleteMany({
      where: { subject: { startsWith: '[test-reset-analysis]' } },
    });
    await prisma.inboxAccount.deleteMany({
      where: { name: { startsWith: '[test-reset-analysis]' } },
    });
  });

  it('requires admin auth', async () => {
    await request(app).post('/admin/reset-analysis').expect(401);
  });

  it('returns 403 in production without staging flag', async () => {
    const prodApp = createApp(
      loadEnv({
        ...VALID_ENV,
        NODE_ENV: 'production',
        STAGING_ADMIN_TOOLS: 'false',
      })
    );
    const res = await auth(request(prodApp).post('/admin/reset-analysis')).expect(403);
    assert.equal(res.body.code, 'STAGING_ADMIN_DISABLED');
  });

  it('clears analysis fields, preserves items/sync state, and returns resetCount', async () => {
    const account = await prisma.inboxAccount.create({
      data: {
        name: '[test-reset-analysis] Acc',
        source: 'GMAIL',
        emailAddress: `reset-${Date.now()}@example.com`,
        externalAccountId: `reset-ext-${Date.now()}`,
        isActive: true,
        syncCursor: 'history-keep-me',
        lastSyncedAt: new Date('2026-07-20T12:00:00.000Z'),
      },
    });

    const analyzed = await prisma.inboxItem.create({
      data: {
        inboxAccountId: account.id,
        source: 'GMAIL',
        externalId: `reset-msg-${Date.now()}`,
        senderIdentifier: 'bills@example.com',
        subject: '[test-reset-analysis] Bill',
        rawContent: 'Pay ILS 10.00 due 2026-08-01',
        summary: 'Bill summary',
        status: 'READY_FOR_REVIEW',
        confidence: 0.9,
        urgency: 'HIGH',
        category: 'BILL',
        requiresAction: true,
        dueDate: new Date('2026-08-01T00:00:00.000Z'),
        suggestedTask: 'Pay bill',
        receivedAt: new Date('2026-07-20T10:00:00.000Z'),
        processedAt: new Date('2026-07-21T10:00:00.000Z'),
      },
    });

    const untouched = await prisma.inboxItem.create({
      data: {
        inboxAccountId: account.id,
        source: 'GMAIL',
        externalId: `reset-new-${Date.now()}`,
        senderIdentifier: 'other@example.com',
        subject: '[test-reset-analysis] New',
        rawContent: 'fresh message',
        status: 'NEW',
        receivedAt: new Date('2026-07-20T11:00:00.000Z'),
      },
    });

    const res = await auth(request(app).post('/admin/reset-analysis')).expect(200);
    assert.equal(typeof res.body.resetCount, 'number');
    assert.ok(res.body.resetCount >= 1);

    const resetRow = await prisma.inboxItem.findUnique({ where: { id: analyzed.id } });
    assert.ok(resetRow);
    assert.equal(resetRow.status, 'NEW');
    assert.equal(resetRow.processedAt, null);
    assert.equal(resetRow.category, null);
    assert.equal(resetRow.urgency, null);
    assert.equal(resetRow.confidence, null);
    assert.equal(resetRow.requiresAction, null);
    assert.equal(resetRow.dueDate, null);
    assert.equal(resetRow.suggestedTask, null);
    assert.equal(resetRow.summary, null);
    assert.equal(resetRow.rawContent, 'Pay ILS 10.00 due 2026-08-01');
    assert.equal(resetRow.externalId, analyzed.externalId);

    const stillNew = await prisma.inboxItem.findUnique({ where: { id: untouched.id } });
    assert.equal(stillNew.status, 'NEW');

    const syncAccount = await prisma.inboxAccount.findUnique({ where: { id: account.id } });
    assert.equal(syncAccount.syncCursor, 'history-keep-me');
    assert.ok(syncAccount.lastSyncedAt);
    assert.equal(syncAccount.isActive, true);

    // Direct service path also returns a count
    const again = await inbox.resetInboxAnalysis();
    assert.equal(typeof again.resetCount, 'number');
  });

  it('allows production when STAGING_ADMIN_TOOLS=true', async () => {
    const stagingProdApp = createApp(
      loadEnv({
        ...VALID_ENV,
        NODE_ENV: 'production',
        STAGING_ADMIN_TOOLS: 'true',
      })
    );
    const res = await auth(request(stagingProdApp).post('/admin/reset-analysis')).expect(200);
    assert.equal(typeof res.body.resetCount, 'number');
  });
});
