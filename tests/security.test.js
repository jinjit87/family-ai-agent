const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const request = require('supertest');

const { createApp, loadEnv, SERVICE_NAME, createOAuthClient, CALENDAR_READONLY_SCOPE } = require('../index');

const VALID_ENV = {
  ANTHROPIC_API_KEY: 'test-anthropic-key',
  GOOGLE_CLIENT_ID: 'test-google-client-id',
  GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
  GOOGLE_CALENDAR_REDIRECT_URI: 'https://example.com/auth/callback',
  ADMIN_API_KEY: 'test-admin-api-key',
};

describe('environment validation', () => {
  it('rejects missing required variables and lists their names only', () => {
    assert.throws(
      () => loadEnv({}),
      (err) => {
        assert.match(err.message, /Missing required environment variables/);
        assert.match(err.message, /ANTHROPIC_API_KEY/);
        assert.match(err.message, /GOOGLE_CLIENT_ID/);
        assert.match(err.message, /GOOGLE_CLIENT_SECRET/);
        assert.match(err.message, /GOOGLE_CALENDAR_REDIRECT_URI/);
        assert.match(err.message, /ADMIN_API_KEY/);
        // Never echo secret-like values (none were provided; ensure message has no key=value leaks).
        assert.doesNotMatch(err.message, /=/);
        return true;
      }
    );
  });

  it('accepts a valid environment with GOOGLE_CALENDAR_REDIRECT_URI', () => {
    const env = loadEnv(VALID_ENV);
    assert.equal(env.ADMIN_API_KEY, VALID_ENV.ADMIN_API_KEY);
    assert.equal(env.GOOGLE_CALENDAR_REDIRECT_URI, VALID_ENV.GOOGLE_CALENDAR_REDIRECT_URI);
  });

  it('accepts deprecated GOOGLE_REDIRECT_URI as Calendar-only fallback', () => {
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (msg) => warnings.push(String(msg));
    try {
      const env = loadEnv({
        ANTHROPIC_API_KEY: 'test-anthropic-key',
        GOOGLE_CLIENT_ID: 'test-google-client-id',
        GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
        GOOGLE_REDIRECT_URI: 'https://example.com/auth/callback',
        ADMIN_API_KEY: 'test-admin-api-key',
      });
      assert.equal(env.GOOGLE_CALENDAR_REDIRECT_URI, 'https://example.com/auth/callback');
      assert.ok(warnings.some((w) => w.includes('DEPRECATED') && w.includes('GOOGLE_REDIRECT_URI')));
      assert.ok(warnings.every((w) => !w.includes('https://example.com')));
    } finally {
      console.warn = originalWarn;
    }
  });

  it('Calendar OAuth client uses GOOGLE_CALENDAR_REDIRECT_URI only', () => {
    const crypto = require('crypto');
    const env = loadEnv({
      ...VALID_ENV,
      GOOGLE_CALENDAR_REDIRECT_URI: 'https://cal.example/auth/callback',
      GOOGLE_GMAIL_REDIRECT_URI: 'https://gmail.example/gmail/callback',
      TOKEN_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
      DATABASE_URL: 'postgresql://family_ai:family_ai_dev@localhost:5432/family_ai_agent?schema=public',
    });
    const client = createOAuthClient(env);
    const url = client.generateAuthUrl({
      access_type: 'offline',
      scope: [CALENDAR_READONLY_SCOPE],
    });
    const redirect = new URL(url).searchParams.get('redirect_uri');
    assert.equal(redirect, 'https://cal.example/auth/callback');
    assert.notEqual(redirect, env.GOOGLE_GMAIL_REDIRECT_URI);
    const scopes = (new URL(url).searchParams.get('scope') || '').split(/\s+/);
    assert.ok(scopes.includes(CALENDAR_READONLY_SCOPE));
    assert.ok(!scopes.some((s) => s.includes('gmail')));
  });
});

describe('HTTP security', () => {
  let app;

  before(() => {
    const env = loadEnv(VALID_ENV);
    app = createApp(env);
  });

  it('/health is publicly accessible and returns only status, timestamp, service', async () => {
    const res = await request(app).get('/health').expect(200);
    assert.equal(res.body.status, 'ok');
    assert.equal(res.body.service, SERVICE_NAME);
    assert.equal(typeof res.body.timestamp, 'string');
    assert.deepEqual(Object.keys(res.body).sort(), ['service', 'status', 'timestamp']);
  });

  it('/morning returns 401 without authorization', async () => {
    const res = await request(app).get('/morning').expect(401);
    assert.equal(res.body.error, 'Unauthorized');
  });

  it('/morning returns 401 with an invalid key', async () => {
    const res = await request(app)
      .get('/morning')
      .set('Authorization', 'Bearer wrong-key')
      .expect(401);
    assert.equal(res.body.error, 'Unauthorized');
  });

  it('/morning rejects secrets passed as query parameters', async () => {
    const res = await request(app)
      .get('/morning')
      .query({ api_key: VALID_ENV.ADMIN_API_KEY, key: VALID_ENV.ADMIN_API_KEY })
      .expect(401);
    assert.equal(res.body.error, 'Unauthorized');
  });

  it('/qr is not available', async () => {
    await request(app).get('/qr').expect(404);
  });

  it('/auth returns 401 without authorization', async () => {
    await request(app).get('/auth').expect(401);
  });
});

describe('Baileys isolation', () => {
  it('no active application file imports Baileys', () => {
    const root = path.join(__dirname, '..');
    const activeFiles = [
      'index.js',
      'lib/env.js',
      'lib/db.js',
      'lib/contacts.js',
      'lib/contactsSchemas.js',
      'lib/contactsRouter.js',
      'package.json',
    ];

    const forbidden = [
      /@whiskeysockets\/baileys/,
      /require\(['"]@whiskeysockets\/baileys['"]\)/,
      /require\(['"]qrcode['"]\)/,
      /require\(['"]pino['"]\)/,
      /\bmakeWASocket\b/,
      /\buseMultiFileAuthState\b/,
      /\bDisconnectReason\b/,
    ];

    for (const relative of activeFiles) {
      const content = fs.readFileSync(path.join(root, relative), 'utf8');
      for (const pattern of forbidden) {
        assert.doesNotMatch(content, pattern, `${relative} matched ${pattern}`);
      }
    }

    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert.equal(pkg.dependencies['@whiskeysockets/baileys'], undefined);
    assert.equal(pkg.dependencies.qrcode, undefined);
    assert.equal(pkg.dependencies.pino, undefined);
  });
});
