const db = require('./db');
const { SORT_FIELDS } = require('./tasksSchemas');

/**
 * @typedef {object} TaskRecord
 * @property {string} id
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {string} title
 * @property {string | null} description
 * @property {string} status
 * @property {string} priority
 * @property {Date | null} dueDate
 * @property {Date | null} completedAt
 * @property {string} source
 * @property {string | null} contactId
 * @property {string | null} conversationId
 */

/**
 * Serialize a Prisma task for JSON responses.
 * @param {TaskRecord} task
 */
function serializeTask(task) {
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    priority: task.priority,
    status: task.status,
    dueDate: task.dueDate ? task.dueDate.toISOString() : null,
    completedAt: task.completedAt ? task.completedAt.toISOString() : null,
    source: task.source,
    contactId: task.contactId,
    conversationId: task.conversationId,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
  };
}

/**
 * Build list filters: search, status/priority/source/contactId, archive rule.
 * Archived tasks never appear unless includeArchived=true.
 * @param {{
 *   q?: string,
 *   status?: string,
 *   priority?: string,
 *   source?: string,
 *   contactId?: string,
 *   includeArchived?: boolean,
 * }} query
 */
function buildListWhere(query) {
  /** @type {Record<string, unknown>} */
  const where = {};

  if (query.status) {
    if (!query.includeArchived && query.status === 'ARCHIVED') {
      // Archived tasks never appear unless includeArchived=true
      where.id = { in: [] };
    } else {
      where.status = query.status;
    }
  } else if (!query.includeArchived) {
    where.status = { not: 'ARCHIVED' };
  }

  if (query.priority) {
    where.priority = query.priority;
  }
  if (query.source) {
    where.source = query.source;
  }
  if (query.contactId) {
    where.contactId = query.contactId;
  }

  if (query.q) {
    const term = query.q.trim();
    if (term) {
      where.OR = [
        { title: { contains: term, mode: 'insensitive' } },
        { description: { contains: term, mode: 'insensitive' } },
      ];
    }
  }

  return where;
}

/**
 * @param {'dueDate' | 'priority' | 'updatedAt'} sort
 */
function buildOrderBy(sort) {
  if (sort === 'dueDate') {
    return { dueDate: { sort: 'asc', nulls: 'last' } };
  }
  if (sort === 'priority') {
    // Enum order: LOW < MEDIUM < HIGH < URGENT → desc puts URGENT first
    return { priority: 'desc' };
  }
  return { updatedAt: 'desc' };
}

/**
 * List tasks with search, filters, sorting, and pagination.
 * @param {{
 *   q?: string,
 *   status?: string,
 *   priority?: string,
 *   source?: string,
 *   contactId?: string,
 *   includeArchived?: boolean,
 *   page: number,
 *   limit: number,
 *   sort: string,
 * }} query
 */
async function listTasks(query) {
  const prisma = db.getPrisma();
  const where = buildListWhere(query);
  const sort = SORT_FIELDS.includes(query.sort) ? query.sort : 'updatedAt';
  const skip = (query.page - 1) * query.limit;

  const [total, rows] = await Promise.all([
    prisma.task.count({ where }),
    prisma.task.findMany({
      where,
      orderBy: buildOrderBy(sort),
      skip,
      take: query.limit,
    }),
  ]);

  const totalPages = total === 0 ? 0 : Math.ceil(total / query.limit);

  return {
    data: rows.map(serializeTask),
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages,
    },
  };
}

/**
 * Get one task by id.
 * @param {string} id
 * @returns {Promise<object | null>}
 */
async function getTaskById(id) {
  const prisma = db.getPrisma();
  const task = await prisma.task.findUnique({ where: { id } });
  return task ? serializeTask(task) : null;
}

/**
 * Create a task.
 * @param {object} input
 */
async function createTask(input) {
  const prisma = db.getPrisma();
  const status = input.status ?? 'OPEN';
  const task = await prisma.task.create({
    data: {
      title: input.title,
      description: input.description ?? null,
      priority: input.priority ?? 'MEDIUM',
      status,
      dueDate: input.dueDate ? new Date(input.dueDate) : null,
      completedAt: status === 'COMPLETED' ? new Date() : null,
      source: input.source ?? 'MANUAL',
      contactId: input.contactId ?? null,
      conversationId: input.conversationId ?? null,
    },
  });
  return serializeTask(task);
}

/**
 * Apply completedAt lifecycle rules for a status transition.
 * - COMPLETED → set completedAt (preserve if already completed)
 * - ARCHIVED → preserve completedAt (historical completion is intentional)
 * - OPEN / IN_PROGRESS / WAITING → clear completedAt
 * @param {string | undefined} nextStatus
 * @param {TaskRecord} existing
 * @param {Record<string, unknown>} data
 */
function applyCompletedAtLifecycle(nextStatus, existing, data) {
  if (nextStatus === undefined) {
    return;
  }
  if (nextStatus === 'COMPLETED') {
    if (existing.status !== 'COMPLETED' || !existing.completedAt) {
      data.completedAt = new Date();
    }
    return;
  }
  if (nextStatus === 'ARCHIVED') {
    // Intentionally preserve historical completedAt.
    return;
  }
  // OPEN | IN_PROGRESS | WAITING (reopen-style transitions)
  data.completedAt = null;
}

/**
 * True when Prisma rejected a foreign key (invalid contactId / conversationId).
 * @param {unknown} err
 */
function isForeignKeyError(err) {
  return Boolean(err && typeof err === 'object' && 'code' in err && err.code === 'P2003');
}

/**
 * Patch a task. Returns null if missing.
 * Completing via status=COMPLETED sets completedAt; reopening clears it;
 * archiving preserves historical completedAt.
 * @param {string} id
 * @param {object} input
 */
async function updateTask(id, input) {
  const prisma = db.getPrisma();
  const existing = await prisma.task.findUnique({ where: { id } });
  if (!existing) {
    return null;
  }

  /** @type {Record<string, unknown>} */
  const data = { ...input };
  if (input.dueDate !== undefined) {
    data.dueDate = input.dueDate ? new Date(input.dueDate) : null;
  }

  applyCompletedAtLifecycle(input.status, existing, data);

  const task = await prisma.task.update({
    where: { id },
    data,
  });
  return serializeTask(task);
}

/**
 * Mark a task completed and set completedAt.
 * @param {string} id
 */
async function completeTask(id) {
  const prisma = db.getPrisma();
  const existing = await prisma.task.findUnique({ where: { id } });
  if (!existing) {
    return null;
  }

  const task = await prisma.task.update({
    where: { id },
    data: {
      status: 'COMPLETED',
      completedAt: existing.status === 'COMPLETED' && existing.completedAt
        ? existing.completedAt
        : new Date(),
    },
  });
  return serializeTask(task);
}

/**
 * Reopen a task: set status OPEN and clear completedAt.
 * @param {string} id
 */
async function reopenTask(id) {
  const prisma = db.getPrisma();
  const existing = await prisma.task.findUnique({ where: { id } });
  if (!existing) {
    return null;
  }

  const task = await prisma.task.update({
    where: { id },
    data: {
      status: 'OPEN',
      completedAt: null,
    },
  });
  return serializeTask(task);
}

/**
 * Archive a task.
 * Intentionally preserves completedAt when the task was previously completed.
 * @param {string} id
 */
async function archiveTask(id) {
  const prisma = db.getPrisma();
  const existing = await prisma.task.findUnique({ where: { id } });
  if (!existing) {
    return null;
  }

  const task = await prisma.task.update({
    where: { id },
    data: {
      status: 'ARCHIVED',
      // Do not touch completedAt — preserve historical completion time.
    },
  });
  return serializeTask(task);
}

module.exports = {
  serializeTask,
  buildListWhere,
  buildOrderBy,
  applyCompletedAtLifecycle,
  isForeignKeyError,
  listTasks,
  getTaskById,
  createTask,
  updateTask,
  completeTask,
  reopenTask,
  archiveTask,
};
