const express = require('express');
const inbox = require('./inbox');

/**
 * Daily briefing router. Mount under /briefing with admin auth.
 * @param {{ adminAuth: import('express').RequestHandler }} options
 */
function createBriefingRouter({ adminAuth }) {
  const router = express.Router();
  router.use(adminAuth);

  router.get('/daily', async (_req, res) => {
    try {
      const briefing = await inbox.getDailyBriefing();
      return res.status(200).json(briefing);
    } catch (_err) {
      console.error('Failed to build daily briefing: database error');
      return res.status(500).json({ error: 'Failed to build daily briefing' });
    }
  });

  return router;
}

module.exports = {
  createBriefingRouter,
};
