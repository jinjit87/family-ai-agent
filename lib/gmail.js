/**
 * Gmail connector: OAuth, encrypted credentials, sync, account management.
 *
 * Security rules:
 * - Never log tokens, codes, client secrets, decrypted credentials, email bodies,
 *   subjects, senders, recipients, Gmail IDs, Authorization headers, or DATABASE_URL.
 * - Never return credentials through APIs.
 * - Safe user-facing errors only.
 * - Gmail uses GOOGLE_GMAIL_REDIRECT_URI only (never Calendar redirect).
 */

const crypto = require('crypto');
const db = require('./db');
const { isGmailFullyConfigured } = require('./env');
const { encryptToken, decryptToken } = require('./tokenEncryption');
const {
  GMAIL_OAUTH_SCOPES,
  createGmailOAuth2Client,
  getGmailApiAdapter,
} = require('./gmailClient');

const INITIAL_SYNC_LIMIT = 50;
/** OAuth state TTL - documented short window. */
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
/** Back-compat default lease constant. Runtime value is configurable. */
const SYNC_LOCK_LEASE_MS = 5 * 60 * 1000;
/** Lease renewal cadence during sync. */
const SYNC_LOCK_RENEW_EVERY_MS = 60 * 1000;
/** Max stored body characters after sanitization (documented safe maximum). */
const MAX_BODY_CHARS = 100_000;
const GMAIL_OAUTH_FLOW = 'gmail';

const defaults = Object.freeze({
  GMAIL_INITIAL_SYNC_MAX_MESSAGES: INITIAL_SYNC_LIMIT,
  GMAIL_HISTORY_MAX_PAGES: 25,
  GMAIL_SYNC_TIMEOUT_MS: 240_000,
  GMAIL_API_MAX_RETRIES: 3,
  GMAIL_SYNC_LEASE_MS: SYNC_LOCK_LEASE_MS,
});

/** Sync status values stored on InboxAccount.syncStatus */
const SYNC_STATUS = {
  IDLE: 'IDLE',
  OK: 'OK',
  ERROR: 'ERROR',
  RECONNECT_REQUIRED: 'RECONNECT_REQUIRED',
  SYNCING: 'SYNCING',
};

let gmailTestHooks = {};

/**
 * @param {{ beforeCredentialWrite?: Function }} hooks
 */
function setGmailTestHooks(hooks = {}) {
  gmailTestHooks = { ...hooks };
}

function resetGmailTestHooks() {
  gmailTestHooks = {};
}

/**
 * @param {Record<string, unknown>} env
 */
function isGmailConfigured(env) {
  return isGmailFullyConfigured(env);
}

/**
 * @param {Date | null | undefined} value
 */
function isoOrNull(value) {
  return value ? value.toISOString() : null;
}

/**
 * Public Gmail account view - never includes credentials or encrypted fields.
 * @param {object | null} account
 */
function serializeGmailAccount(account) {
  if (!account) return null;
  return {
    id: account.id,
    emailAddress: account.emailAddress,
    isActive: account.isActive,
    lastSyncedAt: isoOrNull(account.lastSyncedAt),
    syncStatus: account.syncStatus || SYNC_STATUS.IDLE,
    lastSyncError: account.lastSyncError || null,
    externalAccountId: account.externalAccountId,
    name: account.name,
    source: account.source,
    createdAt: account.createdAt.toISOString(),
    updatedAt: account.updatedAt.toISOString(),
  };
}

/**
 * @param {unknown} value
 * @param {number} fallback
 */
function parsePositiveInteger(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

/**
 * Read optional Gmail sync tuning configuration.
 * @param {Record<string, unknown>} [env]
 */
function getGmailSyncConfig(env = process.env) {
  return {
    GMAIL_INITIAL_SYNC_MAX_MESSAGES: parsePositiveInteger(
      env.GMAIL_INITIAL_SYNC_MAX_MESSAGES,
      defaults.GMAIL_INITIAL_SYNC_MAX_MESSAGES
    ),
    GMAIL_HISTORY_MAX_PAGES: parsePositiveInteger(
      env.GMAIL_HISTORY_MAX_PAGES,
      defaults.GMAIL_HISTORY_MAX_PAGES
    ),
    GMAIL_SYNC_TIMEOUT_MS: parsePositiveInteger(
      env.GMAIL_SYNC_TIMEOUT_MS,
      defaults.GMAIL_SYNC_TIMEOUT_MS
    ),
    GMAIL_API_MAX_RETRIES: parsePositiveInteger(
      env.GMAIL_API_MAX_RETRIES,
      defaults.GMAIL_API_MAX_RETRIES
    ),
    GMAIL_SYNC_LEASE_MS: parsePositiveInteger(
      env.GMAIL_SYNC_LEASE_MS,
      defaults.GMAIL_SYNC_LEASE_MS
    ),
  };
}

/**
 * Create a signed, short-lived, DB-backed one-time OAuth state bound to Gmail flow.
 * Uses ADMIN_API_KEY as HMAC secret so Bearer never appears in the browser URL.
 *
 * @param {string} hmacSecret
 * @returns {Promise<string>}
 */
async function createOAuthState(hmacSecret) {
  const nonce = crypto.randomBytes(32).toString('base64url');
  const exp = Date.now() + OAUTH_STATE_TTL_MS;
  const payload = `${GMAIL_OAUTH_FLOW}.${nonce}.${exp}`;
  const sig = crypto.createHmac('sha256', hmacSecret).update(payload).digest('base64url');
  const state = `${GMAIL_OAUTH_FLOW}.${nonce}.${exp}.${sig}`;

  const prisma = db.getPrisma();
  await prisma.gmailOAuthState.create({
    data: {
      nonce,
      flow: GMAIL_OAUTH_FLOW,
      expiresAt: new Date(exp),
    },
  });

  return state;
}

/**
 * Parse and verify OAuth state without consuming it.
 * Bound to flow=gmail - cannot be reused for Calendar.
 *
 * @param {string} state
 * @param {string} hmacSecret
 * @returns {Promise<{ nonce: string, flow: string, expiresAt: Date } | null>}
 */
async function parseAndVerifyOAuthState(state, hmacSecret) {
  if (!state || typeof state !== 'string') return null;
  const parts = state.split('.');
  if (parts.length !== 4) return null;
  const [flow, nonce, expStr, sig] = parts;
  if (flow !== GMAIL_OAUTH_FLOW) return null;
  const exp = Number(expStr);
  if (!nonce || !Number.isFinite(exp) || !sig) return null;
  if (Date.now() > exp) {
    try {
      const prisma = db.getPrisma();
      await prisma.gmailOAuthState.deleteMany({ where: { nonce } });
    } catch (_e) {
      // ignore cleanup failures
    }
    return null;
  }

  const payload = `${flow}.${nonce}.${exp}`;
  const expected = crypto.createHmac('sha256', hmacSecret).update(payload).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expected);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }

  const prisma = db.getPrisma();
  const row = await prisma.gmailOAuthState.findUnique({ where: { nonce } });
  if (!row || row.flow !== GMAIL_OAUTH_FLOW || row.consumedAt || row.expiresAt <= new Date()) {
    return null;
  }

  return { nonce, flow, expiresAt: row.expiresAt };
}

/**
 * Verify OAuth state (CSRF) and consume it atomically. Kept for tests/back-compat.
 *
 * @param {string} state
 * @param {string} hmacSecret
 * @returns {Promise<boolean>}
 */
async function verifyOAuthState(state, hmacSecret) {
  const parsed = await parseAndVerifyOAuthState(state, hmacSecret);
  if (!parsed) return false;

  const prisma = db.getPrisma();
  const updated = await prisma.gmailOAuthState.updateMany({
    where: {
      nonce: parsed.nonce,
      flow: GMAIL_OAUTH_FLOW,
      consumedAt: null,
      expiresAt: { gt: new Date() },
    },
    data: { consumedAt: new Date() },
  });

  return updated.count === 1;
}

/** Test helper - clear pending Gmail OAuth states. */
async function clearOAuthStates() {
  try {
    const prisma = db.getPrisma();
    await prisma.gmailOAuthState.deleteMany({});
  } catch (_e) {
    // ignore when DB unavailable in pure unit contexts
  }
}

/** Test helper - peek whether a nonce is pending (unconsumed). */
async function hasPendingOAuthState(state) {
  if (!state || typeof state !== 'string') return false;
  const parts = state.split('.');
  if (parts.length !== 4) return false;
  const nonce = parts[1];
  try {
    const prisma = db.getPrisma();
    const row = await prisma.gmailOAuthState.findUnique({ where: { nonce } });
    return Boolean(row && !row.consumedAt && row.expiresAt > new Date());
  } catch (_e) {
    return false;
  }
}

/**
 * @param {{ GOOGLE_CLIENT_ID: string, GOOGLE_CLIENT_SECRET: string, GOOGLE_GMAIL_REDIRECT_URI: string }} env
 */
function buildOAuthClient(env) {
  if (!env.GOOGLE_GMAIL_REDIRECT_URI) {
    throw new Error('Gmail redirect URI not configured');
  }
  return createGmailOAuth2Client({
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUri: env.GOOGLE_GMAIL_REDIRECT_URI,
  });
}

/**
 * Extract redirect_uri from a Google auth URL (for tests).
 * @param {string} url
 */
function extractRedirectUriFromAuthUrl(url) {
  try {
    return new URL(url).searchParams.get('redirect_uri');
  } catch (_e) {
    return null;
  }
}

/**
 * Extract scopes from a Google auth URL (for tests).
 * @param {string} url
 * @returns {string[]}
 */
function extractScopesFromAuthUrl(url) {
  try {
    const raw = new URL(url).searchParams.get('scope') || '';
    return raw.split(/\s+/).filter(Boolean).sort();
  } catch (_e) {
    return [];
  }
}

/**
 * Start Gmail OAuth - returns Google authorization URL (no Bearer in URL).
 * @param {Record<string, string | undefined>} env
 */
async function buildConnectUrl(env) {
  if (!isGmailConfigured(env)) {
    return { notConfigured: true };
  }
  const state = await createOAuthState(/** @type {string} */ (env.ADMIN_API_KEY));
  const oauth2Client = buildOAuthClient(
    /** @type {{ GOOGLE_CLIENT_ID: string, GOOGLE_CLIENT_SECRET: string, GOOGLE_GMAIL_REDIRECT_URI: string }} */ (
      env
    )
  );
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: GMAIL_OAUTH_SCOPES,
    state,
    // Do not include previously granted scopes (avoids Calendar/modify bleed).
    include_granted_scopes: false,
  });
  return { url, state };
}

/**
 * Decode a Gmail message header map.
 * @param {Array<{ name?: string | null, value?: string | null }> | undefined} headers
 * @param {string} name
 */
function getHeader(headers, name) {
  if (!headers) return null;
  const found = headers.find((h) => (h.name || '').toLowerCase() === name.toLowerCase());
  return found?.value || null;
}

/**
 * Parse "Name <email@x.com>" or bare email into { name, email }.
 * @param {string | null} raw
 */
function parseAddress(raw) {
  if (!raw || typeof raw !== 'string') {
    return { name: null, email: 'unknown' };
  }
  const angle = raw.match(/^(.*?)\s*<([^>]+)>\s*$/);
  if (angle) {
    const name = angle[1].replace(/^["']|["']$/g, '').trim() || null;
    return { name, email: angle[2].trim().toLowerCase() };
  }
  const emailOnly = raw.trim();
  if (emailOnly.includes('@')) {
    return { name: null, email: emailOnly.toLowerCase() };
  }
  return { name: emailOnly || null, email: 'unknown' };
}

/**
 * Parse a comma-separated recipient header into email strings.
 * @param {string | null} raw
 * @returns {string[]}
 */
function parseRecipientList(raw) {
  if (!raw) return [];
  return raw
    .split(',')
    .map((part) => parseAddress(part.trim()).email)
    .filter((e) => e && e !== 'unknown');
}

/**
 * Recursively collect MIME parts.
 * @param {object | null | undefined} payload
 * @param {object[]} out
 */
function collectParts(payload, out) {
  if (!payload) return;
  out.push(payload);
  for (const child of payload.parts || []) {
    collectParts(child, out);
  }
}

/**
 * Decode base64url body data.
 * @param {string | null | undefined} data
 */
function decodeBodyData(data) {
  if (!data) return '';
  try {
    return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  } catch (_e) {
    return '';
  }
}

/**
 * Cap stored body size - truncate abnormally large messages safely.
 * @param {string} text
 */
function capBodySize(text) {
  if (!text) return text;
  if (text.length <= MAX_BODY_CHARS) return text;
  return `${text.slice(0, MAX_BODY_CHARS)}\n\n[truncated]`;
}

/**
 * Convert HTML to readable plain text, stripping scripts, styles, tracking,
 * remote images, and unsafe markup before storage.
 * @param {string} html
 */
function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, ' ')
    .replace(/<object[\s\S]*?<\/object>/gi, ' ')
    .replace(/<embed[\s\S]*?>/gi, ' ')
    .replace(/<link[^>]*>/gi, ' ')
    .replace(/<meta[^>]*>/gi, ' ')
    // Strip images (including tracking pixels) and remote URL references.
    .replace(/<img[^>]*>/gi, ' ')
    .replace(/\bhttps?:\/\/[^\s"'<>]+/gi, ' ')
    .replace(/\bsrc\s*=\s*["'][^"']*["']/gi, ' ')
    .replace(/\bhref\s*=\s*["']\s*javascript:[^"']*["']/gi, ' ')
    .replace(/on\w+\s*=\s*["'][^"']*["']/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * Prefer text/plain; fall back to sanitized HTML->text. No attachments.
 * @param {object} message - Gmail users.messages resource
 * @returns {{ text: string, labels: string[] }}
 */
function extractMessageBody(message) {
  const labels = message.labelIds || [];
  const parts = [];
  collectParts(message.payload, parts);

  let plain = '';
  let html = '';

  for (const part of parts) {
    const mime = (part.mimeType || '').toLowerCase();
    // Skip attachment parts (filename present) - never download attachments.
    if (part.filename) continue;
    // Skip non-text MIME (images, etc.)
    if (mime && !mime.startsWith('text/') && mime !== 'multipart/alternative' && mime !== 'multipart/related') {
      if (part.body?.attachmentId || part.body?.data) {
        if (!mime.startsWith('text/')) continue;
      }
    }
    const data = part.body?.data;
    if (!data) continue;
    if (mime === 'text/plain' && !plain) {
      plain = decodeBodyData(data);
    } else if (mime === 'text/html' && !html) {
      html = decodeBodyData(data);
    }
  }

  if (!plain && !html && message.payload?.body?.data) {
    const topMime = (message.payload.mimeType || '').toLowerCase();
    const decoded = decodeBodyData(message.payload.body.data);
    if (topMime === 'text/html') html = decoded;
    else plain = decoded;
  }

  let text = plain.trim() ? plain.trim() : html ? htmlToText(html) : '';
  text = capBodySize(text || '(no text body)');
  return { text, labels };
}

/**
 * True if message is in Spam or Trash (must not ingest).
 * @param {string[]} labels
 */
function isSpamOrTrash(labels) {
  return labels.includes('SPAM') || labels.includes('TRASH');
}

/**
 * Map a Gmail message resource to an ingest payload (no account id yet).
 * @param {object} message
 */
function mapGmailMessageToIngest(message) {
  const headers = message.payload?.headers || [];
  const from = parseAddress(getHeader(headers, 'From'));
  const to = parseRecipientList(getHeader(headers, 'To'));
  const cc = parseRecipientList(getHeader(headers, 'Cc'));
  const subject = getHeader(headers, 'Subject');
  const { text, labels } = extractMessageBody(message);
  const internalDate = message.internalDate ? new Date(Number(message.internalDate)) : new Date();

  return {
    externalId: message.id,
    threadExternalId: message.threadId || null,
    senderName: from.name,
    senderIdentifier: from.email,
    recipients: [...new Set([...to, ...cc])],
    subject: subject || null,
    rawContent: text,
    receivedAt: internalDate.toISOString(),
    source: 'GMAIL',
    status: 'NEW',
    labels,
    sourceMetadata: {
      gmailMessageId: message.id,
      gmailThreadId: message.threadId || null,
      labelIds: labels,
      snippet: message.snippet ? String(message.snippet).slice(0, 200) : null,
    },
  };
}

/**
 * @param {unknown} err
 */
function getHttpStatus(err) {
  if (!err || typeof err !== 'object') return null;
  const anyErr = /** @type {Record<string, unknown>} */ (err);
  const response = anyErr.response && typeof anyErr.response === 'object'
    ? /** @type {Record<string, unknown>} */ (anyErr.response)
    : null;
  const status = response?.status || anyErr.status || anyErr.statusCode;
  if (typeof status === 'number') return status;
  if (typeof status === 'string' && /^\d+$/.test(status)) return Number(status);
  if (typeof anyErr.code === 'number') return anyErr.code;
  if (typeof anyErr.code === 'string' && /^\d+$/.test(anyErr.code)) return Number(anyErr.code);
  return null;
}

/**
 * @param {unknown} value
 */
function safeCodeString(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return null;
  if (/^[A-Za-z0-9_.-]{1,64}$/.test(value)) return value;
  return null;
}

/**
 * @param {unknown} err
 */
function getSafeErrorCode(err) {
  if (!err || typeof err !== 'object') return null;
  const anyErr = /** @type {Record<string, unknown>} */ (err);
  const responseData =
    anyErr.response && typeof anyErr.response === 'object'
      ? /** @type {Record<string, unknown>} */ (anyErr.response).data
      : null;
  const providerCode =
    responseData && typeof responseData === 'object'
      ? safeCodeString(/** @type {Record<string, unknown>} */ (responseData).error)
      : null;
  return providerCode || safeCodeString(anyErr.code) || null;
}

/**
 * @param {unknown} err
 */
function isInvalidGrantError(err) {
  if (!err || typeof err !== 'object') return false;
  const anyErr = /** @type {Record<string, unknown>} */ (err);
  const message = String(anyErr.message || '');
  const errorCode = getSafeErrorCode(err);
  return (
    errorCode === 'invalid_grant' ||
    message.includes('invalid_grant') ||
    message.includes('Token has been expired or revoked')
  );
}

/**
 * @param {unknown} err
 */
function isRetryableGoogleError(err) {
  if (isInvalidGrantError(err)) return false;
  const status = getHttpStatus(err);
  if (status === 401 || status === 403) return false;
  if ([429, 500, 502, 503, 504].includes(Number(status))) return true;
  if (!err || typeof err !== 'object') return false;
  const anyErr = /** @type {Record<string, unknown>} */ (err);
  const code = safeCodeString(anyErr.code);
  return ['ECONNRESET', 'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(
    code || ''
  );
}

/**
 * @param {number} ms
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry transient Google/network failures with bounded exponential backoff + jitter.
 * @template T
 * @param {() => Promise<T>} fn
 * @param {{ env?: Record<string, unknown>, maxRetries?: number, sleep?: (ms: number) => Promise<void>, baseDelayMs?: number }} [opts]
 * @returns {Promise<T>}
 */
async function withGoogleRetries(fn, opts = {}) {
  const config = getGmailSyncConfig(opts.env || process.env);
  const maxRetries = opts.maxRetries ?? config.GMAIL_API_MAX_RETRIES;
  const wait = opts.sleep || sleep;
  const baseDelayMs = opts.baseDelayMs ?? 25;

  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= maxRetries || !isRetryableGoogleError(err)) {
        throw err;
      }
      const exponential = Math.min(1000, baseDelayMs * 2 ** attempt);
      const jitter = Math.floor(Math.random() * Math.max(1, exponential));
      attempt += 1;
      await wait(exponential + jitter);
    }
  }
}

/**
 * Structured, safe Gmail operational logging.
 * @param {object} fields
 */
function logGmailEvent(fields = {}) {
  const event = {
    gmail: true,
    accountId: fields.accountId || null,
    operation: fields.operation || 'gmail_operation',
    errorCode: fields.errorCode || null,
    httpStatus: fields.httpStatus || null,
    durationMs: typeof fields.durationMs === 'number' ? fields.durationMs : null,
    retryCount: typeof fields.retryCount === 'number' ? fields.retryCount : 0,
    capped: Boolean(fields.capped),
    capReason: fields.capReason || null,
  };
  console.error(JSON.stringify(event));
}

/**
 * Persist refreshed tokens. Only replaces refresh token when Google issues a new one.
 * @param {string} accountId
 * @param {object} tokens
 * @param {string} encryptionKey
 */
async function persistRefreshedTokens(accountId, tokens, encryptionKey) {
  const prisma = db.getPrisma();
  /** @type {Record<string, unknown>} */
  const data = {};
  if (tokens.access_token) {
    data.encryptedAccessToken = encryptToken(tokens.access_token, encryptionKey);
  }
  if (tokens.refresh_token) {
    data.encryptedRefreshToken = encryptToken(tokens.refresh_token, encryptionKey);
  }
  if (tokens.expiry_date) {
    data.tokenExpiry = new Date(tokens.expiry_date);
  } else if (tokens.expires_in) {
    data.tokenExpiry = new Date(Date.now() + Number(tokens.expires_in) * 1000);
  }
  if (Object.keys(data).length === 0) return;
  await prisma.gmailCredential.update({
    where: { inboxAccountId: accountId },
    data,
  });
}

/**
 * Load and decrypt credentials for an account; refresh access token if needed.
 * Uses GOOGLE_GMAIL_REDIRECT_URI for the OAuth client.
 * @param {string} accountId
 * @param {Record<string, string>} env
 */
async function getAuthorizedClient(accountId, env) {
  const prisma = db.getPrisma();
  const credential = await prisma.gmailCredential.findUnique({ where: { inboxAccountId: accountId } });
  if (!credential) {
    return { missingCredentials: true };
  }

  const oauth2Client = buildOAuthClient(
    /** @type {{ GOOGLE_CLIENT_ID: string, GOOGLE_CLIENT_SECRET: string, GOOGLE_GMAIL_REDIRECT_URI: string }} */ (
      env
    )
  );
  const refreshToken = decryptToken(credential.encryptedRefreshToken, env.TOKEN_ENCRYPTION_KEY);
  /** @type {{ refresh_token: string, access_token?: string, expiry_date?: number }} */
  const creds = { refresh_token: refreshToken };

  if (credential.encryptedAccessToken) {
    try {
      creds.access_token = decryptToken(credential.encryptedAccessToken, env.TOKEN_ENCRYPTION_KEY);
    } catch (_e) {
      // Ignore corrupt access token; refresh will replace it.
    }
  }
  if (credential.tokenExpiry) {
    creds.expiry_date = credential.tokenExpiry.getTime();
  }
  oauth2Client.setCredentials(creds);

  const needsRefresh =
    !creds.access_token ||
    !credential.tokenExpiry ||
    credential.tokenExpiry.getTime() <= Date.now() + 60_000;

  if (needsRefresh) {
    try {
      const adapter = getGmailApiAdapter();
      const refreshed = await withGoogleRetries(() => adapter.refreshAccessToken(oauth2Client), { env });
      oauth2Client.setCredentials({
        ...oauth2Client.credentials,
        ...refreshed,
        // Preserve existing refresh token when Google omits a new one.
        refresh_token: refreshed.refresh_token || refreshToken,
      });
      await persistRefreshedTokens(accountId, oauth2Client.credentials, env.TOKEN_ENCRYPTION_KEY);
    } catch (err) {
      if (isInvalidGrantError(err)) {
        await markReconnectRequired(accountId);
        return { reconnectRequired: true };
      }
      return { authError: true };
    }
  }

  return { oauth2Client, credential };
}

/**
 * @param {string} accountId
 */
async function markReconnectRequired(accountId) {
  const prisma = db.getPrisma();
  await prisma.inboxAccount.update({
    where: { id: accountId },
    data: {
      syncStatus: SYNC_STATUS.RECONNECT_REQUIRED,
      lastSyncError: 'Gmail authorization revoked. Reconnect the account.',
      syncLockExpiresAt: null,
      syncLockToken: null,
    },
  });
}

/**
 * Acquire a sync lease lock. Returns the ownership token, or null if unavailable.
 * @param {string} accountId
 * @param {Record<string, unknown>} [envOrConfig]
 */
async function acquireSyncLock(accountId, envOrConfig = process.env) {
  const prisma = db.getPrisma();
  const config = 'GMAIL_SYNC_LEASE_MS' in envOrConfig
    ? getGmailSyncConfig(envOrConfig)
    : { ...defaults, ...envOrConfig };
  const token = crypto.randomUUID();
  const now = new Date();
  const expires = new Date(Date.now() + config.GMAIL_SYNC_LEASE_MS);
  const result = await prisma.inboxAccount.updateMany({
    where: {
      id: accountId,
      OR: [{ syncLockExpiresAt: null }, { syncLockExpiresAt: { lt: now } }],
    },
    data: {
      syncLockExpiresAt: expires,
      syncLockToken: token,
      syncStatus: SYNC_STATUS.SYNCING,
    },
  });
  return result.count === 1 ? token : null;
}

/**
 * Renew a sync lease only when the caller still owns an unexpired token.
 * @param {string} accountId
 * @param {string} token
 * @param {Record<string, unknown>} [envOrConfig]
 */
async function renewSyncLock(accountId, token, envOrConfig = process.env) {
  if (!token) return false;
  const prisma = db.getPrisma();
  const config = 'GMAIL_SYNC_LEASE_MS' in envOrConfig
    ? getGmailSyncConfig(envOrConfig)
    : { ...defaults, ...envOrConfig };
  const now = new Date();
  const result = await prisma.inboxAccount.updateMany({
    where: {
      id: accountId,
      syncLockToken: token,
      isActive: true,
      syncLockExpiresAt: { gt: now },
    },
    data: {
      syncLockExpiresAt: new Date(Date.now() + config.GMAIL_SYNC_LEASE_MS),
    },
  });
  return result.count === 1;
}

/**
 * @param {string} accountId
 * @param {Record<string, unknown>} data
 * @param {string | null} token
 */
async function releaseSyncLock(accountId, data = {}, token = null) {
  const prisma = db.getPrisma();
  const updateData = {
    syncLockExpiresAt: null,
    syncLockToken: null,
    ...data,
  };
  if (token) {
    const result = await prisma.inboxAccount.updateMany({
      where: { id: accountId, syncLockToken: token },
      data: updateData,
    });
    return result.count === 1;
  }
  await prisma.inboxAccount.update({
    where: { id: accountId },
    data: updateData,
  });
  return true;
}

/**
 * @param {unknown} err
 */
function isUniqueConstraintError(err) {
  return Boolean(err && typeof err === 'object' && err.code === 'P2002');
}

/**
 * Handle OAuth callback: verify state, exchange code, upsert account + credentials.
 * Never echoes raw Google query parameters.
 * @param {{ code?: unknown, state?: unknown, error?: unknown }} query
 * @param {Record<string, string | undefined>} env
 */
async function handleOAuthCallback(query, env) {
  if (!isGmailConfigured(env)) {
    return { error: 'not_configured', status: 503 };
  }

  // Ignore/suppress provider error query params - never reflect them.
  if (query.error) {
    return { error: 'authorization_denied', status: 400 };
  }

  const code = query.code;
  const state = query.state;
  if (!code || typeof code !== 'string') {
    return { error: 'invalid_request', status: 400 };
  }
  if (!state || typeof state !== 'string') {
    return { error: 'invalid_state', status: 400 };
  }

  const parsedState = await parseAndVerifyOAuthState(state, /** @type {string} */ (env.ADMIN_API_KEY));
  if (!parsedState) {
    return { error: 'invalid_state', status: 400 };
  }

  const oauth2Client = buildOAuthClient(
    /** @type {{ GOOGLE_CLIENT_ID: string, GOOGLE_CLIENT_SECRET: string, GOOGLE_GMAIL_REDIRECT_URI: string }} */ (
      env
    )
  );
  const adapter = getGmailApiAdapter();

  let tokens;
  try {
    tokens = await withGoogleRetries(() => adapter.exchangeCode(oauth2Client, code), { env });
  } catch (_e) {
    return { error: 'exchange_failed', status: 400 };
  }

  oauth2Client.setCredentials(tokens);

  let profile;
  try {
    profile = await withGoogleRetries(() => adapter.getProfile(oauth2Client), { env });
  } catch (_e) {
    return { error: 'profile_failed', status: 400 };
  }

  if (!profile?.email || !profile?.id) {
    return { error: 'profile_incomplete', status: 400 };
  }

  const encryptionKey = /** @type {string} */ (env.TOKEN_ENCRYPTION_KEY);
  const prisma = db.getPrisma();
  const tokenExpiry = tokens.expiry_date
    ? new Date(tokens.expiry_date)
    : tokens.expires_in
      ? new Date(Date.now() + Number(tokens.expires_in) * 1000)
      : null;
  const scopes = Array.isArray(tokens.scope)
    ? tokens.scope.join(' ')
    : typeof tokens.scope === 'string'
      ? tokens.scope
      : GMAIL_OAUTH_SCOPES.join(' ');
  const encryptedAccessToken = tokens.access_token ? encryptToken(tokens.access_token, encryptionKey) : null;

  let account;
  try {
    account = await prisma.$transaction(async (tx) => {
      const consumed = await tx.gmailOAuthState.updateMany({
        where: {
          nonce: parsedState.nonce,
          flow: GMAIL_OAUTH_FLOW,
          consumedAt: null,
          expiresAt: { gt: new Date() },
        },
        data: { consumedAt: new Date() },
      });
      if (consumed.count !== 1) {
        const err = new Error('OAuth state already consumed');
        err.code = 'INVALID_STATE';
        throw err;
      }

      const existing = await tx.inboxAccount.findUnique({
        where: {
          source_externalAccountId: {
            source: 'GMAIL',
            externalAccountId: profile.id,
          },
        },
        include: { gmailCredential: true },
      });

      let encryptedRefreshToken = null;
      if (tokens.refresh_token) {
        encryptedRefreshToken = encryptToken(tokens.refresh_token, encryptionKey);
      } else if (existing?.gmailCredential?.encryptedRefreshToken) {
        encryptedRefreshToken = existing.gmailCredential.encryptedRefreshToken;
      } else {
        const err = new Error('Missing refresh token');
        err.code = 'MISSING_REFRESH_TOKEN';
        throw err;
      }

      const row = await tx.inboxAccount.upsert({
        where: {
          source_externalAccountId: {
            source: 'GMAIL',
            externalAccountId: profile.id,
          },
        },
        create: {
          name: profile.name || profile.email,
          source: 'GMAIL',
          emailAddress: profile.email,
          externalAccountId: profile.id,
          isActive: true,
          syncStatus: SYNC_STATUS.IDLE,
          lastSyncError: null,
          syncLockExpiresAt: null,
          syncLockToken: null,
        },
        update: {
          emailAddress: profile.email,
          name: profile.name || profile.email,
          isActive: true,
          syncStatus: SYNC_STATUS.IDLE,
          lastSyncError: null,
          syncLockExpiresAt: null,
          syncLockToken: null,
        },
      });

      if (gmailTestHooks.beforeCredentialWrite) {
        await gmailTestHooks.beforeCredentialWrite({ tx, account: row, profile });
      }

      await tx.gmailCredential.upsert({
        where: { inboxAccountId: row.id },
        create: {
          inboxAccountId: row.id,
          encryptedAccessToken,
          encryptedRefreshToken,
          tokenExpiry,
          scopes,
        },
        update: {
          encryptedAccessToken,
          encryptedRefreshToken,
          tokenExpiry,
          scopes,
        },
      });

      return row;
    });
  } catch (err) {
    if (err && typeof err === 'object' && err.code === 'INVALID_STATE') {
      return { error: 'invalid_state', status: 400 };
    }
    if (err && typeof err === 'object' && err.code === 'MISSING_REFRESH_TOKEN') {
      return { error: 'missing_refresh_token', status: 400 };
    }
    if (isUniqueConstraintError(err)) {
      return { error: 'persist_conflict', status: 409 };
    }
    return { error: 'persist_failed', status: 500 };
  }

  return { account: serializeGmailAccount(account), status: 200 };
}

/**
 * List connected Gmail accounts (safe fields only).
 */
async function listGmailAccounts() {
  const prisma = db.getPrisma();
  const rows = await prisma.inboxAccount.findMany({
    where: { source: 'GMAIL' },
    orderBy: { updatedAt: 'desc' },
  });
  return { data: rows.map(serializeGmailAccount) };
}

/**
 * Disconnect: delete credentials, deactivate account, keep InboxItems.
 * @param {string} accountId
 */
async function disconnectGmailAccount(accountId) {
  const prisma = db.getPrisma();
  const account = await prisma.inboxAccount.findFirst({
    where: { id: accountId, source: 'GMAIL' },
  });
  if (!account) {
    return { notFound: true };
  }

  await prisma.$transaction([
    prisma.gmailCredential.deleteMany({ where: { inboxAccountId: accountId } }),
    prisma.inboxAccount.update({
      where: { id: accountId },
      data: {
        isActive: false,
        syncStatus: SYNC_STATUS.IDLE,
        lastSyncError: null,
        syncLockExpiresAt: null,
        syncLockToken: null,
      },
    }),
  ]);

  const updated = await prisma.inboxAccount.findUnique({ where: { id: accountId } });
  return { account: serializeGmailAccount(updated) };
}

/**
 * Ingest a mapped message idempotently for an account.
 * @param {string} accountId
 * @param {ReturnType<typeof mapGmailMessageToIngest>} mapped
 */
async function ingestMappedMessage(accountId, mapped) {
  const prisma = db.getPrisma();
  try {
    await prisma.inboxItem.create({
      data: {
        inboxAccountId: accountId,
        source: 'GMAIL',
        externalId: mapped.externalId,
        threadExternalId: mapped.threadExternalId,
        senderName: mapped.senderName,
        senderIdentifier: mapped.senderIdentifier,
        recipients: mapped.recipients,
        subject: mapped.subject,
        rawContent: mapped.rawContent,
        status: 'NEW',
        receivedAt: new Date(mapped.receivedAt),
        summary: mapped.sourceMetadata?.snippet || null,
      },
    });
    return { created: true };
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      return { duplicate: true };
    }
    throw err;
  }
}

/**
 * @param {string | null | undefined} priorCursor
 * @param {string | null | undefined} nextCursor
 */
function isSafeCursorAdvance(priorCursor, nextCursor) {
  if (!nextCursor || typeof nextCursor !== 'string') return false;
  if (!priorCursor) return true;
  if (/^\d+$/.test(priorCursor) && /^\d+$/.test(nextCursor)) {
    return BigInt(nextCursor) >= BigInt(priorCursor);
  }
  // Test adapters often use human-readable cursors; production Gmail historyIds are numeric.
  return true;
}

/**
 * @param {ReturnType<typeof getGmailApiAdapter>} adapter
 * @param {object} oauth2Client
 * @param {ReturnType<typeof getGmailSyncConfig>} config
 * @param {Record<string, unknown>} env
 */
async function listMessageIdsPaginated(adapter, oauth2Client, config, env) {
  const messageIds = [];
  const seen = new Set();
  let pageToken;
  let capped = false;
  let capReason = null;

  do {
    const remaining = config.GMAIL_INITIAL_SYNC_MAX_MESSAGES - messageIds.length;
    if (remaining <= 0) {
      capped = true;
      capReason = 'initial_sync_max_messages';
      break;
    }
    const listed = await withGoogleRetries(
      () =>
        adapter.listMessages(oauth2Client, {
          maxResults: remaining,
          pageToken,
          q: '-in:spam -in:trash',
        }),
      { env }
    );
    for (const message of listed.messages || []) {
      if (!message?.id || seen.has(message.id)) continue;
      seen.add(message.id);
      messageIds.push(message.id);
      if (messageIds.length >= config.GMAIL_INITIAL_SYNC_MAX_MESSAGES) {
        capped = Boolean(listed.nextPageToken || (listed.messages || []).length > messageIds.length);
        capReason = capped ? 'initial_sync_max_messages' : null;
        break;
      }
    }
    pageToken = listed.nextPageToken || null;
    if (pageToken && messageIds.length >= config.GMAIL_INITIAL_SYNC_MAX_MESSAGES) {
      capped = true;
      capReason = 'initial_sync_max_messages';
    }
  } while (pageToken && !capped);

  return { messageIds, capped, capReason };
}

/**
 * @param {ReturnType<typeof getGmailApiAdapter>} adapter
 * @param {object} oauth2Client
 * @param {string} startHistoryId
 * @param {ReturnType<typeof getGmailSyncConfig>} config
 * @param {Record<string, unknown>} env
 */
async function listHistoryBounded(adapter, oauth2Client, startHistoryId, config, env) {
  const messageIds = new Set();
  let latestHistoryId = startHistoryId;
  let pagesUsed = 0;
  let pageToken;
  let capped = false;
  let missingHistoryId = false;

  do {
    pagesUsed += 1;
    const history = await withGoogleRetries(
      () =>
        adapter.listHistory(oauth2Client, startHistoryId, {
          pageToken,
          maxPages: Math.max(1, config.GMAIL_HISTORY_MAX_PAGES - pagesUsed + 1),
        }),
      { env }
    );
    for (const id of history.messageIds || []) {
      if (id) messageIds.add(id);
    }
    if (history.historyId) {
      latestHistoryId = history.historyId;
    } else {
      missingHistoryId = true;
    }
    if (typeof history.pagesUsed === 'number' && history.pagesUsed > 1) {
      pagesUsed += history.pagesUsed - 1;
    }
    capped = Boolean(history.capped);
    pageToken = history.nextPageToken || null;
    if (capped || pagesUsed >= config.GMAIL_HISTORY_MAX_PAGES) break;
  } while (pageToken);

  if (pageToken || capped) {
    capped = true;
  }

  return {
    messageIds: [...messageIds],
    historyId: latestHistoryId,
    pagesUsed,
    capped,
    capReason: capped ? 'history_max_pages' : null,
    missingHistoryId,
  };
}

/**
 * @param {unknown} err
 */
function isHistoryIdInvalid(err) {
  if (!err || typeof err !== 'object') return false;
  const anyErr = /** @type {Record<string, unknown>} */ (err);
  const code = anyErr.code;
  const message = String(anyErr.message || '');
  return code === 404 || message.includes('historyId') || message.includes('notFound');
}

/**
 * @param {string} accountId
 * @param {string} token
 * @param {ReturnType<typeof getGmailSyncConfig>} config
 */
function startLeaseRenewal(accountId, token, config) {
  const timer = setInterval(() => {
    renewSyncLock(accountId, token, config).catch(() => {});
  }, SYNC_LOCK_RENEW_EVERY_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

/**
 * Sync one Gmail account. Advances cursor only after full successful ingestion.
 * Concurrent syncs for the same account return syncInProgress.
 * @param {string} accountId
 * @param {Record<string, string | undefined>} env
 */
async function syncGmailAccount(accountId, env) {
  const started = Date.now();
  if (!isGmailConfigured(env)) {
    return { notConfigured: true };
  }

  const prisma = db.getPrisma();
  const preflight = await prisma.inboxAccount.findFirst({
    where: { id: accountId, source: 'GMAIL' },
  });
  if (!preflight) {
    return { notFound: true };
  }
  if (!preflight.isActive) {
    return { inactive: true };
  }
  if (preflight.syncStatus === SYNC_STATUS.RECONNECT_REQUIRED) {
    return { reconnectRequired: true };
  }

  const config = getGmailSyncConfig(env);
  const token = await acquireSyncLock(accountId, config);
  if (!token) {
    return { syncInProgress: true };
  }

  let renewTimer = null;
  const deadline = Date.now() + config.GMAIL_SYNC_TIMEOUT_MS;
  const failWithLockRelease = async (data, result) => {
    await releaseSyncLock(accountId, data, token);
    return result;
  };
  const ensureNotTimedOut = () => {
    if (Date.now() > deadline) {
      const err = new Error('Gmail sync timed out');
      err.code = 'SYNC_TIMEOUT';
      throw err;
    }
  };

  try {
    renewTimer = startLeaseRenewal(accountId, token, config);
    const account = await prisma.inboxAccount.findFirst({
      where: { id: accountId, source: 'GMAIL', syncLockToken: token },
    });
    if (!account) {
      return { syncFailed: true, cursorUnchanged: true, lockLost: true };
    }
    if (!account.isActive) {
      return { inactive: true };
    }
    if (account.syncStatus === SYNC_STATUS.RECONNECT_REQUIRED) {
      return { reconnectRequired: true };
    }

    const priorCursor = account.syncCursor;
    const auth = await getAuthorizedClient(accountId, /** @type {Record<string, string>} */ (env));

    if (auth.missingCredentials) {
      await markReconnectRequired(accountId);
      return { reconnectRequired: true };
    }
    if (auth.reconnectRequired) {
      return { reconnectRequired: true };
    }
    if (auth.authError || !auth.oauth2Client) {
      return failWithLockRelease(
        {
          syncStatus: SYNC_STATUS.ERROR,
          lastSyncError: 'Failed to authorize Gmail account.',
        },
        { authError: true }
      );
    }

    const oauth2Client = auth.oauth2Client;
    const adapter = getGmailApiAdapter();

    let messageIds = [];
    let nextCursor = null;
    let capped = false;
    let capReason = null;

    try {
      ensureNotTimedOut();
      if (!priorCursor) {
        const listed = await listMessageIdsPaginated(adapter, oauth2Client, config, env);
        messageIds = listed.messageIds;
        capped = listed.capped;
        capReason = listed.capReason;
        const profile = await withGoogleRetries(() => adapter.getProfileHistoryId(oauth2Client), { env });
        nextCursor = profile.historyId || null;
      } else {
        try {
          const history = await listHistoryBounded(adapter, oauth2Client, priorCursor, config, env);
          messageIds = history.messageIds;
          nextCursor = history.missingHistoryId ? null : history.historyId || null;
          capped = history.capped;
          capReason = history.capReason;
        } catch (err) {
          if (isHistoryIdInvalid(err)) {
            const listed = await listMessageIdsPaginated(adapter, oauth2Client, config, env);
            messageIds = listed.messageIds;
            capped = listed.capped;
            capReason = listed.capReason;
            const profile = await withGoogleRetries(() => adapter.getProfileHistoryId(oauth2Client), { env });
            nextCursor = profile.historyId || null;
          } else {
            throw err;
          }
        }
      }
    } catch (err) {
      logGmailEvent({
        accountId,
        operation: 'gmail_list_messages',
        errorCode: getSafeErrorCode(err),
        httpStatus: getHttpStatus(err),
        durationMs: Date.now() - started,
        capped,
        capReason,
      });
      return failWithLockRelease(
        {
          syncStatus: SYNC_STATUS.ERROR,
          lastSyncError: 'Failed to list Gmail messages.',
        },
        { syncFailed: true, cursorUnchanged: true, capped, capReason }
      );
    }

    if (!isSafeCursorAdvance(priorCursor, nextCursor)) {
      return failWithLockRelease(
        {
          syncStatus: SYNC_STATUS.ERROR,
          lastSyncError: 'Gmail sync did not return a safe history cursor.',
        },
        {
          syncFailed: true,
          cursorUnchanged: true,
          missingHistoryId: !nextCursor,
          created: 0,
          skipped: 0,
          excluded: 0,
          capped,
          capReason,
        }
      );
    }

    let created = 0;
    let skipped = 0;
    let excluded = 0;

    try {
      for (const messageId of messageIds) {
        ensureNotTimedOut();
        const raw = await withGoogleRetries(() => adapter.getMessage(oauth2Client, messageId), { env });
        const mapped = mapGmailMessageToIngest(raw);
        if (isSpamOrTrash(mapped.labels)) {
          excluded += 1;
          continue;
        }
        const result = await ingestMappedMessage(accountId, mapped);
        if (result.created) created += 1;
        else if (result.duplicate) skipped += 1;
      }
    } catch (err) {
      logGmailEvent({
        accountId,
        operation: 'gmail_ingest_messages',
        errorCode: getSafeErrorCode(err),
        httpStatus: getHttpStatus(err),
        durationMs: Date.now() - started,
        capped,
        capReason,
      });
      await releaseSyncLock(
        accountId,
        {
          syncStatus: SYNC_STATUS.ERROR,
          lastSyncError: 'Failed to ingest one or more Gmail messages.',
        },
        token
      );
      const unchanged = await prisma.inboxAccount.findUnique({ where: { id: accountId } });
      return {
        syncFailed: true,
        cursorUnchanged: true,
        created,
        skipped,
        excluded,
        capped,
        capReason,
        account: serializeGmailAccount(unchanged),
      };
    }

    const cursorWhere = priorCursor === null ? { syncCursor: null } : { syncCursor: priorCursor };
    const updated = await prisma.inboxAccount.updateMany({
      where: {
        id: accountId,
        source: 'GMAIL',
        syncLockToken: token,
        syncLockExpiresAt: { gt: new Date() },
        isActive: true,
        gmailCredential: { isNot: null },
        ...cursorWhere,
      },
      data: {
        syncCursor: nextCursor,
        lastSyncedAt: new Date(),
        syncStatus: SYNC_STATUS.OK,
        lastSyncError: null,
        syncLockExpiresAt: null,
        syncLockToken: null,
      },
    });

    if (updated.count !== 1) {
      await releaseSyncLock(
        accountId,
        {
          syncStatus: SYNC_STATUS.ERROR,
          lastSyncError: 'Gmail sync lock was lost before completion.',
        },
        token
      );
      const current = await prisma.inboxAccount.findUnique({ where: { id: accountId } });
      return {
        syncFailed: true,
        cursorUnchanged: true,
        lockLost: true,
        created,
        skipped,
        excluded,
        capped,
        capReason,
        account: serializeGmailAccount(current),
      };
    }

    const finalAccount = await prisma.inboxAccount.findUnique({ where: { id: accountId } });
    return {
      ok: true,
      created,
      skipped,
      excluded,
      fetched: messageIds.length,
      capped,
      capReason,
      account: serializeGmailAccount(finalAccount),
    };
  } catch (err) {
    logGmailEvent({
      accountId,
      operation: 'gmail_sync',
      errorCode: getSafeErrorCode(err),
      httpStatus: getHttpStatus(err),
      durationMs: Date.now() - started,
    });
    await releaseSyncLock(
      accountId,
      {
        syncStatus: SYNC_STATUS.ERROR,
        lastSyncError: 'Gmail sync failed.',
      },
      token
    );
    return { syncFailed: true, cursorUnchanged: true };
  } finally {
    if (renewTimer) clearInterval(renewTimer);
  }
}

/**
 * Sync all active Gmail accounts that have credentials.
 * @param {object} env
 */
async function syncAllGmailAccounts(env) {
  if (!isGmailConfigured(env)) {
    return { notConfigured: true };
  }

  const prisma = db.getPrisma();
  const accounts = await prisma.inboxAccount.findMany({
    where: {
      source: 'GMAIL',
      isActive: true,
    },
    orderBy: { updatedAt: 'asc' },
  });

  const results = [];
  for (const account of accounts) {
    const result = await syncGmailAccount(account.id, env);
    results.push({
      accountId: account.id,
      ...summarizeSyncResult(result),
    });
  }

  return { results };
}

/**
 * Safe summary for sync-all (no email addresses, bodies, or raw errors).
 * @param {object} result
 */
function summarizeSyncResult(result) {
  if (result.ok) {
    return {
      status: 'ok',
      created: result.created,
      skipped: result.skipped,
      excluded: result.excluded,
      fetched: result.fetched,
      capped: Boolean(result.capped),
      capReason: result.capReason || null,
    };
  }
  if (result.notFound) return { status: 'not_found' };
  if (result.inactive) return { status: 'inactive' };
  if (result.reconnectRequired) return { status: 'reconnect_required' };
  if (result.syncInProgress) return { status: 'sync_in_progress' };
  if (result.authError) return { status: 'auth_error' };
  if (result.syncFailed) {
    return {
      status: 'sync_failed',
      created: result.created || 0,
      skipped: result.skipped || 0,
      excluded: result.excluded || 0,
      cursorUnchanged: true,
      capped: Boolean(result.capped),
      capReason: result.capReason || null,
    };
  }
  return { status: 'error' };
}

module.exports = {
  SYNC_STATUS,
  INITIAL_SYNC_LIMIT,
  OAUTH_STATE_TTL_MS,
  SYNC_LOCK_LEASE_MS,
  SYNC_LOCK_RENEW_EVERY_MS,
  MAX_BODY_CHARS,
  GMAIL_OAUTH_FLOW,
  defaults,
  isGmailConfigured,
  serializeGmailAccount,
  createOAuthState,
  parseAndVerifyOAuthState,
  verifyOAuthState,
  clearOAuthStates,
  hasPendingOAuthState,
  buildConnectUrl,
  buildOAuthClient,
  extractRedirectUriFromAuthUrl,
  extractScopesFromAuthUrl,
  handleOAuthCallback,
  listGmailAccounts,
  disconnectGmailAccount,
  syncGmailAccount,
  syncAllGmailAccounts,
  mapGmailMessageToIngest,
  extractMessageBody,
  htmlToText,
  capBodySize,
  parseAddress,
  isSpamOrTrash,
  isInvalidGrantError,
  getAuthorizedClient,
  markReconnectRequired,
  acquireSyncLock,
  renewSyncLock,
  releaseSyncLock,
  persistRefreshedTokens,
  summarizeSyncResult,
  isHistoryIdInvalid,
  isSafeCursorAdvance,
  isRetryableGoogleError,
  withGoogleRetries,
  logGmailEvent,
  setGmailTestHooks,
  resetGmailTestHooks,
  getGmailSyncConfig,
  getHttpStatus,
};
