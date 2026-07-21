/**
 * Shared deterministic extractors for inbox / email analysis (no AI).
 */

/**
 * Extract a simple amount + currency hint from text.
 * @param {string} text
 * @returns {{ amount: string | null, currency: string | null, snippet: string | null }}
 */
function detectAmount(text) {
  const match =
    text.match(
      /(?:ILS|USD|EUR|GBP|₪|\$|€|£)\s*(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/i
    ) ||
    text.match(/(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)\s*(?:ILS|USD|EUR|GBP)/i);
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

module.exports = {
  detectAmount,
  detectDueDate,
};
