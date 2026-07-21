const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { createApp, loadEnv } = require('../index');
const { getPrisma, disconnectPrisma } = require('../lib/db');
const {
  isExpiredMeetingOrEvent,
  isMeetingOrEventItem,
  dedupeByThread,
  applyInboxResultQuality,
} = require('../lib/inboxQuality');

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

describe('inbox quality helpers', () => {
  const now = new Date('2026-07-21T12:00:00.000Z');

  it('detects meeting/event language', () => {
    assert.equal(isMeetingOrEventItem({ subject: 'Zoom meeting with team' }), true);
    assert.equal(isMeetingOrEventItem({ subject: 'Calendar invite: dentist' }), true);
    assert.equal(isMeetingOrEventItem({ summary: 'Appointment reminder tomorrow' }), true);
    assert.equal(isMeetingOrEventItem({ subject: 'Water bill due' }), false);
  });

  it('treats past meetings as expired but not overdue bills', () => {
    assert.equal(
      isExpiredMeetingOrEvent(
        {
          subject: 'Old Zoom meeting',
          dueDate: '2026-07-01T15:00:00.000Z',
          category: 'WORK',
        },
        now
      ),
      true
    );
    assert.equal(
      isExpiredMeetingOrEvent(
        {
          subject: 'Upcoming calendar invite',
          dueDate: '2026-08-01T15:00:00.000Z',
          category: 'WORK',
        },
        now
      ),
      false
    );
    assert.equal(
      isExpiredMeetingOrEvent(
        {
          subject: 'Electric bill payment due',
          dueDate: '2026-06-01T00:00:00.000Z',
          category: 'BILL',
        },
        now
      ),
      false
    );
  });

  it('dedupes Gmail threads keeping the newest email', () => {
    const items = [
      {
        id: 'old',
        threadExternalId: 'thread-1',
        receivedAt: '2026-07-10T10:00:00.000Z',
        summary: 'old summary',
        suggestedTask: 'old task',
      },
      {
        id: 'new',
        threadExternalId: 'thread-1',
        receivedAt: '2026-07-20T10:00:00.000Z',
        summary: 'latest summary',
        suggestedTask: 'latest task',
      },
      {
        id: 'other',
        threadExternalId: 'thread-2',
        receivedAt: '2026-07-15T10:00:00.000Z',
        summary: 'other thread',
        suggestedTask: 'other task',
      },
      {
        id: 'solo',
        threadExternalId: null,
        receivedAt: '2026-07-12T10:00:00.000Z',
        summary: 'no thread',
        suggestedTask: null,
      },
    ];
    const deduped = dedupeByThread(items);
    assert.equal(deduped.length, 3);
    assert.equal(deduped.find((r) => r.threadExternalId === 'thread-1').id, 'new');
    assert.equal(deduped.find((r) => r.threadExternalId === 'thread-1').suggestedTask, 'latest task');
    assert.ok(deduped.some((r) => r.id === 'other'));
    assert.ok(deduped.some((r) => r.id === 'solo'));
  });

  it('applyInboxResultQuality filters expired meetings then dedupes', () => {
    const rows = [
      {
        id: 'past-zoom',
        subject: 'Zoom meeting yesterday',
        dueDate: '2026-07-01T10:00:00.000Z',
        urgency: 'HIGH',
        threadExternalId: 't-a',
        receivedAt: '2026-07-01T09:00:00.000Z',
      },
      {
        id: 'thread-old',
        subject: 'Please review',
        dueDate: null,
        urgency: 'HIGH',
        requiresAction: true,
        suggestedTask: 'old follow-up',
        threadExternalId: 't-b',
        receivedAt: '2026-07-10T10:00:00.000Z',
      },
      {
        id: 'thread-new',
        subject: 'Please review (updated)',
        dueDate: null,
        urgency: 'HIGH',
        requiresAction: true,
        suggestedTask: 'latest follow-up',
        summary: 'latest summary',
        threadExternalId: 't-b',
        receivedAt: '2026-07-20T10:00:00.000Z',
      },
    ];
    const result = applyInboxResultQuality(rows, now);
    assert.equal(result.some((r) => r.id === 'past-zoom'), false);
    assert.equal(result.filter((r) => r.threadExternalId === 't-b').length, 1);
    assert.equal(result.find((r) => r.threadExternalId === 't-b').id, 'thread-new');
    assert.equal(result.find((r) => r.threadExternalId === 't-b').suggestedTask, 'latest follow-up');
  });
});

describe('inbox important/tasks quality integration', () => {
  let app;
  let prisma;

  before(async () => {
    process.env.DATABASE_URL = DATABASE_URL;
    prisma = getPrisma();
    app = createApp(loadEnv(VALID_ENV));
  });

  after(async () => {
    await disconnectPrisma();
  });

  beforeEach(async () => {
    await prisma.inboxReplySuggestion.deleteMany({
      where: { inboxItem: { subject: { startsWith: '[test-quality]' } } },
    });
    await prisma.inboxPaymentSuggestion.deleteMany({
      where: { inboxItem: { subject: { startsWith: '[test-quality]' } } },
    });
    await prisma.inboxTaskSuggestion.deleteMany({
      where: { inboxItem: { subject: { startsWith: '[test-quality]' } } },
    });
    await prisma.inboxItem.deleteMany({
      where: { subject: { startsWith: '[test-quality]' } },
    });
    await prisma.inboxAccount.deleteMany({
      where: { name: { startsWith: '[test-quality]' } },
    });
  });

  async function createAccount() {
    return prisma.inboxAccount.create({
      data: {
        name: `[test-quality] Acc ${Date.now()}`,
        source: 'GMAIL',
        emailAddress: `quality-${Date.now()}@example.com`,
        isActive: true,
      },
    });
  }

  it('filters past meetings out of /inbox/important and archives them', async () => {
    const account = await createAccount();
    const pastMeeting = await prisma.inboxItem.create({
      data: {
        inboxAccountId: account.id,
        source: 'GMAIL',
        externalId: `qual-past-${Date.now()}`,
        senderIdentifier: 'zoom@example.com',
        subject: '[test-quality] Zoom meeting — Q2 planning',
        rawContent: 'Join Zoom meeting',
        summary: 'Past Zoom meeting invite',
        status: 'READY_FOR_REVIEW',
        urgency: 'HIGH',
        category: 'WORK',
        requiresAction: true,
        suggestedTask: 'Attend Zoom meeting',
        dueDate: new Date('2026-06-01T15:00:00.000Z'),
        receivedAt: new Date('2026-05-30T10:00:00.000Z'),
        processedAt: new Date('2026-05-30T11:00:00.000Z'),
      },
    });
    const liveAlert = await prisma.inboxItem.create({
      data: {
        inboxAccountId: account.id,
        source: 'GMAIL',
        externalId: `qual-live-${Date.now()}`,
        senderIdentifier: 'security@example.com',
        subject: '[test-quality] Security login alert',
        rawContent: 'Unauthorized login',
        summary: 'Security alert needs review',
        status: 'READY_FOR_REVIEW',
        urgency: 'CRITICAL',
        category: 'SECURITY',
        requiresAction: true,
        suggestedTask: 'Review login alert',
        dueDate: null,
        receivedAt: new Date('2026-07-20T10:00:00.000Z'),
        processedAt: new Date('2026-07-20T11:00:00.000Z'),
      },
    });

    const important = await auth(
      request(app).get(`/inbox/important?inboxAccountId=${account.id}&limit=50`)
    ).expect(200);

    assert.equal(important.body.data.some((row) => row.id === pastMeeting.id), false);
    assert.equal(important.body.data.some((row) => row.id === liveAlert.id), true);

    const tasks = await auth(
      request(app).get(`/inbox/tasks?inboxAccountId=${account.id}&limit=50`)
    ).expect(200);
    assert.equal(tasks.body.data.some((row) => row.id === pastMeeting.id), false);
    assert.equal(tasks.body.data.some((row) => row.id === liveAlert.id), true);

    const archived = await prisma.inboxItem.findUnique({ where: { id: pastMeeting.id } });
    assert.equal(archived.status, 'ARCHIVED');
    assert.equal(archived.requiresAction, false);
    // Item still exists (not deleted)
    assert.equal(archived.externalId, pastMeeting.externalId);
  });

  it('returns only one actionable item per Gmail thread', async () => {
    const account = await createAccount();
    const threadId = `thread-qual-${Date.now()}`;

    const older = await prisma.inboxItem.create({
      data: {
        inboxAccountId: account.id,
        source: 'GMAIL',
        externalId: `qual-thread-old-${Date.now()}`,
        threadExternalId: threadId,
        senderIdentifier: 'boss@example.com',
        subject: '[test-quality] Please review the deck',
        rawContent: 'Can you review?',
        summary: 'Old request to review deck',
        status: 'READY_FOR_REVIEW',
        urgency: 'HIGH',
        category: 'WORK',
        requiresAction: true,
        suggestedTask: 'Review deck (old)',
        receivedAt: new Date('2026-07-10T10:00:00.000Z'),
        processedAt: new Date('2026-07-10T11:00:00.000Z'),
      },
    });
    const newer = await prisma.inboxItem.create({
      data: {
        inboxAccountId: account.id,
        source: 'GMAIL',
        externalId: `qual-thread-new-${Date.now()}`,
        threadExternalId: threadId,
        senderIdentifier: 'boss@example.com',
        subject: '[test-quality] Please review the deck (updated)',
        rawContent: 'Updated ask — please review v2',
        summary: 'Latest request to review deck v2',
        status: 'READY_FOR_REVIEW',
        urgency: 'HIGH',
        category: 'WORK',
        requiresAction: true,
        suggestedTask: 'Review deck v2 (latest)',
        receivedAt: new Date('2026-07-20T10:00:00.000Z'),
        processedAt: new Date('2026-07-20T11:00:00.000Z'),
      },
    });

    const important = await auth(
      request(app).get(`/inbox/important?inboxAccountId=${account.id}&limit=50`)
    ).expect(200);
    const threadRows = important.body.data.filter((row) => row.threadExternalId === threadId);
    assert.equal(threadRows.length, 1);
    assert.equal(threadRows[0].id, newer.id);
    assert.equal(threadRows[0].summary, 'Latest request to review deck v2');
    assert.equal(threadRows[0].suggestedTask, 'Review deck v2 (latest)');

    const tasks = await auth(
      request(app).get(`/inbox/tasks?inboxAccountId=${account.id}&limit=50`)
    ).expect(200);
    const taskThreadRows = tasks.body.data.filter((row) => row.threadExternalId === threadId);
    assert.equal(taskThreadRows.length, 1);
    assert.equal(taskThreadRows[0].id, newer.id);

    // Both underlying messages remain stored
    assert.ok(await prisma.inboxItem.findUnique({ where: { id: older.id } }));
    assert.ok(await prisma.inboxItem.findUnique({ where: { id: newer.id } }));
  });
});
