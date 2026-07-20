const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const express = require('express');
const { createApp, loadEnv, requireAdmin } = require('../index');
const { getPrisma, disconnectPrisma } = require('../lib/db');
const {
  createContactSchema,
  updateContactSchema,
  listContactsQuerySchema,
  contactIdParamSchema,
  formatZodError,
} = require('../lib/contactsSchemas');
const contacts = require('../lib/contacts');
const schemas = require('../lib/contactsSchemas');
const { createContactsRouter } = require('../lib/contactsRouter');
const {
  buildSearchWhere,
  buildOrderBy,
  serializeContact,
  softDeleteContact,
  createContact,
  listContacts,
  updateContact,
} = contacts;

const VALID_ENV = {
  ANTHROPIC_API_KEY: 'test-anthropic-key',
  GOOGLE_CLIENT_ID: 'test-google-client-id',
  GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
  GOOGLE_REDIRECT_URI: 'https://example.com/auth/callback',
  ADMIN_API_KEY: 'test-admin-api-key',
};

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://family_ai:family_ai_dev@localhost:5432/family_ai_agent?schema=public';

function auth(req) {
  return req.set('Authorization', `Bearer ${VALID_ENV.ADMIN_API_KEY}`);
}

describe('contacts Zod schemas', () => {
  it('accepts a valid create payload and normalizes blank optionals to null', () => {
    const parsed = createContactSchema.parse({
      name: '  Smadar Cohen  ',
      phone: '  ',
      email: '',
      company: 'Acme',
      role: 'SCHOOL',
      notes: null,
    });
    assert.equal(parsed.name, 'Smadar Cohen');
    assert.equal(parsed.phone, null);
    assert.equal(parsed.email, null);
    assert.equal(parsed.company, 'Acme');
    assert.equal(parsed.role, 'SCHOOL');
    assert.equal(parsed.notes, null);
  });

  it('rejects create without name and unknown fields', () => {
    const missing = createContactSchema.safeParse({});
    assert.equal(missing.success, false);
    const formatted = formatZodError(missing.error);
    assert.equal(formatted.error, 'Validation failed');
    assert.ok(formatted.details.some((d) => d.path === 'name'));

    const extra = createContactSchema.safeParse({ name: 'A', unexpected: true });
    assert.equal(extra.success, false);
  });

  it('rejects invalid email and role on create', () => {
    const badEmail = createContactSchema.safeParse({ name: 'A', email: 'not-an-email' });
    assert.equal(badEmail.success, false);

    const badRole = createContactSchema.safeParse({ name: 'A', role: 'BOSS' });
    assert.equal(badRole.success, false);
  });

  it('requires at least one field on update', () => {
    const empty = updateContactSchema.safeParse({});
    assert.equal(empty.success, false);

    const ok = updateContactSchema.parse({ company: 'New Co' });
    assert.equal(ok.company, 'New Co');
  });

  it('parses list query defaults and rejects invalid sort/page/limit', () => {
    const defaults = listContactsQuerySchema.parse({});
    assert.equal(defaults.page, 1);
    assert.equal(defaults.limit, 20);
    assert.equal(defaults.sort, 'name');

    assert.equal(listContactsQuerySchema.safeParse({ page: 0 }).success, false);
    assert.equal(listContactsQuerySchema.safeParse({ limit: 101 }).success, false);
    assert.equal(listContactsQuerySchema.safeParse({ sort: 'email' }).success, false);
  });
});

describe('contacts helpers', () => {
  it('buildSearchWhere searches name, email, phone, and company', () => {
    const where = buildSearchWhere('smadar');
    assert.equal(where.deletedAt, null);
    assert.ok(Array.isArray(where.OR));
    assert.equal(where.OR.length, 4);
    assert.deepEqual(
      where.OR.map((clause) => Object.keys(clause)[0]).sort(),
      ['company', 'email', 'name', 'phone']
    );
  });

  it('buildSearchWhere ignores blank queries', () => {
    assert.deepEqual(buildSearchWhere(undefined), { deletedAt: null });
    assert.deepEqual(buildSearchWhere('   '), { deletedAt: null });
  });

  it('buildOrderBy supports name and updatedAt', () => {
    assert.deepEqual(buildOrderBy('name'), { name: 'asc' });
    assert.deepEqual(buildOrderBy('updatedAt'), { updatedAt: 'desc' });
  });

  it('serializeContact formats dates and null deletedAt', () => {
    const now = new Date('2026-07-20T12:00:00.000Z');
    const serialized = serializeContact({
      id: 'c1',
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      name: 'Test',
      phone: null,
      email: null,
      company: null,
      role: 'OTHER',
      notes: null,
    });
    assert.equal(serialized.createdAt, '2026-07-20T12:00:00.000Z');
    assert.equal(serialized.deletedAt, null);

    const deleted = serializeContact({
      ...serialized,
      createdAt: now,
      updatedAt: now,
      deletedAt: now,
    });
    assert.equal(deleted.deletedAt, '2026-07-20T12:00:00.000Z');
  });

  it('contactIdParamSchema rejects empty ids', () => {
    assert.equal(contactIdParamSchema.safeParse({ id: '' }).success, false);
    assert.equal(contactIdParamSchema.safeParse({ id: 'abc' }).success, true);
  });
});

describe('Contacts API', () => {
  let app;
  let prisma;
  const createdIds = [];

  before(async () => {
    process.env.DATABASE_URL = DATABASE_URL;
    const env = loadEnv(VALID_ENV);
    app = createApp(env);
    prisma = getPrisma();
    await prisma.$queryRaw`SELECT 1`;
  });

  after(async () => {
    if (createdIds.length > 0) {
      await prisma.contact.deleteMany({ where: { id: { in: createdIds } } });
    }
    await disconnectPrisma();
  });

  beforeEach(async () => {
    // Ensure each test starts from a clean contacts table for API fixtures,
    // but keep seed contacts if present by only deleting test-tagged rows.
    await prisma.contact.deleteMany({
      where: {
        OR: [
          { notes: { startsWith: '[test-contacts]' } },
          { email: { endsWith: '@contacts-test.example' } },
        ],
      },
    });
  });

  afterEach(async () => {
    await prisma.contact.deleteMany({
      where: {
        OR: [
          { notes: { startsWith: '[test-contacts]' } },
          { email: { endsWith: '@contacts-test.example' } },
        ],
      },
    });
  });

  async function createFixture(overrides = {}) {
    const res = await auth(request(app).post('/contacts'))
      .send({
        name: overrides.name || 'Smadar Levi',
        email: overrides.email || 'smadar@contacts-test.example',
        phone: overrides.phone || '+972501111111',
        company: overrides.company || 'Smadar Labs',
        role: overrides.role || 'OTHER',
        notes: overrides.notes || '[test-contacts] fixture',
      })
      .expect(201);
    createdIds.push(res.body.id);
    return res.body;
  }

  it('rejects unauthenticated requests on every contacts endpoint', async () => {
    await request(app).get('/contacts').expect(401);
    await request(app).get('/contacts/some-id').expect(401);
    await request(app).post('/contacts').send({ name: 'X' }).expect(401);
    await request(app).patch('/contacts/some-id').send({ name: 'X' }).expect(401);
    await request(app).delete('/contacts/some-id').expect(401);
  });

  it('mounts /contacts before the final catch-all 404 handler', async () => {
    // a) Unauthenticated /contacts must hit admin auth (401), not the catch-all (404).
    const unauth = await request(app).get('/contacts').expect(401);
    assert.equal(unauth.body.error, 'Unauthorized');
    assert.notEqual(unauth.status, 404);

    // b) Authenticated /contacts reaches the Contacts router (list payload).
    const authed = await auth(request(app).get('/contacts')).expect(200);
    assert.ok(Array.isArray(authed.body.data));
    assert.equal(typeof authed.body.pagination, 'object');
    assert.equal(typeof authed.body.pagination.page, 'number');

    // c) Unknown routes still hit the final catch-all 404.
    const missing = await request(app).get('/definitely-not-a-real-route').expect(404);
    assert.equal(missing.body.error, 'Not found');
  });

  it('POST /contacts creates a contact', async () => {
    const res = await auth(request(app).post('/contacts'))
      .send({
        name: 'Avi Cohen',
        email: 'avi@contacts-test.example',
        phone: '+972502222222',
        company: 'School Board',
        role: 'SCHOOL',
        notes: '[test-contacts] create',
      })
      .expect(201);

    createdIds.push(res.body.id);
    assert.equal(res.body.name, 'Avi Cohen');
    assert.equal(res.body.email, 'avi@contacts-test.example');
    assert.equal(res.body.company, 'School Board');
    assert.equal(res.body.role, 'SCHOOL');
    assert.equal(res.body.deletedAt, null);
    assert.equal(typeof res.body.id, 'string');
    assert.equal(typeof res.body.createdAt, 'string');
    assert.equal(typeof res.body.updatedAt, 'string');
  });

  it('POST /contacts returns 400 for invalid payloads', async () => {
    const res = await auth(request(app).post('/contacts')).send({ email: 'bad' }).expect(400);
    assert.equal(res.body.error, 'Validation failed');
    assert.ok(Array.isArray(res.body.details));
  });

  it('GET /contacts/:id returns a contact and 404 for missing/soft-deleted', async () => {
    const created = await createFixture({ name: 'Lookup Contact' });

    const ok = await auth(request(app).get(`/contacts/${created.id}`)).expect(200);
    assert.equal(ok.body.id, created.id);
    assert.equal(ok.body.name, 'Lookup Contact');

    await auth(request(app).get('/contacts/does-not-exist')).expect(404);

    await auth(request(app).delete(`/contacts/${created.id}`)).expect(200);
    await auth(request(app).get(`/contacts/${created.id}`)).expect(404);
  });

  it('GET /contacts lists contacts with pagination', async () => {
    await createFixture({ name: 'Alpha Contact', email: 'alpha@contacts-test.example' });
    await createFixture({ name: 'Beta Contact', email: 'beta@contacts-test.example' });
    await createFixture({ name: 'Gamma Contact', email: 'gamma@contacts-test.example' });

    const page1 = await auth(request(app).get('/contacts'))
      .query({ limit: 2, page: 1, sort: 'name', q: 'Contact' })
      .expect(200);

    assert.equal(page1.body.data.length, 2);
    assert.equal(page1.body.pagination.page, 1);
    assert.equal(page1.body.pagination.limit, 2);
    assert.equal(page1.body.pagination.total, 3);
    assert.equal(page1.body.pagination.totalPages, 2);
    assert.equal(page1.body.data[0].name, 'Alpha Contact');
    assert.equal(page1.body.data[1].name, 'Beta Contact');

    const page2 = await auth(request(app).get('/contacts'))
      .query({ limit: 2, page: 2, sort: 'name', q: 'Contact' })
      .expect(200);
    assert.equal(page2.body.data.length, 1);
    assert.equal(page2.body.data[0].name, 'Gamma Contact');
  });

  it('GET /contacts?q=smadar searches name, email, phone, and company', async () => {
    await createFixture({
      name: 'Other Person',
      email: 'other@contacts-test.example',
      phone: '+972509999999',
      company: 'Unrelated',
    });
    const byName = await createFixture({
      name: 'Smadar Name Match',
      email: 'n1@contacts-test.example',
      phone: '+972501000001',
      company: 'Co1',
    });
    const byEmail = await createFixture({
      name: 'Email Match',
      email: 'smadar.mail@contacts-test.example',
      phone: '+972501000002',
      company: 'Co2',
    });
    const byPhone = await createFixture({
      name: 'Phone Match',
      email: 'p@contacts-test.example',
      phone: 'smadar-ext-99',
      company: 'Co3',
    });
    const byCompany = await createFixture({
      name: 'Company Match',
      email: 'c@contacts-test.example',
      phone: '+972501000004',
      company: 'Smadar Industries',
    });

    const res = await auth(request(app).get('/contacts')).query({ q: 'smadar' }).expect(200);
    const ids = res.body.data.map((c) => c.id).sort();
    assert.deepEqual(
      ids,
      [byName.id, byEmail.id, byPhone.id, byCompany.id].sort()
    );
  });

  it('GET /contacts sorts by name and updatedAt', async () => {
    const first = await createFixture({
      name: 'Zed Sort',
      email: 'zed@contacts-test.example',
    });
    // Ensure a later updatedAt
    await new Promise((r) => setTimeout(r, 20));
    const second = await createFixture({
      name: 'Ann Sort',
      email: 'ann@contacts-test.example',
    });
    await auth(request(app).patch(`/contacts/${first.id}`))
      .send({ notes: '[test-contacts] bumped' })
      .expect(200);

    const byName = await auth(request(app).get('/contacts'))
      .query({ sort: 'name', q: 'Sort' })
      .expect(200);
    assert.deepEqual(
      byName.body.data.map((c) => c.name),
      ['Ann Sort', 'Zed Sort']
    );

    const byUpdated = await auth(request(app).get('/contacts'))
      .query({ sort: 'updatedAt', q: 'Sort' })
      .expect(200);
    assert.equal(byUpdated.body.data[0].id, first.id);
    assert.equal(byUpdated.body.data[1].id, second.id);
  });

  it('GET /contacts returns 400 for invalid query params', async () => {
    const res = await auth(request(app).get('/contacts')).query({ sort: 'email' }).expect(400);
    assert.equal(res.body.error, 'Validation failed');
  });

  it('PATCH /contacts/:id updates fields and validates input', async () => {
    const created = await createFixture({ name: 'Patch Me' });

    const updated = await auth(request(app).patch(`/contacts/${created.id}`))
      .send({
        name: 'Patched Name',
        company: 'Patched Co',
        role: 'FAMILY',
        email: 'patched@contacts-test.example',
      })
      .expect(200);

    assert.equal(updated.body.name, 'Patched Name');
    assert.equal(updated.body.company, 'Patched Co');
    assert.equal(updated.body.role, 'FAMILY');
    assert.equal(updated.body.email, 'patched@contacts-test.example');

    await auth(request(app).patch(`/contacts/${created.id}`)).send({}).expect(400);
    await auth(request(app).patch('/contacts/missing')).send({ name: 'X' }).expect(404);
  });

  it('DELETE /contacts/:id soft-deletes only and never hard-deletes', async () => {
    const created = await createFixture({ name: 'Soft Delete Me' });

    const deleted = await auth(request(app).delete(`/contacts/${created.id}`)).expect(200);
    assert.equal(deleted.body.id, created.id);
    assert.ok(deleted.body.deletedAt);

    const row = await prisma.contact.findUnique({ where: { id: created.id } });
    assert.ok(row, 'row must still exist after soft delete');
    assert.ok(row.deletedAt);

    // Already soft-deleted → 404; record remains.
    await auth(request(app).delete(`/contacts/${created.id}`)).expect(404);
    const stillThere = await prisma.contact.findUnique({ where: { id: created.id } });
    assert.ok(stillThere);

    // Soft-deleted contacts are excluded from list/search.
    const list = await auth(request(app).get('/contacts'))
      .query({ q: 'Soft Delete Me' })
      .expect(200);
    assert.equal(list.body.data.length, 0);

    // Direct service soft-delete of missing id returns null.
    const missing = await softDeleteContact('definitely-missing-id');
    assert.equal(missing, null);
  });

  it('does not alter existing endpoints', async () => {
    const health = await request(app).get('/health').expect(200);
    assert.deepEqual(Object.keys(health.body).sort(), ['service', 'status', 'timestamp']);

    await request(app).get('/qr').expect(404);
    await request(app).get('/morning').expect(401);
  });

  it('creates with defaults when only name is provided', async () => {
    const created = await createContact({ name: 'Minimal Contact' });
    createdIds.push(created.id);
    assert.equal(created.name, 'Minimal Contact');
    assert.equal(created.phone, null);
    assert.equal(created.email, null);
    assert.equal(created.company, null);
    assert.equal(created.role, 'OTHER');
    assert.equal(created.notes, null);

    // Tag for cleanup helpers that filter test rows.
    await updateContact(created.id, { notes: '[test-contacts] minimal', email: 'minimal@contacts-test.example' });
  });

  it('listContacts falls back for unknown sort and reports empty pages', async () => {
    const empty = await listContacts({
      q: 'zzzz-no-match-contacts-test',
      page: 1,
      limit: 10,
      sort: 'not-a-real-sort',
    });
    assert.equal(empty.pagination.total, 0);
    assert.equal(empty.pagination.totalPages, 0);
    assert.deepEqual(empty.data, []);
  });

  it('updateContact returns null for missing ids', async () => {
    const missing = await updateContact('missing-contact-id', { name: 'Nope' });
    assert.equal(missing, null);
  });
});

describe('Contacts API error paths', () => {
  let app;
  const originals = {};

  before(() => {
    process.env.DATABASE_URL = DATABASE_URL;
    const env = loadEnv(VALID_ENV);
    app = express();
    app.use(express.json());
    app.use('/contacts', createContactsRouter({ adminAuth: requireAdmin(env) }));
  });

  afterEach(() => {
    for (const key of Object.keys(originals)) {
      if (key === 'safeParseId') {
        schemas.contactIdParamSchema.safeParse = originals.safeParseId;
      } else {
        contacts[key] = originals[key];
      }
      delete originals[key];
    }
  });

  function stubContactFn(name, impl) {
    if (!(name in originals)) {
      originals[name] = contacts[name];
    }
    contacts[name] = impl;
  }

  it('returns 500 when list/get/create/update/delete services fail', async () => {
    stubContactFn('listContacts', async () => {
      throw new Error('list boom');
    });
    await auth(request(app).get('/contacts')).expect(500);

    stubContactFn('getContactById', async () => {
      throw 'get boom';
    });
    await auth(request(app).get('/contacts/abc')).expect(500);

    stubContactFn('createContact', async () => {
      throw new Error('create boom');
    });
    await auth(request(app).post('/contacts')).send({ name: 'X' }).expect(500);

    stubContactFn('updateContact', async () => {
      throw new Error('update boom');
    });
    await auth(request(app).patch('/contacts/abc')).send({ name: 'Y' }).expect(500);

    stubContactFn('softDeleteContact', async () => {
      throw new Error('delete boom');
    });
    await auth(request(app).delete('/contacts/abc')).expect(500);
  });

  it('returns 400 when contact id params fail validation', async () => {
    originals.safeParseId = schemas.contactIdParamSchema.safeParse;
    schemas.contactIdParamSchema.safeParse = () => ({
      success: false,
      error: createContactSchema.safeParse({}).error,
    });

    await auth(request(app).get('/contacts/abc')).expect(400);
    await auth(request(app).patch('/contacts/abc')).send({ name: 'Y' }).expect(400);
    await auth(request(app).delete('/contacts/abc')).expect(400);
  });
});
