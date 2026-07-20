/**
 * AI analysis provider interface for Inbox items (Phase 6).
 *
 * IMPORTANT:
 * - Do not call Anthropic (or any external LLM) from this module yet.
 * - Implementations must return user-facing reasons only — never chain-of-thought.
 * - Analysis never creates Tasks or Payments automatically.
 */

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
 * @property {'LOW'|'MEDIUM'|'HIGH'|'URGENT'} urgency
 * @property {number} confidence
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
 * @typedef {object} InboxAnalysisProvider
 * @property {(item: InboxAnalysisInput) => Promise<InboxAnalysisResult>} analyze
 */

/**
 * Extract a simple amount + currency hint from text (deterministic).
 * @param {string} text
 * @returns {{ amount: string | null, currency: string | null, snippet: string | null }}
 */
function detectAmount(text) {
  const match = text.match(/(?:ILS|USD|EUR|GBP|₪|\$|€|£)\s*(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/i)
    || text.match(/(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)\s*(?:ILS|USD|EUR|GBP)/i);
  if (!match) {
    return { amount: null, currency: null, snippet: null };
  }
  const snippet = match[0];
  const amountRaw = (match[1] || '').replace(/,/g, '');
  let currency = null;
  if (/ILS|₪/i.test(snippet)) currency = 'ILS';
  else if (/USD|\$/i.test(snippet)) currency = 'USD';
  else if (/EUR|€/i.test(snippet)) currency = 'EUR';
  else if (/GBP|£/i.test(snippet)) currency = 'GBP';
  return { amount: amountRaw || null, currency, snippet };
}

/**
 * Detect an ISO-like or common due date mention.
 * @param {string} text
 * @returns {{ dueDate: string | null, snippet: string | null }}
 */
function detectDueDate(text) {
  const iso = text.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (iso) {
    return { dueDate: `${iso[1]}T00:00:00.000Z`, snippet: iso[0] };
  }
  return { dueDate: null, snippet: null };
}

/**
 * Deterministic mock analyzer — no external AI calls.
 * Uses simple keyword heuristics so tests are stable.
 *
 * @param {InboxAnalysisInput} item
 * @returns {Promise<InboxAnalysisResult>}
 */
async function mockAnalyze(item) {
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
  const dueInfo = detectDueDate(`${subject} ${body}`);

  const looksLikeInvoice =
    /\b(invoice|payment|pay|due|bill|amount owed|remittance)\b/i.test(haystack) ||
    Boolean(amountInfo.amount);

  const looksLikeAction =
    /\b(please|need you to|can you|schedule|pick up|remind|deadline|submit|sign)\b/i.test(haystack);

  const looksLikeQuestion = /\?/.test(`${subject}${body}`) || /\b(reply|respond|let me know)\b/i.test(haystack);

  let urgency = 'MEDIUM';
  if (/\b(urgent|asap|immediately|overdue)\b/i.test(haystack)) {
    urgency = 'URGENT';
  } else if (/\b(today|tomorrow|important)\b/i.test(haystack)) {
    urgency = 'HIGH';
  } else if (/\b(fyi|no rush|whenever)\b/i.test(haystack)) {
    urgency = 'LOW';
  }

  if (looksLikeInvoice) {
    const evidence = [];
    if (amountInfo.snippet) evidence.push(amountInfo.snippet);
    if (dueInfo.snippet) evidence.push(`due ${dueInfo.snippet}`);
    if (/\binvoice\b/i.test(haystack)) evidence.push('invoice');
    suggestedPayments.push({
      confidence: amountInfo.amount ? 0.92 : 0.78,
      reason: 'Detected an invoice amount, due date, and payment request.',
      payeeName: item.senderName || item.senderIdentifier,
      amount: amountInfo.amount,
      currency: amountInfo.currency || 'ILS',
      dueDate: dueInfo.dueDate,
      businessUnit: 'FAMILY',
      category: 'invoice',
      description: subject || 'Payment request from inbox',
      invoiceNumber: (body.match(/\bINV[-\s]?\d+\b/i) || [null])[0],
      evidence: evidence.length > 0 ? evidence : ['payment language in message'],
    });
  }

  if (looksLikeAction) {
    suggestedTasks.push({
      confidence: 0.84,
      reason: 'Detected an actionable request that may need a follow-up task.',
      title: subject ? subject.slice(0, 200) : `Follow up with ${item.senderIdentifier}`,
      description: body.slice(0, 1000) || null,
      priority: urgency === 'URGENT' || urgency === 'HIGH' ? urgency : 'MEDIUM',
      dueDate: dueInfo.dueDate,
      evidence: ['actionable language in message'],
    });
  }

  if (looksLikeQuestion || suggestedReplies.length === 0) {
    // Always offer a conservative reply draft for human review.
    suggestedReplies.push({
      confidence: looksLikeQuestion ? 0.8 : 0.55,
      reason: 'Drafted a short acknowledgment for human approval before sending.',
      replyText: `Thanks for your message${item.senderName ? `, ${item.senderName}` : ''}. I will review and get back to you shortly.`,
      evidence: looksLikeQuestion ? ['question or reply request detected'] : ['default acknowledgment draft'],
    });
  }

  const summaryParts = [];
  if (subject) summaryParts.push(subject);
  else summaryParts.push(`Message from ${item.senderIdentifier}`);
  if (looksLikeInvoice) summaryParts.push('Appears to include a payment or invoice request.');
  if (looksLikeAction) summaryParts.push('Contains an actionable follow-up.');

  return {
    summary: summaryParts.join(' ').slice(0, 1000),
    urgency,
    confidence: looksLikeInvoice || looksLikeAction ? 0.88 : 0.65,
    suggestedTasks,
    suggestedPayments,
    suggestedReplies,
  };
}

/**
 * Create the default mock analysis provider.
 * @returns {InboxAnalysisProvider}
 */
function createMockAnalysisProvider() {
  return {
    analyze: mockAnalyze,
  };
}

module.exports = {
  createMockAnalysisProvider,
  mockAnalyze,
  detectAmount,
  detectDueDate,
};
