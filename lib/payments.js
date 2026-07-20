const { Prisma } = require('@prisma/client');
const db = require('./db');
const { SORT_FIELDS } = require('./paymentsSchemas');

const TERMINAL_HIDDEN_STATUSES = ['ARCHIVED', 'CANCELLED'];
const NON_OVERDUE_STATUSES = ['PAID', 'CANCELLED', 'ARCHIVED'];

/**
 * @typedef {object} PaymentRecord
 * @property {string} id
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} deletedAt
 * @property {string} payeeName
 * @property {string | null} contactId
 * @property {string} businessUnit
 * @property {string | null} category
 * @property {string | null} description
 * @property {import('@prisma/client').Prisma.Decimal | string} amount
 * @property {string} currency
 * @property {Date} dueDate
 * @property {string} status
 * @property {string | null} invoiceNumber
 * @property {string | null} paymentMethod
 * @property {Date | null} paidAt
 * @property {Date | null} approvedAt
 * @property {string | null} notes
 * @property {string} source
 */

/**
 * Format Prisma Decimal / string amount as a fixed decimal string (no float).
 * Always emits 4 fractional digits to match Decimal(19,4) storage.
 * @param {import('@prisma/client').Prisma.Decimal | string | number} amount
 */
function formatAmount(amount) {
  const decimal = amount instanceof Prisma.Decimal ? amount : new Prisma.Decimal(amount);
  return decimal.toFixed(4);
}

/**
 * Serialize a Prisma payment for JSON responses.
 * Amount is always a decimal string — never a float.
 * @param {PaymentRecord} payment
 * @param {{ now?: Date }} [options]
 */
function serializePayment(payment, options = {}) {
  const now = options.now || new Date();
  return {
    id: payment.id,
    payeeName: payment.payeeName,
    contactId: payment.contactId,
    businessUnit: payment.businessUnit,
    category: payment.category,
    description: payment.description,
    amount: formatAmount(payment.amount),
    currency: payment.currency,
    dueDate: payment.dueDate.toISOString(),
    status: payment.status,
    isOverdue: isEffectivelyOverdue(payment, now),
    invoiceNumber: payment.invoiceNumber,
    paymentMethod: payment.paymentMethod,
    paidAt: payment.paidAt ? payment.paidAt.toISOString() : null,
    approvedAt: payment.approvedAt ? payment.approvedAt.toISOString() : null,
    notes: payment.notes,
    source: payment.source,
    createdAt: payment.createdAt.toISOString(),
    updatedAt: payment.updatedAt.toISOString(),
    deletedAt: payment.deletedAt ? payment.deletedAt.toISOString() : null,
  };
}

/**
 * Effective overdue: past dueDate and not paid/cancelled/archived (and not soft-deleted).
 * Computed at read time — no scheduled DB status update required.
 * @param {{ dueDate: Date, status: string, deletedAt?: Date | null, paidAt?: Date | null }} payment
 * @param {Date} [now]
 */
function isEffectivelyOverdue(payment, now = new Date()) {
  if (payment.deletedAt) {
    return false;
  }
  if (NON_OVERDUE_STATUSES.includes(payment.status)) {
    return false;
  }
  if (payment.paidAt) {
    return false;
  }
  return payment.dueDate.getTime() < now.getTime();
}

/**
 * Active (non-soft-deleted) payments.
 * @param {Record<string, unknown>} [extra]
 */
function activeWhere(extra = {}) {
  return {
    deletedAt: null,
    ...extra,
  };
}

/**
 * Build list filters: search, status/businessUnit/currency/contactId/due range, archive rule.
 * Soft-deleted never appear. ARCHIVED and CANCELLED are hidden unless includeArchived
 * (CANCELLED still excluded unless status=CANCELLED is requested with includeArchived).
 * @param {{
 *   q?: string,
 *   status?: string,
 *   businessUnit?: string,
 *   currency?: string,
 *   contactId?: string,
 *   dueFrom?: string | null,
 *   dueTo?: string | null,
 *   includeArchived?: boolean,
 * }} query
 */
function buildListWhere(query) {
  /** @type {Record<string, unknown>} */
  const where = activeWhere();

  if (query.status) {
    if (!query.includeArchived && TERMINAL_HIDDEN_STATUSES.includes(query.status)) {
      where.id = { in: [] };
    } else {
      where.status = query.status;
    }
  } else if (!query.includeArchived) {
    where.status = { notIn: TERMINAL_HIDDEN_STATUSES };
  }

  if (query.businessUnit) {
    where.businessUnit = query.businessUnit;
  }
  if (query.currency) {
    where.currency = query.currency;
  }
  if (query.contactId) {
    where.contactId = query.contactId;
  }

  if (query.dueFrom != null || query.dueTo != null) {
    /** @type {Record<string, Date>} */
    const dueDate = {};
    if (query.dueFrom != null) {
      dueDate.gte = new Date(query.dueFrom);
    }
    if (query.dueTo != null) {
      dueDate.lte = new Date(query.dueTo);
    }
    where.dueDate = dueDate;
  }

  if (query.q) {
    const term = query.q.trim();
    if (term) {
      where.OR = [
        { payeeName: { contains: term, mode: 'insensitive' } },
        { description: { contains: term, mode: 'insensitive' } },
        { invoiceNumber: { contains: term, mode: 'insensitive' } },
        { notes: { contains: term, mode: 'insensitive' } },
      ];
    }
  }

  return where;
}

/**
 * @param {'dueDate' | 'amount' | 'updatedAt' | 'payeeName'} sort
 */
function buildOrderBy(sort) {
  if (sort === 'amount') {
    return { amount: 'asc' };
  }
  if (sort === 'updatedAt') {
    return { updatedAt: 'desc' };
  }
  if (sort === 'payeeName') {
    return { payeeName: 'asc' };
  }
  return { dueDate: 'asc' };
}

/**
 * List payments with search, filters, sorting, and pagination.
 * @param {{
 *   q?: string,
 *   status?: string,
 *   businessUnit?: string,
 *   currency?: string,
 *   contactId?: string,
 *   dueFrom?: string | null,
 *   dueTo?: string | null,
 *   includeArchived?: boolean,
 *   page: number,
 *   limit: number,
 *   sort: string,
 * }} query
 */
async function listPayments(query) {
  const prisma = db.getPrisma();
  const where = buildListWhere(query);
  const sort = SORT_FIELDS.includes(query.sort) ? query.sort : 'dueDate';
  const skip = (query.page - 1) * query.limit;
  const now = new Date();

  const [total, rows] = await Promise.all([
    prisma.payment.count({ where }),
    prisma.payment.findMany({
      where,
      orderBy: buildOrderBy(sort),
      skip,
      take: query.limit,
    }),
  ]);

  const totalPages = total === 0 ? 0 : Math.ceil(total / query.limit);

  return {
    data: rows.map((row) => serializePayment(row, { now })),
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages,
    },
  };
}

/**
 * Get one active payment by id.
 * @param {string} id
 * @returns {Promise<object | null>}
 */
async function getPaymentById(id) {
  const prisma = db.getPrisma();
  const payment = await prisma.payment.findFirst({
    where: activeWhere({ id }),
  });
  return payment ? serializePayment(payment) : null;
}

/**
 * Create a payment. Amount stored as Decimal.
 * @param {object} input
 */
async function createPayment(input) {
  const prisma = db.getPrisma();
  const status = input.status ?? 'DRAFT';
  const payment = await prisma.payment.create({
    data: {
      payeeName: input.payeeName,
      contactId: input.contactId ?? null,
      businessUnit: input.businessUnit,
      category: input.category ?? null,
      description: input.description ?? null,
      amount: new Prisma.Decimal(input.amount),
      currency: input.currency,
      dueDate: new Date(input.dueDate),
      status,
      invoiceNumber: input.invoiceNumber ?? null,
      paymentMethod: input.paymentMethod ?? null,
      notes: input.notes ?? null,
      source: input.source ?? 'MANUAL',
      paidAt: status === 'PAID' ? new Date() : null,
      approvedAt: status === 'APPROVED' || status === 'PAID' ? new Date() : null,
    },
  });
  return serializePayment(payment);
}

/**
 * True when Prisma rejected a foreign key (invalid contactId).
 * @param {unknown} err
 */
function isForeignKeyError(err) {
  return Boolean(err && typeof err === 'object' && 'code' in err && err.code === 'P2003');
}

/**
 * Patch a payment. Returns null if missing/soft-deleted.
 * @param {string} id
 * @param {object} input
 * @returns {Promise<{ payment: object } | { notFound: true } | { conflict: string }>}
 */
async function updatePayment(id, input) {
  const prisma = db.getPrisma();
  const existing = await prisma.payment.findFirst({ where: activeWhere({ id }) });
  if (!existing) {
    return { notFound: true };
  }

  if (existing.status === 'ARCHIVED' || existing.status === 'CANCELLED') {
    return { conflict: `Cannot update a ${existing.status.toLowerCase()} payment` };
  }

  /** @type {Record<string, unknown>} */
  const data = { ...input };
  if (input.amount !== undefined) {
    data.amount = new Prisma.Decimal(input.amount);
  }
  if (input.dueDate !== undefined) {
    data.dueDate = input.dueDate ? new Date(input.dueDate) : existing.dueDate;
  }
  if (input.status === 'PAID' && existing.status !== 'PAID') {
    data.paidAt = new Date();
    if (!existing.approvedAt) {
      data.approvedAt = new Date();
    }
  }
  if (input.status === 'APPROVED' && !existing.approvedAt) {
    data.approvedAt = new Date();
  }
  if (
    input.status &&
    ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'OVERDUE'].includes(input.status) &&
    existing.status === 'PAID'
  ) {
    data.paidAt = null;
  }

  const payment = await prisma.payment.update({
    where: { id },
    data,
  });
  return { payment: serializePayment(payment) };
}

/**
 * Approve a payment: status APPROVED, set approvedAt.
 * @param {string} id
 * @returns {Promise<{ payment: object } | { notFound: true } | { conflict: string }>}
 */
async function approvePayment(id) {
  const prisma = db.getPrisma();
  const existing = await prisma.payment.findFirst({ where: activeWhere({ id }) });
  if (!existing) {
    return { notFound: true };
  }

  if (['PAID', 'CANCELLED', 'ARCHIVED'].includes(existing.status)) {
    return { conflict: `Cannot approve a ${existing.status.toLowerCase()} payment` };
  }

  const payment = await prisma.payment.update({
    where: { id },
    data: {
      status: 'APPROVED',
      approvedAt: existing.approvedAt || new Date(),
    },
  });
  return { payment: serializePayment(payment) };
}

/**
 * Mark a payment paid. Requires paymentMethod or notes (validated upstream).
 * @param {string} id
 * @param {{ paymentMethod?: string | null, notes?: string | null }} input
 * @returns {Promise<{ payment: object } | { notFound: true } | { conflict: string }>}
 */
async function markPaymentPaid(id, input) {
  const prisma = db.getPrisma();
  const existing = await prisma.payment.findFirst({ where: activeWhere({ id }) });
  if (!existing) {
    return { notFound: true };
  }

  if (existing.status === 'PAID') {
    return { conflict: 'Payment is already paid' };
  }
  if (existing.status === 'CANCELLED' || existing.status === 'ARCHIVED') {
    return { conflict: `Cannot mark a ${existing.status.toLowerCase()} payment as paid` };
  }

  /** @type {Record<string, unknown>} */
  const data = {
    status: 'PAID',
    paidAt: new Date(),
  };
  if (input.paymentMethod !== undefined) {
    data.paymentMethod = input.paymentMethod;
  }
  if (input.notes !== undefined) {
    data.notes = input.notes;
  }
  if (!existing.approvedAt) {
    data.approvedAt = new Date();
  }

  const payment = await prisma.payment.update({
    where: { id },
    data,
  });
  return { payment: serializePayment(payment) };
}

/**
 * Reopen a paid payment: clear paidAt, set status APPROVED.
 * @param {string} id
 * @returns {Promise<{ payment: object } | { notFound: true } | { conflict: string }>}
 */
async function reopenPayment(id) {
  const prisma = db.getPrisma();
  const existing = await prisma.payment.findFirst({ where: activeWhere({ id }) });
  if (!existing) {
    return { notFound: true };
  }

  if (existing.status === 'CANCELLED' || existing.status === 'ARCHIVED') {
    return { conflict: `Cannot reopen a ${existing.status.toLowerCase()} payment` };
  }
  if (existing.status !== 'PAID' && !existing.paidAt) {
    return { conflict: 'Only paid payments can be reopened' };
  }

  const payment = await prisma.payment.update({
    where: { id },
    data: {
      status: 'APPROVED',
      paidAt: null,
    },
  });
  return { payment: serializePayment(payment) };
}

/**
 * Archive a payment (status ARCHIVED). Soft-deleted rows remain excluded separately.
 * @param {string} id
 * @returns {Promise<{ payment: object } | { notFound: true } | { conflict: string }>}
 */
async function archivePayment(id) {
  const prisma = db.getPrisma();
  const existing = await prisma.payment.findFirst({ where: activeWhere({ id }) });
  if (!existing) {
    return { notFound: true };
  }

  if (existing.status === 'ARCHIVED') {
    return { conflict: 'Payment is already archived' };
  }
  if (existing.status === 'CANCELLED') {
    return { conflict: 'Cannot archive a cancelled payment' };
  }

  const payment = await prisma.payment.update({
    where: { id },
    data: {
      status: 'ARCHIVED',
    },
  });
  return { payment: serializePayment(payment) };
}

/**
 * Soft-delete a payment (sets deletedAt). Never hard-deletes.
 * @param {string} id
 * @returns {Promise<object | null>}
 */
async function softDeletePayment(id) {
  const prisma = db.getPrisma();
  const existing = await prisma.payment.findFirst({ where: activeWhere({ id }) });
  if (!existing) {
    return null;
  }

  const payment = await prisma.payment.update({
    where: { id },
    data: {
      deletedAt: new Date(),
    },
  });
  return serializePayment(payment);
}

/**
 * Sum Decimal amounts by a grouping key. Returns string totals (no float).
 * @param {PaymentRecord[]} payments
 * @param {(p: PaymentRecord) => string} keyFn
 */
function sumTotalsBy(payments, keyFn) {
  /** @type {Map<string, import('@prisma/client').Prisma.Decimal>} */
  const map = new Map();
  for (const payment of payments) {
    const key = keyFn(payment);
    const current = map.get(key) || new Prisma.Decimal(0);
    map.set(key, current.add(new Prisma.Decimal(payment.amount)));
  }
  return Array.from(map.entries())
    .map(([key, total]) => ({ key, total: total.toFixed(4) }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Weekly report: due in next 7 days, overdue unpaid, totals, pending/overdue counts.
 * Overdue is computed from dueDate at read time (no scheduled status update).
 * Archived, cancelled, and soft-deleted payments are excluded.
 * @param {{ now?: Date }} [options]
 */
async function getWeeklyReport(options = {}) {
  const prisma = db.getPrisma();
  const now = options.now || new Date();
  const inSevenDays = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  const baseWhere = activeWhere({
    status: { notIn: TERMINAL_HIDDEN_STATUSES },
  });

  const rows = await prisma.payment.findMany({
    where: baseWhere,
    orderBy: { dueDate: 'asc' },
  });

  const dueSoon = rows.filter(
    (p) => p.dueDate.getTime() >= now.getTime() && p.dueDate.getTime() <= inSevenDays.getTime() && p.status !== 'PAID'
  );
  const overdue = rows.filter((p) => isEffectivelyOverdue(p, now));
  const pendingApprovals = rows.filter((p) => p.status === 'PENDING_APPROVAL');

  // Totals for actionable unpaid items in the report window (due soon + overdue).
  const reportPayments = [...dueSoon, ...overdue.filter((p) => !dueSoon.some((d) => d.id === p.id))];

  const byCurrency = sumTotalsBy(reportPayments, (p) => p.currency).map(({ key, total }) => ({
    currency: key,
    total,
  }));
  const byBusinessUnit = sumTotalsBy(reportPayments, (p) => p.businessUnit).map(({ key, total }) => ({
    businessUnit: key,
    total,
  }));

  return {
    generatedAt: now.toISOString(),
    window: {
      from: now.toISOString(),
      to: inSevenDays.toISOString(),
    },
    dueInNext7Days: dueSoon.map((p) => serializePayment(p, { now })),
    overdue: overdue.map((p) => serializePayment(p, { now })),
    totalsByCurrency: byCurrency,
    totalsByBusinessUnit: byBusinessUnit,
    pendingApprovalCount: pendingApprovals.length,
    overdueCount: overdue.length,
  };
}

module.exports = {
  formatAmount,
  serializePayment,
  isEffectivelyOverdue,
  activeWhere,
  buildListWhere,
  buildOrderBy,
  isForeignKeyError,
  sumTotalsBy,
  listPayments,
  getPaymentById,
  createPayment,
  updatePayment,
  approvePayment,
  markPaymentPaid,
  reopenPayment,
  archivePayment,
  softDeletePayment,
  getWeeklyReport,
  TERMINAL_HIDDEN_STATUSES,
  NON_OVERDUE_STATUSES,
};
