const { PrismaClient } = require('@prisma/client');

/** @type {PrismaClient | undefined} */
let prisma;

/**
 * Shared Prisma client singleton.
 * Requires DATABASE_URL in the environment when used.
 */
function getPrisma() {
  if (!prisma) {
    prisma = new PrismaClient();
  }
  return prisma;
}

/**
 * Check PostgreSQL connectivity via Prisma.
 * @returns {Promise<{ ok: boolean, latencyMs: number, error?: string }>}
 */
async function checkDatabaseHealth() {
  const started = Date.now();

  if (!process.env.DATABASE_URL) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: 'DATABASE_URL is not set',
    };
  }

  try {
    const client = getPrisma();
    await client.$queryRaw`SELECT 1`;
    return {
      ok: true,
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: err instanceof Error ? err.message : 'Database health check failed',
    };
  }
}

/**
 * Disconnect the shared Prisma client (for tests / graceful shutdown).
 */
async function disconnectPrisma() {
  if (prisma) {
    await prisma.$disconnect();
    prisma = undefined;
  }
}

module.exports = {
  getPrisma,
  checkDatabaseHealth,
  disconnectPrisma,
};
