/**
 * Gmail connector: OAuth, encrypted credentials, sync, account management.
 *
 * Security rules:
 * - Never log tokens, codes, client secrets, or decrypted credentials.
 * - Never return credentials through APIs.
 * - Safe user-facing errors only.
 */

const crypto = require('crypto');
const db = require('./db');
const { encryptToken, decryptToken, validateEncryptionKey } = require('./tokenEncryption');
const {
  GMAIL_OAUTH_SCOPES,
  createGmailOAuth2Client,
  getGmailApiAdapter,
} = require('./gmailClient');

const INITIAL_SYNC_LIMIT = 50;
const OAUTH_STATE_TTL_MS = 15 * 60 * 1000;

/** Sync status values stored on InboxAccount.syncStatus */
const SYNC_STATUS = {
  IDLE: 'IDLE',
  OK: 'OK',
  ERROR: 'ERROR',
  RECONNECT_REQUIRED: 'RECONNECT_REQUIRED',
};

/**
 * In-memory OAuth state store (CSRF). Keyed by nonce.
 * Values never include tokens — only issued-at metadata.
 * @type {Map<string, { createdAt: number, exp: number }>}
 */
const pendingOAuthStates = new Map();

/**
 * @param {string | undefined} encryptionKey
 * @returns {boolean}
 */
function isGmailConfigured(encryptionKey) {
  if (!encryptionKey || typeof encryptionKey !== 'string' || encryptionKey.trim() === '') {
    return false;
  }
  try {
    validateEncryptionKey(encryptionKey);
    return true;
  } catch (_e) {
    return false;
  }
}

/**
 * @param {Date | null | undefined} value
 */
function isoOrNull(value) {
  return value ? value.toISOString() : null;
}

/**
 * Public Gmail account view — never includes credentials.
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
 * Create a signed, short-lived OAuth state and remember the nonce.
 * Uses ADMIN_API_KEY as HMAC secret so Bearer never appears in the browser URL.
 *
 * @param {string} hmacSecret
 * @returns {string}
 */
function createOAuthState(hmacSecret) {
  const nonce = crypto.randomBytes(24).toString('base64url');
  const exp = Date.now() + OAUTH_STATE_TTL_MS;
  const payload = `${nonce}.${exp}`;
  const sig = crypto.createHmac('sha256', hmacSecret).update(payload).digest('base64url');
  pendingOAuthStates.set(nonce, { createdAt: Date.now(), exp });
  return `${nonce}.${exp}.${sig}`;
}

/**
 * Verify OAuth state (CSRF). Consumes the nonce (one-time use).
 * @param {string} state
 * @param {string} hmacSecret
 * @returns {boolean}
 */
function verifyOAuthState(state, hmacSecret) {
  if (!state || typeof state !== 'string') return false;
  const parts = state.split('.');
  if (parts.length !== 3) return false;
  const [nonce, expStr, sig] = parts;
  const exp = Number(expStr);
  if (!nonce || !Number.isFinite(exp) || !sig) return false;
  if (Date.now() > exp) {
    pendingOAuthStates.delete(nonce);
    return false;
  }

  const payload = `${nonce}.${exp}`;
  const expected = crypto.createHmac('sha256', hmacSecret).update(payload).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expected);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return false;
  }

  const pending = pendingOAuthStates.get(nonce);
  if (!pending) return false;
  pendingOAuthStates.delete(nonce);
  return true;
}

/** Test helper — clear pending states. */
function clearOAuthStates() {
  pendingOAuthStates.clear();
}

/** Test helper — peek whether a nonce is pending (does not expose secrets). */
function hasPendingOAuthState(state) {
  if (!state || typeof state !== 'string') return false;
  const nonce = state.split('.')[0];
  return pendingOAuthStates.has(nonce);
}

/**
 * @param {{ GOOGLE_CLIENT_ID: string, GOOGLE_CLIENT_SECRET: string, GOOGLE_REDIRECT_URI: string }} env
 */
function buildOAuthClient(env) {
  return createGmailOAuth2Client({
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUri: env.GOOGLE_REDIRECT_URI,
  });
}

/**
 * Start Gmail OAuth — returns Google authorization URL (no Bearer in URL).
 * @param {{ GOOGLE_CLIENT_ID: string, GOOGLE_CLIENT_SECRET: string, GOOGLE_REDIRECT_URI: string, ADMIN_API_KEY: string, TOKEN_ENCRYPTION_KEY?: string }} env
 */
function buildConnectUrl(env) {
  if (!isGmailConfigured(env.TOKEN_ENCRYPTION_KEY)) {
    return { notConfigured: true };
  }
  const state = createOAuthState(env.ADMIN_API_KEY);
  const oauth2Client = buildOAuthClient(env);
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: GMAIL_OAUTH_SCOPES,
    state,
    include_granted_scopes: true,
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
 * Convert basic HTML to readable plain text (no full HTML parser dependency).
 * @param {string} html
 */
function htmlToText(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
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
 * Prefer text/plain; fall back to basic HTML→text. No attachments.
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
    // Skip attachment parts (filename present).
    if (part.filename) continue;
    const data = part.body?.data;
    if (!data) continue;
    if (mime === 'text/plain' && !plain) {
      plain = decodeBodyData(data);
    } else if (mime === 'text/html' && !html) {
      html = decodeBodyData(data);
    }
  }

  // Some simple messages put body on the top-level payload.
  if (!plain && !html && message.payload?.body?.data) {
    const topMime = (message.payload.mimeType || '').toLowerCase();
    const decoded = decodeBodyData(message.payload.body.data);
    if (topMime === 'text/html') html = decoded;
    else plain = decoded;
  }

  const text = plain.trim() ? plain.trim() : html ? htmlToText(html) : '';
  return { text: text || '(no text body)', labels };
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
      snippet: message.snippet || null,
    },
  };
}

/**
 * Load and decrypt credentials for an account; refresh access token if needed.
 * @param {string} accountId
 * @param {{ GOOGLE_CLIENT_ID: string, GOOGLE_CLIENT_SECRET: string, GOOGLE_REDIRECT_URI: string, TOKEN_ENCRYPTION_KEY: string }} env
 */
async function getAuthorizedClient(accountId, env) {
  const prisma = db.getPrisma();
  const credential = await prisma.gmailCredential.findUnique({ where: { inboxAccountId: accountId } });
  if (!credential) {
    return { missingCredentials: true };
  }

  const oauth2Client = buildOAuthClient(env);
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
    },
  });
}

/**
 * Handle OAuth callback: verify state, exchange code, upsert account + credentials.
 * @param {{ code?: unknown, state?: unknown }} query
 * @param {{ GOOGLE_CLIENT_ID: string, GOOGLE_CLIENT_SECRET: string, GOOGLE_REDIRECT_URI: string, ADMIN_API_KEY: string, TOKEN_ENCRYPTION_KEY?: string }} env
 */
async function handleOAuthCallback(query, env) {
  if (!isGmailConfigured(env.TOKEN_ENCRYPTION_KEY)) {
    return { error: 'not_configured', status: 503 };
  }

  const code = query.code;
  const state = query.state;
  if (!code || typeof code !== 'string') {
    return { error: 'invalid_request', status: 400 };
  }
  if (!state || typeof state !== 'string' || !verifyOAuthState(state, env.ADMIN_API_KEY)) {
    return { error: 'invalid_state', status: 400 };
  }

  const oauth2Client = buildOAuthClient(env);
  const adapter = getGmailApiAdapter();

  let tokens;
  try {
    tokens = await adapter.exchangeCode(oauth2Client, code);
  } catch (_e) {
    return { error: 'exchange_failed', status: 400 };
  }

  if (!tokens || !tokens.refresh_token) {
    // Re-consent should always return refresh when prompt=consent; treat missing as failure.
    return { error: 'missing_refresh_token', status: 400 };
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
  const encryptedRefreshToken = encryptToken(tokens.refresh_token, encryptionKey);
  const encryptedAccessToken = tokens.access_token
    ? encryptToken(tokens.access_token, encryptionKey)
    : null;
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

  const prisma = db.getPrisma();

  // Upsert by Google external account id — never confuse distinct Google identities.
  let account = await prisma.inboxAccount.findFirst({
    where: {
      source: 'GMAIL',
      externalAccountId: profile.id,
    },
  });

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
        // Keep syncCursor so a future reconnect can choose to resume or reset.
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
 * @param {string} accountId
 * @param {{ GOOGLE_CLIENT_ID: string, GOOGLE_CLIENT_SECRET: string, GOOGLE_REDIRECT_URI: string, TOKEN_ENCRYPTION_KEY?: string }} env
 */
async function syncGmailAccount(accountId, env) {
  if (!isGmailConfigured(env.TOKEN_ENCRYPTION_KEY)) {
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

  const priorCursor = account.syncCursor;
  const auth = await getAuthorizedClient(accountId, {
    ...env,
    TOKEN_ENCRYPTION_KEY: /** @type {string} */ (env.TOKEN_ENCRYPTION_KEY),
  });

  if (auth.missingCredentials) {
    await markReconnectRequired(accountId);
    return { reconnectRequired: true };
  }
  if (auth.reconnectRequired) {
    return { reconnectRequired: true };
  }
  if (auth.authError || !auth.oauth2Client) {
    await prisma.inboxAccount.update({
      where: { id: accountId },
      data: {
        syncStatus: SYNC_STATUS.ERROR,
        lastSyncError: 'Failed to authorize Gmail account.',
      },
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
      // Initial sync: most recent N messages (excluding spam/trash via query).
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
        // History id expired/invalid → safe fallback to recent messages; still capture new historyId.
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
    await prisma.inboxAccount.update({
      where: { id: accountId },
      data: {
        syncStatus: SYNC_STATUS.ERROR,
        lastSyncError: 'Failed to list Gmail messages.',
      },
    });
    // Do not advance cursor.
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
    await prisma.inboxAccount.update({
      where: { id: accountId },
      data: {
        syncStatus: SYNC_STATUS.ERROR,
        lastSyncError: 'Failed to ingest one or more Gmail messages.',
      },
    });
    // Partial failure — leave syncCursor unchanged.
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

  // Success — advance cursor + lastSyncedAt only now.
  const updated = await prisma.inboxAccount.update({
    where: { id: accountId },
    data: {
      syncCursor: nextCursor,
      lastSyncedAt: new Date(),
      syncStatus: SYNC_STATUS.OK,
      lastSyncError: null,
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
  if (!isGmailConfigured(env.TOKEN_ENCRYPTION_KEY)) {
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
      emailAddress: account.emailAddress,
      ...summarizeSyncResult(result),
    });
  }

  return { results };
}

/**
 * Safe summary for sync-all (no raw errors).
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
  isGmailConfigured,
  serializeGmailAccount,
  createOAuthState,
  verifyOAuthState,
  clearOAuthStates,
  hasPendingOAuthState,
  buildConnectUrl,
  handleOAuthCallback,
  listGmailAccounts,
  disconnectGmailAccount,
  syncGmailAccount,
  syncAllGmailAccounts,
  mapGmailMessageToIngest,
  extractMessageBody,
  htmlToText,
  parseAddress,
  isSpamOrTrash,
  isInvalidGrantError,
  getAuthorizedClient,
  markReconnectRequired,
};
