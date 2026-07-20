const express = require('express');
const schemas = require('./tasksSchemas');
const tasks = require('./tasks');

/**
 * Log a safe, generic message — never Prisma/driver details.
 * @param {string} action
 * @param {unknown} err
 */
function logTaskFailure(action, err) {
  if (tasks.isForeignKeyError(err)) {
    console.error(`Failed to ${action} task: invalid related id`);
    return;
  }
  console.error(`Failed to ${action} task: database error`);
}

/**
 * Map write failures to safe HTTP responses (no Prisma leakage).
 * @param {import('express').Response} res
 * @param {string} action
 * @param {unknown} err
 */
function respondTaskWriteError(res, action, err) {
  logTaskFailure(action, err);
  if (tasks.isForeignKeyError(err)) {
    return res.status(400).json({ error: 'Invalid contactId or conversationId' });
  }
  return res.status(500).json({ error: `Failed to ${action} task` });
}

/**
 * Express router for Tasks API (Phase 4).
 * Mount under /tasks with admin auth. Does not alter existing routes.
 *
 * @param {{ adminAuth: import('express').RequestHandler }} options
 */
function createTasksRouter({ adminAuth }) {
  const router = express.Router();

  router.use(adminAuth);

  router.get('/', async (req, res) => {
    const parsed = schemas.listTasksQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json(schemas.formatZodError(parsed.error));
    }

    try {
      const result = await tasks.listTasks(parsed.data);
      return res.status(200).json(result);
    } catch (_err) {
      console.error('Failed to list tasks: database error');
      return res.status(500).json({ error: 'Failed to list tasks' });
    }
  });

  router.get('/:id', async (req, res) => {
    const parsed = schemas.taskIdParamSchema.safeParse(req.params);
    if (!parsed.success) {
      return res.status(400).json(schemas.formatZodError(parsed.error));
    }

    try {
      const task = await tasks.getTaskById(parsed.data.id);
      if (!task) {
        return res.status(404).json({ error: 'Task not found' });
      }
      return res.status(200).json(task);
    } catch (_err) {
      console.error('Failed to get task: database error');
      return res.status(500).json({ error: 'Failed to get task' });
    }
  });

  router.post('/', async (req, res) => {
    const parsed = schemas.createTaskSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json(schemas.formatZodError(parsed.error));
    }

    try {
      const task = await tasks.createTask(parsed.data);
      return res.status(201).json(task);
    } catch (err) {
      return respondTaskWriteError(res, 'create', err);
    }
  });

  router.patch('/:id', async (req, res) => {
    const params = schemas.taskIdParamSchema.safeParse(req.params);
    if (!params.success) {
      return res.status(400).json(schemas.formatZodError(params.error));
    }

    const body = schemas.updateTaskSchema.safeParse(req.body ?? {});
    if (!body.success) {
      return res.status(400).json(schemas.formatZodError(body.error));
    }

    try {
      const task = await tasks.updateTask(params.data.id, body.data);
      if (!task) {
        return res.status(404).json({ error: 'Task not found' });
      }
      return res.status(200).json(task);
    } catch (err) {
      return respondTaskWriteError(res, 'update', err);
    }
  });

  router.post('/:id/complete', async (req, res) => {
    const parsed = schemas.taskIdParamSchema.safeParse(req.params);
    if (!parsed.success) {
      return res.status(400).json(schemas.formatZodError(parsed.error));
    }

    try {
      const task = await tasks.completeTask(parsed.data.id);
      if (!task) {
        return res.status(404).json({ error: 'Task not found' });
      }
      return res.status(200).json(task);
    } catch (_err) {
      console.error('Failed to complete task: database error');
      return res.status(500).json({ error: 'Failed to complete task' });
    }
  });

  router.post('/:id/reopen', async (req, res) => {
    const parsed = schemas.taskIdParamSchema.safeParse(req.params);
    if (!parsed.success) {
      return res.status(400).json(schemas.formatZodError(parsed.error));
    }

    try {
      const task = await tasks.reopenTask(parsed.data.id);
      if (!task) {
        return res.status(404).json({ error: 'Task not found' });
      }
      return res.status(200).json(task);
    } catch (_err) {
      console.error('Failed to reopen task: database error');
      return res.status(500).json({ error: 'Failed to reopen task' });
    }
  });

  router.post('/:id/archive', async (req, res) => {
    const parsed = schemas.taskIdParamSchema.safeParse(req.params);
    if (!parsed.success) {
      return res.status(400).json(schemas.formatZodError(parsed.error));
    }

    try {
      const task = await tasks.archiveTask(parsed.data.id);
      if (!task) {
        return res.status(404).json({ error: 'Task not found' });
      }
      return res.status(200).json(task);
    } catch (_err) {
      console.error('Failed to archive task: database error');
      return res.status(500).json({ error: 'Failed to archive task' });
    }
  });

  return router;
}

module.exports = {
  createTasksRouter,
  logTaskFailure,
  respondTaskWriteError,
};
