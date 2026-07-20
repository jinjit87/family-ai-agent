const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const request = require('supertest');

const { createApp, loadEnv } = require('../index');
const { getPrisma, disconnectPrisma } = require('../lib/db');
const { encryptToken, decryptToken, validateEncryptionKey, parseEncryptionKey } = require('../lib/tokenEncryption');
const {
  createOAuthState,
  verifyOAuthState,
  clearOAuthStates,
  hasPendingOAuthState,
  handleOAuthCallback,
  syncGmailAccount,
  disconnectGmailAccount,
  listGmailAccounts,
  htmlToText,
  parseAddress,
  mapGmailMessageToIngest,
  isSpamOrTrash,
  extractMessageBody,
  SYNC_STATUS,
} = require('../lib/gmail');
const { setGmailApiAdapter, resetGmailApiAdapter, GMAIL_OAUTH_SCOPES } = require('../lib/gmailClient');

const ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');

const VALID_ENV = {
  ANTHROPIC_API_KEY: 'test-anthropic-key',
  GOOGLE_CLIENT_ID: 'test-google-client-id',
  GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
  GOOGLE_REDIRECT_URI: 'https://example.com/gmail/callback',
  ADMIN_API_KEY: 'test-admin-api-key',
  TOKEN_ENCRYPTION_KEY: ENCRYPTION_KEY,
};

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://family_ai:family_ai_dev@localhost:5432/family_ai_agent?schema=public';

const SECRET_MARKERS = [
  'ya29.',
  '1//0',
  'refresh-token-value',
  'access-token-value',
  'test-google-client-secret',
  ENCRYPTION_KEY,
];

function auth(req) {
  return req.set('Authorization', `Bearer ${VALID_ENV.ADMIN_API_KEY}`);
}

function assertNoSecrets(payload) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  for (const marker of SECRET_MARKERS) {
    assert.equal(text.includes(marker), false, `secret-like value leaked: ${marker.slice(0, 8)}…`);
  }
  assert.equal(text.includes('encryptedAccessToken'), false);
  assert.equal(text.includes('encryptedRefreshToken'), false);
  assert.equal(text.includes('TOKEN_ENCRYPTION_KEY'), false);
}

function buildGmailMessage({
  id = 'msg-1',
  threadId = 'thread-1',
  from = 'Alice <alice@example.com>',
  to = 'me@example.com',
  subject = 'Hello',
  plain = 'Plain body text',
  html = null,
  labelIds = ['INBOX'],
  internalDate = String(Date.parse('2026-07-20T10:00:00.000Z')),
} = {}) {
  /** @type {object} */
  const payload = {
    mimeType: html && !plain ? 'text/html' : 'multipart/alternative',
    headers: [
      { name: 'From', value: from },
      { name: 'To', value: to },
      { name: 'Subject', value: subject },
    ],
    parts: [],
  };
  if (plain) {
    payload.parts.push({
      mimeType: 'text/plain',
      body: { data: Buffer.from(plain, 'utf8').toString('base64url') },
    });
  }
  if (html) {
    payload.parts.push({
      mimeType: 'text/html',
      body: { data: Buffer.from(html, 'utf8').toString('base64url') },
    });
  }
  if (!plain && !html) {
    payload.mimeType = 'text/plain';
    payload.body = { data: Buffer.from('(empty)', 'utf8').toString('base64url') };
    payload.parts = undefined;
  }
  return {
    id,
    threadId,
    labelIds,
    internalDate,
    snippet: subject,
    payload,
  };
}

describe('token encryption', () => {
  it('encrypts and decrypts round-trip', () => {
    const key = crypto.randomBytes(32).toString('base64');
    const cipher = encryptToken('super-secret-refresh', key);
    assert.notEqual(cipher, 'super-secret-refresh');
    assert.equal(decryptToken(cipher, key), 'super-secret-refresh');
  });

  it('accepts hex, base64, and utf8 32-byte keys', () => {
    assert.equal(parseEncryptionKey(crypto.randomBytes(32).toString('hex')).length, 32);
    assert.equal(parseEncryptionKey(crypto.randomBytes(32).toString('base64')).length, 32);
    assert.equal(parseEncryptionKey('a'.repeat(32)).length, 32);
    assert.throws(() => validateEncryptionKey('too-short'), /Invalid TOKEN_ENCRYPTION_KEY/);
  });

  it('rejects invalid ciphertext without leaking plaintext', () => {
    const key = crypto.randomBytes(32).toString('hex');
    assert.throws(() => decryptToken('not-valid', key));
  });
});

describe('gmail helpers', () => {
  it('parses addresses and converts basic HTML', () => {
    assert.deepEqual(parseAddress('Bob <bob@x.com>'), { name: 'Bob', email: 'bob@x.com' });
    assert.equal(htmlToText('<p>Hi&nbsp;<b>there</b></p>').includes('Hi'), true);
    assert.equal(htmlToText('<p>Hi&nbsp;<b>there</b></p>').includes('there'), true);
  });

  it('prefers text/plain and excludes spam/trash labels', () => {
    const msg = buildGmailMessage({
      plain: 'Plain wins',
      html: '<p>HTML</p>',
      labelIds: ['INBOX'],
    });
    const { text, labels } = extractMessageBody(msg);
    assert.equal(text, 'Plain wins');
    assert.equal(isSpamOrTrash(labels), false);
    assert.equal(isSpamOrTrash(['SPAM']), true);
    assert.equal(isSpamOrTrash(['TRASH']), true);
  });

  it('maps gmail messages to ingest fields', () => {
    const mapped = mapGmailMessageToIngest(
      buildGmailMessage({
        id: 'g-1',
        threadId: 't-1',
        from: 'Sam <sam@corp.com>',
        subject: 'Invoice',
        plain: 'Please pay',
      })
    );
    assert.equal(mapped.externalId, 'g-1');
    assert.equal(mapped.threadExternalId, 't-1');
    assert.equal(mapped.senderIdentifier, 'sam@corp.com');
    assert.equal(mapped.senderName, 'Sam');
    assert.equal(mapped.subject, 'Invoice');
    assert.equal(mapped.status, 'NEW');
    assert.equal(mapped.source, 'GMAIL');
  });
});

describe('oauth state verification', () => {
  afterEach(() => {
    clearOAuthStates();
  });

  it('accepts a fresh state once and rejects reuse / tampering', () => {
    const state = createOAuthState(VALID_ENV.ADMIN_API_KEY);
    assert.equal(hasPendingOAuthState(state), true);
    assert.equal(verifyOAuthState(state, VALID_ENV.ADMIN_API_KEY), true);
    assert.equal(verifyOAuthState(state, VALID_ENV.ADMIN_API_KEY), false);

    const again = createOAuthState(VALID_ENV.ADMIN_API_KEY);
    const tampered = again.replace(/\.[^.]+$/, '.badsignature');
    assert.equal(verifyOAuthState(tampered, VALID_ENV.ADMIN_API_KEY), false);
    assert.equal(verifyOAuthState('not.a.state', VALID_ENV.ADMIN_API_KEY), false);
    assert.equal(verifyOAuthState(null, VALID_ENV.ADMIN_API_KEY), false);
  });
});

describe('env TOKEN_ENCRYPTION_KEY validation', () => {
  it('rejects invalid encryption key at startup when Gmail is enabled', () => {
    assert.throws(
      () =>
        loadEnv({
          ...VALID_ENV,
          TOKEN_ENCRYPTION_KEY: 'short',
        }),
      (err) => {
        assert.match(err.message, /TOKEN_ENCRYPTION_KEY/);
        assert.doesNotMatch(err.message, /short/);
        return true;
      }
    );
  });

  it('accepts a valid encryption key', () => {
    const env = loadEnv(VALID_ENV);
    assert.equal(env.TOKEN_ENCRYPTION_KEY, ENCRYPTION_KEY);
  });
});

describe('gmail HTTP routes and sync', () => {
  /** @type {import('express').Express} */
  let app;
  /** @type {string[]} */
  const fixtureAccountIds = [];

  before(() => {
    process.env.DATABASE_URL = DATABASE_URL;
    const env = loadEnv(VALID_ENV);
    app = createApp(env);
  });

  after(async () => {
    resetGmailApiAdapter();
    clearOAuthStates();
    await disconnectPrisma();
  });

  beforeEach(() => {
    clearOAuthStates();
    resetGmailApiAdapter();
  });

  afterEach(async () => {
    const prisma = getPrisma();
    if (fixtureAccountIds.length > 0) {
      await prisma.inboxItem.deleteMany({ where: { inboxAccountId: { in: fixtureAccountIds } } });
      await prisma.gmailCredential.deleteMany({ where: { inboxAccountId: { in: fixtureAccountIds } } });
      await prisma.inboxAccount.deleteMany({ where: { id: { in: fixtureAccountIds } } });
      fixtureAccountIds.length = 0;
    }
    // Also clean any leftover test gmail accounts by email pattern
    const leftovers = await prisma.inboxAccount.findMany({
      where: { emailAddress: { endsWith: '@gmail-test.example' } },
      select: { id: true },
    });
    const ids = leftovers.map((r) => r.id);
    if (ids.length) {
      await prisma.inboxItem.deleteMany({ where: { inboxAccountId: { in: ids } } });
      await prisma.gmailCredential.deleteMany({ where: { inboxAccountId: { in: ids } } });
      await prisma.inboxAccount.deleteMany({ where: { id: { in: ids } } });
    }
    resetGmailApiAdapter();
    clearOAuthStates();
  });

  /**
   * @param {Partial<ReturnType<typeof createDefaultAdapter>>} overrides
   */
  function installMockAdapter(overrides = {}) {
    /** @type {Record<string, unknown>} */
    const store = {
      messages: {},
      listIds: [],
      historyIds: [],
      historyId: 'hist-100',
      refreshShouldFail: false,
      refreshInvalidGrant: false,
      listShouldFail: false,
      getShouldFailAfter: null,
      getFailCount: 0,
    };

    const adapter = {
      async exchangeCode(_client, _code) {
        return {
          access_token: 'access-token-value',
          refresh_token: 'refresh-token-value-aaa',
          expiry_date: Date.now() + 3600_000,
          scope: GMAIL_OAUTH_SCOPES.join(' '),
        };
      },
      async getProfile(_client) {
        return {
          id: 'google-user-1',
          email: 'alpha@gmail-test.example',
          name: 'Alpha Tester',
        };
      },
      async refreshAccessToken(_client) {
        if (store.refreshInvalidGrant) {
          const err = new Error('invalid_grant');
          err.response = { data: { error: 'invalid_grant' } };
          throw err;
        }
        if (store.refreshShouldFail) {
          throw new Error('refresh failed');
        }
        return {
          access_token: 'access-token-value-refreshed',
          expiry_date: Date.now() + 3600_000,
          refresh_token: 'refresh-token-value-aaa',
        };
      },
      async listMessages(_client, _opts) {
        if (store.listShouldFail) throw new Error('list failed');
        return {
          messages: store.listIds.map((id) => ({ id, threadId: `thread-${id}` })),
          nextPageToken: null,
        };
      },
      async getMessage(_client, messageId) {
        store.getFailCount += 1;
        if (store.getShouldFailAfter !== null && store.getFailCount > store.getShouldFailAfter) {
          throw new Error('get message failed');
        }
        const msg = store.messages[messageId];
        if (!msg) throw new Error('missing message');
        return msg;
      },
      async getProfileHistoryId(_client) {
        return {
          emailAddress: 'alpha@gmail-test.example',
          historyId: store.historyId,
          messagesTotal: Object.keys(store.messages).length,
        };
      },
      async listHistory(_client, _startHistoryId) {
        return {
          messageIds: store.historyIds,
          historyId: store.historyId,
        };
      },
      ...overrides,
      __store: store,
    };

    // Keep store reference on adapter after spread overrides.
    adapter.__store = store;
    setGmailApiAdapter(adapter);
    return adapter;
  }

  it('requires admin auth on connect/accounts/sync and keeps callback public', async () => {
    await request(app).get('/gmail/connect').expect(401);
    await request(app).get('/gmail/accounts').expect(401);
    await request(app).post('/gmail/sync-all').expect(401);
    await request(app).post('/gmail/accounts/x/sync').expect(401);
    await request(app).post('/gmail/accounts/x/disconnect').expect(401);

    // Callback without state/code → 400, not 401
    const cb = await request(app).get('/gmail/callback').expect(400);
    assert.match(String(cb.text || cb.body.error || ''), /authorization failed|Invalid/i);
  });

  it('returns 503 when Gmail is not configured', async () => {
    const envNoKey = loadEnv({
      ANTHROPIC_API_KEY: 'test-anthropic-key',
      GOOGLE_CLIENT_ID: 'test-google-client-id',
      GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
      GOOGLE_REDIRECT_URI: 'https://example.com/gmail/callback',
      ADMIN_API_KEY: 'test-admin-api-key',
    });
    const appNoGmail = createApp(envNoKey);
    const res = await auth(request(appNoGmail).get('/gmail/connect?format=json')).expect(503);
    assert.equal(res.body.error, 'Gmail connector is not configured');
    assertNoSecrets(res.body);
  });

  it('GET /gmail/connect returns authorization URL without Bearer in it', async () => {
    const res = await auth(request(app).get('/gmail/connect').set('Accept', 'application/json')).expect(
      200
    );
    assert.ok(res.body.authorizationUrl);
    assert.equal(res.body.authorizationUrl.includes(VALID_ENV.ADMIN_API_KEY), false);
    assert.equal(res.body.authorizationUrl.includes('Bearer'), false);
    assert.match(res.body.authorizationUrl, /accounts\.google\.com/);
    assertNoSecrets(res.body);
  });

  it('verifies OAuth state on callback and creates encrypted credentials', async () => {
    const adapter = installMockAdapter();
    const state = createOAuthState(VALID_ENV.ADMIN_API_KEY);

    const res = await request(app)
      .get('/gmail/callback')
      .query({ code: 'auth-code-xyz', state, format: 'json' })
      .expect(200);

    assert.equal(res.body.status, 'ok');
    assert.equal(res.body.account.emailAddress, 'alpha@gmail-test.example');
    assertNoSecrets(res.body);
    assert.equal(JSON.stringify(res.body).includes('auth-code-xyz'), false);
    assert.equal(JSON.stringify(res.body).includes('refresh-token'), false);

    const prisma = getPrisma();
    const account = await prisma.inboxAccount.findFirst({
      where: { emailAddress: 'alpha@gmail-test.example' },
      include: { gmailCredential: true },
    });
    assert.ok(account);
    fixtureAccountIds.push(account.id);
    assert.equal(account.source, 'GMAIL');
    assert.equal(account.isActive, true);
    assert.equal(account.externalAccountId, 'google-user-1');
    assert.ok(account.gmailCredential);
    assert.ok(account.gmailCredential.encryptedRefreshToken);
    assert.notEqual(account.gmailCredential.encryptedRefreshToken, 'refresh-token-value-aaa');
    const decrypted = decryptToken(
      account.gmailCredential.encryptedRefreshToken,
      VALID_ENV.TOKEN_ENCRYPTION_KEY
    );
    assert.equal(decrypted, 'refresh-token-value-aaa');

    // Reuse state → fail
    await request(app)
      .get('/gmail/callback')
      .query({ code: 'auth-code-xyz', state, format: 'json' })
      .expect(400);

    // Invalid state
    await request(app)
      .get('/gmail/callback')
      .query({ code: 'auth-code-xyz', state: 'bad.state.value', format: 'json' })
      .expect(400);

    void adapter;
  });

  it('updates the same Google identity instead of duplicating accounts', async () => {
    installMockAdapter();
    const state1 = createOAuthState(VALID_ENV.ADMIN_API_KEY);
    await request(app)
      .get('/gmail/callback')
      .query({ code: 'c1', state: state1, format: 'json' })
      .expect(200);

    const state2 = createOAuthState(VALID_ENV.ADMIN_API_KEY);
    setGmailApiAdapter({
      ...installMockAdapter(),
      async exchangeCode() {
        return {
          access_token: 'access-token-value',
          refresh_token: 'refresh-token-value-bbb',
          expiry_date: Date.now() + 3600_000,
          scope: GMAIL_OAUTH_SCOPES.join(' '),
        };
      },
      async getProfile() {
        return {
          id: 'google-user-1',
          email: 'alpha-renamed@gmail-test.example',
          name: 'Alpha Renamed',
        };
      },
    });

    await request(app)
      .get('/gmail/callback')
      .query({ code: 'c2', state: state2, format: 'json' })
      .expect(200);

    const prisma = getPrisma();
    const rows = await prisma.inboxAccount.findMany({
      where: { externalAccountId: 'google-user-1', source: 'GMAIL' },
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].emailAddress, 'alpha-renamed@gmail-test.example');
    fixtureAccountIds.push(rows[0].id);
  });

  it('supports multiple distinct Gmail accounts', async () => {
    installMockAdapter({
      async getProfile() {
        return { id: 'google-user-a', email: 'a@gmail-test.example', name: 'A' };
      },
    });
    const s1 = createOAuthState(VALID_ENV.ADMIN_API_KEY);
    await request(app).get('/gmail/callback').query({ code: 'c', state: s1, format: 'json' }).expect(200);

    installMockAdapter({
      async getProfile() {
        return { id: 'google-user-b', email: 'b@gmail-test.example', name: 'B' };
      },
      async exchangeCode() {
        return {
          access_token: 'access-token-value',
          refresh_token: 'refresh-token-value-bbb',
          expiry_date: Date.now() + 3600_000,
          scope: GMAIL_OAUTH_SCOPES.join(' '),
        };
      },
    });
    const s2 = createOAuthState(VALID_ENV.ADMIN_API_KEY);
    await request(app).get('/gmail/callback').query({ code: 'c', state: s2, format: 'json' }).expect(200);

    const listed = await auth(request(app).get('/gmail/accounts')).expect(200);
    assert.ok(listed.body.data.length >= 2);
    const emails = listed.body.data.map((a) => a.emailAddress);
    assert.ok(emails.includes('a@gmail-test.example'));
    assert.ok(emails.includes('b@gmail-test.example'));
    assertNoSecrets(listed.body);

    for (const row of listed.body.data) {
      assert.ok(row.id);
      assert.equal(typeof row.isActive, 'boolean');
      assert.ok('lastSyncedAt' in row);
      assert.ok('syncStatus' in row);
      assert.ok('lastSyncError' in row);
      assert.equal('encryptedRefreshToken' in row, false);
      fixtureAccountIds.push(row.id);
    }
  });

  it('syncs messages idempotently and isolates accounts by externalId', async () => {
    const prisma = getPrisma();

    // Create two accounts with credentials directly.
    const enc = (v) => encryptToken(v, VALID_ENV.TOKEN_ENCRYPTION_KEY);
    const accountA = await prisma.inboxAccount.create({
      data: {
        name: 'A',
        source: 'GMAIL',
        emailAddress: 'sync-a@gmail-test.example',
        externalAccountId: 'sync-google-a',
        isActive: true,
        syncStatus: SYNC_STATUS.IDLE,
        gmailCredential: {
          create: {
            encryptedAccessToken: enc('access-token-value'),
            encryptedRefreshToken: enc('refresh-token-value-aaa'),
            tokenExpiry: new Date(Date.now() + 3600_000),
            scopes: GMAIL_OAUTH_SCOPES.join(' '),
          },
        },
      },
    });
    const accountB = await prisma.inboxAccount.create({
      data: {
        name: 'B',
        source: 'GMAIL',
        emailAddress: 'sync-b@gmail-test.example',
        externalAccountId: 'sync-google-b',
        isActive: true,
        syncStatus: SYNC_STATUS.IDLE,
        gmailCredential: {
          create: {
            encryptedAccessToken: enc('access-token-value'),
            encryptedRefreshToken: enc('refresh-token-value-bbb'),
            tokenExpiry: new Date(Date.now() + 3600_000),
            scopes: GMAIL_OAUTH_SCOPES.join(' '),
          },
        },
      },
    });
    fixtureAccountIds.push(accountA.id, accountB.id);

    const sharedExternalId = 'shared-msg-id';
    const adapter = installMockAdapter();
    adapter.__store.listIds = [sharedExternalId, 'msg-spam'];
    adapter.__store.messages[sharedExternalId] = buildGmailMessage({
      id: sharedExternalId,
      subject: 'Shared',
      plain: 'Body A',
      labelIds: ['INBOX'],
    });
    adapter.__store.messages['msg-spam'] = buildGmailMessage({
      id: 'msg-spam',
      subject: 'Spam',
      plain: 'Nope',
      labelIds: ['SPAM'],
    });
    adapter.__store.historyId = 'hist-200';

    const syncA = await auth(request(app).post(`/gmail/accounts/${accountA.id}/sync`)).expect(200);
    assert.equal(syncA.body.created, 1);
    assert.equal(syncA.body.excluded, 1);
    assert.equal(syncA.body.account.syncStatus, SYNC_STATUS.OK);
    assert.equal(syncA.body.account.lastSyncError, null);
    assertNoSecrets(syncA.body);

    // Same external id on account B is allowed (account isolation).
    const syncB = await auth(request(app).post(`/gmail/accounts/${accountB.id}/sync`)).expect(200);
    assert.equal(syncB.body.created, 1);

    const itemsA = await prisma.inboxItem.findMany({ where: { inboxAccountId: accountA.id } });
    const itemsB = await prisma.inboxItem.findMany({ where: { inboxAccountId: accountB.id } });
    assert.equal(itemsA.length, 1);
    assert.equal(itemsB.length, 1);
    assert.equal(itemsA[0].externalId, sharedExternalId);
    assert.equal(itemsB[0].externalId, sharedExternalId);
    assert.equal(itemsA[0].status, 'NEW');
    assert.equal(itemsA[0].source, 'GMAIL');
    assert.ok(!itemsA.some((i) => i.externalId === 'msg-spam'));

    // Duplicate ingestion is idempotent (skipped).
    adapter.__store.listIds = [sharedExternalId];
    // Clear cursor to force list path again
    await prisma.inboxAccount.update({
      where: { id: accountA.id },
      data: { syncCursor: null },
    });
    const syncDup = await auth(request(app).post(`/gmail/accounts/${accountA.id}/sync`)).expect(200);
    assert.equal(syncDup.body.created, 0);
    assert.equal(syncDup.body.skipped, 1);
    const countA = await prisma.inboxItem.count({ where: { inboxAccountId: accountA.id } });
    assert.equal(countA, 1);
  });

  it('does not advance cursor on partial sync failure', async () => {
    const prisma = getPrisma();
    const enc = (v) => encryptToken(v, VALID_ENV.TOKEN_ENCRYPTION_KEY);
    const account = await prisma.inboxAccount.create({
      data: {
        name: 'Partial',
        source: 'GMAIL',
        emailAddress: 'partial@gmail-test.example',
        externalAccountId: 'partial-google',
        isActive: true,
        syncCursor: null,
        gmailCredential: {
          create: {
            encryptedAccessToken: enc('access-token-value'),
            encryptedRefreshToken: enc('refresh-token-value-aaa'),
            tokenExpiry: new Date(Date.now() + 3600_000),
            scopes: GMAIL_OAUTH_SCOPES.join(' '),
          },
        },
      },
    });
    fixtureAccountIds.push(account.id);

    const adapter = installMockAdapter();
    adapter.__store.listIds = ['ok-1', 'fail-2'];
    adapter.__store.messages['ok-1'] = buildGmailMessage({ id: 'ok-1', plain: 'ok' });
    adapter.__store.messages['fail-2'] = buildGmailMessage({ id: 'fail-2', plain: 'fail' });
    adapter.__store.getShouldFailAfter = 1; // first get ok, second fails
    adapter.__store.historyId = 'hist-should-not-save';

    const res = await auth(request(app).post(`/gmail/accounts/${account.id}/sync`)).expect(503);
    assert.equal(res.body.cursorUnchanged, true);
    assertNoSecrets(res.body);

    const reloaded = await prisma.inboxAccount.findUnique({ where: { id: account.id } });
    assert.equal(reloaded.syncCursor, null);
    assert.equal(reloaded.syncStatus, SYNC_STATUS.ERROR);
    assert.ok(reloaded.lastSyncError);
    assert.equal(reloaded.lastSyncError.includes('stack'), false);
  });

  it('advances cursor only after successful sync', async () => {
    const prisma = getPrisma();
    const enc = (v) => encryptToken(v, VALID_ENV.TOKEN_ENCRYPTION_KEY);
    const account = await prisma.inboxAccount.create({
      data: {
        name: 'OkSync',
        source: 'GMAIL',
        emailAddress: 'oksync@gmail-test.example',
        externalAccountId: 'oksync-google',
        isActive: true,
        gmailCredential: {
          create: {
            encryptedAccessToken: enc('access-token-value'),
            encryptedRefreshToken: enc('refresh-token-value-aaa'),
            tokenExpiry: new Date(Date.now() + 3600_000),
            scopes: GMAIL_OAUTH_SCOPES.join(' '),
          },
        },
      },
    });
    fixtureAccountIds.push(account.id);

    const adapter = installMockAdapter();
    adapter.__store.listIds = ['m1'];
    adapter.__store.messages.m1 = buildGmailMessage({ id: 'm1', plain: 'hello' });
    adapter.__store.historyId = 'hist-ok-1';

    await auth(request(app).post(`/gmail/accounts/${account.id}/sync`)).expect(200);
    let reloaded = await prisma.inboxAccount.findUnique({ where: { id: account.id } });
    assert.equal(reloaded.syncCursor, 'hist-ok-1');
    assert.ok(reloaded.lastSyncedAt);

    // Incremental sync uses history
    adapter.__store.historyIds = ['m2'];
    adapter.__store.messages.m2 = buildGmailMessage({ id: 'm2', plain: 'newer' });
    adapter.__store.historyId = 'hist-ok-2';
    await auth(request(app).post(`/gmail/accounts/${account.id}/sync`)).expect(200);
    reloaded = await prisma.inboxAccount.findUnique({ where: { id: account.id } });
    assert.equal(reloaded.syncCursor, 'hist-ok-2');
    const count = await prisma.inboxItem.count({ where: { inboxAccountId: account.id } });
    assert.equal(count, 2);
  });

  it('refreshes expired access tokens automatically', async () => {
    const prisma = getPrisma();
    const enc = (v) => encryptToken(v, VALID_ENV.TOKEN_ENCRYPTION_KEY);
    const account = await prisma.inboxAccount.create({
      data: {
        name: 'Refresh',
        source: 'GMAIL',
        emailAddress: 'refresh@gmail-test.example',
        externalAccountId: 'refresh-google',
        isActive: true,
        gmailCredential: {
          create: {
            encryptedAccessToken: enc('access-token-value'),
            encryptedRefreshToken: enc('refresh-token-value-aaa'),
            tokenExpiry: new Date(Date.now() - 60_000), // expired
            scopes: GMAIL_OAUTH_SCOPES.join(' '),
          },
        },
      },
    });
    fixtureAccountIds.push(account.id);

    let refreshed = false;
    const adapter = installMockAdapter({
      async refreshAccessToken() {
        refreshed = true;
        return {
          access_token: 'access-token-value-refreshed',
          expiry_date: Date.now() + 3600_000,
          refresh_token: 'refresh-token-value-aaa',
        };
      },
    });
    adapter.__store.listIds = [];
    adapter.__store.historyId = 'hist-refresh';

    await auth(request(app).post(`/gmail/accounts/${account.id}/sync`)).expect(200);
    assert.equal(refreshed, true);

    const cred = await prisma.gmailCredential.findUnique({ where: { inboxAccountId: account.id } });
    const access = decryptToken(cred.encryptedAccessToken, VALID_ENV.TOKEN_ENCRYPTION_KEY);
    assert.equal(access, 'access-token-value-refreshed');
  });

  it('marks reconnect-required when refresh authorization is revoked', async () => {
    const prisma = getPrisma();
    const enc = (v) => encryptToken(v, VALID_ENV.TOKEN_ENCRYPTION_KEY);
    const account = await prisma.inboxAccount.create({
      data: {
        name: 'Revoked',
        source: 'GMAIL',
        emailAddress: 'revoked@gmail-test.example',
        externalAccountId: 'revoked-google',
        isActive: true,
        gmailCredential: {
          create: {
            encryptedAccessToken: enc('access-token-value'),
            encryptedRefreshToken: enc('refresh-token-value-aaa'),
            tokenExpiry: new Date(Date.now() - 60_000),
            scopes: GMAIL_OAUTH_SCOPES.join(' '),
          },
        },
      },
    });
    // Pre-existing inbox item must survive.
    await prisma.inboxItem.create({
      data: {
        inboxAccountId: account.id,
        source: 'GMAIL',
        externalId: 'keep-me',
        senderIdentifier: 'x@y.com',
        rawContent: 'keep',
        status: 'NEW',
        receivedAt: new Date(),
      },
    });
    fixtureAccountIds.push(account.id);

    const adapter = installMockAdapter();
    adapter.__store.refreshInvalidGrant = true;

    const res = await auth(request(app).post(`/gmail/accounts/${account.id}/sync`)).expect(409);
    assert.equal(res.body.code, 'RECONNECT_REQUIRED');
    assertNoSecrets(res.body);

    const reloaded = await prisma.inboxAccount.findUnique({ where: { id: account.id } });
    assert.equal(reloaded.syncStatus, SYNC_STATUS.RECONNECT_REQUIRED);
    const items = await prisma.inboxItem.count({ where: { inboxAccountId: account.id } });
    assert.equal(items, 1);
  });

  it('disconnect removes credentials but keeps inbox items', async () => {
    const prisma = getPrisma();
    const enc = (v) => encryptToken(v, VALID_ENV.TOKEN_ENCRYPTION_KEY);
    const account = await prisma.inboxAccount.create({
      data: {
        name: 'Disc',
        source: 'GMAIL',
        emailAddress: 'disc@gmail-test.example',
        externalAccountId: 'disc-google',
        isActive: true,
        gmailCredential: {
          create: {
            encryptedRefreshToken: enc('refresh-token-value-aaa'),
            scopes: GMAIL_OAUTH_SCOPES.join(' '),
          },
        },
      },
    });
    await prisma.inboxItem.create({
      data: {
        inboxAccountId: account.id,
        source: 'GMAIL',
        externalId: 'stay',
        senderIdentifier: 'x@y.com',
        rawContent: 'stay',
        status: 'NEW',
        receivedAt: new Date(),
      },
    });
    fixtureAccountIds.push(account.id);

    const res = await auth(request(app).post(`/gmail/accounts/${account.id}/disconnect`)).expect(200);
    assert.equal(res.body.account.isActive, false);
    assertNoSecrets(res.body);

    const cred = await prisma.gmailCredential.findUnique({ where: { inboxAccountId: account.id } });
    assert.equal(cred, null);
    const items = await prisma.inboxItem.count({ where: { inboxAccountId: account.id } });
    assert.equal(items, 1);
  });

  it('sync-all returns per-account safe summaries', async () => {
    const prisma = getPrisma();
    const enc = (v) => encryptToken(v, VALID_ENV.TOKEN_ENCRYPTION_KEY);
    const account = await prisma.inboxAccount.create({
      data: {
        name: 'All',
        source: 'GMAIL',
        emailAddress: 'all@gmail-test.example',
        externalAccountId: 'all-google',
        isActive: true,
        gmailCredential: {
          create: {
            encryptedAccessToken: enc('access-token-value'),
            encryptedRefreshToken: enc('refresh-token-value-aaa'),
            tokenExpiry: new Date(Date.now() + 3600_000),
            scopes: GMAIL_OAUTH_SCOPES.join(' '),
          },
        },
      },
    });
    fixtureAccountIds.push(account.id);

    const adapter = installMockAdapter();
    adapter.__store.listIds = [];
    adapter.__store.historyId = 'hist-all';

    const res = await auth(request(app).post('/gmail/sync-all')).expect(200);
    assert.ok(Array.isArray(res.body.results));
    assert.ok(res.body.results.some((r) => r.accountId === account.id && r.status === 'ok'));
    assertNoSecrets(res.body);
  });

  it('Express route ordering: /gmail/sync-all is not captured as an account id', async () => {
    const res = await auth(request(app).post('/gmail/sync-all')).expect(200);
    assert.ok(res.body.results);
  });

  it('returns safe 404 for unknown account sync/disconnect', async () => {
    const missing = 'ckmissing00000000000000001';
    await auth(request(app).post(`/gmail/accounts/${missing}/sync`)).expect(404);
    await auth(request(app).post(`/gmail/accounts/${missing}/disconnect`)).expect(404);
  });

  it('excludes trash labels during sync', async () => {
    const prisma = getPrisma();
    const enc = (v) => encryptToken(v, VALID_ENV.TOKEN_ENCRYPTION_KEY);
    const account = await prisma.inboxAccount.create({
      data: {
        name: 'Trash',
        source: 'GMAIL',
        emailAddress: 'trash@gmail-test.example',
        externalAccountId: 'trash-google',
        isActive: true,
        gmailCredential: {
          create: {
            encryptedAccessToken: enc('access-token-value'),
            encryptedRefreshToken: enc('refresh-token-value-aaa'),
            tokenExpiry: new Date(Date.now() + 3600_000),
            scopes: GMAIL_OAUTH_SCOPES.join(' '),
          },
        },
      },
    });
    fixtureAccountIds.push(account.id);

    const adapter = installMockAdapter();
    adapter.__store.listIds = ['trash-1'];
    adapter.__store.messages['trash-1'] = buildGmailMessage({
      id: 'trash-1',
      labelIds: ['TRASH'],
      plain: 'trashed',
    });
    adapter.__store.historyId = 'hist-trash';

    const res = await auth(request(app).post(`/gmail/accounts/${account.id}/sync`)).expect(200);
    assert.equal(res.body.created, 0);
    assert.equal(res.body.excluded, 1);
    const count = await prisma.inboxItem.count({ where: { inboxAccountId: account.id } });
    assert.equal(count, 0);
  });

  it('service helpers cover callback edge cases without logging secrets', async () => {
    const logs = [];
    const originalError = console.error;
    console.error = (...args) => {
      logs.push(args.map(String).join(' '));
    };
    try {
      clearOAuthStates();
      const bad = await handleOAuthCallback({ code: 'x' }, VALID_ENV);
      assert.equal(bad.status, 400);

      installMockAdapter({
        async exchangeCode() {
          throw new Error('boom access-token-value');
        },
      });
      const state = createOAuthState(VALID_ENV.ADMIN_API_KEY);
      const failed = await handleOAuthCallback({ code: 'x', state }, VALID_ENV);
      assert.equal(failed.error, 'exchange_failed');

      for (const line of logs) {
        assertNoSecrets(line);
      }
    } finally {
      console.error = originalError;
    }
  });

  it('listGmailAccounts and disconnect via service layer', async () => {
    const listed = await listGmailAccounts();
    assert.ok(Array.isArray(listed.data));
    const missing = await disconnectGmailAccount('ckmissing00000000000000002');
    assert.equal(missing.notFound, true);
  });

  it('inactive account sync returns conflict', async () => {
    const prisma = getPrisma();
    const enc = (v) => encryptToken(v, VALID_ENV.TOKEN_ENCRYPTION_KEY);
    const account = await prisma.inboxAccount.create({
      data: {
        name: 'Inactive',
        source: 'GMAIL',
        emailAddress: 'inactive@gmail-test.example',
        externalAccountId: 'inactive-google',
        isActive: false,
        gmailCredential: {
          create: {
            encryptedRefreshToken: enc('refresh-token-value-aaa'),
            scopes: GMAIL_OAUTH_SCOPES.join(' '),
          },
        },
      },
    });
    fixtureAccountIds.push(account.id);
    const res = await auth(request(app).post(`/gmail/accounts/${account.id}/sync`)).expect(409);
    assert.match(res.body.error, /inactive/i);
  });

  it('analyze endpoint still works on synced Gmail items', async () => {
    const prisma = getPrisma();
    const enc = (v) => encryptToken(v, VALID_ENV.TOKEN_ENCRYPTION_KEY);
    const account = await prisma.inboxAccount.create({
      data: {
        name: 'Analyze',
        source: 'GMAIL',
        emailAddress: 'analyze@gmail-test.example',
        externalAccountId: 'analyze-google',
        isActive: true,
        gmailCredential: {
          create: {
            encryptedAccessToken: enc('access-token-value'),
            encryptedRefreshToken: enc('refresh-token-value-aaa'),
            tokenExpiry: new Date(Date.now() + 3600_000),
            scopes: GMAIL_OAUTH_SCOPES.join(' '),
          },
        },
      },
    });
    fixtureAccountIds.push(account.id);

    const adapter = installMockAdapter();
    adapter.__store.listIds = ['an-1'];
    adapter.__store.messages['an-1'] = buildGmailMessage({
      id: 'an-1',
      subject: 'Please pay invoice 100',
      plain: 'Invoice due soon amount 100 USD',
    });
    adapter.__store.historyId = 'hist-an';

    await auth(request(app).post(`/gmail/accounts/${account.id}/sync`)).expect(200);
    const item = await prisma.inboxItem.findFirst({ where: { inboxAccountId: account.id } });
    assert.ok(item);
    assert.equal(item.status, 'NEW');

    const analyzed = await auth(request(app).post(`/inbox/${item.id}/analyze`)).expect(200);
    assert.ok(analyzed.body.item || analyzed.body.status || analyzed.body.id);
    // Ensure no Task/Payment auto-created
    const tasks = await prisma.task.count({ where: { inboxItemId: item.id } });
    const payments = await prisma.payment.count({ where: { inboxItemId: item.id } });
    assert.equal(tasks, 0);
    assert.equal(payments, 0);
  });
});
