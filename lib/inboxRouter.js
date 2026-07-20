const express = require('express');
const schemas = require('./inboxSchemas');
const inbox = require('./inbox');

/**
 * Log a safe, generic message — never Prisma/driver details.
 * @param {string} action
 * @param {unknown} [_err]
 */
function logInboxFailure(action, _err) {
  console.error(`Failed to ${action} inbox resource: database error`);
}

/**
 * Map service result objects that use notFound/conflict shapes.
 * @param {import('express').Response} res
 * @param {{ suggestion?: object, task?: object, payment?: object, idempotent?: boolean, notFound?: true, conflict?: string } | null} result
 * @param {string} notFoundMessage
 */
function respondSuggestionResult(res, result, notFoundMessage) {
  if (!result || result.notFound) {
    return res.status(404).json({ error: notFoundMessage });
  }
  if (result.conflict) {
    return res.status(409).json({ error: result.conflict });
  }
  /** @type {Record<string, unknown>} */
  const body = { suggestion: result.suggestion };
  if (result.task) body.task = result.task;
  if (result.payment) body.payment = result.payment;
  if (result.idempotent !== undefined) body.idempotent = result.idempotent;
  return res.status(200).json(body);
}

/**
 * Express router for Multi-Inbox AI Inbox (Phase 6).
 * Mount under /inbox with admin auth. Does not alter existing routes.
 *
 * Important: /accounts routes are registered before /:id so Express does not
 * treat "accounts" as an inbox item id.
 *
 * @param {{ adminAuth: import('express').RequestHandler }} options
 */
function createInboxRouter({ adminAuth }) {
  const router = express.Router();

  router.use(adminAuth);

  // ---- Accounts (must be before /:id) ----

  router.get('/accounts', async (_req, res) => {
    try {
      const result = await inbox.listAccounts();
      return res.status(200).json(result);
    } catch (_err) {
      logInboxFailure('list accounts');
      return res.status(500).json({ error: 'Failed to list inbox accounts' });
    }
  });

  router.post('/accounts', async (req, res) => {
    const parsed = schemas.createInboxAccountSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json(schemas.formatZodError(parsed.error));
    }

    try {
      const account = await inbox.createAccount(parsed.data);
      return res.status(201).json(account);
    } catch (_err) {
      logInboxFailure('create account');
      return res.status(500).json({ error: 'Failed to create inbox account' });
    }
  });

  router.get('/accounts/:id', async (req, res) => {
    const parsed = schemas.idParamSchema.safeParse(req.params);
    if (!parsed.success) {
      return res.status(400).json(schemas.formatZodError(parsed.error));
    }

    try {
      const account = await inbox.getAccountById(parsed.data.id);
      if (!account) {
        return res.status(404).json({ error: 'Inbox account not found' });
      }
      return res.status(200).json(account);
    } catch (_err) {
      logInboxFailure('get account');
      return res.status(500).json({ error: 'Failed to get inbox account' });
    }
  });

  router.patch('/accounts/:id', async (req, res) => {
    const params = schemas.idParamSchema.safeParse(req.params);
    if (!params.success) {
      return res.status(400).json(schemas.formatZodError(params.error));
    }
    const body = schemas.updateInboxAccountSchema.safeParse(req.body ?? {});
    if (!body.success) {
      return res.status(400).json(schemas.formatZodError(body.error));
    }

    try {
      const account = await inbox.updateAccount(params.data.id, body.data);
      if (!account) {
        return res.status(404).json({ error: 'Inbox account not found' });
      }
      return res.status(200).json(account);
    } catch (_err) {
      logInboxFailure('update account');
      return res.status(500).json({ error: 'Failed to update inbox account' });
    }
  });

  router.post('/accounts/:id/activate', async (req, res) => {
    const parsed = schemas.idParamSchema.safeParse(req.params);
    if (!parsed.success) {
      return res.status(400).json(schemas.formatZodError(parsed.error));
    }

    try {
      const account = await inbox.activateAccount(parsed.data.id);
      if (!account) {
        return res.status(404).json({ error: 'Inbox account not found' });
      }
      return res.status(200).json(account);
    } catch (_err) {
      logInboxFailure('activate account');
      return res.status(500).json({ error: 'Failed to activate inbox account' });
    }
  });

  router.post('/accounts/:id/deactivate', async (req, res) => {
    const parsed = schemas.idParamSchema.safeParse(req.params);
    if (!parsed.success) {
      return res.status(400).json(schemas.formatZodError(parsed.error));
    }

    try {
      const account = await inbox.deactivateAccount(parsed.data.id);
      if (!account) {
        return res.status(404).json({ error: 'Inbox account not found' });
      }
      return res.status(200).json(account);
    } catch (_err) {
      logInboxFailure('deactivate account');
      return res.status(500).json({ error: 'Failed to deactivate inbox account' });
    }
  });

  // ---- Items ----

  router.get('/', async (req, res) => {
    const parsed = schemas.listInboxItemsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json(schemas.formatZodError(parsed.error));
    }

    try {
      const result = await inbox.listInboxItems(parsed.data);
      return res.status(200).json(result);
    } catch (_err) {
      logInboxFailure('list items');
      return res.status(500).json({ error: 'Failed to list inbox items' });
    }
  });

  router.post('/', async (req, res) => {
    const parsed = schemas.createInboxItemSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json(schemas.formatZodError(parsed.error));
    }

    try {
      const result = await inbox.createInboxItem(parsed.data);
      if (result.notFoundAccount) {
        return res.status(400).json({ error: 'Invalid inboxAccountId' });
      }
      if (result.conflict) {
        return res.status(409).json({ error: result.conflict });
      }
      return res.status(201).json(result.item);
    } catch (_err) {
      logInboxFailure('create item');
      return res.status(500).json({ error: 'Failed to create inbox item' });
    }
  });

  router.get('/:id', async (req, res) => {
    const parsed = schemas.idParamSchema.safeParse(req.params);
    if (!parsed.success) {
      return res.status(400).json(schemas.formatZodError(parsed.error));
    }

    try {
      const item = await inbox.getInboxItemById(parsed.data.id);
      if (!item) {
        return res.status(404).json({ error: 'Inbox item not found' });
      }
      return res.status(200).json(item);
    } catch (_err) {
      logInboxFailure('get item');
      return res.status(500).json({ error: 'Failed to get inbox item' });
    }
  });

  router.patch('/:id', async (req, res) => {
    const params = schemas.idParamSchema.safeParse(req.params);
    if (!params.success) {
      return res.status(400).json(schemas.formatZodError(params.error));
    }
    const body = schemas.updateInboxItemSchema.safeParse(req.body ?? {});
    if (!body.success) {
      return res.status(400).json(schemas.formatZodError(body.error));
    }

    try {
      const item = await inbox.updateInboxItem(params.data.id, body.data);
      if (!item) {
        return res.status(404).json({ error: 'Inbox item not found' });
      }
      return res.status(200).json(item);
    } catch (_err) {
      logInboxFailure('update item');
      return res.status(500).json({ error: 'Failed to update inbox item' });
    }
  });

  router.post('/:id/analyze', async (req, res) => {
    const parsed = schemas.idParamSchema.safeParse(req.params);
    if (!parsed.success) {
      return res.status(400).json(schemas.formatZodError(parsed.error));
    }

    try {
      const result = await inbox.analyzeInboxItem(parsed.data.id);
      if (result.notFound) {
        return res.status(404).json({ error: 'Inbox item not found' });
      }
      if (result.failed) {
        return res.status(500).json({ error: 'Failed to analyze inbox item' });
      }
      return res.status(200).json(result);
    } catch (_err) {
      logInboxFailure('analyze item');
      return res.status(500).json({ error: 'Failed to analyze inbox item' });
    }
  });

  router.post('/:id/archive', async (req, res) => {
    const parsed = schemas.idParamSchema.safeParse(req.params);
    if (!parsed.success) {
      return res.status(400).json(schemas.formatZodError(parsed.error));
    }

    try {
      const item = await inbox.archiveInboxItem(parsed.data.id);
      if (!item) {
        return res.status(404).json({ error: 'Inbox item not found' });
      }
      return res.status(200).json(item);
    } catch (_err) {
      logInboxFailure('archive item');
      return res.status(500).json({ error: 'Failed to archive inbox item' });
    }
  });

  // ---- Suggestion approve / reject / apply ----

  router.post('/:id/task-suggestions/:suggestionId/approve', async (req, res) => {
    const parsed = schemas.suggestionParamSchema.safeParse(req.params);
    if (!parsed.success) {
      return res.status(400).json(schemas.formatZodError(parsed.error));
    }
    try {
      const result = await inbox.approveTaskSuggestion(parsed.data.id, parsed.data.suggestionId);
      return respondSuggestionResult(res, result, 'Task suggestion not found');
    } catch (_err) {
      logInboxFailure('approve task suggestion');
      return res.status(500).json({ error: 'Failed to approve task suggestion' });
    }
  });

  router.post('/:id/task-suggestions/:suggestionId/reject', async (req, res) => {
    const parsed = schemas.suggestionParamSchema.safeParse(req.params);
    if (!parsed.success) {
      return res.status(400).json(schemas.formatZodError(parsed.error));
    }
    try {
      const result = await inbox.rejectTaskSuggestion(parsed.data.id, parsed.data.suggestionId);
      return respondSuggestionResult(res, result, 'Task suggestion not found');
    } catch (_err) {
      logInboxFailure('reject task suggestion');
      return res.status(500).json({ error: 'Failed to reject task suggestion' });
    }
  });

  router.post('/:id/task-suggestions/:suggestionId/apply', async (req, res) => {
    const parsed = schemas.suggestionParamSchema.safeParse(req.params);
    if (!parsed.success) {
      return res.status(400).json(schemas.formatZodError(parsed.error));
    }
    try {
      const result = await inbox.applyTaskSuggestion(parsed.data.id, parsed.data.suggestionId);
      return respondSuggestionResult(res, result, 'Task suggestion not found');
    } catch (_err) {
      logInboxFailure('apply task suggestion');
      return res.status(500).json({ error: 'Failed to apply task suggestion' });
    }
  });

  router.post('/:id/payment-suggestions/:suggestionId/approve', async (req, res) => {
    const parsed = schemas.suggestionParamSchema.safeParse(req.params);
    if (!parsed.success) {
      return res.status(400).json(schemas.formatZodError(parsed.error));
    }
    try {
      const result = await inbox.approvePaymentSuggestion(parsed.data.id, parsed.data.suggestionId);
      return respondSuggestionResult(res, result, 'Payment suggestion not found');
    } catch (_err) {
      logInboxFailure('approve payment suggestion');
      return res.status(500).json({ error: 'Failed to approve payment suggestion' });
    }
  });

  router.post('/:id/payment-suggestions/:suggestionId/reject', async (req, res) => {
    const parsed = schemas.suggestionParamSchema.safeParse(req.params);
    if (!parsed.success) {
      return res.status(400).json(schemas.formatZodError(parsed.error));
    }
    try {
      const result = await inbox.rejectPaymentSuggestion(parsed.data.id, parsed.data.suggestionId);
      return respondSuggestionResult(res, result, 'Payment suggestion not found');
    } catch (_err) {
      logInboxFailure('reject payment suggestion');
      return res.status(500).json({ error: 'Failed to reject payment suggestion' });
    }
  });

  router.post('/:id/payment-suggestions/:suggestionId/apply', async (req, res) => {
    const parsed = schemas.suggestionParamSchema.safeParse(req.params);
    if (!parsed.success) {
      return res.status(400).json(schemas.formatZodError(parsed.error));
    }
    try {
      const result = await inbox.applyPaymentSuggestion(parsed.data.id, parsed.data.suggestionId);
      return respondSuggestionResult(res, result, 'Payment suggestion not found');
    } catch (_err) {
      logInboxFailure('apply payment suggestion');
      return res.status(500).json({ error: 'Failed to apply payment suggestion' });
    }
  });

  router.post('/:id/reply-suggestions/:suggestionId/approve', async (req, res) => {
    const parsed = schemas.suggestionParamSchema.safeParse(req.params);
    if (!parsed.success) {
      return res.status(400).json(schemas.formatZodError(parsed.error));
    }
    try {
      const result = await inbox.approveReplySuggestion(parsed.data.id, parsed.data.suggestionId);
      return respondSuggestionResult(res, result, 'Reply suggestion not found');
    } catch (_err) {
      logInboxFailure('approve reply suggestion');
      return res.status(500).json({ error: 'Failed to approve reply suggestion' });
    }
  });

  router.post('/:id/reply-suggestions/:suggestionId/reject', async (req, res) => {
    const parsed = schemas.suggestionParamSchema.safeParse(req.params);
    if (!parsed.success) {
      return res.status(400).json(schemas.formatZodError(parsed.error));
    }
    try {
      const result = await inbox.rejectReplySuggestion(parsed.data.id, parsed.data.suggestionId);
      return respondSuggestionResult(res, result, 'Reply suggestion not found');
    } catch (_err) {
      logInboxFailure('reject reply suggestion');
      return res.status(500).json({ error: 'Failed to reject reply suggestion' });
    }
  });

  router.post('/:id/reply-suggestions/:suggestionId/apply', async (req, res) => {
    const parsed = schemas.suggestionParamSchema.safeParse(req.params);
    if (!parsed.success) {
      return res.status(400).json(schemas.formatZodError(parsed.error));
    }
    try {
      const result = await inbox.applyReplySuggestion(parsed.data.id, parsed.data.suggestionId);
      return respondSuggestionResult(res, result, 'Reply suggestion not found');
    } catch (_err) {
      logInboxFailure('apply reply suggestion');
      return res.status(500).json({ error: 'Failed to apply reply suggestion' });
    }
  });

  return router;
}

module.exports = {
  createInboxRouter,
  logInboxFailure,
  respondSuggestionResult,
};
