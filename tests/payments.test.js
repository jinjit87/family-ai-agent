const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const express = require('express');
const { Prisma } = require('@prisma/client');
const { createApp, loadEnv, requireAdmin } = require('../index');
const { getPrisma, disconnectPrisma } = require('../lib/db');
const {
  createPaymentSchema,
  updatePaymentSchema,
  listPaymentsQuerySchema,
  paymentIdParamSchema,
  markPaidSchema,
  formatZodError,
  amountSchema,
  currencySchema,
} = require('../lib/paymentsSchemas');
const payments = require('../lib/payments');
const schemas = require('../lib/paymentsSchemas');
const { createPaymentsRouter } = require('../lib/paymentsRouter');
const {
  buildListWhere,
  buildOrderBy,
  serializePayment,
  isEffectivelyOverdue,
  isForeignKeyError,
  formatAmount,
  sumTotalsBy,
  createPayment,
  listPayments,
  updatePayment,
  approvePayment,
  markPaymentPaid,
  reopenPayment,
  archivePayment,
  softDeletePayment,
  getPaymentById,
  getWeeklyReport,
} = payments;

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

function daysFromNow(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

describe('payments Zod schemas', () => {
  it('accepts a valid create payload and normalizes blank optionals to null', () => {
    const parsed = createPaymentSchema.parse({
      payeeName: '  Electric Co  ',
      businessUnit: 'HOUSE',
      amount: '450.50',
      currency: 'ils',
      dueDate: '2026-07-25T00:00:00.000Z',
      description: '  ',
      contactId: '',
      category: null,
      invoiceNumber: ' INV-1 ',
      notes: null,
    });
    assert.equal(parsed.payeeName, 'Electric Co');
    assert.equal(parsed.amount, '450.50');
    assert.equal(parsed.currency, 'ILS');
    assert.equal(parsed.description, null);
    assert.equal(parsed.contactId, null);
    assert.equal(parsed.invoiceNumber, 'INV-1');
  });

  it('rejects create without required fields and unknown fields', () => {
    const missing = createPaymentSchema.safeParse({});
    assert.equal(missing.success, false);
    const formatted = formatZodError(missing.error);
    assert.equal(formatted.error, 'Validation failed');
    assert.ok(formatted.details.some((d) => d.path === 'payeeName'));

    const extra = createPaymentSchema.safeParse({
      payeeName: 'A',
      businessUnit: 'HOUSE',
      amount: '10',
      currency: 'USD',
      dueDate: '2026-07-25T00:00:00.000Z',
      unexpected: true,
    });
    assert.equal(extra.success, false);
  });

  it('validates decimal amounts and rejects floating-point numbers', () => {
    assert.equal(amountSchema.parse('123.4567'), '123.4567');
    assert.equal(amountSchema.parse(100), '100');
    assert.equal(amountSchema.safeParse(10.5).success, false);
    assert.equal(amountSchema.safeParse('-1').success, false);
    assert.equal(amountSchema.safeParse('1.23456').success, false);
    assert.equal(amountSchema.safeParse('abc').success, false);
    assert.equal(amountSchema.safeParse(Number.POSITIVE_INFINITY).success, false);
  });

  it('validates ISO 4217 currency codes', () => {
    assert.equal(currencySchema.parse('usd'), 'USD');
    assert.equal(currencySchema.parse('EUR'), 'EUR');
    assert.equal(currencySchema.safeParse('US').success, false);
    assert.equal(currencySchema.safeParse('USDD').success, false);
    assert.equal(currencySchema.safeParse('12$').success, false);
  });

  it('requires at least one field on update', () => {
    const empty = updatePaymentSchema.safeParse({});
    assert.equal(empty.success, false);

    const ok = updatePaymentSchema.parse({ notes: 'Updated' });
    assert.equal(ok.notes, 'Updated');
  });

  it('parses list query defaults and rejects invalid filters/sort/page/limit', () => {
    const defaults = listPaymentsQuerySchema.parse({});
    assert.equal(defaults.page, 1);
    assert.equal(defaults.limit, 20);
    assert.equal(defaults.sort, 'dueDate');
    assert.equal(defaults.includeArchived, false);

    assert.equal(listPaymentsQuerySchema.safeParse({ page: 0 }).success, false);
    assert.equal(listPaymentsQuerySchema.safeParse({ limit: 101 }).success, false);
    assert.equal(listPaymentsQuerySchema.safeParse({ sort: 'createdAt' }).success, false);
    assert.equal(listPaymentsQuerySchema.safeParse({ status: 'DONE' }).success, false);
    assert.equal(listPaymentsQuerySchema.safeParse({ businessUnit: 'ACME' }).success, false);
    assert.equal(listPaymentsQuerySchema.parse({ includeArchived: 'true' }).includeArchived, true);
    assert.equal(listPaymentsQuerySchema.parse({ includeArchived: '1' }).includeArchived, true);
    assert.equal(listPaymentsQuerySchema.parse({ currency: 'gbp' }).currency, 'GBP');

    const badRange = listPaymentsQuerySchema.safeParse({
      dueFrom: '2026-08-01T00:00:00.000Z',
      dueTo: '2026-07-01T00:00:00.000Z',
    });
    assert.equal(badRange.success, false);
  });

  it('markPaidSchema requires paymentMethod or notes', () => {
    assert.equal(markPaidSchema.safeParse({}).success, false);
    assert.equal(markPaidSchema.safeParse({ paymentMethod: null, notes: null }).success, false);
    assert.equal(markPaidSchema.parse({ paymentMethod: 'cash' }).paymentMethod, 'cash');
    assert.equal(markPaidSchema.parse({ notes: 'Paid at desk' }).notes, 'Paid at desk');
  });

  it('paymentIdParamSchema rejects empty ids', () => {
    assert.equal(paymentIdParamSchema.safeParse({ id: '' }).success, false);
    assert.equal(paymentIdParamSchema.safeParse({ id: 'abc' }).success, true);
  });
});

describe('payments helpers', () => {
  it('buildListWhere excludes archived/cancelled by default and supports filters/search', () => {
    const base = buildListWhere({});
    assert.deepEqual(base.status, { notIn: ['ARCHIVED', 'CANCELLED'] });
    assert.equal(base.deletedAt, null);

    const withFilters = buildListWhere({
      status: 'APPROVED',
      businessUnit: 'MILA',
      currency: 'USD',
      contactId: 'c1',
      dueFrom: '2026-07-01T00:00:00.000Z',
      dueTo: '2026-07-31T00:00:00.000Z',
      q: 'invoice',
      includeArchived: false,
    });
    assert.equal(withFilters.status, 'APPROVED');
    assert.equal(withFilters.businessUnit, 'MILA');
    assert.equal(withFilters.currency, 'USD');
    assert.equal(withFilters.contactId, 'c1');
    assert.ok(withFilters.dueDate);
    assert.ok(Array.isArray(withFilters.OR));
    assert.equal(withFilters.OR.length, 4);

    const archivedHidden = buildListWhere({ status: 'ARCHIVED', includeArchived: false });
    assert.deepEqual(archivedHidden.id, { in: [] });

    const cancelledHidden = buildListWhere({ status: 'CANCELLED', includeArchived: false });
    assert.deepEqual(cancelledHidden.id, { in: [] });

    const archivedShown = buildListWhere({ status: 'ARCHIVED', includeArchived: true });
    assert.equal(archivedShown.status, 'ARCHIVED');

    const includeAll = buildListWhere({ includeArchived: true });
    assert.equal(includeAll.status, undefined);

    assert.deepEqual(buildListWhere({ q: '   ' }).status, { notIn: ['ARCHIVED', 'CANCELLED'] });
  });

  it('buildOrderBy supports dueDate, amount, updatedAt, and payeeName', () => {
    assert.deepEqual(buildOrderBy('dueDate'), { dueDate: 'asc' });
    assert.deepEqual(buildOrderBy('amount'), { amount: 'asc' });
    assert.deepEqual(buildOrderBy('updatedAt'), { updatedAt: 'desc' });
    assert.deepEqual(buildOrderBy('payeeName'), { payeeName: 'asc' });
  });

  it('isEffectivelyOverdue computes overdue without requiring OVERDUE status', () => {
    const now = new Date('2026-07-20T12:00:00.000Z');
    const past = new Date('2026-07-10T00:00:00.000Z');
    const future = new Date('2026-07-25T00:00:00.000Z');

    assert.equal(
      isEffectivelyOverdue({ dueDate: past, status: 'APPROVED', deletedAt: null }, now),
      true
    );
    assert.equal(
      isEffectivelyOverdue({ dueDate: past, status: 'PENDING_APPROVAL', deletedAt: null }, now),
      true
    );
    assert.equal(isEffectivelyOverdue({ dueDate: past, status: 'PAID', deletedAt: null }, now), false);
    assert.equal(
      isEffectivelyOverdue({ dueDate: past, status: 'CANCELLED', deletedAt: null }, now),
      false
    );
    assert.equal(
      isEffectivelyOverdue({ dueDate: past, status: 'ARCHIVED', deletedAt: null }, now),
      false
    );
    assert.equal(
      isEffectivelyOverdue({ dueDate: past, status: 'APPROVED', deletedAt: now }, now),
      false
    );
    assert.equal(
      isEffectivelyOverdue({ dueDate: past, status: 'APPROVED', paidAt: now, deletedAt: null }, now),
      false
    );
    assert.equal(
      isEffectivelyOverdue({ dueDate: future, status: 'APPROVED', deletedAt: null }, now),
      false
    );
  });

  it('isForeignKeyError detects Prisma P2003 only', () => {
    assert.equal(isForeignKeyError({ code: 'P2003' }), true);
    assert.equal(isForeignKeyError({ code: 'P2002' }), false);
    assert.equal(isForeignKeyError(new Error('boom')), false);
    assert.equal(isForeignKeyError(null), false);
  });

  it('formatAmount and serializePayment keep amounts as decimal strings', () => {
    const now = new Date('2026-07-20T12:00:00.000Z');
    assert.equal(formatAmount(new Prisma.Decimal('19.99')), '19.9900');
    assert.equal(formatAmount('19.9900'), '19.9900');
    assert.equal(formatAmount(5), '5.0000');

    const serialized = serializePayment(
      {
        id: 'p1',
        payeeName: 'Vendor',
        contactId: null,
        businessUnit: 'HOUSE',
        category: null,
        description: null,
        amount: new Prisma.Decimal('100.2500'),
        currency: 'ILS',
        dueDate: new Date('2026-07-10T00:00:00.000Z'),
        status: 'APPROVED',
        invoiceNumber: null,
        paymentMethod: null,
        paidAt: null,
        approvedAt: null,
        notes: null,
        source: 'MANUAL',
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
      { now }
    );
    assert.equal(serialized.amount, '100.2500');
    assert.equal(typeof serialized.amount, 'string');
    assert.equal(serialized.isOverdue, true);
    assert.equal(serialized.paidAt, null);
    assert.equal(serialized.deletedAt, null);
  });

  it('sumTotalsBy groups decimal totals without float math', () => {
    const rows = [
      { amount: '10.10', currency: 'USD', businessUnit: 'MILA' },
      { amount: '0.20', currency: 'USD', businessUnit: 'HOUSE' },
      { amount: '5.00', currency: 'ILS', businessUnit: 'MILA' },
    ];
    const byCurrency = sumTotalsBy(rows, (p) => p.currency);
    assert.deepEqual(byCurrency, [
      { key: 'ILS', total: '5.0000' },
      { key: 'USD', total: '10.3000' },
    ]);
    const byBu = sumTotalsBy(rows, (p) => p.businessUnit);
    assert.ok(byBu.some((r) => r.key === 'MILA' && r.total === '15.1000'));
  });
});

describe('Payments API', () => {
  let app;
  let prisma;
  const createdPaymentIds = [];
  const createdContactIds = [];

  before(async () => {
    process.env.DATABASE_URL = DATABASE_URL;
    const env = loadEnv(VALID_ENV);
    app = createApp(env);
    prisma = getPrisma();
    await prisma.$queryRaw`SELECT 1`;
  });

  after(async () => {
    if (createdPaymentIds.length > 0) {
      await prisma.payment.deleteMany({ where: { id: { in: createdPaymentIds } } });
    }
    if (createdContactIds.length > 0) {
      await prisma.contact.deleteMany({ where: { id: { in: createdContactIds } } });
    }
    await disconnectPrisma();
  });

  async function cleanupFixtures() {
    await prisma.payment.deleteMany({
      where: {
        OR: [
          { notes: { startsWith: '[test-payments]' } },
          { description: { startsWith: '[test-payments]' } },
          { payeeName: { startsWith: '[test-payments]' } },
        ],
      },
    });
    await prisma.contact.deleteMany({
      where: {
        OR: [
          { notes: { startsWith: '[test-payments]' } },
          { email: { endsWith: '@payments-test.example' } },
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
        name: 'Payments Test Contact',
        email: `contact-${Date.now()}@payments-test.example`,
        notes: '[test-payments] contact fixture',
      },
    });
    createdContactIds.push(contact.id);
    return contact;
  }

  async function createFixture(overrides = {}) {
    const res = await auth(request(app).post('/payments'))
      .send({
        payeeName: overrides.payeeName || '[test-payments] Default Payee',
        businessUnit: overrides.businessUnit || 'HOUSE',
        amount: overrides.amount || '100.00',
        currency: overrides.currency || 'ILS',
        dueDate: overrides.dueDate || daysFromNow(3),
        description: overrides.description || '[test-payments] fixture',
        notes: overrides.notes || '[test-payments] notes',
        status: overrides.status,
        source: overrides.source,
        category: overrides.category,
        invoiceNumber: overrides.invoiceNumber,
        contactId: overrides.contactId,
        paymentMethod: overrides.paymentMethod,
      })
      .expect(201);
    createdPaymentIds.push(res.body.id);
    return res.body;
  }

  it('rejects unauthenticated requests on every payments endpoint', async () => {
    await request(app).get('/payments').expect(401);
    await request(app).get('/payments/reports/weekly').expect(401);
    await request(app).get('/payments/some-id').expect(401);
    await request(app)
      .post('/payments')
      .send({
        payeeName: 'X',
        businessUnit: 'HOUSE',
        amount: '1',
        currency: 'USD',
        dueDate: daysFromNow(1),
      })
      .expect(401);
    await request(app).patch('/payments/some-id').send({ notes: 'X' }).expect(401);
    await request(app).post('/payments/some-id/approve').expect(401);
    await request(app).post('/payments/some-id/mark-paid').send({ paymentMethod: 'cash' }).expect(401);
    await request(app).post('/payments/some-id/reopen').expect(401);
    await request(app).post('/payments/some-id/archive').expect(401);
    await request(app).delete('/payments/some-id').expect(401);
  });

  it('production mount order: /payments hits auth/router before catch-all 404', async () => {
    const unauth = await request(app).get('/payments');
    assert.equal(unauth.status, 401);
    assert.notEqual(unauth.status, 404);
    assert.equal(unauth.body.error, 'Unauthorized');

    const authed = await auth(request(app).get('/payments')).expect(200);
    assert.ok(Array.isArray(authed.body.data));
    assert.equal(typeof authed.body.pagination, 'object');

    const weekly = await auth(request(app).get('/payments/reports/weekly')).expect(200);
    assert.ok(Array.isArray(weekly.body.dueInNext7Days));
    assert.ok(Array.isArray(weekly.body.overdue));

    const missing = await request(app).get('/definitely-not-a-real-route').expect(404);
    assert.equal(missing.body.error, 'Not found');
  });

  it('POST /payments creates a payment with decimal amount and defaults', async () => {
    const res = await auth(request(app).post('/payments'))
      .send({
        payeeName: '[test-payments] Create Me',
        businessUnit: 'FAMILY',
        amount: '1250.5000',
        currency: 'ILS',
        dueDate: '2026-08-01T00:00:00.000Z',
        notes: '[test-payments] create',
      })
      .expect(201);

    createdPaymentIds.push(res.body.id);
    assert.equal(res.body.payeeName, '[test-payments] Create Me');
    assert.equal(res.body.status, 'DRAFT');
    assert.equal(res.body.source, 'MANUAL');
    assert.equal(res.body.amount, '1250.5000');
    assert.equal(typeof res.body.amount, 'string');
    assert.equal(res.body.currency, 'ILS');
    assert.equal(res.body.paidAt, null);
    assert.equal(res.body.deletedAt, null);
  });

  it('POST /payments returns 400 for invalid payloads and floating amounts', async () => {
    const missing = await auth(request(app).post('/payments')).send({ payeeName: 'X' }).expect(400);
    assert.equal(missing.body.error, 'Validation failed');

    const floatAmount = await auth(request(app).post('/payments'))
      .send({
        payeeName: '[test-payments] Float',
        businessUnit: 'HOUSE',
        amount: 10.25,
        currency: 'USD',
        dueDate: daysFromNow(1),
      })
      .expect(400);
    assert.equal(floatAmount.body.error, 'Validation failed');

    const badCurrency = await auth(request(app).post('/payments'))
      .send({
        payeeName: '[test-payments] Bad FX',
        businessUnit: 'HOUSE',
        amount: '10',
        currency: 'US',
        dueDate: daysFromNow(1),
      })
      .expect(400);
    assert.equal(badCurrency.body.error, 'Validation failed');
  });

  it('POST /payments sets paidAt/approvedAt when created as PAID', async () => {
    const res = await auth(request(app).post('/payments'))
      .send({
        payeeName: '[test-payments] Already Paid',
        businessUnit: 'MILA',
        amount: '50',
        currency: 'USD',
        dueDate: daysFromNow(1),
        status: 'PAID',
        notes: '[test-payments] paid create',
      })
      .expect(201);
    createdPaymentIds.push(res.body.id);
    assert.equal(res.body.status, 'PAID');
    assert.ok(res.body.paidAt);
    assert.ok(res.body.approvedAt);
  });

  it('GET /payments/:id returns a payment and 404 for missing', async () => {
    const created = await createFixture({ payeeName: '[test-payments] Lookup' });

    const ok = await auth(request(app).get(`/payments/${created.id}`)).expect(200);
    assert.equal(ok.body.id, created.id);
    assert.equal(ok.body.payeeName, '[test-payments] Lookup');

    await auth(request(app).get('/payments/does-not-exist')).expect(404);
  });

  it('GET /payments lists with pagination', async () => {
    await createFixture({ payeeName: '[test-payments] Page Alpha' });
    await createFixture({ payeeName: '[test-payments] Page Beta' });
    await createFixture({ payeeName: '[test-payments] Page Gamma' });

    const page1 = await auth(request(app).get('/payments'))
      .query({ limit: 2, page: 1, sort: 'payeeName', q: '[test-payments] Page' })
      .expect(200);

    assert.equal(page1.body.data.length, 2);
    assert.equal(page1.body.pagination.page, 1);
    assert.equal(page1.body.pagination.limit, 2);
    assert.equal(page1.body.pagination.total, 3);
    assert.equal(page1.body.pagination.totalPages, 2);

    const page2 = await auth(request(app).get('/payments'))
      .query({ limit: 2, page: 2, q: '[test-payments] Page' })
      .expect(200);
    assert.equal(page2.body.data.length, 1);
  });

  it('GET /payments?q= searches payeeName, description, invoiceNumber, notes', async () => {
    const byPayee = await createFixture({
      payeeName: '[test-payments] UniqueZebra Payee',
      description: '[test-payments] plain',
    });
    const byDesc = await createFixture({
      payeeName: '[test-payments] Other',
      description: '[test-payments] UniqueZebra in description',
    });
    const byInvoice = await createFixture({
      payeeName: '[test-payments] Invoice Holder',
      invoiceNumber: 'UniqueZebra-INV',
    });
    const byNotes = await createFixture({
      payeeName: '[test-payments] Notes Holder',
      notes: '[test-payments] UniqueZebra in notes',
    });
    await createFixture({
      payeeName: '[test-payments] Unrelated',
      description: '[test-payments] no match',
    });

    const res = await auth(request(app).get('/payments')).query({ q: 'UniqueZebra' }).expect(200);
    const ids = res.body.data.map((p) => p.id).sort();
    assert.deepEqual(ids, [byPayee.id, byDesc.id, byInvoice.id, byNotes.id].sort());
  });

  it('GET /payments filters by status, businessUnit, currency, contactId, due range', async () => {
    const contact = await createContactFixture();
    const match = await createFixture({
      payeeName: '[test-payments] Filter Match',
      status: 'APPROVED',
      businessUnit: 'TERAMIND',
      currency: 'EUR',
      contactId: contact.id,
      dueDate: '2026-07-15T00:00:00.000Z',
    });
    await createFixture({
      payeeName: '[test-payments] Filter Other',
      status: 'DRAFT',
      businessUnit: 'HOUSE',
      currency: 'USD',
      dueDate: '2026-08-15T00:00:00.000Z',
    });

    const byStatus = await auth(request(app).get('/payments'))
      .query({ status: 'APPROVED', q: '[test-payments] Filter' })
      .expect(200);
    assert.equal(byStatus.body.data.length, 1);
    assert.equal(byStatus.body.data[0].id, match.id);

    const byBu = await auth(request(app).get('/payments'))
      .query({ businessUnit: 'TERAMIND', q: '[test-payments] Filter' })
      .expect(200);
    assert.equal(byBu.body.data[0].id, match.id);

    const byCurrency = await auth(request(app).get('/payments'))
      .query({ currency: 'EUR', q: '[test-payments] Filter' })
      .expect(200);
    assert.equal(byCurrency.body.data[0].id, match.id);

    const byContact = await auth(request(app).get('/payments'))
      .query({ contactId: contact.id })
      .expect(200);
    assert.ok(byContact.body.data.some((p) => p.id === match.id));

    const byDue = await auth(request(app).get('/payments'))
      .query({
        dueFrom: '2026-07-01T00:00:00.000Z',
        dueTo: '2026-07-31T23:59:59.000Z',
        q: '[test-payments] Filter',
      })
      .expect(200);
    assert.equal(byDue.body.data.length, 1);
    assert.equal(byDue.body.data[0].id, match.id);
  });

  it('GET /payments sorts by dueDate, amount, updatedAt, and payeeName', async () => {
    const early = await createFixture({
      payeeName: '[test-payments] Sort Alpha',
      dueDate: '2026-07-21T10:00:00.000Z',
      amount: '50.00',
    });
    await new Promise((r) => setTimeout(r, 20));
    const late = await createFixture({
      payeeName: '[test-payments] Sort Zeta',
      dueDate: '2026-07-28T10:00:00.000Z',
      amount: '200.00',
    });
    await auth(request(app).patch(`/payments/${early.id}`))
      .send({ notes: '[test-payments] bumped' })
      .expect(200);

    const byDue = await auth(request(app).get('/payments'))
      .query({ sort: 'dueDate', q: '[test-payments] Sort' })
      .expect(200);
    assert.equal(byDue.body.data[0].id, early.id);
    assert.equal(byDue.body.data[1].id, late.id);

    const byAmount = await auth(request(app).get('/payments'))
      .query({ sort: 'amount', q: '[test-payments] Sort' })
      .expect(200);
    assert.equal(byAmount.body.data[0].id, early.id);
    assert.equal(byAmount.body.data[1].id, late.id);

    const byName = await auth(request(app).get('/payments'))
      .query({ sort: 'payeeName', q: '[test-payments] Sort' })
      .expect(200);
    assert.equal(byName.body.data[0].id, early.id);
    assert.equal(byName.body.data[1].id, late.id);

    const byUpdated = await auth(request(app).get('/payments'))
      .query({ sort: 'updatedAt', q: '[test-payments] Sort' })
      .expect(200);
    assert.equal(byUpdated.body.data[0].id, early.id);
    assert.equal(byUpdated.body.data[1].id, late.id);
  });

  it('GET /payments returns 400 for invalid query params', async () => {
    const res = await auth(request(app).get('/payments')).query({ sort: 'createdAt' }).expect(400);
    assert.equal(res.body.error, 'Validation failed');
  });

  it('archived and cancelled payments are hidden unless includeArchived=true', async () => {
    const open = await createFixture({ payeeName: '[test-payments] Archive Open' });
    const archived = await createFixture({ payeeName: '[test-payments] Archive Hidden' });
    await auth(request(app).post(`/payments/${archived.id}/archive`)).expect(200);

    const cancelled = await createFixture({
      payeeName: '[test-payments] Cancel Hidden',
      status: 'CANCELLED',
    });

    const without = await auth(request(app).get('/payments'))
      .query({ q: '[test-payments] Archive' })
      .expect(200);
    const withoutIds = without.body.data.map((p) => p.id);
    assert.ok(withoutIds.includes(open.id));
    assert.ok(!withoutIds.includes(archived.id));

    const withArchived = await auth(request(app).get('/payments'))
      .query({ q: '[test-payments]', includeArchived: 'true' })
      .expect(200);
    const withIds = withArchived.body.data.map((p) => p.id);
    assert.ok(withIds.includes(open.id));
    assert.ok(withIds.includes(archived.id));
    assert.ok(withIds.includes(cancelled.id));

    const filterArchivedNoFlag = await auth(request(app).get('/payments'))
      .query({ status: 'ARCHIVED', q: '[test-payments]' })
      .expect(200);
    assert.equal(filterArchivedNoFlag.body.data.length, 0);
  });

  it('PATCH /payments/:id updates fields and validates input', async () => {
    const created = await createFixture({ payeeName: '[test-payments] Patch Me' });

    const updated = await auth(request(app).patch(`/payments/${created.id}`))
      .send({
        payeeName: '[test-payments] Patched',
        amount: '199.99',
        currency: 'USD',
        businessUnit: 'MILA',
        dueDate: '2026-08-01T12:00:00.000Z',
      })
      .expect(200);

    assert.equal(updated.body.payeeName, '[test-payments] Patched');
    assert.equal(updated.body.amount, '199.9900');
    assert.equal(updated.body.currency, 'USD');
    assert.equal(updated.body.businessUnit, 'MILA');
    assert.equal(updated.body.dueDate, '2026-08-01T12:00:00.000Z');

    await auth(request(app).patch(`/payments/${created.id}`)).send({}).expect(400);
    await auth(request(app).patch('/payments/missing')).send({ notes: 'X' }).expect(404);
  });

  it('POST /payments/:id/approve sets status and approvedAt', async () => {
    const created = await createFixture({
      payeeName: '[test-payments] Approve Me',
      status: 'PENDING_APPROVAL',
    });

    const approved = await auth(request(app).post(`/payments/${created.id}/approve`)).expect(200);
    assert.equal(approved.body.status, 'APPROVED');
    assert.ok(approved.body.approvedAt);

    await auth(request(app).post('/payments/missing/approve')).expect(404);
  });

  it('POST /payments/:id/mark-paid requires method or notes and sets PAID', async () => {
    const created = await createFixture({ payeeName: '[test-payments] Pay Me' });

    await auth(request(app).post(`/payments/${created.id}/mark-paid`)).send({}).expect(400);

    const paid = await auth(request(app).post(`/payments/${created.id}/mark-paid`))
      .send({ paymentMethod: 'bank_transfer' })
      .expect(200);
    assert.equal(paid.body.status, 'PAID');
    assert.ok(paid.body.paidAt);
    assert.equal(paid.body.paymentMethod, 'bank_transfer');

    await auth(request(app).post(`/payments/${created.id}/mark-paid`))
      .send({ paymentMethod: 'cash' })
      .expect(409);

    const notesOnly = await createFixture({ payeeName: '[test-payments] Pay Via Notes' });
    const paidNotes = await auth(request(app).post(`/payments/${notesOnly.id}/mark-paid`))
      .send({ notes: '[test-payments] paid in cash' })
      .expect(200);
    assert.equal(paidNotes.body.status, 'PAID');
    assert.match(paidNotes.body.notes, /paid in cash/);

    await auth(request(app).post('/payments/missing/mark-paid'))
      .send({ paymentMethod: 'cash' })
      .expect(404);
  });

  it('POST /payments/:id/reopen clears paidAt and sets APPROVED', async () => {
    const created = await createFixture({ payeeName: '[test-payments] Reopen Me' });
    await auth(request(app).post(`/payments/${created.id}/mark-paid`))
      .send({ paymentMethod: 'cash' })
      .expect(200);

    const reopened = await auth(request(app).post(`/payments/${created.id}/reopen`)).expect(200);
    assert.equal(reopened.body.status, 'APPROVED');
    assert.equal(reopened.body.paidAt, null);

    await auth(request(app).post(`/payments/${created.id}/reopen`)).expect(409);
    await auth(request(app).post('/payments/missing/reopen')).expect(404);
  });

  it('POST /payments/:id/archive archives a payment', async () => {
    const created = await createFixture({ payeeName: '[test-payments] Archive Me' });
    const archived = await auth(request(app).post(`/payments/${created.id}/archive`)).expect(200);
    assert.equal(archived.body.status, 'ARCHIVED');

    await auth(request(app).post(`/payments/${created.id}/archive`)).expect(409);
    await auth(request(app).post('/payments/missing/archive')).expect(404);
  });

  it('soft delete hides payment from list/get and weekly report', async () => {
    const created = await createFixture({ payeeName: '[test-payments] Soft Delete Me' });

    const deleted = await auth(request(app).delete(`/payments/${created.id}`)).expect(200);
    assert.ok(deleted.body.deletedAt);

    await auth(request(app).get(`/payments/${created.id}`)).expect(404);
    await auth(request(app).delete(`/payments/${created.id}`)).expect(404);

    const listed = await auth(request(app).get('/payments'))
      .query({ q: '[test-payments] Soft Delete Me', includeArchived: 'true' })
      .expect(200);
    assert.equal(listed.body.data.length, 0);

    const report = await auth(request(app).get('/payments/reports/weekly')).expect(200);
    assert.ok(!report.body.dueInNext7Days.some((p) => p.id === created.id));
    assert.ok(!report.body.overdue.some((p) => p.id === created.id));
  });

  it('weekly report returns due soon, overdue, totals, and counts', async () => {
    const overduePayment = await createFixture({
      payeeName: '[test-payments] Report Overdue',
      amount: '100.00',
      currency: 'ILS',
      businessUnit: 'HOUSE',
      status: 'APPROVED',
      dueDate: daysFromNow(-5),
    });
    const dueSoon = await createFixture({
      payeeName: '[test-payments] Report Due Soon',
      amount: '50.25',
      currency: 'ILS',
      businessUnit: 'FAMILY',
      status: 'APPROVED',
      dueDate: daysFromNow(2),
    });
    const pending = await createFixture({
      payeeName: '[test-payments] Report Pending',
      amount: '10.00',
      currency: 'USD',
      businessUnit: 'MILA',
      status: 'PENDING_APPROVAL',
      dueDate: daysFromNow(4),
    });
    const paid = await createFixture({
      payeeName: '[test-payments] Report Paid',
      amount: '999.00',
      currency: 'ILS',
      businessUnit: 'HOUSE',
      status: 'PAID',
      dueDate: daysFromNow(-2),
    });
    const archived = await createFixture({
      payeeName: '[test-payments] Report Archived',
      amount: '5.00',
      currency: 'ILS',
      businessUnit: 'HOUSE',
      dueDate: daysFromNow(-1),
    });
    await auth(request(app).post(`/payments/${archived.id}/archive`)).expect(200);

    const report = await auth(request(app).get('/payments/reports/weekly')).expect(200);

    assert.ok(report.body.overdue.some((p) => p.id === overduePayment.id));
    assert.ok(report.body.dueInNext7Days.some((p) => p.id === dueSoon.id));
    assert.ok(report.body.dueInNext7Days.some((p) => p.id === pending.id));
    assert.ok(!report.body.overdue.some((p) => p.id === paid.id));
    assert.ok(!report.body.overdue.some((p) => p.id === archived.id));
    assert.ok(!report.body.dueInNext7Days.some((p) => p.id === paid.id));

    assert.ok(report.body.overdueCount >= 1);
    assert.ok(report.body.pendingApprovalCount >= 1);

    const ilsTotal = report.body.totalsByCurrency.find((t) => t.currency === 'ILS');
    assert.ok(ilsTotal);
    assert.equal(typeof ilsTotal.total, 'string');
    assert.equal(ilsTotal.total.includes('.'), true);
    // 100.00 + 50.25 from overdue + due soon (paid/archived excluded)
    assert.ok(Number(ilsTotal.total) >= 150.25);

    const houseTotal = report.body.totalsByBusinessUnit.find((t) => t.businessUnit === 'HOUSE');
    assert.ok(houseTotal);
    assert.equal(typeof houseTotal.total, 'string');

    // Overdue is computed even when stored status is APPROVED, not OVERDUE
    const overdueRow = report.body.overdue.find((p) => p.id === overduePayment.id);
    assert.equal(overdueRow.status, 'APPROVED');
    assert.equal(overdueRow.isOverdue, true);
  });

  it('rejects invalid contactId without leaking Prisma details', async () => {
    const logs = [];
    const originalError = console.error;
    console.error = (...args) => {
      logs.push(args.map(String).join(' '));
    };

    try {
      const badContact = await auth(request(app).post('/payments'))
        .send({
          payeeName: '[test-payments] Bad Contact',
          businessUnit: 'HOUSE',
          amount: '10',
          currency: 'USD',
          dueDate: daysFromNow(1),
          notes: '[test-payments] fk',
          contactId: 'nonexistent-contact-id',
        })
        .expect(400);

      assert.equal(badContact.body.error, 'Invalid contactId');
      assert.equal(Object.keys(badContact.body).join(','), 'error');
      const bodyText = JSON.stringify(badContact.body);
      assert.equal(bodyText.includes('Prisma'), false);
      assert.equal(bodyText.includes('P2003'), false);
      assert.equal(bodyText.includes('Foreign key'), false);

      const created = await createFixture({ payeeName: '[test-payments] Patch Bad FK' });
      const badPatch = await auth(request(app).patch(`/payments/${created.id}`))
        .send({ contactId: 'still-missing-contact' })
        .expect(400);
      assert.equal(badPatch.body.error, 'Invalid contactId');

      for (const line of logs) {
        assert.equal(line.includes('Prisma'), false, `log leaked Prisma: ${line}`);
        assert.equal(line.includes('P2003'), false, `log leaked P2003: ${line}`);
        assert.match(line, /invalid related id|database error/);
      }
    } finally {
      console.error = originalError;
    }
  });

  it('does not alter existing Contacts or Tasks endpoint behavior', async () => {
    const health = await request(app).get('/health').expect(200);
    assert.deepEqual(Object.keys(health.body).sort(), ['service', 'status', 'timestamp']);

    await request(app).get('/qr').expect(404);
    await request(app).get('/morning').expect(401);

    const contactsUnauth = await request(app).get('/contacts').expect(401);
    assert.equal(contactsUnauth.body.error, 'Unauthorized');

    const tasksUnauth = await request(app).get('/tasks').expect(401);
    assert.equal(tasksUnauth.body.error, 'Unauthorized');

    const contacts = await auth(request(app).get('/contacts')).expect(200);
    assert.ok(Array.isArray(contacts.body.data));
    assert.equal(typeof contacts.body.pagination, 'object');

    const tasks = await auth(request(app).get('/tasks')).expect(200);
    assert.ok(Array.isArray(tasks.body.data));
    assert.equal(typeof tasks.body.pagination, 'object');
  });

  it('service helpers cover defaults, fallbacks, conflicts, and missing ids', async () => {
    const created = await createPayment({
      payeeName: '[test-payments] Service Minimal',
      businessUnit: 'OTHER',
      amount: '1',
      currency: 'GBP',
      dueDate: daysFromNow(1),
      notes: '[test-payments] service',
    });
    createdPaymentIds.push(created.id);
    assert.equal(created.status, 'DRAFT');
    assert.equal(created.source, 'MANUAL');

    const empty = await listPayments({
      q: 'zzzz-no-match-payments-test',
      page: 1,
      limit: 10,
      sort: 'not-a-real-sort',
      includeArchived: false,
    });
    assert.equal(empty.pagination.total, 0);
    assert.equal(empty.pagination.totalPages, 0);
    assert.deepEqual(empty.data, []);

    assert.equal(await getPaymentById('missing-payment-id'), null);
    assert.deepEqual(await updatePayment('missing-payment-id', { notes: 'Nope' }), { notFound: true });
    assert.deepEqual(await approvePayment('missing-payment-id'), { notFound: true });
    assert.deepEqual(await markPaymentPaid('missing-payment-id', { paymentMethod: 'cash' }), {
      notFound: true,
    });
    assert.deepEqual(await reopenPayment('missing-payment-id'), { notFound: true });
    assert.deepEqual(await archivePayment('missing-payment-id'), { notFound: true });
    assert.equal(await softDeletePayment('missing-payment-id'), null);

    const approvedCreate = await createPayment({
      payeeName: '[test-payments] Service Approved',
      businessUnit: 'TAURUS',
      amount: '2',
      currency: 'EUR',
      dueDate: daysFromNow(1),
      status: 'APPROVED',
      notes: '[test-payments] service approved',
    });
    createdPaymentIds.push(approvedCreate.id);
    assert.ok(approvedCreate.approvedAt);

    const archived = await archivePayment(approvedCreate.id);
    assert.equal(archived.payment.status, 'ARCHIVED');
    assert.equal((await updatePayment(approvedCreate.id, { notes: 'x' })).conflict.includes('archived'), true);

    const cancelled = await createPayment({
      payeeName: '[test-payments] Service Cancelled',
      businessUnit: 'DOLCE_MILA',
      amount: '3',
      currency: 'USD',
      dueDate: daysFromNow(-1),
      status: 'CANCELLED',
      notes: '[test-payments] service cancelled',
    });
    createdPaymentIds.push(cancelled.id);
    assert.equal((await approvePayment(cancelled.id)).conflict.includes('cancelled'), true);
    assert.equal(
      (await markPaymentPaid(cancelled.id, { paymentMethod: 'cash' })).conflict.includes('cancelled'),
      true
    );
    assert.equal((await reopenPayment(cancelled.id)).conflict.includes('cancelled'), true);
    assert.equal((await archivePayment(cancelled.id)).conflict.includes('cancelled'), true);

    const report = await getWeeklyReport({ now: new Date() });
    assert.ok(Array.isArray(report.totalsByCurrency));
    assert.ok(Array.isArray(report.totalsByBusinessUnit));
  });

  it('updatePayment lifecycle adjusts paidAt when status changes via patch', async () => {
    const created = await createFixture({ payeeName: '[test-payments] Patch Status' });
    const paid = await updatePayment(created.id, { status: 'PAID' });
    assert.equal(paid.payment.status, 'PAID');
    assert.ok(paid.payment.paidAt);

    const reopened = await updatePayment(created.id, { status: 'APPROVED' });
    assert.equal(reopened.payment.status, 'APPROVED');
    assert.equal(reopened.payment.paidAt, null);
  });
});

describe('Payments API error paths', () => {
  let app;
  const originals = {};

  before(() => {
    process.env.DATABASE_URL = DATABASE_URL;
    const env = loadEnv(VALID_ENV);
    app = express();
    app.use(express.json());
    app.use('/payments', createPaymentsRouter({ adminAuth: requireAdmin(env) }));
  });

  afterEach(() => {
    for (const key of Object.keys(originals)) {
      if (key === 'safeParseId') {
        schemas.paymentIdParamSchema.safeParse = originals.safeParseId;
      } else {
        payments[key] = originals[key];
      }
      delete originals[key];
    }
  });

  function stubPaymentFn(name, impl) {
    if (!(name in originals)) {
      originals[name] = payments[name];
    }
    payments[name] = impl;
  }

  it('returns 500 when list/get/create/update/lifecycle/report services fail', async () => {
    stubPaymentFn('listPayments', async () => {
      throw new Error('list boom with Prisma Client details');
    });
    const listRes = await auth(request(app).get('/payments')).expect(500);
    assert.equal(listRes.body.error, 'Failed to list payments');
    assert.equal(JSON.stringify(listRes.body).includes('Prisma'), false);

    stubPaymentFn('getWeeklyReport', async () => {
      throw new Error('report boom');
    });
    await auth(request(app).get('/payments/reports/weekly')).expect(500);

    stubPaymentFn('getPaymentById', async () => {
      throw 'get boom';
    });
    await auth(request(app).get('/payments/abc')).expect(500);

    stubPaymentFn('createPayment', async () => {
      throw new Error('create boom');
    });
    await auth(request(app).post('/payments'))
      .send({
        payeeName: 'X',
        businessUnit: 'HOUSE',
        amount: '1',
        currency: 'USD',
        dueDate: daysFromNow(1),
      })
      .expect(500);

    stubPaymentFn('updatePayment', async () => {
      throw new Error('update boom');
    });
    await auth(request(app).patch('/payments/abc')).send({ notes: 'Y' }).expect(500);

    stubPaymentFn('approvePayment', async () => {
      throw new Error('approve boom');
    });
    await auth(request(app).post('/payments/abc/approve')).expect(500);

    stubPaymentFn('markPaymentPaid', async () => {
      throw new Error('paid boom');
    });
    await auth(request(app).post('/payments/abc/mark-paid')).send({ paymentMethod: 'cash' }).expect(500);

    stubPaymentFn('reopenPayment', async () => {
      throw new Error('reopen boom');
    });
    await auth(request(app).post('/payments/abc/reopen')).expect(500);

    stubPaymentFn('archivePayment', async () => {
      throw new Error('archive boom');
    });
    await auth(request(app).post('/payments/abc/archive')).expect(500);

    stubPaymentFn('softDeletePayment', async () => {
      throw new Error('delete boom');
    });
    await auth(request(app).delete('/payments/abc')).expect(500);
  });

  it('returns 400 for foreign-key failures without leaking Prisma details', async () => {
    const logs = [];
    const originalError = console.error;
    console.error = (...args) => {
      logs.push(args.map(String).join(' '));
    };

    try {
      stubPaymentFn('createPayment', async () => {
        const err = new Error('Foreign key constraint violated on Contact');
        err.code = 'P2003';
        throw err;
      });
      const res = await auth(request(app).post('/payments'))
        .send({
          payeeName: 'X',
          businessUnit: 'HOUSE',
          amount: '1',
          currency: 'USD',
          dueDate: daysFromNow(1),
        })
        .expect(400);
      assert.equal(res.body.error, 'Invalid contactId');
      assert.equal(JSON.stringify(res.body).includes('Prisma'), false);
      assert.equal(JSON.stringify(res.body).includes('P2003'), false);

      stubPaymentFn('updatePayment', async () => {
        const err = new Error('Foreign key constraint violated on Contact');
        err.code = 'P2003';
        throw err;
      });
      await auth(request(app).patch('/payments/abc')).send({ notes: 'Y' }).expect(400);

      assert.ok(logs.every((line) => !line.includes('P2003') && !line.includes('Foreign key')));
      assert.ok(logs.some((line) => line.includes('invalid related id')));
    } finally {
      console.error = originalError;
    }
  });

  it('returns 400 when payment id params fail validation', async () => {
    originals.safeParseId = schemas.paymentIdParamSchema.safeParse;
    schemas.paymentIdParamSchema.safeParse = () => ({
      success: false,
      error: createPaymentSchema.safeParse({}).error,
    });

    await auth(request(app).get('/payments/abc')).expect(400);
    await auth(request(app).patch('/payments/abc')).send({ notes: 'Y' }).expect(400);
    await auth(request(app).post('/payments/abc/approve')).expect(400);
    await auth(request(app).post('/payments/abc/mark-paid')).send({ paymentMethod: 'cash' }).expect(400);
    await auth(request(app).post('/payments/abc/reopen')).expect(400);
    await auth(request(app).post('/payments/abc/archive')).expect(400);
    await auth(request(app).delete('/payments/abc')).expect(400);
  });

  it('returns 409 from lifecycle conflict results', async () => {
    stubPaymentFn('approvePayment', async () => ({ conflict: 'Cannot approve a paid payment' }));
    const res = await auth(request(app).post('/payments/abc/approve')).expect(409);
    assert.equal(res.body.error, 'Cannot approve a paid payment');
  });
});
