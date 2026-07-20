const express = require('express');
const schemas = require('./paymentsSchemas');
const payments = require('./payments');

/**
 * Log a safe, generic message — never Prisma/driver details.
 * @param {string} action
 * @param {unknown} err
 */
function logPaymentFailure(action, err) {
  if (payments.isForeignKeyError(err)) {
    console.error(`Failed to ${action} payment: invalid related id`);
    return;
  }
  console.error(`Failed to ${action} payment: database error`);
}

/**
 * Map write failures to safe HTTP responses (no Prisma leakage).
 * @param {import('express').Response} res
 * @param {string} action
 * @param {unknown} err
 */
function respondPaymentWriteError(res, action, err) {
  logPaymentFailure(action, err);
  if (payments.isForeignKeyError(err)) {
    return res.status(400).json({ error: 'Invalid contactId' });
  }
  return res.status(500).json({ error: `Failed to ${action} payment` });
}

/**
 * Map service result objects that use notFound/conflict/payment shape.
 * @param {import('express').Response} res
 * @param {{ payment?: object, notFound?: true, conflict?: string } | null} result
 * @param {string} notFoundMessage
 */
function respondLifecycleResult(res, result, notFoundMessage) {
  if (!result || result.notFound) {
    return res.status(404).json({ error: notFoundMessage });
  }
  if (result.conflict) {
    return res.status(409).json({ error: result.conflict });
  }
  return res.status(200).json(result.payment);
}

/**
 * Express router for Payments Due Engine.
 * Mount under /payments with admin auth. Does not alter existing routes.
 *
 * Important: /reports/weekly is registered before /:id so Express does not
 * treat "reports" as a payment id.
 *
 * @param {{ adminAuth: import('express').RequestHandler }} options
 */
function createPaymentsRouter({ adminAuth }) {
  const router = express.Router();

  router.use(adminAuth);

  router.get('/', async (req, res) => {
    const parsed = schemas.listPaymentsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json(schemas.formatZodError(parsed.error));
    }

    try {
      const result = await payments.listPayments(parsed.data);
      return res.status(200).json(result);
    } catch (_err) {
      console.error('Failed to list payments: database error');
      return res.status(500).json({ error: 'Failed to list payments' });
    }
  });

  // Must be before /:id — otherwise "reports" is captured as an id.
  router.get('/reports/weekly', async (_req, res) => {
    try {
      const report = await payments.getWeeklyReport();
      return res.status(200).json(report);
    } catch (_err) {
      console.error('Failed to generate weekly payment report: database error');
      return res.status(500).json({ error: 'Failed to generate weekly payment report' });
    }
  });

  router.get('/:id', async (req, res) => {
    const parsed = schemas.paymentIdParamSchema.safeParse(req.params);
    if (!parsed.success) {
      return res.status(400).json(schemas.formatZodError(parsed.error));
    }

    try {
      const payment = await payments.getPaymentById(parsed.data.id);
      if (!payment) {
        return res.status(404).json({ error: 'Payment not found' });
      }
      return res.status(200).json(payment);
    } catch (_err) {
      console.error('Failed to get payment: database error');
      return res.status(500).json({ error: 'Failed to get payment' });
    }
  });

  router.post('/', async (req, res) => {
    const parsed = schemas.createPaymentSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json(schemas.formatZodError(parsed.error));
    }

    try {
      const payment = await payments.createPayment(parsed.data);
      return res.status(201).json(payment);
    } catch (err) {
      return respondPaymentWriteError(res, 'create', err);
    }
  });

  router.patch('/:id', async (req, res) => {
    const params = schemas.paymentIdParamSchema.safeParse(req.params);
    if (!params.success) {
      return res.status(400).json(schemas.formatZodError(params.error));
    }

    const body = schemas.updatePaymentSchema.safeParse(req.body ?? {});
    if (!body.success) {
      return res.status(400).json(schemas.formatZodError(body.error));
    }

    try {
      const result = await payments.updatePayment(params.data.id, body.data);
      return respondLifecycleResult(res, result, 'Payment not found');
    } catch (err) {
      return respondPaymentWriteError(res, 'update', err);
    }
  });

  router.post('/:id/approve', async (req, res) => {
    const parsed = schemas.paymentIdParamSchema.safeParse(req.params);
    if (!parsed.success) {
      return res.status(400).json(schemas.formatZodError(parsed.error));
    }

    try {
      const result = await payments.approvePayment(parsed.data.id);
      return respondLifecycleResult(res, result, 'Payment not found');
    } catch (_err) {
      console.error('Failed to approve payment: database error');
      return res.status(500).json({ error: 'Failed to approve payment' });
    }
  });

  router.post('/:id/mark-paid', async (req, res) => {
    const params = schemas.paymentIdParamSchema.safeParse(req.params);
    if (!params.success) {
      return res.status(400).json(schemas.formatZodError(params.error));
    }

    const body = schemas.markPaidSchema.safeParse(req.body ?? {});
    if (!body.success) {
      return res.status(400).json(schemas.formatZodError(body.error));
    }

    try {
      const result = await payments.markPaymentPaid(params.data.id, body.data);
      return respondLifecycleResult(res, result, 'Payment not found');
    } catch (_err) {
      console.error('Failed to mark payment paid: database error');
      return res.status(500).json({ error: 'Failed to mark payment paid' });
    }
  });

  router.post('/:id/reopen', async (req, res) => {
    const parsed = schemas.paymentIdParamSchema.safeParse(req.params);
    if (!parsed.success) {
      return res.status(400).json(schemas.formatZodError(parsed.error));
    }

    try {
      const result = await payments.reopenPayment(parsed.data.id);
      return respondLifecycleResult(res, result, 'Payment not found');
    } catch (_err) {
      console.error('Failed to reopen payment: database error');
      return res.status(500).json({ error: 'Failed to reopen payment' });
    }
  });

  router.post('/:id/archive', async (req, res) => {
    const parsed = schemas.paymentIdParamSchema.safeParse(req.params);
    if (!parsed.success) {
      return res.status(400).json(schemas.formatZodError(parsed.error));
    }

    try {
      const result = await payments.archivePayment(parsed.data.id);
      return respondLifecycleResult(res, result, 'Payment not found');
    } catch (_err) {
      console.error('Failed to archive payment: database error');
      return res.status(500).json({ error: 'Failed to archive payment' });
    }
  });

  // Soft delete only — never hard-deletes the row.
  router.delete('/:id', async (req, res) => {
    const parsed = schemas.paymentIdParamSchema.safeParse(req.params);
    if (!parsed.success) {
      return res.status(400).json(schemas.formatZodError(parsed.error));
    }

    try {
      const payment = await payments.softDeletePayment(parsed.data.id);
      if (!payment) {
        return res.status(404).json({ error: 'Payment not found' });
      }
      return res.status(200).json(payment);
    } catch (_err) {
      console.error('Failed to delete payment: database error');
      return res.status(500).json({ error: 'Failed to delete payment' });
    }
  });

  return router;
}

module.exports = {
  createPaymentsRouter,
  logPaymentFailure,
  respondPaymentWriteError,
  respondLifecycleResult,
};
