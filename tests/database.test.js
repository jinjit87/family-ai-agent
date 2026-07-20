const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const request = require('supertest');

const { createApp, loadEnv, SERVICE_NAME } = require('../index');
const { checkDatabaseHealth, disconnectPrisma, getPrisma } = require('../lib/db');

const VALID_ENV = {
  ANTHROPIC_API_KEY: 'test-anthropic-key',
  GOOGLE_CLIENT_ID: 'test-google-client-id',
  GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
  GOOGLE_REDIRECT_URI: 'https://example.com/auth/callback',
  ADMIN_API_KEY: 'test-admin-api-key',
};

const ROOT = path.join(__dirname, '..');
const SCHEMA_PATH = path.join(ROOT, 'prisma', 'schema.prisma');
const SEED_PATH = path.join(ROOT, 'prisma', 'seed.js');
const MIGRATIONS_DIR = path.join(ROOT, 'prisma', 'migrations');

const REQUIRED_MODELS = [
  'Contact',
  'Conversation',
  'Message',
  'Task',
  'CalendarProposal',
  'Approval',
  'Rule',
  'AuditLog',
];

describe('Prisma schema foundation', () => {
  it('defines all required models with id, createdAt, updatedAt', () => {
    const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
    assert.match(schema, /provider\s*=\s*"postgresql"/);

    for (const model of REQUIRED_MODELS) {
      assert.match(schema, new RegExp(`model\\s+${model}\\s*\\{`), `missing model ${model}`);
      const blockMatch = schema.match(new RegExp(`model\\s+${model}\\s*\\{([\\s\\S]*?)\\n\\}`));
      assert.ok(blockMatch, `could not parse model block for ${model}`);
      const block = blockMatch[1];
      assert.match(block, /\bid\b/);
      assert.match(block, /\bcreatedAt\b/);
      assert.match(block, /\bupdatedAt\b/);
    }
  });

  it('uses enums for status and type fields', () => {
    const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
    const enums = [
      'ContactRole',
      'ConversationChannel',
      'ConversationStatus',
      'MessageDirection',
      'MessageStatus',
      'TaskStatus',
      'TaskPriority',
      'TaskSource',
      'CalendarProposalStatus',
      'ApprovalType',
      'ApprovalStatus',
      'RuleCategory',
    ];
    for (const name of enums) {
      assert.match(schema, new RegExp(`enum\\s+${name}\\s*\\{`), `missing enum ${name}`);
    }
  });

  it('includes an initial Prisma migration', () => {
    assert.ok(fs.existsSync(MIGRATIONS_DIR), 'prisma/migrations directory missing');
    const entries = fs.readdirSync(MIGRATIONS_DIR).filter((name) => {
      const full = path.join(MIGRATIONS_DIR, name);
      return fs.statSync(full).isDirectory() && fs.existsSync(path.join(full, 'migration.sql'));
    });
    assert.ok(entries.length >= 1, 'expected at least one migration with migration.sql');
  });

  it('seed script creates one Contact, Conversation, and Task', () => {
    const seed = fs.readFileSync(SEED_PATH, 'utf8');
    assert.match(seed, /prisma\.contact\.upsert/);
    assert.match(seed, /prisma\.conversation\.upsert/);
    assert.match(seed, /prisma\.task\.upsert/);
  });
});

describe('database health helper', () => {
  const originalUrl = process.env.DATABASE_URL;

  afterEach(async () => {
    await disconnectPrisma();
    if (originalUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalUrl;
    }
  });

  it('reports unhealthy when DATABASE_URL is missing', async () => {
    delete process.env.DATABASE_URL;
    const result = await checkDatabaseHealth();
    assert.equal(result.ok, false);
    assert.equal(typeof result.latencyMs, 'number');
    assert.equal(result.error, undefined);
  });

  it('reports healthy when DATABASE_URL points at a live database', async (t) => {
    if (!process.env.DATABASE_URL && !originalUrl) {
      t.skip('DATABASE_URL not set; skipping live DB check');
      return;
    }
    process.env.DATABASE_URL = process.env.DATABASE_URL || originalUrl;
    const result = await checkDatabaseHealth();
    assert.equal(result.ok, true);
    assert.equal(typeof result.latencyMs, 'number');
  });
});

describe('GET /health/db', () => {
  let app;
  const originalUrl = process.env.DATABASE_URL;
  const ALLOWED_KEYS = ['database', 'latencyMs', 'service', 'status', 'timestamp'];

  before(() => {
    const env = loadEnv(VALID_ENV);
    app = createApp(env);
  });

  after(async () => {
    await disconnectPrisma();
    if (originalUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalUrl;
    }
  });

  beforeEach(async () => {
    await disconnectPrisma();
  });

  it('returns 503 when DATABASE_URL is not set without leaking internals', async () => {
    delete process.env.DATABASE_URL;
    const res = await request(app).get('/health/db').expect(503);
    assert.equal(res.body.status, 'error');
    assert.equal(res.body.database, 'down');
    assert.equal(res.body.service, SERVICE_NAME);
    assert.equal(typeof res.body.timestamp, 'string');
    assert.equal(typeof res.body.latencyMs, 'number');
    assert.deepEqual(Object.keys(res.body).sort(), ALLOWED_KEYS);
    assert.equal(res.body.error, undefined);

    const serialized = JSON.stringify(res.body);
    assert.doesNotMatch(serialized, /DATABASE_URL/);
    assert.doesNotMatch(serialized, /postgresql:\/\//i);
    assert.doesNotMatch(serialized, /Prisma/);
  });

  it('returns 503 on connection failure without exposing secrets or host details', async () => {
    const secretUser = 'secret_db_user';
    const secretPass = 'super_secret_db_password';
    const secretHost = 'db-host.internal.example';
    const secretDb = 'secret_family_db';
    // Unreachable host + short timeout so the test fails fast.
    process.env.DATABASE_URL =
      `postgresql://${secretUser}:${secretPass}@${secretHost}:5432/${secretDb}` +
      '?schema=public&connect_timeout=1';

    const res = await request(app).get('/health/db').expect(503);
    assert.equal(res.body.status, 'error');
    assert.equal(res.body.database, 'down');
    assert.deepEqual(Object.keys(res.body).sort(), ALLOWED_KEYS);
    assert.equal(res.body.error, undefined);

    const serialized = JSON.stringify(res.body);
    assert.doesNotMatch(serialized, /DATABASE_URL/);
    assert.doesNotMatch(serialized, new RegExp(secretUser));
    assert.doesNotMatch(serialized, new RegExp(secretPass));
    assert.doesNotMatch(serialized, new RegExp(secretHost.replace(/\./g, '\\.')));
    assert.doesNotMatch(serialized, new RegExp(secretDb));
    assert.doesNotMatch(serialized, /postgresql:\/\//i);
    assert.doesNotMatch(serialized, /5432/);
    assert.doesNotMatch(serialized, /PrismaClient/);
    assert.doesNotMatch(serialized, /P1001|P1010|ECONNREFUSED|ENOTFOUND/i);
  });

  it('returns 200 when the database is reachable with only allowed fields', async (t) => {
    if (!originalUrl) {
      t.skip('DATABASE_URL not set; skipping live DB check');
      return;
    }
    process.env.DATABASE_URL = originalUrl;
    const res = await request(app).get('/health/db').expect(200);
    assert.equal(res.body.status, 'ok');
    assert.equal(res.body.database, 'up');
    assert.equal(res.body.service, SERVICE_NAME);
    assert.deepEqual(Object.keys(res.body).sort(), ALLOWED_KEYS);
    assert.equal(res.body.error, undefined);
  });

  it('does not change the public /health contract', async () => {
    const res = await request(app).get('/health').expect(200);
    assert.deepEqual(Object.keys(res.body).sort(), ['service', 'status', 'timestamp']);
  });
});

describe('seed data integration', () => {
  after(async () => {
    await disconnectPrisma();
  });

  it('seed records exist after db:seed', async (t) => {
    if (!process.env.DATABASE_URL) {
      t.skip('DATABASE_URL not set; skipping seed integration check');
      return;
    }

    const prisma = getPrisma();
    const contact = await prisma.contact.findUnique({ where: { id: 'seed_contact_meytal' } });
    const conversation = await prisma.conversation.findUnique({
      where: { id: 'seed_conversation_internal' },
    });
    const task = await prisma.task.findUnique({ where: { id: 'seed_task_review_calendar' } });

    assert.ok(contact, 'seed contact missing — run npm run db:seed');
    assert.ok(conversation, 'seed conversation missing — run npm run db:seed');
    assert.ok(task, 'seed task missing — run npm run db:seed');
    assert.equal(conversation.contactId, contact.id);
    assert.equal(task.contactId, contact.id);
  });
});
