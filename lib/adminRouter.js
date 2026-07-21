const express = require('express');
const inbox = require('./inbox');

/**
 * True when staging-only admin tools may run.
 * Enabled when NODE_ENV is not production, or STAGING_ADMIN_TOOLS=true
 * (Railway staging often still sets NODE_ENV=production).
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [source]
 */
function isStagingAdminToolsEnabled(source = process.env) {
  if (String(source.STAGING_ADMIN_TOOLS || '').toLowerCase() === 'true') {
    return true;
  }
  return String(source.NODE_ENV || '').toLowerCase() !== 'production';
}

/**
 * Staging-only admin router. Mount under /admin with admin auth.
 * @param {{ adminAuth: import('express').RequestHandler, env?: Record<string, unknown> }} options
 */
function createAdminRouter({ adminAuth, env = process.env }) {
  const router = express.Router();
  router.use(adminAuth);

  router.post('/reset-analysis', async (_req, res) => {
    if (!isStagingAdminToolsEnabled(env)) {
      return res.status(403).json({
        error: 'Staging admin tools are disabled in this environment',
        code: 'STAGING_ADMIN_DISABLED',
      });
    }

    try {
      const result = await inbox.resetInboxAnalysis();
      console.info(
        JSON.stringify({
          event: 'admin_reset_analysis',
          resetCount: result.resetCount,
        })
      );
      return res.status(200).json(result);
    } catch (_err) {
      console.error('Failed to reset inbox analysis: database error');
      return res.status(500).json({ error: 'Failed to reset inbox analysis' });
    }
  });

  return router;
}

module.exports = {
  createAdminRouter,
  isStagingAdminToolsEnabled,
};
