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
/** OAuth state TTL — documented short window. */
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
/** Sync lease duration — expired leases are reclaimable after process crash. */
const SYNC_LOCK_LEASE_MS = 5 * 60 * 1000;
/** Max stored body characters after sanitization (documented safe maximum). */
const MAX_BODY_CHARS = 100_000;
const GMAIL_OAUTH_FLOW = 'gmail';

/** Sync status values stored on InboxAccount.syncStatus */
const SYNC_STATUS = {
  IDLE: 'IDLE',
  OK: 'OK',
  ERROR: 'ERROR',
  RECONNECT_REQUIRED: 'RECONNECT_REQUIRED',
  SYNCING: 'SYNCING',
};

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
 * Public Gmail account view — never includes credentials or encrypted fields.
 * @param {object} account
 */
function serializeGmailAccount(account) {
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
 * Verify OAuth state (CSRF). Consumes the nonce atomically (one-time use).
 * Bound to flow=gmail — cannot be reused for Calendar.
 *
 * @param {string} state
 * @param {string} hmacSecret
 * @returns {Promise<boolean>}
 */
async function verifyOAuthState(state, hmacSecret) {
  if (!state || typeof state !== 'string') return false;
  const parts = state.split('.');
  if (parts.length !== 4) return false;
  const [flow, nonce, expStr, sig] = parts;
  if (flow !== GMAIL_OAUTH_FLOW) return false;
  const exp = Number(expStr);
  if (!nonce || !Number.isFinite(exp) || !sig) return false;
  if (Date.now() > exp) {
    try {
      const prisma = db.getPrisma();
      await prisma.gmailOAuthState.deleteMany({ where: { nonce } });
    } catch (_e) {
      // ignore cleanup failures
    }
    return false;
  }

  const payload = `${flow}.${nonce}.${exp}`;
  const expected = crypto.createHmac('sha256', hmacSecret).update(payload).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expected);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return false;
  }

  const prisma = db.getPrisma();
  // Atomic one-time consume: only succeed if unconsumed and unexpired.
  const updated = await prisma.gmailOAuthState.updateMany({
    where: {
      nonce,
      flow: GMAIL_OAUTH_FLOW,
      consumedAt: null,
      expiresAt: { gt: new Date() },
    },
    data: { consumedAt: new Date() },
  });

  return updated.count === 1;
}

/** Test helper — clear pending Gmail OAuth states. */
async function clearOAuthStates() {
  try {
    const prisma = db.getPrisma();
    await prisma.gmailOAuthState.deleteMany({});
  } catch (_e) {
    // ignore when DB unavailable in pure unit contexts
  }
}

/** Test helper — peek whether a nonce is pending (unconsumed). */
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
 * Start Gmail OAuth — returns Google authorization URL (no Bearer in URL).
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
 * Cap stored body size — truncate abnormally large messages safely.
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
 * Prefer text/plain; fall back to sanitized HTML→text. No attachments.
 * @param {object} message — Gmail users.messages resource
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
    // Skip attachment parts (filename present) — never download attachments.
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
  // Also strip leftover URLs from plain text for tracking privacy.
  if (html && !plain.trim()) {
    // already sanitized via htmlToText
  }
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
  const internalDate = message.internalDate
    ? new Date(Number(message.internalDate))
    : new Date();

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
      const refreshed = await adapter.refreshAccessToken(oauth2Client);
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
 * @param {unknown} err
 */
function isInvalidGrantError(err) {
  if (!err || typeof err !== 'object') return false;
  const anyErr = /** @type {Record<string, unknown>} */ (err);
  const message = String(anyErr.message || '');
  const responseData =
    anyErr.response && typeof anyErr.response === 'object'
      ? /** @type {Record<string, unknown>} */ (anyErr.response).data
      : null;
  const errorCode =
    responseData && typeof responseData === 'object'
      ? /** @type {Record<string, unknown>} */ (responseData).error
      : null;
  return (
    errorCode === 'invalid_grant' ||
    message.includes('invalid_grant') ||
    message.includes('Token has been expired or revoked')
  );
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
    },
  });
}

/**
 * Acquire a sync lease lock. Returns false if another sync holds a valid lease.
 * @param {string} accountId
 */
async function acquireSyncLock(accountId) {
  const prisma = db.getPrisma();
  const now = new Date();
  const expires = new Date(Date.now() + SYNC_LOCK_LEASE_MS);
  const result = await prisma.inboxAccount.updateMany({
    where: {
      id: accountId,
      OR: [{ syncLockExpiresAt: null }, { syncLockExpiresAt: { lt: now } }],
    },
    data: {
      syncLockExpiresAt: expires,
      syncStatus: SYNC_STATUS.SYNCING,
    },
  });
  return result.count === 1;
}

/**
 * @param {string} accountId
 * @param {Record<string, unknown>} data
 */
async function releaseSyncLock(accountId, data = {}) {
  const prisma = db.getPrisma();
  await prisma.inboxAccount.update({
    where: { id: accountId },
    data: {
      syncLockExpiresAt: null,
      ...data,
    },
  });
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

  // Ignore/suppress provider error query params — never reflect them.
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

  const stateOk = await verifyOAuthState(state, /** @type {string} */ (env.ADMIN_API_KEY));
  if (!stateOk) {
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
    tokens = await adapter.exchangeCode(oauth2Client, code);
  } catch (_e) {
    return { error: 'exchange_failed', status: 400 };
  }

  oauth2Client.setCredentials(tokens);

  let profile;
  try {
    profile = await adapter.getProfile(oauth2Client);
  } catch (_e) {
    return { error: 'profile_failed', status: 400 };
  }

  if (!profile?.email || !profile?.id) {
    return { error: 'profile_incomplete', status: 400 };
  }

  const encryptionKey = /** @type {string} */ (env.TOKEN_ENCRYPTION_KEY);
  const prisma = db.getPrisma();

  // Upsert by Google external account id — never confuse distinct Google identities.
  let account = await prisma.inboxAccount.findFirst({
    where: {
      source: 'GMAIL',
      externalAccountId: profile.id,
    },
    include: { gmailCredential: true },
  });

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

  const encryptedAccessToken = tokens.access_token
    ? encryptToken(tokens.access_token, encryptionKey)
    : null;

  // New refresh token replaces old; if Google omits it, preserve existing valid refresh token.
  let encryptedRefreshToken = null;
  if (tokens.refresh_token) {
    encryptedRefreshToken = encryptToken(tokens.refresh_token, encryptionKey);
  } else if (account?.gmailCredential?.encryptedRefreshToken) {
    encryptedRefreshToken = account.gmailCredential.encryptedRefreshToken;
  } else {
    // First connect (or reconnect after disconnect) requires a refresh token.
    return { error: 'missing_refresh_token', status: 400 };
  }

  if (account) {
    account = await prisma.inboxAccount.update({
      where: { id: account.id },
      data: {
        emailAddress: profile.email,
        name: profile.name || profile.email,
        isActive: true,
        syncStatus: SYNC_STATUS.IDLE,
        lastSyncError: null,
      },
    });
  } else {
    account = await prisma.inboxAccount.create({
      data: {
        name: profile.name || profile.email,
        source: 'GMAIL',
        emailAddress: profile.email,
        externalAccountId: profile.id,
        isActive: true,
        syncStatus: SYNC_STATUS.IDLE,
        lastSyncError: null,
      },
    });
  }

  // Unique inboxAccountId prevents duplicate credential rows under concurrent callbacks.
  await prisma.gmailCredential.upsert({
    where: { inboxAccountId: account.id },
    create: {
      inboxAccountId: account.id,
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
    if (err && typeof err === 'object' && 'code' in err && err.code === 'P2002') {
      return { duplicate: true };
    }
    throw err;
  }
}

/**
 * Sync one Gmail account. Advances cursor only after full successful ingestion.
 * Concurrent syncs for the same account return syncInProgress.
 * @param {string} accountId
 * @param {Record<string, string | undefined>} env
 */
async function syncGmailAccount(accountId, env) {
  if (!isGmailConfigured(env)) {
    return { notConfigured: true };
  }

  const prisma = db.getPrisma();
  const account = await prisma.inboxAccount.findFirst({
    where: { id: accountId, source: 'GMAIL' },
  });
  if (!account) {
    return { notFound: true };
  }
  if (!account.isActive) {
    return { inactive: true };
  }
  if (account.syncStatus === SYNC_STATUS.RECONNECT_REQUIRED) {
    return { reconnectRequired: true };
  }

  const locked = await acquireSyncLock(accountId);
  if (!locked) {
    return { syncInProgress: true };
  }

  const priorCursor = account.syncCursor;

  try {
    const auth = await getAuthorizedClient(accountId, /** @type {Record<string, string>} */ (env));

    if (auth.missingCredentials) {
      await markReconnectRequired(accountId);
      return { reconnectRequired: true };
    }
    if (auth.reconnectRequired) {
      return { reconnectRequired: true };
    }
    if (auth.authError || !auth.oauth2Client) {
      await releaseSyncLock(accountId, {
        syncStatus: SYNC_STATUS.ERROR,
        lastSyncError: 'Failed to authorize Gmail account.',
      });
      return { authError: true };
    }

    const oauth2Client = auth.oauth2Client;
    const adapter = getGmailApiAdapter();

    let messageIds = [];
    /** @type {string | null} */
    let nextCursor = null;

    try {
      if (!priorCursor) {
        const listed = await adapter.listMessages(oauth2Client, {
          maxResults: INITIAL_SYNC_LIMIT,
          q: '-in:spam -in:trash',
        });
        messageIds = listed.messages.map((m) => m.id).filter(Boolean);
        const profile = await adapter.getProfileHistoryId(oauth2Client);
        nextCursor = profile.historyId;
      } else {
        try {
          const history = await adapter.listHistory(oauth2Client, priorCursor);
          messageIds = history.messageIds;
          nextCursor = history.historyId || priorCursor;
        } catch (err) {
          if (isHistoryIdInvalid(err)) {
            const listed = await adapter.listMessages(oauth2Client, {
              maxResults: INITIAL_SYNC_LIMIT,
              q: '-in:spam -in:trash',
            });
            messageIds = listed.messages.map((m) => m.id).filter(Boolean);
            const profile = await adapter.getProfileHistoryId(oauth2Client);
            nextCursor = profile.historyId;
          } else {
            throw err;
          }
        }
      }
    } catch (_e) {
      await releaseSyncLock(accountId, {
        syncStatus: SYNC_STATUS.ERROR,
        lastSyncError: 'Failed to list Gmail messages.',
      });
      return { syncFailed: true, cursorUnchanged: true };
    }

    let created = 0;
    let skipped = 0;
    let excluded = 0;

    try {
      for (const messageId of messageIds) {
        const raw = await adapter.getMessage(oauth2Client, messageId);
        const mapped = mapGmailMessageToIngest(raw);
        if (isSpamOrTrash(mapped.labels)) {
          excluded += 1;
          continue;
        }
        const result = await ingestMappedMessage(accountId, mapped);
        if (result.created) created += 1;
        else if (result.duplicate) skipped += 1;
      }
    } catch (_e) {
      await releaseSyncLock(accountId, {
        syncStatus: SYNC_STATUS.ERROR,
        lastSyncError: 'Failed to ingest one or more Gmail messages.',
      });
      const unchanged = await prisma.inboxAccount.findUnique({ where: { id: accountId } });
      return {
        syncFailed: true,
        cursorUnchanged: true,
        created,
        skipped,
        excluded,
        account: serializeGmailAccount(unchanged),
      };
    }

    const updated = await prisma.inboxAccount.update({
      where: { id: accountId },
      data: {
        syncCursor: nextCursor,
        lastSyncedAt: new Date(),
        syncStatus: SYNC_STATUS.OK,
        lastSyncError: null,
        syncLockExpiresAt: null,
      },
    });

    return {
      ok: true,
      created,
      skipped,
      excluded,
      fetched: messageIds.length,
      account: serializeGmailAccount(updated),
    };
  } catch (_e) {
    await releaseSyncLock(accountId, {
      syncStatus: SYNC_STATUS.ERROR,
      lastSyncError: 'Gmail sync failed.',
    });
    return { syncFailed: true, cursorUnchanged: true };
  }
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
    };
  }
  return { status: 'error' };
}

module.exports = {
  SYNC_STATUS,
  INITIAL_SYNC_LIMIT,
  OAUTH_STATE_TTL_MS,
  SYNC_LOCK_LEASE_MS,
  MAX_BODY_CHARS,
  GMAIL_OAUTH_FLOW,
  isGmailConfigured,
  serializeGmailAccount,
  createOAuthState,
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
  releaseSyncLock,
  persistRefreshedTokens,
  summarizeSyncResult,
  isHistoryIdInvalid,
};
