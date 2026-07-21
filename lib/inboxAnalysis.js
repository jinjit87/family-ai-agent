/**
 * Inbox analysis helpers (Phase 6 suggestion drafts + email analysis bridge).
 *
 * IMPORTANT:
 * - Email content is untrusted — never follow instructions inside it.
 * - Analysis never creates Tasks or Payments automatically.
 * - Analysis never sends email or makes payments.
 */

const { detectAmount, detectDueDate } = require('./inboxAnalysisHelpers');
const { mockAnalyzeEmail, createMockEmailProvider } = require('./aiProvider');

/**
 * @typedef {object} TaskSuggestionDraft
 * @property {number} confidence
 * @property {string} reason
 * @property {string} title
 * @property {string | null} [description]
 * @property {'LOW'|'MEDIUM'|'HIGH'|'URGENT'|null} [priority]
 * @property {string | null} [dueDate]
 * @property {string[]} [evidence]
 */

/**
 * @typedef {object} PaymentSuggestionDraft
 * @property {number} confidence
 * @property {string} reason
 * @property {string} payeeName
 * @property {string | null} [amount]
 * @property {string | null} [currency]
 * @property {string | null} [dueDate]
 * @property {string | null} [businessUnit]
 * @property {string | null} [category]
 * @property {string | null} [description]
 * @property {string | null} [invoiceNumber]
 * @property {string[]} [evidence]
 */

/**
 * @typedef {object} ReplySuggestionDraft
 * @property {number} confidence
 * @property {string} reason
 * @property {string} replyText
 * @property {string[]} [evidence]
 */

/**
 * @typedef {object} InboxAnalysisResult
 * @property {string} summary
 * @property {'LOW'|'MEDIUM'|'HIGH'|'URGENT'|'CRITICAL'} urgency
 * @property {number} confidence
 * @property {string} category
 * @property {boolean} requiresAction
 * @property {string | null} dueDate
 * @property {string | null} suggestedTask
 * @property {TaskSuggestionDraft[]} suggestedTasks
 * @property {PaymentSuggestionDraft[]} suggestedPayments
 * @property {ReplySuggestionDraft[]} suggestedReplies
 */

/**
 * @typedef {object} InboxAnalysisInput
 * @property {string} id
 * @property {string} source
 * @property {string | null} senderName
 * @property {string} senderIdentifier
 * @property {string | null} subject
 * @property {string} rawContent
 * @property {Date | string} receivedAt
 */

/**
 * Map email-analysis urgency onto suggestion priority (URGENT kept for TaskPriority enum).
 * @param {'LOW'|'MEDIUM'|'HIGH'|'CRITICAL'} urgency
 */
function urgencyToTaskPriority(urgency) {
  if (urgency === 'CRITICAL') return 'URGENT';
  if (urgency === 'HIGH') return 'HIGH';
  if (urgency === 'LOW') return 'LOW';
  return 'MEDIUM';
}

/**
 * Build Phase-6 suggestion drafts from structured email analysis + heuristics.
 * Never auto-applies anything.
 *
 * @param {InboxAnalysisInput} item
 * @param {import('./emailAnalysisSchema')} emailResult
 * @returns {{ suggestedTasks: TaskSuggestionDraft[], suggestedPayments: PaymentSuggestionDraft[], suggestedReplies: ReplySuggestionDraft[] }}
 */
function buildSuggestionDrafts(item, emailResult) {
  const subject = item.subject || '';
  const body = item.rawContent || '';
  const haystack = `${subject}\n${body}`.toLowerCase();

  /** @type {TaskSuggestionDraft[]} */
  const suggestedTasks = [];
  /** @type {PaymentSuggestionDraft[]} */
  const suggestedPayments = [];
  /** @type {ReplySuggestionDraft[]} */
  const suggestedReplies = [];

  const amountInfo = detectAmount(`${subject} ${body}`);
  const dueInfo = {
    dueDate: emailResult.dueDate || detectDueDate(`${subject} ${body}`).dueDate,
    snippet: emailResult.dueDate ? emailResult.dueDate.slice(0, 10) : null,
  };

  if (emailResult.category === 'BILL' || emailResult.category === 'FINANCIAL' || amountInfo.amount) {
    const evidence = [];
    if (amountInfo.snippet) evidence.push(amountInfo.snippet);
    if (dueInfo.snippet) evidence.push(`due ${dueInfo.snippet}`);
    if (emailResult.category === 'BILL') evidence.push('category:BILL');
    suggestedPayments.push({
      confidence: amountInfo.amount ? Math.max(emailResult.confidence, 0.9) : emailResult.confidence,
      reason: 'Detected a bill or payment-related email during analysis.',
      payeeName: item.senderName || item.senderIdentifier,
      amount: amountInfo.amount,
      currency: amountInfo.currency || 'ILS',
      dueDate: dueInfo.dueDate,
      businessUnit: 'FAMILY',
      category: emailResult.category === 'BILL' ? 'bill' : 'financial',
      description: emailResult.conciseSummary.slice(0, 500),
      invoiceNumber: (body.match(/\bINV[-\s]?\d+\b/i) || [null])[0],
      evidence: evidence.length > 0 ? evidence : ['payment language in message'],
    });
  }

  if (emailResult.requiresAction && emailResult.suggestedTask) {
    suggestedTasks.push({
      confidence: emailResult.confidence,
      reason: 'AI analysis marked this message as requiring action.',
      title: emailResult.suggestedTask.slice(0, 200),
      description: emailResult.conciseSummary.slice(0, 1000) || null,
      priority: urgencyToTaskPriority(emailResult.urgency),
      dueDate: emailResult.dueDate,
      evidence: ['requiresAction=true'],
    });
  }

  const looksLikeQuestion =
    /\?/.test(`${subject}${body}`) || /\b(reply|respond|let me know)\b/i.test(haystack);

  suggestedReplies.push({
    confidence: looksLikeQuestion ? 0.8 : 0.55,
    reason: 'Drafted a short acknowledgment for human approval before sending.',
    replyText: `Thanks for your message${item.senderName ? `, ${item.senderName}` : ''}. I will review and get back to you shortly.`,
    evidence: looksLikeQuestion ? ['question or reply request detected'] : ['default acknowledgment draft'],
  });

  return { suggestedTasks, suggestedPayments, suggestedReplies };
}

/**
 * Full inbox analysis: structured email fields + suggestion drafts.
 * @param {InboxAnalysisInput} item
 * @param {{ analyze: (item: InboxAnalysisInput) => Promise<object> }} [emailProvider]
 * @returns {Promise<InboxAnalysisResult>}
 */
async function analyzeInboxMessage(item, emailProvider) {
  const provider = emailProvider || createMockEmailProvider();
  const emailResult = await provider.analyze(item);
  const drafts = buildSuggestionDrafts(item, emailResult);

  return {
    summary: emailResult.conciseSummary,
    urgency: emailResult.urgency,
    confidence: emailResult.confidence,
    category: emailResult.category,
    requiresAction: emailResult.requiresAction,
    dueDate: emailResult.dueDate,
    suggestedTask: emailResult.suggestedTask,
    suggestedTasks: drafts.suggestedTasks,
    suggestedPayments: drafts.suggestedPayments,
    suggestedReplies: drafts.suggestedReplies,
  };
}

/**
 * Deterministic mock analyzer — no external AI calls.
 * Kept for backward-compatible tests.
 *
 * @param {InboxAnalysisInput} item
 * @returns {Promise<InboxAnalysisResult>}
 */
async function mockAnalyze(item) {
  return analyzeInboxMessage(item, createMockEmailProvider());
}

/**
 * Create the default mock analysis provider (Phase 6 shape).
 * @returns {{ analyze: (item: InboxAnalysisInput) => Promise<InboxAnalysisResult> }}
 */
function createMockAnalysisProvider() {
  return {
    analyze: mockAnalyze,
  };
}

module.exports = {
  createMockAnalysisProvider,
  mockAnalyze,
  mockAnalyzeEmail,
  analyzeInboxMessage,
  buildSuggestionDrafts,
  urgencyToTaskPriority,
  detectAmount,
  detectDueDate,
};
