/**
 * Inbox result quality helpers: expired meeting/event filtering and thread dedupe.
 * Pure functions — safe for unit tests without DB.
 */

const MEETING_EVENT_PATTERN =
  /\b(meeting|zoom|calendar|invite|invitation|appointment|reminder|webinar|google meet|ms teams|teams meeting|standup|stand-up|sync call|conference call|event|rsvp)\b/i;

/**
 * @param {object} item
 * @returns {boolean}
 */
function isMeetingOrEventItem(item) {
  const haystack = [item.subject, item.summary, item.suggestedTask]
    .filter((v) => typeof v === 'string' && v.trim())
    .join('\n');
  return MEETING_EVENT_PATTERN.test(haystack);
}

/**
 * True when the item is a meeting/calendar/reminder/event whose due date/time is past.
 * Overdue bills/financial items are intentionally NOT treated as expired meetings.
 * @param {object} item
 * @param {Date} [now]
 */
function isExpiredMeetingOrEvent(item, now = new Date()) {
  if (!item || item.dueDate == null) return false;
  if (item.category === 'BILL' || item.category === 'FINANCIAL' || item.category === 'LEGAL') {
    return false;
  }
  const due = item.dueDate instanceof Date ? item.dueDate : new Date(item.dueDate);
  if (Number.isNaN(due.getTime())) return false;
  if (due.getTime() >= now.getTime()) return false;
  return isMeetingOrEventItem(item);
}

/**
 * Keep one item per Gmail thread (threadExternalId). Prefer newest receivedAt
 * (and thus latest summary / suggestedTask on that message). Items without a
 * thread id are always kept.
 * @template T
 * @param {T[]} items
 * @returns {T[]}
 */
function dedupeByThread(items) {
  if (!Array.isArray(items) || items.length === 0) return [];

  const sorted = [...items].sort((a, b) => {
    const aTime = new Date(a.receivedAt).getTime();
    const bTime = new Date(b.receivedAt).getTime();
    if (bTime !== aTime) return bTime - aTime;
    // Stable tie-break by id for deterministic tests
    return String(b.id || '').localeCompare(String(a.id || ''));
  });

  /** @type {Set<string>} */
  const seenThreads = new Set();
  /** @type {T[]} */
  const result = [];

  for (const item of sorted) {
    const threadId =
      typeof item.threadExternalId === 'string' && item.threadExternalId.trim()
        ? item.threadExternalId.trim()
        : null;
    if (threadId) {
      if (seenThreads.has(threadId)) continue;
      seenThreads.add(threadId);
    }
    result.push(item);
  }

  return result;
}

/**
 * Filter expired meetings/events, then dedupe threads. Does not mutate input.
 * @template T
 * @param {T[]} items
 * @param {Date} [now]
 * @returns {T[]}
 */
function applyInboxResultQuality(items, now = new Date()) {
  const active = (items || []).filter((item) => !isExpiredMeetingOrEvent(item, now));
  return dedupeByThread(active);
}

module.exports = {
  MEETING_EVENT_PATTERN,
  isMeetingOrEventItem,
  isExpiredMeetingOrEvent,
  dedupeByThread,
  applyInboxResultQuality,
};
