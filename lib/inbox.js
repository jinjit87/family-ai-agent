const { Prisma } = require('@prisma/client');
const db = require('./db');
const { SORT_FIELDS } = require('./inboxSchemas');
const { createMockAnalysisProvider } = require('./inboxAnalysis');
const {
  createSaveSyncCursor,
  createStubSyncProvider,
  resolveSyncProvider,
} = require('./inboxSync');

/** @type {import('./inboxAnalysis').InboxAnalysisProvider} */
let analysisProvider = createMockAnalysisProvider();

/**
 * Override the analysis provider (tests / future Anthropic wiring).
 * @param {import('./inboxAnalysis').InboxAnalysisProvider} provider
 */
function setAnalysisProvider(provider) {
  analysisProvider = provider;
}

/**
 * Reset to the default mock provider.
 */
function resetAnalysisProvider() {
  analysisProvider = createMockAnalysisProvider();
}

/**
 * @param {unknown} err
 */
function isUniqueConstraintError(err) {
  return Boolean(err && typeof err === 'object' && 'code' in err && err.code === 'P2002');
}

/**
 * @param {unknown} err
 */
function isForeignKeyError(err) {
  return Boolean(err && typeof err === 'object' && 'code' in err && err.code === 'P2003');
}

/**
 * @param {Date | null | undefined} value
 */
function isoOrNull(value) {
  return value ? value.toISOString() : null;
}

/**
 * @param {import('@prisma/client').Prisma.Decimal | string | number | null | undefined} amount
 */
function formatAmount(amount) {
  if (amount === null || amount === undefined) return null;
  if (amount instanceof Prisma.Decimal) return amount.toFixed(4);
  return new Prisma.Decimal(amount).toFixed(4);
}

/**
 * Serialize an inbox account for JSON responses.
 * Never includes OAuth tokens or credentials.
 * @param {object} account
 */
function serializeAccount(account) {
  return {
    id: account.id,
    name: account.name,
    source: account.source,
    emailAddress: account.emailAddress,
    externalAccountId: account.externalAccountId,
    isActive: account.isActive,
    lastSyncedAt: isoOrNull(account.lastSyncedAt),
    syncCursor: account.syncCursor,
    createdAt: account.createdAt.toISOString(),
    updatedAt: account.updatedAt.toISOString(),
  };
}

/**
 * @param {object} suggestion
 */
function serializeTaskSuggestion(suggestion) {
  return {
    id: suggestion.id,
    inboxItemId: suggestion.inboxItemId,
    status: suggestion.status,
    confidence: suggestion.confidence,
    reason: suggestion.reason,
    title: suggestion.title,
    description: suggestion.description,
    priority: suggestion.priority,
    dueDate: isoOrNull(suggestion.dueDate),
    contactId: suggestion.contactId,
    evidence: suggestion.evidence ?? null,
    appliedTaskId: suggestion.appliedTaskId ?? null,
    createdAt: suggestion.createdAt.toISOString(),
    updatedAt: suggestion.updatedAt.toISOString(),
  };
}

/**
 * @param {object} suggestion
 */
function serializePaymentSuggestion(suggestion) {
  return {
    id: suggestion.id,
    inboxItemId: suggestion.inboxItemId,
    status: suggestion.status,
    confidence: suggestion.confidence,
    reason: suggestion.reason,
    payeeName: suggestion.payeeName,
    amount: formatAmount(suggestion.amount),
    currency: suggestion.currency,
    dueDate: isoOrNull(suggestion.dueDate),
    businessUnit: suggestion.businessUnit,
    category: suggestion.category,
    description: suggestion.description,
    invoiceNumber: suggestion.invoiceNumber,
    evidence: suggestion.evidence ?? null,
    appliedPaymentId: suggestion.appliedPaymentId ?? null,
    createdAt: suggestion.createdAt.toISOString(),
    updatedAt: suggestion.updatedAt.toISOString(),
  };
}

/**
 * @param {object} suggestion
 */
function serializeReplySuggestion(suggestion) {
  return {
    id: suggestion.id,
    inboxItemId: suggestion.inboxItemId,
    status: suggestion.status,
    confidence: suggestion.confidence,
    reason: suggestion.reason,
    replyText: suggestion.replyText,
    evidence: suggestion.evidence ?? null,
    createdAt: suggestion.createdAt.toISOString(),
    updatedAt: suggestion.updatedAt.toISOString(),
  };
}

/**
 * Serialize an inbox item.
 * @param {object} item
 * @param {{ includeRawContent?: boolean, includeSuggestions?: boolean }} [options]
 */
function serializeInboxItem(item, options = {}) {
  const includeRawContent = options.includeRawContent === true;
  const includeSuggestions = options.includeSuggestions === true;

  /** @type {Record<string, unknown>} */
  const payload = {
    id: item.id,
    inboxAccountId: item.inboxAccountId,
    source: item.source,
    externalId: item.externalId,
    threadExternalId: item.threadExternalId,
    senderName: item.senderName,
    senderIdentifier: item.senderIdentifier,
    recipients: item.recipients ?? null,
    subject: item.subject,
    summary: item.summary,
    status: item.status,
    confidence: item.confidence,
    urgency: item.urgency,
    receivedAt: item.receivedAt.toISOString(),
    processedAt: isoOrNull(item.processedAt),
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  };

  if (includeRawContent) {
    payload.rawContent = item.rawContent;
  }

  if (includeSuggestions) {
    payload.taskSuggestions = (item.taskSuggestions || []).map(serializeTaskSuggestion);
    payload.paymentSuggestions = (item.paymentSuggestions || []).map(serializePaymentSuggestion);
    payload.replySuggestions = (item.replySuggestions || []).map(serializeReplySuggestion);
  }

  return payload;
}

/**
 * @param {object} query
 */
function buildListWhere(query) {
  /** @type {Record<string, unknown>} */
  const where = {};

  if (query.inboxAccountId) where.inboxAccountId = query.inboxAccountId;
  if (query.source) where.source = query.source;
  if (query.status) where.status = query.status;
  if (query.urgency) where.urgency = query.urgency;
  if (query.senderIdentifier) where.senderIdentifier = query.senderIdentifier;

  if (query.receivedFrom || query.receivedTo) {
    /** @type {Record<string, Date>} */
    const receivedAt = {};
    if (query.receivedFrom) receivedAt.gte = new Date(query.receivedFrom);
    if (query.receivedTo) receivedAt.lte = new Date(query.receivedTo);
    where.receivedAt = receivedAt;
  }

  if (query.q) {
    const term = query.q.trim();
    if (term) {
      where.OR = [
        { senderName: { contains: term, mode: 'insensitive' } },
        { senderIdentifier: { contains: term, mode: 'insensitive' } },
        { subject: { contains: term, mode: 'insensitive' } },
        { summary: { contains: term, mode: 'insensitive' } },
      ];
    }
  }

  return where;
}

/**
 * @param {'receivedAt' | 'updatedAt' | 'urgency'} sort
 */
function buildOrderBy(sort) {
  if (sort === 'updatedAt') return { updatedAt: 'desc' };
  if (sort === 'urgency') return { urgency: 'desc' };
  return { receivedAt: 'desc' };
}

// ---- Accounts ----

async function listAccounts() {
  const prisma = db.getPrisma();
  const rows = await prisma.inboxAccount.findMany({
    orderBy: { updatedAt: 'desc' },
  });
  return { data: rows.map(serializeAccount) };
}

async function getAccountById(id) {
  const prisma = db.getPrisma();
  const account = await prisma.inboxAccount.findUnique({ where: { id } });
  return account ? serializeAccount(account) : null;
}

async function createAccount(input) {
  const prisma = db.getPrisma();
  const account = await prisma.inboxAccount.create({
    data: {
      name: input.name,
      source: input.source,
      emailAddress: input.emailAddress ?? null,
      externalAccountId: input.externalAccountId ?? null,
      isActive: input.isActive ?? true,
    },
  });
  return serializeAccount(account);
}

async function updateAccount(id, input) {
  const prisma = db.getPrisma();
  const existing = await prisma.inboxAccount.findUnique({ where: { id } });
  if (!existing) return null;

  const account = await prisma.inboxAccount.update({
    where: { id },
    data: input,
  });
  return serializeAccount(account);
}

async function activateAccount(id) {
  const prisma = db.getPrisma();
  const existing = await prisma.inboxAccount.findUnique({ where: { id } });
  if (!existing) return null;
  const account = await prisma.inboxAccount.update({
    where: { id },
    data: { isActive: true },
  });
  return serializeAccount(account);
}

async function deactivateAccount(id) {
  const prisma = db.getPrisma();
  const existing = await prisma.inboxAccount.findUnique({ where: { id } });
  if (!existing) return null;
  const account = await prisma.inboxAccount.update({
    where: { id },
    data: { isActive: false },
  });
  return serializeAccount(account);
}

/**
 * Persist sync cursor + lastSyncedAt for an account (independent cursors).
 * @param {string} accountId
 * @param {string | null} cursor
 */
async function persistSyncCursor(accountId, cursor) {
  const prisma = db.getPrisma();
  const account = await prisma.inboxAccount.update({
    where: { id: accountId },
    data: {
      syncCursor: cursor,
      lastSyncedAt: new Date(),
    },
  });
  return serializeAccount(account);
}

function getStubSyncProvider() {
  const saveSyncCursor = createSaveSyncCursor(persistSyncCursor);
  return createStubSyncProvider({ saveSyncCursor });
}

/**
 * Resolve sync provider for an account source (stub until OAuth/polling exists).
 * @param {string} source
 */
function getSyncProviderForSource(source) {
  return resolveSyncProvider(source, getStubSyncProvider());
}

// ---- Items ----

const suggestionInclude = {
  taskSuggestions: { orderBy: { createdAt: 'asc' } },
  paymentSuggestions: { orderBy: { createdAt: 'asc' } },
  replySuggestions: { orderBy: { createdAt: 'asc' } },
};

async function listInboxItems(query) {
  const prisma = db.getPrisma();
  const where = buildListWhere(query);
  const sort = SORT_FIELDS.includes(query.sort) ? query.sort : 'receivedAt';
  const skip = (query.page - 1) * query.limit;

  const [total, rows] = await Promise.all([
    prisma.inboxItem.count({ where }),
    prisma.inboxItem.findMany({
      where,
      orderBy: buildOrderBy(sort),
      skip,
      take: query.limit,
      // Explicitly omit rawContent from list fetches for safety/perf.
      select: {
        id: true,
        inboxAccountId: true,
        source: true,
        externalId: true,
        threadExternalId: true,
        senderName: true,
        senderIdentifier: true,
        recipients: true,
        subject: true,
        summary: true,
        status: true,
        confidence: true,
        urgency: true,
        receivedAt: true,
        processedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
  ]);

  const totalPages = total === 0 ? 0 : Math.ceil(total / query.limit);

  return {
    data: rows.map((row) => serializeInboxItem(row, { includeRawContent: false })),
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages,
    },
  };
}

async function getInboxItemById(id) {
  const prisma = db.getPrisma();
  const item = await prisma.inboxItem.findUnique({
    where: { id },
    include: suggestionInclude,
  });
  if (!item) return null;
  return serializeInboxItem(item, { includeRawContent: true, includeSuggestions: true });
}

/**
 * Ingest an inbox item for a specific account.
 * Duplicate (inboxAccountId, externalId) → conflict (not silent merge).
 * @param {object} input
 */
async function createInboxItem(input) {
  const prisma = db.getPrisma();
  const account = await prisma.inboxAccount.findUnique({ where: { id: input.inboxAccountId } });
  if (!account) {
    return { notFoundAccount: true };
  }

  try {
    const item = await prisma.inboxItem.create({
      data: {
        inboxAccountId: input.inboxAccountId,
        source: input.source ?? account.source,
        externalId: input.externalId,
        threadExternalId: input.threadExternalId ?? null,
        senderName: input.senderName ?? null,
        senderIdentifier: input.senderIdentifier,
        recipients: input.recipients ?? undefined,
        subject: input.subject ?? null,
        rawContent: input.rawContent,
        summary: input.summary ?? null,
        status: input.status ?? 'NEW',
        confidence: input.confidence ?? null,
        urgency: input.urgency ?? null,
        receivedAt: new Date(input.receivedAt),
      },
      include: suggestionInclude,
    });
    return {
      item: serializeInboxItem(item, { includeRawContent: true, includeSuggestions: true }),
    };
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      return { conflict: 'Inbox item with this externalId already exists for this account' };
    }
    if (isForeignKeyError(err)) {
      return { notFoundAccount: true };
    }
    throw err;
  }
}

async function updateInboxItem(id, input) {
  const prisma = db.getPrisma();
  const existing = await prisma.inboxItem.findUnique({ where: { id } });
  if (!existing) return null;

  /** @type {Record<string, unknown>} */
  const data = { ...input };
  if (input.receivedAt !== undefined) {
    data.receivedAt = input.receivedAt ? new Date(input.receivedAt) : existing.receivedAt;
  }
  if (input.recipients === undefined) {
    delete data.recipients;
  }

  const item = await prisma.inboxItem.update({
    where: { id },
    data,
    include: suggestionInclude,
  });
  return serializeInboxItem(item, { includeRawContent: true, includeSuggestions: true });
}

async function archiveInboxItem(id) {
  const prisma = db.getPrisma();
  const existing = await prisma.inboxItem.findUnique({ where: { id } });
  if (!existing) return null;

  const item = await prisma.inboxItem.update({
    where: { id },
    data: { status: 'ARCHIVED' },
    include: suggestionInclude,
  });
  return serializeInboxItem(item, { includeRawContent: true, includeSuggestions: true });
}

/**
 * Run AI analysis (mock provider) and persist suggestion rows.
 * Never creates Tasks or Payments.
 * @param {string} id
 */
async function analyzeInboxItem(id) {
  const prisma = db.getPrisma();
  const existing = await prisma.inboxItem.findUnique({ where: { id } });
  if (!existing) return { notFound: true };

  await prisma.inboxItem.update({
    where: { id },
    data: { status: 'PROCESSING' },
  });

  try {
    const analysis = await analysisProvider.analyze({
      id: existing.id,
      source: existing.source,
      senderName: existing.senderName,
      senderIdentifier: existing.senderIdentifier,
      subject: existing.subject,
      rawContent: existing.rawContent,
      receivedAt: existing.receivedAt,
    });

    // Replace prior suggestions so re-analyze is deterministic and pending-only.
    await prisma.$transaction(async (tx) => {
      await tx.inboxTaskSuggestion.deleteMany({
        where: { inboxItemId: id, status: { in: ['PENDING', 'REJECTED'] } },
      });
      await tx.inboxPaymentSuggestion.deleteMany({
        where: { inboxItemId: id, status: { in: ['PENDING', 'REJECTED'] } },
      });
      await tx.inboxReplySuggestion.deleteMany({
        where: { inboxItemId: id, status: { in: ['PENDING', 'REJECTED'] } },
      });

      if (analysis.suggestedTasks.length > 0) {
        await tx.inboxTaskSuggestion.createMany({
          data: analysis.suggestedTasks.map((s) => ({
            inboxItemId: id,
            status: 'PENDING',
            confidence: s.confidence,
            reason: s.reason,
            title: s.title,
            description: s.description ?? null,
            priority: s.priority ?? null,
            dueDate: s.dueDate ? new Date(s.dueDate) : null,
            evidence: s.evidence ?? undefined,
          })),
        });
      }

      if (analysis.suggestedPayments.length > 0) {
        await tx.inboxPaymentSuggestion.createMany({
          data: analysis.suggestedPayments.map((s) => ({
            inboxItemId: id,
            status: 'PENDING',
            confidence: s.confidence,
            reason: s.reason,
            payeeName: s.payeeName,
            amount: s.amount != null ? new Prisma.Decimal(s.amount) : null,
            currency: s.currency ?? null,
            dueDate: s.dueDate ? new Date(s.dueDate) : null,
            businessUnit: s.businessUnit ?? null,
            category: s.category ?? null,
            description: s.description ?? null,
            invoiceNumber: s.invoiceNumber ?? null,
            evidence: s.evidence ?? undefined,
          })),
        });
      }

      if (analysis.suggestedReplies.length > 0) {
        await tx.inboxReplySuggestion.createMany({
          data: analysis.suggestedReplies.map((s) => ({
            inboxItemId: id,
            status: 'PENDING',
            confidence: s.confidence,
            reason: s.reason,
            replyText: s.replyText,
            evidence: s.evidence ?? undefined,
          })),
        });
      }

      await tx.inboxItem.update({
        where: { id },
        data: {
          summary: analysis.summary,
          urgency: analysis.urgency,
          confidence: analysis.confidence,
          status: 'READY_FOR_REVIEW',
          processedAt: new Date(),
        },
      });
    });

    const item = await prisma.inboxItem.findUnique({
      where: { id },
      include: suggestionInclude,
    });

    return {
      item: serializeInboxItem(item, { includeRawContent: true, includeSuggestions: true }),
      analysis: {
        summary: analysis.summary,
        urgency: analysis.urgency,
        confidence: analysis.confidence,
        suggestedTasks: analysis.suggestedTasks,
        suggestedPayments: analysis.suggestedPayments,
        suggestedReplies: analysis.suggestedReplies,
      },
    };
  } catch (_err) {
    await prisma.inboxItem.update({
      where: { id },
      data: { status: 'FAILED' },
    });
    return { failed: true };
  }
}

// ---- Suggestion lifecycle ----

/**
 * @param {'PENDING'|'APPROVED'|'REJECTED'|'APPLIED'} from
 * @param {'APPROVED'|'REJECTED'} to
 */
function canTransitionSuggestion(from, to) {
  if (to === 'APPROVED') return from === 'PENDING' || from === 'APPROVED';
  if (to === 'REJECTED') return from === 'PENDING' || from === 'APPROVED' || from === 'REJECTED';
  return false;
}

async function approveTaskSuggestion(inboxItemId, suggestionId) {
  const prisma = db.getPrisma();
  const suggestion = await prisma.inboxTaskSuggestion.findFirst({
    where: { id: suggestionId, inboxItemId },
  });
  if (!suggestion) return { notFound: true };
  if (!canTransitionSuggestion(suggestion.status, 'APPROVED')) {
    return { conflict: `Cannot approve a ${suggestion.status.toLowerCase()} suggestion` };
  }
  if (suggestion.status === 'APPROVED') {
    return { suggestion: serializeTaskSuggestion(suggestion) };
  }
  const updated = await prisma.inboxTaskSuggestion.update({
    where: { id: suggestionId },
    data: { status: 'APPROVED' },
  });
  return { suggestion: serializeTaskSuggestion(updated) };
}

async function rejectTaskSuggestion(inboxItemId, suggestionId) {
  const prisma = db.getPrisma();
  const suggestion = await prisma.inboxTaskSuggestion.findFirst({
    where: { id: suggestionId, inboxItemId },
  });
  if (!suggestion) return { notFound: true };
  if (suggestion.status === 'APPLIED') {
    return { conflict: 'Cannot reject an applied suggestion' };
  }
  if (suggestion.status === 'REJECTED') {
    return { suggestion: serializeTaskSuggestion(suggestion) };
  }
  const updated = await prisma.inboxTaskSuggestion.update({
    where: { id: suggestionId },
    data: { status: 'REJECTED' },
  });
  return { suggestion: serializeTaskSuggestion(updated) };
}

/**
 * Apply an approved task suggestion — creates a Task once (idempotent).
 * Never auto-runs without prior approval.
 */
async function applyTaskSuggestion(inboxItemId, suggestionId) {
  const prisma = db.getPrisma();
  const suggestion = await prisma.inboxTaskSuggestion.findFirst({
    where: { id: suggestionId, inboxItemId },
  });
  if (!suggestion) return { notFound: true };

  if (suggestion.status === 'APPLIED' && suggestion.appliedTaskId) {
    const task = await prisma.task.findUnique({ where: { id: suggestion.appliedTaskId } });
    return {
      suggestion: serializeTaskSuggestion(suggestion),
      task: task
        ? {
            id: task.id,
            title: task.title,
            inboxItemId: task.inboxItemId,
            source: task.source,
          }
        : { id: suggestion.appliedTaskId },
      idempotent: true,
    };
  }

  if (suggestion.status !== 'APPROVED') {
    return { conflict: 'Suggestion must be approved before it can be applied' };
  }

  const result = await prisma.$transaction(async (tx) => {
    const task = await tx.task.create({
      data: {
        title: suggestion.title,
        description: suggestion.description,
        priority: suggestion.priority || 'MEDIUM',
        status: 'OPEN',
        dueDate: suggestion.dueDate,
        source: 'AI',
        contactId: suggestion.contactId,
        inboxItemId,
      },
    });
    const updated = await tx.inboxTaskSuggestion.update({
      where: { id: suggestionId },
      data: {
        status: 'APPLIED',
        appliedTaskId: task.id,
      },
    });
    return { task, suggestion: updated };
  });

  return {
    suggestion: serializeTaskSuggestion(result.suggestion),
    task: {
      id: result.task.id,
      title: result.task.title,
      inboxItemId: result.task.inboxItemId,
      source: result.task.source,
    },
    idempotent: false,
  };
}

async function approvePaymentSuggestion(inboxItemId, suggestionId) {
  const prisma = db.getPrisma();
  const suggestion = await prisma.inboxPaymentSuggestion.findFirst({
    where: { id: suggestionId, inboxItemId },
  });
  if (!suggestion) return { notFound: true };
  if (!canTransitionSuggestion(suggestion.status, 'APPROVED')) {
    return { conflict: `Cannot approve a ${suggestion.status.toLowerCase()} suggestion` };
  }
  if (suggestion.status === 'APPROVED') {
    return { suggestion: serializePaymentSuggestion(suggestion) };
  }
  const updated = await prisma.inboxPaymentSuggestion.update({
    where: { id: suggestionId },
    data: { status: 'APPROVED' },
  });
  return { suggestion: serializePaymentSuggestion(updated) };
}

async function rejectPaymentSuggestion(inboxItemId, suggestionId) {
  const prisma = db.getPrisma();
  const suggestion = await prisma.inboxPaymentSuggestion.findFirst({
    where: { id: suggestionId, inboxItemId },
  });
  if (!suggestion) return { notFound: true };
  if (suggestion.status === 'APPLIED') {
    return { conflict: 'Cannot reject an applied suggestion' };
  }
  if (suggestion.status === 'REJECTED') {
    return { suggestion: serializePaymentSuggestion(suggestion) };
  }
  const updated = await prisma.inboxPaymentSuggestion.update({
    where: { id: suggestionId },
    data: { status: 'REJECTED' },
  });
  return { suggestion: serializePaymentSuggestion(updated) };
}

async function applyPaymentSuggestion(inboxItemId, suggestionId) {
  const prisma = db.getPrisma();
  const suggestion = await prisma.inboxPaymentSuggestion.findFirst({
    where: { id: suggestionId, inboxItemId },
  });
  if (!suggestion) return { notFound: true };

  if (suggestion.status === 'APPLIED' && suggestion.appliedPaymentId) {
    const payment = await prisma.payment.findUnique({ where: { id: suggestion.appliedPaymentId } });
    return {
      suggestion: serializePaymentSuggestion(suggestion),
      payment: payment
        ? {
            id: payment.id,
            payeeName: payment.payeeName,
            inboxItemId: payment.inboxItemId,
            source: payment.source,
          }
        : { id: suggestion.appliedPaymentId },
      idempotent: true,
    };
  }

  if (suggestion.status !== 'APPROVED') {
    return { conflict: 'Suggestion must be approved before it can be applied' };
  }

  if (suggestion.amount == null || !suggestion.currency || !suggestion.dueDate || !suggestion.businessUnit) {
    return {
      conflict:
        'Payment suggestion is missing required amount, currency, dueDate, or businessUnit to apply',
    };
  }

  const result = await prisma.$transaction(async (tx) => {
    const payment = await tx.payment.create({
      data: {
        payeeName: suggestion.payeeName,
        businessUnit: suggestion.businessUnit,
        category: suggestion.category,
        description: suggestion.description,
        amount: suggestion.amount,
        currency: suggestion.currency,
        dueDate: suggestion.dueDate,
        invoiceNumber: suggestion.invoiceNumber,
        status: 'DRAFT',
        source: 'AI',
        inboxItemId,
      },
    });
    const updated = await tx.inboxPaymentSuggestion.update({
      where: { id: suggestionId },
      data: {
        status: 'APPLIED',
        appliedPaymentId: payment.id,
      },
    });
    return { payment, suggestion: updated };
  });

  return {
    suggestion: serializePaymentSuggestion(result.suggestion),
    payment: {
      id: result.payment.id,
      payeeName: result.payment.payeeName,
      inboxItemId: result.payment.inboxItemId,
      source: result.payment.source,
    },
    idempotent: false,
  };
}

async function approveReplySuggestion(inboxItemId, suggestionId) {
  const prisma = db.getPrisma();
  const suggestion = await prisma.inboxReplySuggestion.findFirst({
    where: { id: suggestionId, inboxItemId },
  });
  if (!suggestion) return { notFound: true };
  if (!canTransitionSuggestion(suggestion.status, 'APPROVED')) {
    return { conflict: `Cannot approve a ${suggestion.status.toLowerCase()} suggestion` };
  }
  if (suggestion.status === 'APPROVED') {
    return { suggestion: serializeReplySuggestion(suggestion) };
  }
  const updated = await prisma.inboxReplySuggestion.update({
    where: { id: suggestionId },
    data: { status: 'APPROVED' },
  });
  return { suggestion: serializeReplySuggestion(updated) };
}

async function rejectReplySuggestion(inboxItemId, suggestionId) {
  const prisma = db.getPrisma();
  const suggestion = await prisma.inboxReplySuggestion.findFirst({
    where: { id: suggestionId, inboxItemId },
  });
  if (!suggestion) return { notFound: true };
  if (suggestion.status === 'APPLIED') {
    return { conflict: 'Cannot reject an applied suggestion' };
  }
  if (suggestion.status === 'REJECTED') {
    return { suggestion: serializeReplySuggestion(suggestion) };
  }
  const updated = await prisma.inboxReplySuggestion.update({
    where: { id: suggestionId },
    data: { status: 'REJECTED' },
  });
  return { suggestion: serializeReplySuggestion(updated) };
}

/**
 * Mark a reply suggestion as applied (no outbound send yet — approval workflow only).
 * Idempotent.
 */
async function applyReplySuggestion(inboxItemId, suggestionId) {
  const prisma = db.getPrisma();
  const suggestion = await prisma.inboxReplySuggestion.findFirst({
    where: { id: suggestionId, inboxItemId },
  });
  if (!suggestion) return { notFound: true };

  if (suggestion.status === 'APPLIED') {
    return { suggestion: serializeReplySuggestion(suggestion), idempotent: true };
  }
  if (suggestion.status !== 'APPROVED') {
    return { conflict: 'Suggestion must be approved before it can be applied' };
  }

  const updated = await prisma.inboxReplySuggestion.update({
    where: { id: suggestionId },
    data: { status: 'APPLIED' },
  });
  return { suggestion: serializeReplySuggestion(updated), idempotent: false };
}

module.exports = {
  setAnalysisProvider,
  resetAnalysisProvider,
  isUniqueConstraintError,
  isForeignKeyError,
  serializeAccount,
  serializeInboxItem,
  serializeTaskSuggestion,
  serializePaymentSuggestion,
  serializeReplySuggestion,
  buildListWhere,
  buildOrderBy,
  listAccounts,
  getAccountById,
  createAccount,
  updateAccount,
  activateAccount,
  deactivateAccount,
  persistSyncCursor,
  getStubSyncProvider,
  getSyncProviderForSource,
  listInboxItems,
  getInboxItemById,
  createInboxItem,
  updateInboxItem,
  archiveInboxItem,
  analyzeInboxItem,
  approveTaskSuggestion,
  rejectTaskSuggestion,
  applyTaskSuggestion,
  approvePaymentSuggestion,
  rejectPaymentSuggestion,
  applyPaymentSuggestion,
  approveReplySuggestion,
  rejectReplySuggestion,
  applyReplySuggestion,
  canTransitionSuggestion,
};
