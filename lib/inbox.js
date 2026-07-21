const { Prisma } = require('@prisma/client');
const db = require('./db');
const { SORT_FIELDS } = require('./inboxSchemas');
const { analyzeInboxMessage } = require('./inboxAnalysis');
const { createEmailAnalysisProvider, sanitizeProviderError } = require('./aiProvider');
const {
  isExpiredMeetingOrEvent,
  applyInboxResultQuality,
} = require('./inboxQuality');
const {
  createSaveSyncCursor,
  createStubSyncProvider,
  resolveSyncProvider,
} = require('./inboxSync');

/** @type {import('./inboxAnalysis').InboxAnalysisProvider | null} */
let analysisProvider = null;

/** @type {{ analyze: Function, name?: string } | null} */
let emailAnalysisProvider = null;

/**
 * Resolve (and cache) the structured email analysis provider.
 * Defaults to mock unless AI_EMAIL_ANALYSIS_ENABLED=true.
 */
function getEmailAnalysisProvider() {
  if (!emailAnalysisProvider) {
    emailAnalysisProvider = createEmailAnalysisProvider(process.env);
  }
  return emailAnalysisProvider;
}

/**
 * Resolve Phase-6 analysis provider (structured email + suggestion drafts).
 */
function getAnalysisProvider() {
  if (analysisProvider) return analysisProvider;
  const emailProvider = getEmailAnalysisProvider();
  return {
    analyze: (item) => analyzeInboxMessage(item, emailProvider),
  };
}

/**
 * Override the analysis provider (tests / future Anthropic wiring).
 * @param {import('./inboxAnalysis').InboxAnalysisProvider} provider
 */
function setAnalysisProvider(provider) {
  analysisProvider = provider;
}

/**
 * Override only the structured email analysis provider (tests).
 * @param {{ analyze: Function, name?: string }} provider
 */
function setEmailAnalysisProvider(provider) {
  emailAnalysisProvider = provider;
  analysisProvider = null;
}

/**
 * Reset to the default mock provider.
 */
function resetAnalysisProvider() {
  analysisProvider = null;
  emailAnalysisProvider = createEmailAnalysisProvider({ AI_EMAIL_ANALYSIS_ENABLED: 'false' });
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
    syncStatus: account.syncStatus ?? null,
    lastSyncError: account.lastSyncError ?? null,
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
    category: item.category ?? null,
    requiresAction: item.requiresAction ?? null,
    dueDate: isoOrNull(item.dueDate),
    suggestedTask: item.suggestedTask ?? null,
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
        category: true,
        requiresAction: true,
        dueDate: true,
        suggestedTask: true,
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
  // Inactive accounts reject all new ingestion (manual POST and future provider sync).
  // Deactivate is non-destructive — existing items remain readable.
  if (!account.isActive) {
    return { inactiveAccount: true };
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
 * Atomically claim an inbox item for analysis.
 * Prevents concurrent duplicate processing via status transition.
 *
 * @param {string} id
 * @param {{ allowReanalyze?: boolean }} [options]
 * @returns {Promise<{ claimed: object } | { notFound: true } | { skipped: string } | { busy: true }>}
 */
async function claimInboxItemForAnalysis(id, options = {}) {
  const prisma = db.getPrisma();
  const allowReanalyze = options.allowReanalyze === true;

  const existing = await prisma.inboxItem.findUnique({ where: { id } });
  if (!existing) return { notFound: true };

  if (existing.status === 'PROCESSING') {
    return { busy: true };
  }
  if (existing.status === 'ARCHIVED') {
    return { skipped: 'ARCHIVED' };
  }

  // Unprocessed path: only NEW or FAILED.
  // Explicit reanalyze: also allow READY_FOR_REVIEW / APPROVED / REJECTED.
  const allowed = allowReanalyze
    ? ['NEW', 'FAILED', 'READY_FOR_REVIEW', 'APPROVED', 'REJECTED']
    : ['NEW', 'FAILED'];

  if (!allowed.includes(existing.status)) {
    return { skipped: existing.status };
  }

  const claimed = await prisma.inboxItem.updateMany({
    where: {
      id,
      status: { in: allowed },
    },
    data: { status: 'PROCESSING' },
  });

  if (claimed.count === 0) {
    // Lost the race — another worker claimed it.
    return { busy: true };
  }

  const row = await prisma.inboxItem.findUnique({ where: { id } });
  return { claimed: row };
}

/**
 * Persist a fully validated analysis result. Never saves partial analysis.
 * Past meeting/calendar/reminder events are archived (not actionable).
 * @param {string} id
 * @param {import('./inboxAnalysis').InboxAnalysisResult} analysis
 * @param {{ subject?: string | null }} [itemContext]
 */
async function persistAnalysisResult(id, analysis, itemContext = {}) {
  const prisma = db.getPrisma();
  const expiredMeeting = isExpiredMeetingOrEvent({
    subject: itemContext.subject || analysis.summary,
    summary: analysis.summary,
    suggestedTask: analysis.suggestedTask,
    category: analysis.category,
    dueDate: analysis.dueDate,
  });

  await prisma.$transaction(async (tx) => {
    await tx.inboxTaskSuggestion.deleteMany({
      where: { inboxItemId: id, status: { not: 'APPLIED' } },
    });
    await tx.inboxPaymentSuggestion.deleteMany({
      where: { inboxItemId: id, status: { not: 'APPLIED' } },
    });
    await tx.inboxReplySuggestion.deleteMany({
      where: { inboxItemId: id, status: { not: 'APPLIED' } },
    });

    if (!expiredMeeting && analysis.suggestedTasks.length > 0) {
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

    if (!expiredMeeting && analysis.suggestedPayments.length > 0) {
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

    if (!expiredMeeting && analysis.suggestedReplies.length > 0) {
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
        category: analysis.category,
        requiresAction: expiredMeeting ? false : analysis.requiresAction,
        dueDate: analysis.dueDate ? new Date(analysis.dueDate) : null,
        suggestedTask: expiredMeeting ? null : analysis.suggestedTask,
        status: expiredMeeting ? 'ARCHIVED' : 'READY_FOR_REVIEW',
        processedAt: new Date(),
      },
    });
  });
}

/**
 * Mark analysis failed for retry — does not save partial analysis fields.
 * @param {string} id
 * @param {unknown} [err]
 * @param {number} [latencyMs]
 */
async function markAnalysisFailed(id, err, latencyMs) {
  const prisma = db.getPrisma();
  await prisma.inboxItem.update({
    where: { id },
    data: { status: 'FAILED' },
  });
  console.error(
    JSON.stringify({
      event: 'inbox_analysis_failed',
      messageId: id,
      latencyMs: latencyMs ?? null,
      error: sanitizeProviderError(err),
    })
  );
}

/**
 * Run AI analysis and persist structured fields + suggestion rows.
 * Never creates Tasks or Payments. Never sends email.
 *
 * Uses an atomic status claim so concurrent requests cannot analyze the same
 * message twice. Validation failures mark the item FAILED for retry and do
 * not save partial analysis.
 *
 * @param {string} id
 * @param {{ allowReanalyze?: boolean }} [options]
 */
async function analyzeInboxItem(id, options = {}) {
  const prisma = db.getPrisma();
  const started = Date.now();
  const claim = await claimInboxItemForAnalysis(id, options);

  if (claim.notFound) return { notFound: true };
  if (claim.busy) return { busy: true };
  if (claim.skipped) return { skipped: claim.skipped };

  const existing = claim.claimed;

  try {
    const provider = getAnalysisProvider();
    const analysis = await provider.analyze({
      id: existing.id,
      source: existing.source,
      senderName: existing.senderName,
      senderIdentifier: existing.senderIdentifier,
      subject: existing.subject,
      rawContent: existing.rawContent,
      receivedAt: existing.receivedAt,
    });

    // Require structured email fields (provider must validate before return).
    if (
      !analysis ||
      !analysis.category ||
      analysis.requiresAction === undefined ||
      !analysis.summary ||
      typeof analysis.confidence !== 'number'
    ) {
      throw new Error('Analysis provider returned incomplete result');
    }

    await persistAnalysisResult(id, analysis, { subject: existing.subject });

    const latencyMs = Date.now() - started;
    const item = await prisma.inboxItem.findUnique({
      where: { id },
      include: suggestionInclude,
    });

    console.info(
      JSON.stringify({
        event: 'inbox_analysis_ok',
        messageId: id,
        category: analysis.category,
        urgency: analysis.urgency,
        status: item?.status || 'READY_FOR_REVIEW',
        latencyMs,
      })
    );

    return {
      item: serializeInboxItem(item, { includeRawContent: true, includeSuggestions: true }),
      analysis: {
        category: analysis.category,
        urgency: analysis.urgency,
        requiresAction: item?.requiresAction ?? analysis.requiresAction,
        dueDate: analysis.dueDate,
        conciseSummary: analysis.summary,
        suggestedTask: item?.suggestedTask ?? analysis.suggestedTask,
        confidence: analysis.confidence,
        summary: analysis.summary,
        suggestedTasks: analysis.suggestedTasks,
        suggestedPayments: analysis.suggestedPayments,
        suggestedReplies: analysis.suggestedReplies,
        processedAt: item.processedAt ? item.processedAt.toISOString() : null,
      },
    };
  } catch (err) {
    await markAnalysisFailed(id, err, Date.now() - started);
    return { failed: true };
  }
}

/**
 * Batch / selective analysis endpoint support.
 *
 * @param {{
 *   messageIds?: string[],
 *   unprocessedOnly?: boolean,
 *   limit?: number,
 *   inboxAccountId?: string,
 * }} input
 */
async function analyzeInboxBatch(input = {}) {
  const prisma = db.getPrisma();
  const limit = Math.min(Math.max(Number(input.limit) || 20, 1), 100);
  const messageIds = Array.isArray(input.messageIds)
    ? [...new Set(input.messageIds.filter((id) => typeof id === 'string' && id.trim()))]
    : [];
  const unprocessedOnly = input.unprocessedOnly !== false || messageIds.length === 0;
  // Explicit messageIds → allow reanalyze of already-processed items.
  // unprocessedOnly / default batch → only NEW + FAILED.
  const allowReanalyze = messageIds.length > 0 && input.unprocessedOnly === false;

  /** @type {string[]} */
  let ids = messageIds;

  if (ids.length === 0) {
    const where = {
      status: { in: ['NEW', 'FAILED'] },
      ...(input.inboxAccountId ? { inboxAccountId: input.inboxAccountId } : {}),
    };
    const rows = await prisma.inboxItem.findMany({
      where,
      orderBy: { receivedAt: 'asc' },
      take: limit,
      select: { id: true },
    });
    ids = rows.map((r) => r.id);
  } else if (unprocessedOnly && !allowReanalyze) {
    // Filter explicit ids down to unprocessed when requested.
    const rows = await prisma.inboxItem.findMany({
      where: {
        id: { in: ids },
        status: { in: ['NEW', 'FAILED'] },
      },
      select: { id: true },
    });
    const allowed = new Set(rows.map((r) => r.id));
    ids = ids.filter((id) => allowed.has(id));
  }

  ids = ids.slice(0, limit);

  const results = {
    processed: [],
    failed: [],
    skipped: [],
    busy: [],
    notFound: [],
  };

  for (const id of ids) {
    const result = await analyzeInboxItem(id, { allowReanalyze });
    if (result.notFound) {
      results.notFound.push(id);
    } else if (result.busy) {
      results.busy.push(id);
    } else if (result.skipped) {
      results.skipped.push({ id, status: result.skipped });
    } else if (result.failed) {
      results.failed.push(id);
    } else {
      results.processed.push({
        id,
        category: result.analysis?.category,
        urgency: result.analysis?.urgency,
        status: result.item?.status,
      });
    }
  }

  return {
    requested: ids.length,
    limit,
    ...results,
  };
}

const INBOX_ITEM_LIST_SELECT = {
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
  category: true,
  requiresAction: true,
  dueDate: true,
  suggestedTask: true,
  receivedAt: true,
  processedAt: true,
  createdAt: true,
  updatedAt: true,
};

/**
 * @param {object} query
 * @param {Record<string, unknown>} extraWhere
 */
async function listInboxItemsWithWhere(query, extraWhere) {
  const prisma = db.getPrisma();
  const where = { ...buildListWhere(query), ...extraWhere };
  const sort = SORT_FIELDS.includes(query.sort) ? query.sort : 'receivedAt';
  const skip = (query.page - 1) * query.limit;

  const [total, rows] = await Promise.all([
    prisma.inboxItem.count({ where }),
    prisma.inboxItem.findMany({
      where,
      orderBy: buildOrderBy(sort),
      skip,
      take: query.limit,
      select: INBOX_ITEM_LIST_SELECT,
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

/**
 * Archive past meeting/calendar/reminder/event emails so they drop out of
 * important/tasks views. Does not delete items or touch Gmail sync state.
 * @param {Date} [now]
 * @returns {Promise<{ archivedCount: number }>}
 */
async function archiveExpiredMeetingEvents(now = new Date()) {
  const prisma = db.getPrisma();
  const candidates = await prisma.inboxItem.findMany({
    where: {
      status: { not: 'ARCHIVED' },
      dueDate: { lt: now },
      category: { notIn: ['BILL', 'FINANCIAL', 'LEGAL'] },
    },
    select: {
      id: true,
      subject: true,
      summary: true,
      suggestedTask: true,
      category: true,
      dueDate: true,
    },
    take: 500,
  });

  const ids = candidates.filter((row) => isExpiredMeetingOrEvent(row, now)).map((row) => row.id);
  if (ids.length === 0) {
    return { archivedCount: 0 };
  }

  const updated = await prisma.inboxItem.updateMany({
    where: { id: { in: ids }, status: { not: 'ARCHIVED' } },
    data: {
      status: 'ARCHIVED',
      requiresAction: false,
      suggestedTask: null,
    },
  });

  if (updated.count > 0) {
    console.info(
      JSON.stringify({
        event: 'inbox_expired_meetings_archived',
        archivedCount: updated.count,
      })
    );
  }

  return { archivedCount: updated.count };
}

/**
 * List view with expired-meeting archival, thread dedupe, then pagination.
 * Response shape matches existing list endpoints (API contract unchanged).
 * @param {object} query
 * @param {Record<string, unknown>} extraWhere
 * @param {{ now?: Date }} [options]
 */
async function listQualityInboxItems(query, extraWhere, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  await archiveExpiredMeetingEvents(now);

  const prisma = db.getPrisma();
  const where = {
    ...buildListWhere(query),
    ...extraWhere,
    status: { notIn: ['ARCHIVED'] },
  };
  const sort = SORT_FIELDS.includes(query.sort) ? query.sort : 'receivedAt';
  const candidateLimit = Math.min(500, Math.max(query.limit * 15, 100));

  const rows = await prisma.inboxItem.findMany({
    where,
    orderBy: buildOrderBy(sort),
    take: candidateLimit,
    select: INBOX_ITEM_LIST_SELECT,
  });

  // Defense in depth: filter any expired meetings not yet archived, then
  // keep one item per Gmail thread (newest receivedAt / latest summary+task).
  const qualityRows = applyInboxResultQuality(rows, now);
  const total = qualityRows.length;
  const skip = (query.page - 1) * query.limit;
  const pageRows = qualityRows.slice(skip, skip + query.limit);
  const totalPages = total === 0 ? 0 : Math.ceil(total / query.limit);

  return {
    data: pageRows.map((row) => serializeInboxItem(row, { includeRawContent: false })),
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages,
    },
  };
}

async function listImportantInboxItems(query) {
  return listQualityInboxItems(query, {
    urgency: { in: ['HIGH', 'URGENT', 'CRITICAL'] },
  });
}

async function listActionInboxItems(query) {
  return listQualityInboxItems(query, {
    requiresAction: true,
  });
}

async function listBillInboxItems(query) {
  // Bills: thread-dedupe only (past due bills remain visible / overdue).
  return listQualityInboxItems(query, {
    category: 'BILL',
  });
}

/**
 * Daily briefing aggregates (no email bodies).
 * @param {{ now?: Date }} [options]
 */
async function getDailyBriefing(options = {}) {
  const prisma = db.getPrisma();
  const now = options.now instanceof Date ? options.now : new Date();
  const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  await archiveExpiredMeetingEvents(now);
  const active = { status: { notIn: ['ARCHIVED'] } };

  const [highPriorityRaw, actionItemsRaw, billsRaw, packages, securityAlerts, overdue] =
    await Promise.all([
      prisma.inboxItem.findMany({
        where: {
          ...active,
          urgency: { in: ['HIGH', 'URGENT', 'CRITICAL'] },
        },
        orderBy: [{ urgency: 'desc' }, { receivedAt: 'desc' }],
        take: 100,
        select: INBOX_ITEM_LIST_SELECT,
      }),
      prisma.inboxItem.findMany({
        where: { ...active, requiresAction: true },
        orderBy: { receivedAt: 'desc' },
        take: 100,
        select: INBOX_ITEM_LIST_SELECT,
      }),
      prisma.inboxItem.findMany({
        where: { ...active, category: 'BILL' },
        orderBy: [{ dueDate: 'asc' }, { receivedAt: 'desc' }],
        take: 100,
        select: INBOX_ITEM_LIST_SELECT,
      }),
      prisma.inboxItem.findMany({
        where: { ...active, category: 'PACKAGE' },
        orderBy: { receivedAt: 'desc' },
        take: 50,
        select: INBOX_ITEM_LIST_SELECT,
      }),
      prisma.inboxItem.findMany({
        where: { ...active, category: 'SECURITY' },
        orderBy: { receivedAt: 'desc' },
        take: 50,
        select: INBOX_ITEM_LIST_SELECT,
      }),
      prisma.inboxItem.findMany({
        where: {
          ...active,
          dueDate: { lt: startOfDay },
          OR: [{ requiresAction: true }, { category: { in: ['BILL', 'LEGAL', 'FINANCIAL'] } }],
        },
        orderBy: { dueDate: 'asc' },
        take: 50,
        select: INBOX_ITEM_LIST_SELECT,
      }),
    ]);

  const highPriority = applyInboxResultQuality(highPriorityRaw, now).slice(0, 50);
  const actionItems = applyInboxResultQuality(actionItemsRaw, now).slice(0, 50);
  // Bills keep overdue visibility; only thread-dedupe.
  const bills = applyInboxResultQuality(billsRaw, now).slice(0, 50);
  // Overdue section should not include expired meetings (archive already ran).
  const overdueFiltered = overdue.filter((row) => !isExpiredMeetingOrEvent(row, now));

  const serialize = (rows) => rows.map((row) => serializeInboxItem(row, { includeRawContent: false }));

  return {
    date: startOfDay.toISOString().slice(0, 10),
    generatedAt: now.toISOString(),
    counts: {
      highPriority: highPriority.length,
      actionItems: actionItems.length,
      bills: bills.length,
      packages: packages.length,
      securityAlerts: securityAlerts.length,
      overdue: overdueFiltered.length,
    },
    highPriority: serialize(highPriority),
    actionItems: serialize(actionItems),
    bills: serialize(bills),
    packages: serialize(packages),
    securityAlerts: serialize(securityAlerts),
    overdue: serialize(overdueFiltered),
  };
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
 * Uses SELECT FOR UPDATE so concurrent applies create at most one Task.
 * Never auto-runs without prior approval.
 */
async function applyTaskSuggestion(inboxItemId, suggestionId) {
  const prisma = db.getPrisma();

  try {
    return await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw`
        SELECT id, status, title, description, priority, "dueDate", "contactId", "appliedTaskId",
               confidence, reason, evidence, "inboxItemId", "createdAt", "updatedAt"
        FROM "InboxTaskSuggestion"
        WHERE id = ${suggestionId} AND "inboxItemId" = ${inboxItemId}
        FOR UPDATE
      `;
      if (!locked.length) {
        return { notFound: true };
      }
      const suggestion = locked[0];

      if (suggestion.status === 'APPLIED' && suggestion.appliedTaskId) {
        const task = await tx.task.findUnique({ where: { id: suggestion.appliedTaskId } });
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

      return {
        suggestion: serializeTaskSuggestion(updated),
        task: {
          id: task.id,
          title: task.title,
          inboxItemId: task.inboxItemId,
          source: task.source,
        },
        idempotent: false,
      };
    });
  } catch (_err) {
    // Safe conflict if a concurrent writer won a uniqueness race — never leak Prisma.
    return { conflict: 'Failed to apply task suggestion' };
  }
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

  try {
    return await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw`
        SELECT id, status, "payeeName", amount, currency, "dueDate", "businessUnit", category,
               description, "invoiceNumber", "appliedPaymentId", confidence, reason, evidence,
               "inboxItemId", "createdAt", "updatedAt"
        FROM "InboxPaymentSuggestion"
        WHERE id = ${suggestionId} AND "inboxItemId" = ${inboxItemId}
        FOR UPDATE
      `;
      if (!locked.length) {
        return { notFound: true };
      }
      const suggestion = locked[0];

      if (suggestion.status === 'APPLIED' && suggestion.appliedPaymentId) {
        const payment = await tx.payment.findUnique({ where: { id: suggestion.appliedPaymentId } });
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

      if (
        suggestion.amount == null ||
        !suggestion.currency ||
        !suggestion.dueDate ||
        !suggestion.businessUnit
      ) {
        return {
          conflict:
            'Payment suggestion is missing required amount, currency, dueDate, or businessUnit to apply',
        };
      }

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

      return {
        suggestion: serializePaymentSuggestion(updated),
        payment: {
          id: payment.id,
          payeeName: payment.payeeName,
          inboxItemId: payment.inboxItemId,
          source: payment.source,
        },
        idempotent: false,
      };
    });
  } catch (_err) {
    return { conflict: 'Failed to apply payment suggestion' };
  }
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
 * Uses SELECT FOR UPDATE so concurrent applies remain idempotent.
 */
async function applyReplySuggestion(inboxItemId, suggestionId) {
  const prisma = db.getPrisma();

  try {
    return await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw`
        SELECT id, status, "replyText", confidence, reason, evidence,
               "inboxItemId", "createdAt", "updatedAt"
        FROM "InboxReplySuggestion"
        WHERE id = ${suggestionId} AND "inboxItemId" = ${inboxItemId}
        FOR UPDATE
      `;
      if (!locked.length) {
        return { notFound: true };
      }
      const suggestion = locked[0];

      if (suggestion.status === 'APPLIED') {
        return { suggestion: serializeReplySuggestion(suggestion), idempotent: true };
      }
      if (suggestion.status !== 'APPROVED') {
        return { conflict: 'Suggestion must be approved before it can be applied' };
      }

      const updated = await tx.inboxReplySuggestion.update({
        where: { id: suggestionId },
        data: { status: 'APPLIED' },
      });
      return { suggestion: serializeReplySuggestion(updated), idempotent: false };
    });
  } catch (_err) {
    return { conflict: 'Failed to apply reply suggestion' };
  }
}

/**
 * Staging helper: clear AI analysis fields on InboxItems so they can be re-analyzed.
 * Does not delete InboxItems, Gmail credentials, sync cursors, or APPLIED suggestion links.
 *
 * Clears: processedAt, category, urgency, confidence, requiresAction, dueDate,
 * suggestedTask, summary. Non-archived analyzed items return to status NEW.
 *
 * @returns {Promise<{ resetCount: number }>}
 */
async function resetInboxAnalysis() {
  const prisma = db.getPrisma();

  const analyzedWhere = {
    OR: [
      { processedAt: { not: null } },
      { category: { not: null } },
      { urgency: { not: null } },
      { confidence: { not: null } },
      { requiresAction: { not: null } },
      { dueDate: { not: null } },
      { suggestedTask: { not: null } },
      { summary: { not: null } },
      { status: { in: ['PROCESSING', 'READY_FOR_REVIEW', 'FAILED', 'APPROVED', 'REJECTED'] } },
    ],
  };

  const clearData = {
    processedAt: null,
    category: null,
    urgency: null,
    confidence: null,
    requiresAction: null,
    dueDate: null,
    suggestedTask: null,
    summary: null,
  };

  // Two updates so ARCHIVED keeps its status while still clearing analysis fields.
  const [nonArchived, archived] = await prisma.$transaction([
    prisma.inboxItem.updateMany({
      where: { ...analyzedWhere, status: { not: 'ARCHIVED' } },
      data: { ...clearData, status: 'NEW' },
    }),
    prisma.inboxItem.updateMany({
      where: { ...analyzedWhere, status: 'ARCHIVED' },
      data: clearData,
    }),
  ]);

  return { resetCount: nonArchived.count + archived.count };
}

module.exports = {
  setAnalysisProvider,
  setEmailAnalysisProvider,
  resetAnalysisProvider,
  getAnalysisProvider,
  getEmailAnalysisProvider,
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
  claimInboxItemForAnalysis,
  analyzeInboxItem,
  analyzeInboxBatch,
  listImportantInboxItems,
  listActionInboxItems,
  listBillInboxItems,
  getDailyBriefing,
  archiveExpiredMeetingEvents,
  resetInboxAnalysis,
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
