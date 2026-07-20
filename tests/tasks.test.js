const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const express = require('express');
const { createApp, loadEnv, requireAdmin } = require('../index');
const { getPrisma, disconnectPrisma } = require('../lib/db');
const {
  createTaskSchema,
  updateTaskSchema,
  listTasksQuerySchema,
  taskIdParamSchema,
  formatZodError,
} = require('../lib/tasksSchemas');
const tasks = require('../lib/tasks');
const schemas = require('../lib/tasksSchemas');
const { createTasksRouter } = require('../lib/tasksRouter');
const {
  buildListWhere,
  buildOrderBy,
  serializeTask,
  applyCompletedAtLifecycle,
  isForeignKeyError,
  createTask,
  listTasks,
  updateTask,
  completeTask,
  reopenTask,
  archiveTask,
  getTaskById,
} = tasks;

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

describe('tasks Zod schemas', () => {
  it('accepts a valid create payload and normalizes blank optionals to null', () => {
    const parsed = createTaskSchema.parse({
      title: '  Pick up kids  ',
      description: '  ',
      priority: 'HIGH',
      status: 'OPEN',
      source: 'MANUAL',
      dueDate: '2026-07-25T15:00:00.000Z',
      contactId: null,
      conversationId: '',
    });
    assert.equal(parsed.title, 'Pick up kids');
    assert.equal(parsed.description, null);
    assert.equal(parsed.priority, 'HIGH');
    assert.equal(parsed.dueDate, '2026-07-25T15:00:00.000Z');
    assert.equal(parsed.contactId, null);
    assert.equal(parsed.conversationId, null);
  });

  it('rejects create without title and unknown fields', () => {
    const missing = createTaskSchema.safeParse({});
    assert.equal(missing.success, false);
    const formatted = formatZodError(missing.error);
    assert.equal(formatted.error, 'Validation failed');
    assert.ok(formatted.details.some((d) => d.path === 'title'));

    const extra = createTaskSchema.safeParse({ title: 'A', unexpected: true });
    assert.equal(extra.success, false);
  });

  it('rejects invalid enums and dueDate on create', () => {
    assert.equal(createTaskSchema.safeParse({ title: 'A', priority: 'CRITICAL' }).success, false);
    assert.equal(createTaskSchema.safeParse({ title: 'A', status: 'PENDING' }).success, false);
    assert.equal(createTaskSchema.safeParse({ title: 'A', source: 'SMS' }).success, false);
    assert.equal(createTaskSchema.safeParse({ title: 'A', dueDate: 'not-a-date' }).success, false);
  });

  it('requires at least one field on update', () => {
    const empty = updateTaskSchema.safeParse({});
    assert.equal(empty.success, false);

    const ok = updateTaskSchema.parse({ priority: 'URGENT' });
    assert.equal(ok.priority, 'URGENT');
  });

  it('parses list query defaults and rejects invalid filters/sort/page/limit', () => {
    const defaults = listTasksQuerySchema.parse({});
    assert.equal(defaults.page, 1);
    assert.equal(defaults.limit, 20);
    assert.equal(defaults.sort, 'updatedAt');
    assert.equal(defaults.includeArchived, false);

    assert.equal(listTasksQuerySchema.safeParse({ page: 0 }).success, false);
    assert.equal(listTasksQuerySchema.safeParse({ limit: 101 }).success, false);
    assert.equal(listTasksQuerySchema.safeParse({ sort: 'title' }).success, false);
    assert.equal(listTasksQuerySchema.safeParse({ status: 'PENDING' }).success, false);
    assert.equal(listTasksQuerySchema.parse({ includeArchived: 'true' }).includeArchived, true);
    assert.equal(listTasksQuerySchema.parse({ includeArchived: '1' }).includeArchived, true);
    assert.equal(listTasksQuerySchema.parse({ includeArchived: 'false' }).includeArchived, false);
  });

  it('taskIdParamSchema rejects empty ids', () => {
    assert.equal(taskIdParamSchema.safeParse({ id: '' }).success, false);
    assert.equal(taskIdParamSchema.safeParse({ id: 'abc' }).success, true);
  });
});

describe('tasks helpers', () => {
  it('buildListWhere excludes archived by default and supports filters/search', () => {
    const base = buildListWhere({});
    assert.deepEqual(base.status, { not: 'ARCHIVED' });

    const withFilters = buildListWhere({
      status: 'OPEN',
      priority: 'HIGH',
      source: 'EMAIL',
      contactId: 'c1',
      q: 'school',
      includeArchived: false,
    });
    assert.equal(withFilters.status, 'OPEN');
    assert.equal(withFilters.priority, 'HIGH');
    assert.equal(withFilters.source, 'EMAIL');
    assert.equal(withFilters.contactId, 'c1');
    assert.ok(Array.isArray(withFilters.OR));
    assert.equal(withFilters.OR.length, 2);

    const archivedHidden = buildListWhere({ status: 'ARCHIVED', includeArchived: false });
    assert.deepEqual(archivedHidden.id, { in: [] });

    const archivedShown = buildListWhere({ status: 'ARCHIVED', includeArchived: true });
    assert.equal(archivedShown.status, 'ARCHIVED');

    const includeAll = buildListWhere({ includeArchived: true });
    assert.equal(includeAll.status, undefined);

    assert.deepEqual(buildListWhere({ q: '   ' }), { status: { not: 'ARCHIVED' } });
  });

  it('buildOrderBy supports dueDate, priority, and updatedAt', () => {
    assert.deepEqual(buildOrderBy('dueDate'), { dueDate: { sort: 'asc', nulls: 'last' } });
    assert.deepEqual(buildOrderBy('priority'), { priority: 'desc' });
    assert.deepEqual(buildOrderBy('updatedAt'), { updatedAt: 'desc' });
  });

  it('applyCompletedAtLifecycle sets, clears, and preserves completedAt correctly', () => {
    const existingOpen = {
      id: 't1',
      status: 'OPEN',
      completedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      title: 'x',
      description: null,
      priority: 'MEDIUM',
      dueDate: null,
      source: 'MANUAL',
      contactId: null,
      conversationId: null,
    };
    const toComplete = {};
    applyCompletedAtLifecycle('COMPLETED', existingOpen, toComplete);
    assert.ok(toComplete.completedAt instanceof Date);

    const existingCompleted = {
      ...existingOpen,
      status: 'COMPLETED',
      completedAt: new Date('2026-01-01T00:00:00.000Z'),
    };
    const toArchive = {};
    applyCompletedAtLifecycle('ARCHIVED', existingCompleted, toArchive);
    assert.equal(Object.prototype.hasOwnProperty.call(toArchive, 'completedAt'), false);

    const toReopen = {};
    applyCompletedAtLifecycle('OPEN', existingCompleted, toReopen);
    assert.equal(toReopen.completedAt, null);

    const noop = {};
    applyCompletedAtLifecycle(undefined, existingCompleted, noop);
    assert.deepEqual(noop, {});
  });

  it('isForeignKeyError detects Prisma P2003 only', () => {
    assert.equal(isForeignKeyError({ code: 'P2003' }), true);
    assert.equal(isForeignKeyError({ code: 'P2002' }), false);
    assert.equal(isForeignKeyError(new Error('boom')), false);
    assert.equal(isForeignKeyError(null), false);
  });

  it('serializeTask formats dates and nullables', () => {
    const now = new Date('2026-07-20T12:00:00.000Z');
    const serialized = serializeTask({
      id: 't1',
      title: 'Test',
      description: null,
      priority: 'MEDIUM',
      status: 'OPEN',
      dueDate: null,
      completedAt: null,
      source: 'MANUAL',
      contactId: null,
      conversationId: null,
      createdAt: now,
      updatedAt: now,
    });
    assert.equal(serialized.createdAt, '2026-07-20T12:00:00.000Z');
    assert.equal(serialized.dueDate, null);
    assert.equal(serialized.completedAt, null);

    const withDates = serializeTask({
      ...serialized,
      createdAt: now,
      updatedAt: now,
      dueDate: now,
      completedAt: now,
    });
    assert.equal(withDates.dueDate, '2026-07-20T12:00:00.000Z');
    assert.equal(withDates.completedAt, '2026-07-20T12:00:00.000Z');
  });
});

describe('Tasks API', () => {
  let app;
  let prisma;
  const createdTaskIds = [];
  const createdContactIds = [];

  before(async () => {
    process.env.DATABASE_URL = DATABASE_URL;
    const env = loadEnv(VALID_ENV);
    app = createApp(env);
    prisma = getPrisma();
    await prisma.$queryRaw`SELECT 1`;
  });

  after(async () => {
    if (createdTaskIds.length > 0) {
      await prisma.task.deleteMany({ where: { id: { in: createdTaskIds } } });
    }
    if (createdContactIds.length > 0) {
      await prisma.contact.deleteMany({ where: { id: { in: createdContactIds } } });
    }
    await disconnectPrisma();
  });

  async function cleanupFixtures() {
    await prisma.task.deleteMany({
      where: {
        OR: [
          { description: { startsWith: '[test-tasks]' } },
          { title: { startsWith: '[test-tasks]' } },
        ],
      },
    });
    await prisma.contact.deleteMany({
      where: {
        OR: [
          { notes: { startsWith: '[test-tasks]' } },
          { email: { endsWith: '@tasks-test.example' } },
        ],
      },
    });
  }

  beforeEach(async () => {
    await cleanupFixtures();
  });

  afterEach(async () => {
    await cleanupFixtures();
  });

  async function createContactFixture() {
    const contact = await prisma.contact.create({
      data: {
        name: 'Tasks Test Contact',
        email: `contact-${Date.now()}@tasks-test.example`,
        notes: '[test-tasks] contact fixture',
      },
    });
    createdContactIds.push(contact.id);
    return contact;
  }

  async function createFixture(overrides = {}) {
    const res = await auth(request(app).post('/tasks'))
      .send({
        title: overrides.title || '[test-tasks] Default Task',
        description: overrides.description || '[test-tasks] fixture',
        priority: overrides.priority || 'MEDIUM',
        status: overrides.status || 'OPEN',
        source: overrides.source || 'MANUAL',
        dueDate: overrides.dueDate,
        contactId: overrides.contactId,
        conversationId: overrides.conversationId,
      })
      .expect(201);
    createdTaskIds.push(res.body.id);
    return res.body;
  }

  it('rejects unauthenticated requests on every tasks endpoint', async () => {
    await request(app).get('/tasks').expect(401);
    await request(app).get('/tasks/some-id').expect(401);
    await request(app).post('/tasks').send({ title: 'X' }).expect(401);
    await request(app).patch('/tasks/some-id').send({ title: 'X' }).expect(401);
    await request(app).post('/tasks/some-id/complete').expect(401);
    await request(app).post('/tasks/some-id/reopen').expect(401);
    await request(app).post('/tasks/some-id/archive').expect(401);
  });

  it('production mount order: /tasks hits auth/router before catch-all 404', async () => {
    // GET /tasks without auth → 401 (not 404): adminAuth on Tasks router runs first.
    const unauth = await request(app).get('/tasks');
    assert.equal(unauth.status, 401);
    assert.notEqual(unauth.status, 404);
    assert.equal(unauth.body.error, 'Unauthorized');
    assert.equal(Object.keys(unauth.body).join(','), 'error');

    // GET /tasks with valid auth → Tasks router list payload.
    const authed = await auth(request(app).get('/tasks')).expect(200);
    assert.ok(Array.isArray(authed.body.data), 'expected Tasks list data array');
    assert.equal(typeof authed.body.pagination, 'object');
    assert.equal(typeof authed.body.pagination.page, 'number');
    assert.equal(typeof authed.body.pagination.limit, 'number');
    assert.equal(typeof authed.body.pagination.total, 'number');

    // Unknown route still hits the final catch-all 404.
    const missing = await request(app).get('/definitely-not-a-real-route').expect(404);
    assert.equal(missing.body.error, 'Not found');
    assert.notEqual(missing.status, 401);
  });

  it('POST /tasks creates a task with defaults', async () => {
    const res = await auth(request(app).post('/tasks'))
      .send({
        title: '[test-tasks] Create Me',
        description: '[test-tasks] create',
      })
      .expect(201);

    createdTaskIds.push(res.body.id);
    assert.equal(res.body.title, '[test-tasks] Create Me');
    assert.equal(res.body.status, 'OPEN');
    assert.equal(res.body.priority, 'MEDIUM');
    assert.equal(res.body.source, 'MANUAL');
    assert.equal(res.body.completedAt, null);
    assert.equal(res.body.dueDate, null);
    assert.equal(typeof res.body.id, 'string');
    assert.equal(typeof res.body.createdAt, 'string');
    assert.equal(typeof res.body.updatedAt, 'string');
  });

  it('POST /tasks returns 400 for invalid payloads', async () => {
    const res = await auth(request(app).post('/tasks')).send({ priority: 'HIGH' }).expect(400);
    assert.equal(res.body.error, 'Validation failed');
    assert.ok(Array.isArray(res.body.details));
  });

  it('POST /tasks sets completedAt when created as COMPLETED', async () => {
    const res = await auth(request(app).post('/tasks'))
      .send({
        title: '[test-tasks] Already Done',
        description: '[test-tasks] completed create',
        status: 'COMPLETED',
      })
      .expect(201);
    createdTaskIds.push(res.body.id);
    assert.equal(res.body.status, 'COMPLETED');
    assert.ok(res.body.completedAt);
  });

  it('GET /tasks/:id returns a task and 404 for missing', async () => {
    const created = await createFixture({ title: '[test-tasks] Lookup' });

    const ok = await auth(request(app).get(`/tasks/${created.id}`)).expect(200);
    assert.equal(ok.body.id, created.id);
    assert.equal(ok.body.title, '[test-tasks] Lookup');

    await auth(request(app).get('/tasks/does-not-exist')).expect(404);
  });

  it('GET /tasks lists with pagination', async () => {
    await createFixture({ title: '[test-tasks] Page Alpha' });
    await createFixture({ title: '[test-tasks] Page Beta' });
    await createFixture({ title: '[test-tasks] Page Gamma' });

    const page1 = await auth(request(app).get('/tasks'))
      .query({ limit: 2, page: 1, sort: 'updatedAt', q: '[test-tasks] Page' })
      .expect(200);

    assert.equal(page1.body.data.length, 2);
    assert.equal(page1.body.pagination.page, 1);
    assert.equal(page1.body.pagination.limit, 2);
    assert.equal(page1.body.pagination.total, 3);
    assert.equal(page1.body.pagination.totalPages, 2);

    const page2 = await auth(request(app).get('/tasks'))
      .query({ limit: 2, page: 2, q: '[test-tasks] Page' })
      .expect(200);
    assert.equal(page2.body.data.length, 1);
  });

  it('GET /tasks?q= searches title and description', async () => {
    const byTitle = await createFixture({
      title: '[test-tasks] UniqueZebra Title',
      description: '[test-tasks] plain',
    });
    const byDesc = await createFixture({
      title: '[test-tasks] Other',
      description: '[test-tasks] UniqueZebra in description',
    });
    await createFixture({
      title: '[test-tasks] Unrelated',
      description: '[test-tasks] no match',
    });

    const res = await auth(request(app).get('/tasks')).query({ q: 'UniqueZebra' }).expect(200);
    const ids = res.body.data.map((t) => t.id).sort();
    assert.deepEqual(ids, [byTitle.id, byDesc.id].sort());
  });

  it('GET /tasks filters by status, priority, source, and contactId', async () => {
    const contact = await createContactFixture();
    const match = await createFixture({
      title: '[test-tasks] Filter Match',
      status: 'WAITING',
      priority: 'URGENT',
      source: 'WHATSAPP',
      contactId: contact.id,
    });
    await createFixture({
      title: '[test-tasks] Filter Other',
      status: 'OPEN',
      priority: 'LOW',
      source: 'EMAIL',
    });

    const byStatus = await auth(request(app).get('/tasks'))
      .query({ status: 'WAITING', q: '[test-tasks] Filter' })
      .expect(200);
    assert.equal(byStatus.body.data.length, 1);
    assert.equal(byStatus.body.data[0].id, match.id);

    const byPriority = await auth(request(app).get('/tasks'))
      .query({ priority: 'URGENT', q: '[test-tasks] Filter' })
      .expect(200);
    assert.equal(byPriority.body.data.length, 1);
    assert.equal(byPriority.body.data[0].id, match.id);

    const bySource = await auth(request(app).get('/tasks'))
      .query({ source: 'WHATSAPP', q: '[test-tasks] Filter' })
      .expect(200);
    assert.equal(bySource.body.data.length, 1);
    assert.equal(bySource.body.data[0].id, match.id);

    const byContact = await auth(request(app).get('/tasks'))
      .query({ contactId: contact.id })
      .expect(200);
    assert.ok(byContact.body.data.some((t) => t.id === match.id));
  });

  it('GET /tasks sorts by dueDate, priority, and updatedAt', async () => {
    const early = await createFixture({
      title: '[test-tasks] Sort Early',
      dueDate: '2026-07-21T10:00:00.000Z',
      priority: 'LOW',
    });
    await new Promise((r) => setTimeout(r, 20));
    const late = await createFixture({
      title: '[test-tasks] Sort Late',
      dueDate: '2026-07-28T10:00:00.000Z',
      priority: 'URGENT',
    });
    await auth(request(app).patch(`/tasks/${early.id}`))
      .send({ description: '[test-tasks] bumped' })
      .expect(200);

    const byDue = await auth(request(app).get('/tasks'))
      .query({ sort: 'dueDate', q: '[test-tasks] Sort' })
      .expect(200);
    assert.equal(byDue.body.data[0].id, early.id);
    assert.equal(byDue.body.data[1].id, late.id);

    const byPriority = await auth(request(app).get('/tasks'))
      .query({ sort: 'priority', q: '[test-tasks] Sort' })
      .expect(200);
    assert.equal(byPriority.body.data[0].id, late.id);
    assert.equal(byPriority.body.data[1].id, early.id);

    const byUpdated = await auth(request(app).get('/tasks'))
      .query({ sort: 'updatedAt', q: '[test-tasks] Sort' })
      .expect(200);
    assert.equal(byUpdated.body.data[0].id, early.id);
    assert.equal(byUpdated.body.data[1].id, late.id);
  });

  it('GET /tasks returns 400 for invalid query params', async () => {
    const res = await auth(request(app).get('/tasks')).query({ sort: 'title' }).expect(400);
    assert.equal(res.body.error, 'Validation failed');
  });

  it('archived tasks are hidden unless includeArchived=true', async () => {
    const open = await createFixture({ title: '[test-tasks] Archive Open' });
    const archived = await createFixture({ title: '[test-tasks] Archive Hidden' });
    await auth(request(app).post(`/tasks/${archived.id}/archive`)).expect(200);

    const without = await auth(request(app).get('/tasks'))
      .query({ q: '[test-tasks] Archive' })
      .expect(200);
    const withoutIds = without.body.data.map((t) => t.id);
    assert.ok(withoutIds.includes(open.id));
    assert.ok(!withoutIds.includes(archived.id));

    const withArchived = await auth(request(app).get('/tasks'))
      .query({ q: '[test-tasks] Archive', includeArchived: 'true' })
      .expect(200);
    const withIds = withArchived.body.data.map((t) => t.id);
    assert.ok(withIds.includes(open.id));
    assert.ok(withIds.includes(archived.id));

    const filterArchivedNoFlag = await auth(request(app).get('/tasks'))
      .query({ status: 'ARCHIVED', q: '[test-tasks] Archive' })
      .expect(200);
    assert.equal(filterArchivedNoFlag.body.data.length, 0);

    const filterArchivedWithFlag = await auth(request(app).get('/tasks'))
      .query({ status: 'ARCHIVED', includeArchived: 'true', q: '[test-tasks] Archive' })
      .expect(200);
    assert.equal(filterArchivedWithFlag.body.data.length, 1);
    assert.equal(filterArchivedWithFlag.body.data[0].id, archived.id);
  });

  it('PATCH /tasks/:id updates fields and validates input', async () => {
    const created = await createFixture({ title: '[test-tasks] Patch Me' });

    const updated = await auth(request(app).patch(`/tasks/${created.id}`))
      .send({
        title: '[test-tasks] Patched',
        priority: 'HIGH',
        status: 'IN_PROGRESS',
        source: 'AI',
        dueDate: '2026-08-01T12:00:00.000Z',
      })
      .expect(200);

    assert.equal(updated.body.title, '[test-tasks] Patched');
    assert.equal(updated.body.priority, 'HIGH');
    assert.equal(updated.body.status, 'IN_PROGRESS');
    assert.equal(updated.body.source, 'AI');
    assert.equal(updated.body.dueDate, '2026-08-01T12:00:00.000Z');

    await auth(request(app).patch(`/tasks/${created.id}`)).send({}).expect(400);
    await auth(request(app).patch('/tasks/missing')).send({ title: 'X' }).expect(404);
  });

  it('PATCH sets and clears completedAt when status changes to/from COMPLETED', async () => {
    const created = await createFixture({ title: '[test-tasks] Status Complete' });

    const completed = await auth(request(app).patch(`/tasks/${created.id}`))
      .send({ status: 'COMPLETED' })
      .expect(200);
    assert.equal(completed.body.status, 'COMPLETED');
    assert.ok(completed.body.completedAt);

    const reopened = await auth(request(app).patch(`/tasks/${created.id}`))
      .send({ status: 'WAITING' })
      .expect(200);
    assert.equal(reopened.body.status, 'WAITING');
    assert.equal(reopened.body.completedAt, null);
  });

  it('POST /tasks/:id/complete sets status and completedAt', async () => {
    const created = await createFixture({ title: '[test-tasks] Complete Me' });

    const completed = await auth(request(app).post(`/tasks/${created.id}/complete`)).expect(200);
    assert.equal(completed.body.status, 'COMPLETED');
    assert.ok(completed.body.completedAt);

    // Idempotent complete keeps completedAt
    const again = await auth(request(app).post(`/tasks/${created.id}/complete`)).expect(200);
    assert.equal(again.body.completedAt, completed.body.completedAt);

    await auth(request(app).post('/tasks/missing/complete')).expect(404);
  });

  it('POST /tasks/:id/reopen clears completedAt and sets OPEN', async () => {
    const created = await createFixture({ title: '[test-tasks] Reopen Me' });
    await auth(request(app).post(`/tasks/${created.id}/complete`)).expect(200);

    const reopened = await auth(request(app).post(`/tasks/${created.id}/reopen`)).expect(200);
    assert.equal(reopened.body.status, 'OPEN');
    assert.equal(reopened.body.completedAt, null);

    await auth(request(app).post('/tasks/missing/reopen')).expect(404);
  });

  it('POST /tasks/:id/archive archives a task and preserves completedAt', async () => {
    const created = await createFixture({ title: '[test-tasks] Archive Me' });
    const completed = await auth(request(app).post(`/tasks/${created.id}/complete`)).expect(200);
    assert.ok(completed.body.completedAt);

    const archived = await auth(request(app).post(`/tasks/${created.id}/archive`)).expect(200);
    assert.equal(archived.body.status, 'ARCHIVED');
    assert.equal(archived.body.completedAt, completed.body.completedAt);

    // PATCH to ARCHIVED also preserves historical completedAt
    const again = await createFixture({ title: '[test-tasks] Archive Via Patch' });
    const done = await auth(request(app).post(`/tasks/${again.id}/complete`)).expect(200);
    const patched = await auth(request(app).patch(`/tasks/${again.id}`))
      .send({ status: 'ARCHIVED' })
      .expect(200);
    assert.equal(patched.body.status, 'ARCHIVED');
    assert.equal(patched.body.completedAt, done.body.completedAt);

    await auth(request(app).post('/tasks/missing/archive')).expect(404);
  });

  it('rejects invalid contactId/conversationId without leaking Prisma details', async () => {
    const logs = [];
    const originalError = console.error;
    console.error = (...args) => {
      logs.push(args.map(String).join(' '));
    };

    try {
      const badContact = await auth(request(app).post('/tasks'))
        .send({
          title: '[test-tasks] Bad Contact',
          description: '[test-tasks] fk',
          contactId: 'nonexistent-contact-id',
        })
        .expect(400);

      assert.equal(badContact.body.error, 'Invalid contactId or conversationId');
      assert.equal(Object.keys(badContact.body).join(','), 'error');
      const bodyText = JSON.stringify(badContact.body);
      assert.equal(bodyText.includes('Prisma'), false);
      assert.equal(bodyText.includes('P2003'), false);
      assert.equal(bodyText.includes('Foreign key'), false);
      assert.equal(bodyText.includes('constraint'), false);

      const badConversation = await auth(request(app).post('/tasks'))
        .send({
          title: '[test-tasks] Bad Conversation',
          description: '[test-tasks] fk',
          conversationId: 'nonexistent-conversation-id',
        })
        .expect(400);
      assert.equal(badConversation.body.error, 'Invalid contactId or conversationId');

      const created = await createFixture({ title: '[test-tasks] Patch Bad FK' });
      const badPatch = await auth(request(app).patch(`/tasks/${created.id}`))
        .send({ contactId: 'still-missing-contact' })
        .expect(400);
      assert.equal(badPatch.body.error, 'Invalid contactId or conversationId');

      for (const line of logs) {
        assert.equal(line.includes('Prisma'), false, `log leaked Prisma: ${line}`);
        assert.equal(line.includes('P2003'), false, `log leaked P2003: ${line}`);
        assert.equal(line.includes('Foreign key'), false, `log leaked FK detail: ${line}`);
        assert.match(line, /invalid related id|database error/);
      }
    } finally {
      console.error = originalError;
    }
  });

  it('does not alter existing endpoints', async () => {
    const health = await request(app).get('/health').expect(200);
    assert.deepEqual(Object.keys(health.body).sort(), ['service', 'status', 'timestamp']);

    await request(app).get('/qr').expect(404);
    await request(app).get('/morning').expect(401);
    await request(app).get('/contacts').expect(401);
  });

  it('service helpers cover defaults, fallbacks, and missing ids', async () => {
    const created = await createTask({ title: '[test-tasks] Service Minimal' });
    createdTaskIds.push(created.id);
    assert.equal(created.status, 'OPEN');
    assert.equal(created.priority, 'MEDIUM');
    assert.equal(created.source, 'MANUAL');

    const clearedDue = await updateTask(created.id, { dueDate: null, description: '[test-tasks] cleared' });
    assert.equal(clearedDue.dueDate, null);

    const empty = await listTasks({
      q: 'zzzz-no-match-tasks-test',
      page: 1,
      limit: 10,
      sort: 'not-a-real-sort',
      includeArchived: false,
    });
    assert.equal(empty.pagination.total, 0);
    assert.equal(empty.pagination.totalPages, 0);
    assert.deepEqual(empty.data, []);

    assert.equal(await getTaskById('missing-task-id'), null);
    assert.equal(await updateTask('missing-task-id', { title: 'Nope' }), null);
    assert.equal(await completeTask('missing-task-id'), null);
    assert.equal(await reopenTask('missing-task-id'), null);
    assert.equal(await archiveTask('missing-task-id'), null);
  });
});

describe('Tasks API error paths', () => {
  let app;
  const originals = {};

  before(() => {
    process.env.DATABASE_URL = DATABASE_URL;
    const env = loadEnv(VALID_ENV);
    app = express();
    app.use(express.json());
    app.use('/tasks', createTasksRouter({ adminAuth: requireAdmin(env) }));
  });

  afterEach(() => {
    for (const key of Object.keys(originals)) {
      if (key === 'safeParseId') {
        schemas.taskIdParamSchema.safeParse = originals.safeParseId;
      } else {
        tasks[key] = originals[key];
      }
      delete originals[key];
    }
  });

  function stubTaskFn(name, impl) {
    if (!(name in originals)) {
      originals[name] = tasks[name];
    }
    tasks[name] = impl;
  }

  it('returns 500 when list/get/create/update/complete/reopen/archive services fail', async () => {
    stubTaskFn('listTasks', async () => {
      throw new Error('list boom with Prisma Client details');
    });
    const listRes = await auth(request(app).get('/tasks')).expect(500);
    assert.equal(listRes.body.error, 'Failed to list tasks');
    assert.equal(JSON.stringify(listRes.body).includes('Prisma'), false);

    stubTaskFn('getTaskById', async () => {
      throw 'get boom';
    });
    await auth(request(app).get('/tasks/abc')).expect(500);

    stubTaskFn('createTask', async () => {
      throw new Error('create boom');
    });
    await auth(request(app).post('/tasks')).send({ title: 'X' }).expect(500);

    stubTaskFn('updateTask', async () => {
      throw new Error('update boom');
    });
    await auth(request(app).patch('/tasks/abc')).send({ title: 'Y' }).expect(500);

    stubTaskFn('completeTask', async () => {
      throw new Error('complete boom');
    });
    await auth(request(app).post('/tasks/abc/complete')).expect(500);

    stubTaskFn('reopenTask', async () => {
      throw new Error('reopen boom');
    });
    await auth(request(app).post('/tasks/abc/reopen')).expect(500);

    stubTaskFn('archiveTask', async () => {
      throw new Error('archive boom');
    });
    await auth(request(app).post('/tasks/abc/archive')).expect(500);
  });

  it('returns 400 for foreign-key failures without leaking Prisma details', async () => {
    const logs = [];
    const originalError = console.error;
    console.error = (...args) => {
      logs.push(args.map(String).join(' '));
    };

    try {
      stubTaskFn('createTask', async () => {
        const err = new Error('Foreign key constraint violated on Contact');
        err.code = 'P2003';
        throw err;
      });
      const res = await auth(request(app).post('/tasks')).send({ title: 'X' }).expect(400);
      assert.equal(res.body.error, 'Invalid contactId or conversationId');
      assert.equal(JSON.stringify(res.body).includes('Prisma'), false);
      assert.equal(JSON.stringify(res.body).includes('P2003'), false);
      assert.equal(JSON.stringify(res.body).includes('Foreign key'), false);

      stubTaskFn('updateTask', async () => {
        const err = new Error('Foreign key constraint violated on Conversation');
        err.code = 'P2003';
        throw err;
      });
      await auth(request(app).patch('/tasks/abc')).send({ title: 'Y' }).expect(400);

      assert.ok(logs.every((line) => !line.includes('P2003') && !line.includes('Foreign key')));
      assert.ok(logs.some((line) => line.includes('invalid related id')));
    } finally {
      console.error = originalError;
    }
  });

  it('returns 400 when task id params fail validation', async () => {
    originals.safeParseId = schemas.taskIdParamSchema.safeParse;
    schemas.taskIdParamSchema.safeParse = () => ({
      success: false,
      error: createTaskSchema.safeParse({}).error,
    });

    await auth(request(app).get('/tasks/abc')).expect(400);
    await auth(request(app).patch('/tasks/abc')).send({ title: 'Y' }).expect(400);
    await auth(request(app).post('/tasks/abc/complete')).expect(400);
    await auth(request(app).post('/tasks/abc/reopen')).expect(400);
    await auth(request(app).post('/tasks/abc/archive')).expect(400);
  });
});
