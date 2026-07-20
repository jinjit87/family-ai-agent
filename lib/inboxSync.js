/**
 * Sync provider interfaces for multi-account inbox ingestion (Phase 6).
 *
 * Design goals:
 * - Support multiple accounts with independent sync cursors.
 * - Never merge messages across accounts that share the same externalId.
 * - Do not implement Gmail OAuth or polling yet — interfaces + stubs only.
 * - Never expose OAuth tokens, credentials, or raw provider errors to callers.
 */

/**
 * @typedef {object} InboxAccountRecord
 * @property {string} id
 * @property {string} name
 * @property {string} source
 * @property {string | null} emailAddress
 * @property {string | null} externalAccountId
 * @property {boolean} isActive
 * @property {Date | null} lastSyncedAt
 * @property {string | null} syncCursor
 */

/**
 * @typedef {object} ProviderMessageSummary
 * @property {string} externalId
 * @property {string | null} [threadExternalId]
 * @property {string | null} [senderName]
 * @property {string} senderIdentifier
 * @property {string[]} [recipients]
 * @property {string | null} [subject]
 * @property {string} rawContent
 * @property {string|Date} receivedAt
 */

/**
 * @typedef {object} ListNewMessagesResult
 * @property {ProviderMessageSummary[]} messages
 * @property {string | null} nextCursor
 */

/**
 * @typedef {object} InboxSyncProvider
 * @property {(account: InboxAccountRecord, cursor: string | null) => Promise<ListNewMessagesResult>} listNewMessages
 * @property {(account: InboxAccountRecord, externalId: string) => Promise<ProviderMessageSummary | null>} fetchMessage
 * @property {(account: InboxAccountRecord, cursor: string | null) => Promise<InboxAccountRecord>} saveSyncCursor
 */

/**
 * Persist a sync cursor for an account (independent per account).
 * Safe errors only — never throw raw Prisma details to HTTP layers.
 *
 * @param {(accountId: string, cursor: string | null) => Promise<InboxAccountRecord>} persistFn
 * @returns {(account: InboxAccountRecord, cursor: string | null) => Promise<InboxAccountRecord>}
 */
function createSaveSyncCursor(persistFn) {
  return async function saveSyncCursor(account, cursor) {
    return persistFn(account.id, cursor);
  };
}

/**
 * Stub sync provider used until real Gmail/Outlook connectors exist.
 * listNewMessages / fetchMessage return empty results; saveSyncCursor persists via callback.
 *
 * @param {{ saveSyncCursor: (account: InboxAccountRecord, cursor: string | null) => Promise<InboxAccountRecord> }} deps
 * @returns {InboxSyncProvider}
 */
function createStubSyncProvider(deps) {
  return {
    async listNewMessages(_account, _cursor) {
      return { messages: [], nextCursor: null };
    },
    async fetchMessage(_account, _externalId) {
      return null;
    },
    saveSyncCursor: deps.saveSyncCursor,
  };
}

/**
 * Resolve which sync provider to use for an account source.
 * Currently all sources use the stub — real providers will plug in later.
 *
 * @param {string} source
 * @param {InboxSyncProvider} stub
 * @returns {InboxSyncProvider}
 */
function resolveSyncProvider(source, stub) {
  switch (source) {
    case 'GMAIL':
    case 'OUTLOOK':
    case 'WHATSAPP':
    case 'SMS':
    case 'MANUAL':
    case 'API':
      return stub;
    default:
      return stub;
  }
}

module.exports = {
  createSaveSyncCursor,
  createStubSyncProvider,
  resolveSyncProvider,
};
