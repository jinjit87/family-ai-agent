const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const request = require('supertest');

const ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex'); // NOT all same char

const VALID_ENV = {
  ANTHROPIC_API_KEY: 'test-anthropic-key',
  GOOGLE_CLIENT_ID: 'test-google-client-id',
  GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
  GOOGLE_CALENDAR_REDIRECT_URI: 'https://example.com/auth/callback',
  GOOGLE_GMAIL_REDIRECT_URI: 'https://example.com/gmail/callback',
  ADMIN_API_KEY: 'test-admin-api-key',
  TOKEN_ENCRYPTION_KEY: ENCRYPTION_KEY,
  DATABASE_URL:
    process.env.DATABASE_URL ||
    'postgresql://family_ai:family_ai_dev@localhost:5432/family_ai_agent?schema=public',
};

// Set DATABASE_URL before creating the app / Prisma clients.
process.env.DATABASE_URL = VALID_ENV.DATABASE_URL;

const { createApp, loadEnv, createOAuthClient, CALENDAR_READONLY_SCOPE } = require('../index');
const { getPrisma, disconnectPrisma } = require('../lib/db');
const {
  encryptToken,
  decryptToken,
  validateEncryptionKey,
  parseEncryptionKey,
} = require('../lib/tokenEncryption');
const {
  createOAuthState,
  verifyOAuthState,
  clearOAuthStates,
  hasPendingOAuthState,
  handleOAuthCallback,
  syncGmailAccount,
  disconnectGmailAccount,
  listGmailAccounts,
  buildConnectUrl,
  extractRedirectUriFromAuthUrl,
  extractScopesFromAuthUrl,
  htmlToText,
  parseAddress,
  mapGmailMessageToIngest,
  isSpamOrTrash,
  extractMessageBody,
  capBodySize,
  MAX_BODY_CHARS,
  OAUTH_STATE_TTL_MS,
  SYNC_STATUS,
  acquireSyncLock,
  releaseSyncLock,
} = require('../lib/gmail');
const {
  setGmailApiAdapter,
  resetGmailApiAdapter,
  GMAIL_OAUTH_SCOPES,
  FORBIDDEN_GMAIL_SCOPES,
} = require('../lib/gmailClient');

const SECRET_MARKERS = [
  'access-token-value',
  'refresh-token-value',
  ENCRYPTION_KEY,
  VALID_ENV.DATABASE_URL,
  'Authorization',
  'SecretSubjectXYZ',
  VALID_ENV.GOOGLE_CLIENT_SECRET,
  VALID_ENV.ADMIN_API_KEY,
  'ya29.',
  '1//0',
];

function auth(req) {
  return req.set('Authorization', `Bearer ${VALID_ENV.ADMIN_API_KEY}`);
}

function assertNoSecrets(payload) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  for (const marker of SECRET_MARKERS) {
    assert.equal(
      text.includes(marker),
      false,
      `secret-like value leaked: ${String(marker).slice(0, 12)}…`
    );
  }
  assert.equal(text.includes('encryptedAccessToken'), false);
  assert.equal(text.includes('encryptedRefreshToken'), false);
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

/**
 * Craft a signed OAuth state with an arbitrary flow label (for negative tests).
 * @param {string} flow
 * @param {string} hmacSecret
 */
function craftOAuthState(flow, hmacSecret) {
  const nonce = crypto.randomBytes(32).toString('base64url');
  const exp = Date.now() + OAUTH_STATE_TTL_MS;
  const payload = `${flow}.${nonce}.${exp}`;
  const sig = crypto.createHmac('sha256', hmacSecret).update(payload).digest('base64url');
  return `${flow}.${nonce}.${exp}.${sig}`;
}

describe('token encryption', () => {
  it('encrypts and decrypts round-trip with hex key', () => {
    const key = crypto.randomBytes(32).toString('hex');
    const cipher = encryptToken('super-secret-refresh', key);
    assert.notEqual(cipher, 'super-secret-refresh');
    assert.equal(decryptToken(cipher, key), 'super-secret-refresh');
  });

  it('accepts 64-char hex and base64 of 32 bytes', () => {
    assert.equal(parseEncryptionKey(crypto.randomBytes(32).toString('hex')).length, 32);
    assert.equal(parseEncryptionKey(crypto.randomBytes(32).toString('base64')).length, 32);
    assert.equal(validateEncryptionKey(crypto.randomBytes(32).toString('hex')).length, 32);
  });

  it('rejects empty, short, whitespace-padded, placeholders, and malformed keys without leaking values', () => {
    const goodHex = crypto.randomBytes(32).toString('hex');
    const cases = [
      '',
      'short',
      `  ${goodHex}  `,
      '   ',
      'changeme',
      '0'.repeat(64),
      'not-a-key',
    ];
    for (const bad of cases) {
      assert.throws(
        () => validateEncryptionKey(bad),
        (err) => {
          assert.match(err.message, /TOKEN_ENCRYPTION_KEY/);
          // Never include the key value in the error message.
          if (bad.trim().length > 0) {
            assert.equal(err.message.includes(bad), false);
          }
          return true;
        }
      );
    }
  });
});

describe('gmail helpers', () => {
  it('parses addresses', () => {
    assert.deepEqual(parseAddress('Bob <bob@x.com>'), { name: 'Bob', email: 'bob@x.com' });
    assert.deepEqual(parseAddress('solo@example.com'), { name: null, email: 'solo@example.com' });
  });

  it('htmlToText strips script/style/img and remote URLs', () => {
    const dirty =
      '<script>alert(1)</script><style>.x{color:red}</style>' +
      '<p>Hi&nbsp;<b>there</b></p>' +
      '<img src="https://tracker.example/pixel.gif" />' +
      '<a href="https://evil.example/phish">link</a>';
    const text = htmlToText(dirty);
    assert.equal(text.includes('alert'), false);
    assert.equal(text.includes('color:red'), false);
    assert.equal(text.includes('tracker.example'), false);
    assert.equal(text.includes('evil.example'), false);
    assert.equal(text.includes('<img'), false);
    assert.equal(text.includes('Hi'), true);
    assert.equal(text.includes('there'), true);
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

  it('capBodySize truncates over MAX_BODY_CHARS with [truncated]', () => {
    assert.equal(typeof MAX_BODY_CHARS, 'number');
    assert.ok(MAX_BODY_CHARS > 0);
    const huge = 'x'.repeat(MAX_BODY_CHARS + 50);
    const capped = capBodySize(huge);
    assert.ok(capped.length < huge.length);
    assert.ok(capped.endsWith('[truncated]'));
    assert.equal(capped.slice(0, MAX_BODY_CHARS), 'x'.repeat(MAX_BODY_CHARS));
    assert.equal(capBodySize('short'), 'short');
  });
});

describe('oauth state', () => {
  beforeEach(async () => {
    await clearOAuthStates();
  });

  afterEach(async () => {
    await clearOAuthStates();
  });

  it('createOAuthState / verifyOAuthState are async and include flow gmail (4 parts)', async () => {
    const state = await createOAuthState(VALID_ENV.ADMIN_API_KEY);
    assert.equal(typeof state.then, 'undefined'); // resolved value is string
    const parts = state.split('.');
    assert.equal(parts.length, 4);
    assert.equal(parts[0], 'gmail');
    assert.equal(await hasPendingOAuthState(state), true);
    assert.equal(await verifyOAuthState(state, VALID_ENV.ADMIN_API_KEY), true);
  });

  it('produces cryptographically random states', async () => {
    const a = await createOAuthState(VALID_ENV.ADMIN_API_KEY);
    const b = await createOAuthState(VALID_ENV.ADMIN_API_KEY);
    assert.notEqual(a, b);
  });

  it('documents OAUTH_STATE_TTL_MS as 10 minutes (no flaky expiry timing test)', () => {
    assert.equal(OAUTH_STATE_TTL_MS, 10 * 60 * 1000);
  });

  it('is one-time use: second verify fails', async () => {
    const state = await createOAuthState(VALID_ENV.ADMIN_API_KEY);
    assert.equal(await verifyOAuthState(state, VALID_ENV.ADMIN_API_KEY), true);
    assert.equal(await verifyOAuthState(state, VALID_ENV.ADMIN_API_KEY), false);
    assert.equal(await hasPendingOAuthState(state), false);
  });

  it('rejects tampered signatures', async () => {
    const state = await createOAuthState(VALID_ENV.ADMIN_API_KEY);
    const tampered = state.replace(/\.[^.]+$/, '.badsignature');
    assert.equal(await verifyOAuthState(tampered, VALID_ENV.ADMIN_API_KEY), false);
  });

  it('rejects calendar-bound state (flow must be gmail)', async () => {
    const calendarState = craftOAuthState('calendar', VALID_ENV.ADMIN_API_KEY);
    assert.equal(calendarState.split('.')[0], 'calendar');
    assert.equal(await verifyOAuthState(calendarState, VALID_ENV.ADMIN_API_KEY), false);
  });

  it('rejects missing/null state', async () => {
    assert.equal(await verifyOAuthState(null, VALID_ENV.ADMIN_API_KEY), false);
    assert.equal(await verifyOAuthState(undefined, VALID_ENV.ADMIN_API_KEY), false);
    assert.equal(await verifyOAuthState('', VALID_ENV.ADMIN_API_KEY), false);
    assert.equal(await verifyOAuthState('not.a.state', VALID_ENV.ADMIN_API_KEY), false);
  });
});

describe('env fail-closed', () => {
  it('partial Gmail (TOKEN_ENCRYPTION_KEY without GOOGLE_GMAIL_REDIRECT_URI) throws', () => {
    assert.throws(
      () =>
        loadEnv({
          ANTHROPIC_API_KEY: VALID_ENV.ANTHROPIC_API_KEY,
          GOOGLE_CLIENT_ID: VALID_ENV.GOOGLE_CLIENT_ID,
          GOOGLE_CLIENT_SECRET: VALID_ENV.GOOGLE_CLIENT_SECRET,
          GOOGLE_CALENDAR_REDIRECT_URI: VALID_ENV.GOOGLE_CALENDAR_REDIRECT_URI,
          ADMIN_API_KEY: VALID_ENV.ADMIN_API_KEY,
          TOKEN_ENCRYPTION_KEY: ENCRYPTION_KEY,
          // intentionally omit GOOGLE_GMAIL_REDIRECT_URI and DATABASE_URL
        }),
      (err) => {
        assert.match(err.message, /GOOGLE_GMAIL_REDIRECT_URI/);
        // DATABASE_URL may also be listed when Gmail is signaled.
        return true;
      }
    );
  });

  it('invalid TOKEN_ENCRYPTION_KEY when Gmail signaled — names key, never value', () => {
    const badKey = 'short-bad-key-value';
    assert.throws(
      () =>
        loadEnv({
          ...VALID_ENV,
          TOKEN_ENCRYPTION_KEY: badKey,
        }),
      (err) => {
        assert.match(err.message, /TOKEN_ENCRYPTION_KEY/);
        assert.equal(err.message.includes(badKey), false);
        return true;
      }
    );
  });

  it('accepts valid full Gmail env', () => {
    const env = loadEnv(VALID_ENV);
    assert.equal(env.TOKEN_ENCRYPTION_KEY, ENCRYPTION_KEY);
    assert.equal(env.GOOGLE_GMAIL_REDIRECT_URI, VALID_ENV.GOOGLE_GMAIL_REDIRECT_URI);
    assert.equal(env.GOOGLE_CALENDAR_REDIRECT_URI, VALID_ENV.GOOGLE_CALENDAR_REDIRECT_URI);
    assert.equal(env.gmailEnabled, true);
  });
});

describe('redirect URI + scope separation', () => {
  /** @type {ReturnType<typeof loadEnv>} */
  let env;

  before(async () => {
    process.env.DATABASE_URL = VALID_ENV.DATABASE_URL;
    env = loadEnv(VALID_ENV);
    await clearOAuthStates();
  });

  after(async () => {
    await clearOAuthStates();
  });

  afterEach(async () => {
    await clearOAuthStates();
  });

  it('Gmail connect URL uses GOOGLE_GMAIL_REDIRECT_URI only', async () => {
    const result = await buildConnectUrl(env);
    assert.ok(result.url);
    const redirect = extractRedirectUriFromAuthUrl(result.url);
    assert.equal(redirect, VALID_ENV.GOOGLE_GMAIL_REDIRECT_URI);
    assert.notEqual(redirect, VALID_ENV.GOOGLE_CALENDAR_REDIRECT_URI);
  });

  it('Calendar generateAuthUrl uses GOOGLE_CALENDAR_REDIRECT_URI only', () => {
    const client = createOAuthClient(env);
    const url = client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: [CALENDAR_READONLY_SCOPE],
    });
    const redirect = extractRedirectUriFromAuthUrl(url);
    assert.equal(redirect, VALID_ENV.GOOGLE_CALENDAR_REDIRECT_URI);
    assert.notEqual(redirect, VALID_ENV.GOOGLE_GMAIL_REDIRECT_URI);
  });

  it('Gmail scopes are exactly least-privilege; none forbidden', async () => {
    const result = await buildConnectUrl(env);
    const scopes = extractScopesFromAuthUrl(result.url);
    assert.deepEqual(scopes, [...GMAIL_OAUTH_SCOPES].sort());
    for (const forbidden of FORBIDDEN_GMAIL_SCOPES) {
      assert.equal(scopes.includes(forbidden), false);
    }
    assert.ok(scopes.includes('openid'));
    assert.ok(scopes.includes('https://www.googleapis.com/auth/userinfo.email'));
    assert.ok(scopes.includes('https://www.googleapis.com/auth/gmail.readonly'));
  });

  it('Calendar scopes include only calendar.readonly, no gmail', () => {
    const client = createOAuthClient(env);
    const url = client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: [CALENDAR_READONLY_SCOPE],
    });
    const scopes = extractScopesFromAuthUrl(url);
    assert.deepEqual(scopes, [CALENDAR_READONLY_SCOPE]);
    assert.equal(scopes.some((s) => s.includes('gmail')), false);
  });

  it('regression: with Gmail configured, GET /auth stays calendar-only', async () => {
    const app = createApp(env);
    await request(app).get('/auth').expect(401);

    const res = await auth(request(app).get('/auth')).redirects(0);
    assert.ok([301, 302, 303, 307, 308].includes(res.status));
    const location = res.headers.location;
    assert.ok(location);
    assert.equal(extractRedirectUriFromAuthUrl(location), VALID_ENV.GOOGLE_CALENDAR_REDIRECT_URI);
    assert.notEqual(extractRedirectUriFromAuthUrl(location), VALID_ENV.GOOGLE_GMAIL_REDIRECT_URI);
    const scopes = extractScopesFromAuthUrl(location);
    assert.deepEqual(scopes, [CALENDAR_READONLY_SCOPE]);
    assert.equal(scopes.some((s) => s.toLowerCase().includes('gmail')), false);
  });
});

describe('gmail HTTP routes and sync', () => {
  /** @type {import('express').Express} */
  let app;
  /** @type {ReturnType<typeof loadEnv>} */
  let env;
  /** @type {string[]} */
  const fixtureAccountIds = [];

  before(() => {
    process.env.DATABASE_URL = VALID_ENV.DATABASE_URL;
    env = loadEnv(VALID_ENV);
    app = createApp(env);
  });

  after(async () => {
    resetGmailApiAdapter();
    await clearOAuthStates();
  });

  beforeEach(async () => {
    await clearOAuthStates();
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
    await clearOAuthStates();
  });

  /**
   * @param {Partial<Record<string, Function>>} overrides
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

    adapter.__store = store;
    setGmailApiAdapter(adapter);
    return adapter;
  }

  function enc(v) {
    return encryptToken(v, VALID_ENV.TOKEN_ENCRYPTION_KEY);
  }

  async function createFixtureAccount({
    email = 'fixture@gmail-test.example',
    externalAccountId = 'fixture-google',
    name = 'Fixture',
    isActive = true,
    syncStatus = SYNC_STATUS.IDLE,
    syncCursor = null,
    tokenExpiry = new Date(Date.now() + 3600_000),
    refreshToken = 'refresh-token-value-aaa',
    accessToken = 'access-token-value',
  } = {}) {
    const prisma = getPrisma();
    const account = await prisma.inboxAccount.create({
      data: {
        name,
        source: 'GMAIL',
        emailAddress: email,
        externalAccountId,
        isActive,
        syncStatus,
        syncCursor,
        gmailCredential: {
          create: {
            encryptedAccessToken: enc(accessToken),
            encryptedRefreshToken: enc(refreshToken),
            tokenExpiry,
            scopes: GMAIL_OAUTH_SCOPES.join(' '),
          },
        },
      },
    });
    fixtureAccountIds.push(account.id);
    return account;
  }

  it('requires admin auth on connect/accounts/sync; callback is public with safe errors', async () => {
    await request(app).get('/gmail/connect').expect(401);
    await request(app).get('/gmail/accounts').expect(401);
    await request(app).post('/gmail/sync-all').expect(401);
    await request(app).post('/gmail/accounts/x/sync').expect(401);
    await request(app).post('/gmail/accounts/x/disconnect').expect(401);

    const cb = await request(app).get('/gmail/callback').expect(400);
    assert.equal(String(cb.text).includes('Cannot GET'), false);
    assert.match(String(cb.text || cb.body.error || ''), /authorization failed|Invalid|Missing/i);

    const cbJson = await request(app).get('/gmail/callback?format=json').expect(400);
    assert.ok(cbJson.body.error);
    assertNoSecrets(cbJson.body);

    // Must NOT echo Google error_description query params.
    const denied = await request(app)
      .get('/gmail/callback')
      .query({
        error: 'access_denied',
        error_description: 'User denied SecretSubjectXYZ access-token-value',
        format: 'json',
      })
      .expect(400);
    assert.equal(JSON.stringify(denied.body).includes('error_description'), false);
    assert.equal(JSON.stringify(denied.body).includes('User denied'), false);
    assertNoSecrets(denied.body);
  });

  it('GET /gmail/connect without auth returns 401 not 404', async () => {
    const res = await request(app).get('/gmail/connect').expect(401);
    assert.notEqual(res.status, 404);
  });

  it('returns 503 when Gmail is not configured (calendar-only env)', async () => {
    const envNoGmail = loadEnv({
      ANTHROPIC_API_KEY: 'test-anthropic-key',
      GOOGLE_CLIENT_ID: 'test-google-client-id',
      GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
      GOOGLE_CALENDAR_REDIRECT_URI: 'https://example.com/auth/callback',
      ADMIN_API_KEY: 'test-admin-api-key',
      // no TOKEN_ENCRYPTION_KEY / GOOGLE_GMAIL_REDIRECT_URI
    });
    const appNoGmail = createApp(envNoGmail);
    const res = await auth(request(appNoGmail).get('/gmail/connect?format=json')).expect(503);
    assert.equal(res.body.error, 'Gmail connector is not configured');
    assertNoSecrets(res.body);
  });

  it('authenticated connect returns authorizationUrl with gmail redirect, no Bearer/admin key', async () => {
    const res = await auth(request(app).get('/gmail/connect').set('Accept', 'application/json')).expect(
      200
    );
    assert.ok(res.body.authorizationUrl);
    assert.equal(res.body.authorizationUrl.includes(VALID_ENV.ADMIN_API_KEY), false);
    assert.equal(res.body.authorizationUrl.includes('Bearer'), false);
    assert.match(res.body.authorizationUrl, /accounts\.google\.com/);
    assert.equal(
      extractRedirectUriFromAuthUrl(res.body.authorizationUrl),
      VALID_ENV.GOOGLE_GMAIL_REDIRECT_URI
    );
    assertNoSecrets(res.body);
  });

  it('OAuth callback creates encrypted credentials; replay fails; tokens never in response', async () => {
    installMockAdapter();
    const state = await createOAuthState(VALID_ENV.ADMIN_API_KEY);

    const res = await request(app)
      .get('/gmail/callback')
      .query({ code: 'auth-code-xyz', state, format: 'json' })
      .expect(200);

    assert.equal(res.body.status, 'ok');
    assert.equal(res.body.account.emailAddress, 'alpha@gmail-test.example');
    assertNoSecrets(res.body);
    assert.equal(JSON.stringify(res.body).includes('auth-code-xyz'), false);
    assert.equal(JSON.stringify(res.body).includes('refresh-token'), false);
    assert.equal(JSON.stringify(res.body).includes('access-token'), false);

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

    await request(app)
      .get('/gmail/callback')
      .query({ code: 'auth-code-xyz', state, format: 'json' })
      .expect(400);

    await request(app)
      .get('/gmail/callback')
      .query({ code: 'auth-code-xyz', state: 'bad.state.value', format: 'json' })
      .expect(400);
  });

  it('updates the same Google identity instead of duplicating accounts', async () => {
    installMockAdapter();
    const state1 = await createOAuthState(VALID_ENV.ADMIN_API_KEY);
    await request(app)
      .get('/gmail/callback')
      .query({ code: 'c1', state: state1, format: 'json' })
      .expect(200);

    const state2 = await createOAuthState(VALID_ENV.ADMIN_API_KEY);
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
    const s1 = await createOAuthState(VALID_ENV.ADMIN_API_KEY);
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
    const s2 = await createOAuthState(VALID_ENV.ADMIN_API_KEY);
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
      assert.equal('encryptedAccessToken' in row, false);
      assert.equal('encryptedRefreshToken' in row, false);
      fixtureAccountIds.push(row.id);
    }
  });

  it('GET /gmail/accounts never exposes encrypted tokens', async () => {
    await createFixtureAccount({
      email: 'list-safe@gmail-test.example',
      externalAccountId: 'list-safe-google',
    });
    const listed = await auth(request(app).get('/gmail/accounts')).expect(200);
    const serialized = JSON.stringify(listed.body);
    assert.equal(serialized.includes('encryptedAccessToken'), false);
    assert.equal(serialized.includes('encryptedRefreshToken'), false);
    assertNoSecrets(listed.body);
  });

  it('syncs messages idempotently and isolates accounts by externalId; excludes spam', async () => {
    const prisma = getPrisma();
    const accountA = await createFixtureAccount({
      email: 'sync-a@gmail-test.example',
      externalAccountId: 'sync-google-a',
      name: 'A',
    });
    const accountB = await createFixtureAccount({
      email: 'sync-b@gmail-test.example',
      externalAccountId: 'sync-google-b',
      name: 'B',
      refreshToken: 'refresh-token-value-bbb',
    });

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

    adapter.__store.listIds = [sharedExternalId];
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

  it('excludes trash labels during sync', async () => {
    const prisma = getPrisma();
    const account = await createFixtureAccount({
      email: 'trash@gmail-test.example',
      externalAccountId: 'trash-google',
      name: 'Trash',
    });

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

  it('does not advance cursor on partial sync failure', async () => {
    const prisma = getPrisma();
    const account = await createFixtureAccount({
      email: 'partial@gmail-test.example',
      externalAccountId: 'partial-google',
      name: 'Partial',
      syncCursor: null,
    });

    const adapter = installMockAdapter();
    adapter.__store.listIds = ['ok-1', 'fail-2'];
    adapter.__store.messages['ok-1'] = buildGmailMessage({ id: 'ok-1', plain: 'ok' });
    adapter.__store.messages['fail-2'] = buildGmailMessage({
      id: 'fail-2',
      plain: 'fail',
      subject: 'SecretSubjectXYZ',
    });
    adapter.__store.getShouldFailAfter = 1;
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
    const account = await createFixtureAccount({
      email: 'oksync@gmail-test.example',
      externalAccountId: 'oksync-google',
      name: 'OkSync',
    });

    const adapter = installMockAdapter();
    adapter.__store.listIds = ['m1'];
    adapter.__store.messages.m1 = buildGmailMessage({ id: 'm1', plain: 'hello' });
    adapter.__store.historyId = 'hist-ok-1';

    await auth(request(app).post(`/gmail/accounts/${account.id}/sync`)).expect(200);
    let reloaded = await prisma.inboxAccount.findUnique({ where: { id: account.id } });
    assert.equal(reloaded.syncCursor, 'hist-ok-1');
    assert.ok(reloaded.lastSyncedAt);

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
    const account = await createFixtureAccount({
      email: 'refresh@gmail-test.example',
      externalAccountId: 'refresh-google',
      name: 'Refresh',
      tokenExpiry: new Date(Date.now() - 60_000),
    });

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

  it('marks reconnect-required when refresh authorization is revoked; keeps items', async () => {
    const prisma = getPrisma();
    const account = await createFixtureAccount({
      email: 'revoked@gmail-test.example',
      externalAccountId: 'revoked-google',
      name: 'Revoked',
      tokenExpiry: new Date(Date.now() - 60_000),
    });
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
    const account = await createFixtureAccount({
      email: 'disc@gmail-test.example',
      externalAccountId: 'disc-google',
      name: 'Disc',
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

    const res = await auth(request(app).post(`/gmail/accounts/${account.id}/disconnect`)).expect(200);
    assert.equal(res.body.account.isActive, false);
    assertNoSecrets(res.body);

    const cred = await prisma.gmailCredential.findUnique({ where: { inboxAccountId: account.id } });
    assert.equal(cred, null);
    const items = await prisma.inboxItem.count({ where: { inboxAccountId: account.id } });
    assert.equal(items, 1);
  });

  it('sync-all returns per-account safe summaries', async () => {
    const account = await createFixtureAccount({
      email: 'all@gmail-test.example',
      externalAccountId: 'all-google',
      name: 'All',
    });

    const adapter = installMockAdapter();
    adapter.__store.listIds = [];
    adapter.__store.historyId = 'hist-all';

    const res = await auth(request(app).post('/gmail/sync-all')).expect(200);
    assert.ok(Array.isArray(res.body.results));
    assert.ok(res.body.results.some((r) => r.accountId === account.id && r.status === 'ok'));
    assertNoSecrets(res.body);
  });

  it('route ordering: /gmail/sync-all works; /gmail/accounts not treated as :id; unknown → 404', async () => {
    const syncAll = await auth(request(app).post('/gmail/sync-all')).expect(200);
    assert.ok(syncAll.body.results);

    const accounts = await auth(request(app).get('/gmail/accounts')).expect(200);
    assert.ok(Array.isArray(accounts.body.data));

    await auth(request(app).get('/gmail/nope')).expect(404);
    await auth(request(app).post('/gmail/nope')).expect(404);
  });

  it('returns safe 404 for unknown account sync/disconnect', async () => {
    const missing = 'ckmissing00000000000000001';
    await auth(request(app).post(`/gmail/accounts/${missing}/sync`)).expect(404);
    await auth(request(app).post(`/gmail/accounts/${missing}/disconnect`)).expect(404);
  });

  it('preserves refresh token when Google omits a new one on reconnect', async () => {
    const prisma = getPrisma();
    installMockAdapter();
    const state1 = await createOAuthState(VALID_ENV.ADMIN_API_KEY);
    await request(app)
      .get('/gmail/callback')
      .query({ code: 'c1', state: state1, format: 'json' })
      .expect(200);

    const before = await prisma.inboxAccount.findFirst({
      where: { externalAccountId: 'google-user-1', source: 'GMAIL' },
      include: { gmailCredential: true },
    });
    assert.ok(before?.gmailCredential);
    fixtureAccountIds.push(before.id);
    const oldEncryptedRefresh = before.gmailCredential.encryptedRefreshToken;
    const oldPlain = decryptToken(oldEncryptedRefresh, VALID_ENV.TOKEN_ENCRYPTION_KEY);
    assert.equal(oldPlain, 'refresh-token-value-aaa');

    const state2 = await createOAuthState(VALID_ENV.ADMIN_API_KEY);
    setGmailApiAdapter({
      ...installMockAdapter(),
      async exchangeCode() {
        return {
          access_token: 'access-token-value-new',
          // intentionally omit refresh_token
          expiry_date: Date.now() + 3600_000,
          scope: GMAIL_OAUTH_SCOPES.join(' '),
        };
      },
      async getProfile() {
        return {
          id: 'google-user-1',
          email: 'alpha@gmail-test.example',
          name: 'Alpha Tester',
        };
      },
    });

    await request(app)
      .get('/gmail/callback')
      .query({ code: 'c2', state: state2, format: 'json' })
      .expect(200);

    const after = await prisma.gmailCredential.findUnique({
      where: { inboxAccountId: before.id },
    });
    assert.ok(after);
    assert.equal(after.encryptedRefreshToken, oldEncryptedRefresh);
    assert.equal(
      decryptToken(after.encryptedRefreshToken, VALID_ENV.TOKEN_ENCRYPTION_KEY),
      'refresh-token-value-aaa'
    );
    assert.equal(
      decryptToken(after.encryptedAccessToken, VALID_ENV.TOKEN_ENCRYPTION_KEY),
      'access-token-value-new'
    );
  });

  it('concurrent sync: lock yields syncInProgress / HTTP 409; other accounts can sync', async () => {
    const accountA = await createFixtureAccount({
      email: 'lock-a@gmail-test.example',
      externalAccountId: 'lock-google-a',
      name: 'LockA',
    });
    const accountB = await createFixtureAccount({
      email: 'lock-b@gmail-test.example',
      externalAccountId: 'lock-google-b',
      name: 'LockB',
      refreshToken: 'refresh-token-value-bbb',
    });

    const adapter = installMockAdapter();
    adapter.__store.listIds = [];
    adapter.__store.historyId = 'hist-lock';

    const locked = await acquireSyncLock(accountA.id);
    assert.equal(locked, true);

    const serviceResult = await syncGmailAccount(accountA.id, env);
    assert.equal(serviceResult.syncInProgress, true);

    const httpRes = await auth(request(app).post(`/gmail/accounts/${accountA.id}/sync`)).expect(409);
    assert.equal(httpRes.body.code, 'SYNC_IN_PROGRESS');
    assertNoSecrets(httpRes.body);

    // Different account can still sync while A is locked.
    const syncB = await auth(request(app).post(`/gmail/accounts/${accountB.id}/sync`)).expect(200);
    assert.equal(syncB.body.status, 'ok');

    await releaseSyncLock(accountA.id, { syncStatus: SYNC_STATUS.IDLE });
    const afterRelease = await auth(request(app).post(`/gmail/accounts/${accountA.id}/sync`)).expect(
      200
    );
    assert.equal(afterRelease.body.status, 'ok');
  });

  it('service helpers cover callback edge cases without logging secrets', async () => {
    const logs = [];
    const originalError = console.error;
    console.error = (...args) => {
      logs.push(args.map(String).join(' '));
    };
    try {
      await clearOAuthStates();
      const bad = await handleOAuthCallback({ code: 'x' }, env);
      assert.equal(bad.status, 400);

      installMockAdapter({
        async exchangeCode() {
          throw new Error('boom access-token-value');
        },
      });
      const state = await createOAuthState(VALID_ENV.ADMIN_API_KEY);
      const failed = await handleOAuthCallback({ code: 'x', state }, env);
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
    const account = await createFixtureAccount({
      email: 'inactive@gmail-test.example',
      externalAccountId: 'inactive-google',
      name: 'Inactive',
      isActive: false,
    });
    const res = await auth(request(app).post(`/gmail/accounts/${account.id}/sync`)).expect(409);
    assert.match(res.body.error, /inactive/i);
  });

  it('analyze still works on synced Gmail items; no auto tasks/payments', async () => {
    const prisma = getPrisma();
    const account = await createFixtureAccount({
      email: 'analyze@gmail-test.example',
      externalAccountId: 'analyze-google',
      name: 'Analyze',
    });

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

    const tasks = await prisma.task.count({ where: { inboxItemId: item.id } });
    const payments = await prisma.payment.count({ where: { inboxItemId: item.id } });
    assert.equal(tasks, 0);
    assert.equal(payments, 0);
  });

  it('GET /inbox list does not include rawContent', async () => {
    const prisma = getPrisma();
    const account = await createFixtureAccount({
      email: 'inbox-list@gmail-test.example',
      externalAccountId: 'inbox-list-google',
      name: 'InboxList',
    });

    const adapter = installMockAdapter();
    adapter.__store.listIds = ['inbox-1'];
    adapter.__store.messages['inbox-1'] = buildGmailMessage({
      id: 'inbox-1',
      subject: 'Listed',
      plain: 'raw body must not appear in list',
    });
    adapter.__store.historyId = 'hist-inbox-list';

    await auth(request(app).post(`/gmail/accounts/${account.id}/sync`)).expect(200);
    const list = await auth(request(app).get('/inbox')).expect(200);
    assert.ok(Array.isArray(list.body.data));
    for (const row of list.body.data) {
      assert.equal('rawContent' in row, false);
    }
    assert.equal(JSON.stringify(list.body).includes('rawContent'), false);

    // Confirm the item exists with rawContent in DB.
    const stored = await prisma.inboxItem.findFirst({ where: { inboxAccountId: account.id } });
    assert.ok(stored?.rawContent);
  });
});

describe('privacy in errors', () => {
  /** @type {import('express').Express} */
  let app;
  /** @type {string[]} */
  const fixtureAccountIds = [];

  before(() => {
    process.env.DATABASE_URL = VALID_ENV.DATABASE_URL;
    const env = loadEnv(VALID_ENV);
    app = createApp(env);
  });

  after(async () => {
    resetGmailApiAdapter();
    await clearOAuthStates();
    await disconnectPrisma();
  });

  afterEach(async () => {
    const prisma = getPrisma();
    if (fixtureAccountIds.length > 0) {
      await prisma.inboxItem.deleteMany({ where: { inboxAccountId: { in: fixtureAccountIds } } });
      await prisma.gmailCredential.deleteMany({ where: { inboxAccountId: { in: fixtureAccountIds } } });
      await prisma.inboxAccount.deleteMany({ where: { id: { in: fixtureAccountIds } } });
      fixtureAccountIds.length = 0;
    }
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
    await clearOAuthStates();
  });

  function installMockAdapter(overrides = {}) {
    const store = {
      messages: {},
      listIds: [],
      historyIds: [],
      historyId: 'hist-priv',
      listShouldFail: false,
      getShouldFailAfter: null,
      getFailCount: 0,
    };
    const adapter = {
      async exchangeCode() {
        return {
          access_token: 'access-token-value',
          refresh_token: 'refresh-token-value-aaa',
          expiry_date: Date.now() + 3600_000,
          scope: GMAIL_OAUTH_SCOPES.join(' '),
        };
      },
      async getProfile() {
        return { id: 'priv-google', email: 'priv@gmail-test.example', name: 'Priv' };
      },
      async refreshAccessToken() {
        return {
          access_token: 'access-token-value-refreshed',
          expiry_date: Date.now() + 3600_000,
        };
      },
      async listMessages() {
        if (store.listShouldFail) throw new Error('list failed access-token-value');
        return {
          messages: store.listIds.map((id) => ({ id, threadId: `thread-${id}` })),
          nextPageToken: null,
        };
      },
      async getMessage(_c, messageId) {
        store.getFailCount += 1;
        if (store.getShouldFailAfter !== null && store.getFailCount > store.getShouldFailAfter) {
          throw new Error('get failed SecretSubjectXYZ access-token-value');
        }
        return store.messages[messageId];
      },
      async getProfileHistoryId() {
        return { emailAddress: 'priv@gmail-test.example', historyId: store.historyId, messagesTotal: 0 };
      },
      async listHistory() {
        return { messageIds: store.historyIds, historyId: store.historyId };
      },
      ...overrides,
      __store: store,
    };
    adapter.__store = store;
    setGmailApiAdapter(adapter);
    return adapter;
  }

  it('sync list failure responses are generic and assertNoSecrets', async () => {
    const prisma = getPrisma();
    const account = await prisma.inboxAccount.create({
      data: {
        name: 'PrivList',
        source: 'GMAIL',
        emailAddress: 'priv-list@gmail-test.example',
        externalAccountId: 'priv-list-google',
        isActive: true,
        syncStatus: SYNC_STATUS.IDLE,
        gmailCredential: {
          create: {
            encryptedAccessToken: encryptToken('access-token-value', ENCRYPTION_KEY),
            encryptedRefreshToken: encryptToken('refresh-token-value-aaa', ENCRYPTION_KEY),
            tokenExpiry: new Date(Date.now() + 3600_000),
            scopes: GMAIL_OAUTH_SCOPES.join(' '),
          },
        },
      },
    });
    fixtureAccountIds.push(account.id);

    const adapter = installMockAdapter();
    adapter.__store.listShouldFail = true;

    const res = await auth(request(app).post(`/gmail/accounts/${account.id}/sync`)).expect(503);
    assert.equal(res.body.error, 'Gmail sync failed');
    assert.equal(res.body.cursorUnchanged, true);
    assertNoSecrets(res.body);
  });

  it('sync getMessage failure with secret subject does not leak into response', async () => {
    const prisma = getPrisma();
    const account = await prisma.inboxAccount.create({
      data: {
        name: 'PrivGet',
        source: 'GMAIL',
        emailAddress: 'priv-get@gmail-test.example',
        externalAccountId: 'priv-get-google',
        isActive: true,
        syncStatus: SYNC_STATUS.IDLE,
        gmailCredential: {
          create: {
            encryptedAccessToken: encryptToken('access-token-value', ENCRYPTION_KEY),
            encryptedRefreshToken: encryptToken('refresh-token-value-aaa', ENCRYPTION_KEY),
            tokenExpiry: new Date(Date.now() + 3600_000),
            scopes: GMAIL_OAUTH_SCOPES.join(' '),
          },
        },
      },
    });
    fixtureAccountIds.push(account.id);

    const adapter = installMockAdapter();
    adapter.__store.listIds = ['secret-msg'];
    adapter.__store.messages['secret-msg'] = buildGmailMessage({
      id: 'secret-msg',
      subject: 'SecretSubjectXYZ',
      plain: 'body with access-token-value',
    });
    adapter.__store.getShouldFailAfter = 0;
    adapter.__store.historyId = 'hist-priv-get';

    const res = await auth(request(app).post(`/gmail/accounts/${account.id}/sync`)).expect(503);
    assertNoSecrets(res.body);
    assert.equal(JSON.stringify(res.body).includes('SecretSubjectXYZ'), false);
  });
});
