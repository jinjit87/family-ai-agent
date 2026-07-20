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
 * Returns only non-sensitive status fields — never raw driver errors or URLs.
 * @returns {Promise<{ ok: boolean, latencyMs: number }>}
 */
async function checkDatabaseHealth() {
  const started = Date.now();

  if (!process.env.DATABASE_URL) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
    };
  }

  try {
    const client = getPrisma();
    await client.$queryRaw`SELECT 1`;
    return {
      ok: true,
      latencyMs: Date.now() - started,
    };
  } catch (_err) {
    // Swallow raw Prisma/driver errors here; callers log a generic message only.
    return {
      ok: false,
      latencyMs: Date.now() - started,
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
