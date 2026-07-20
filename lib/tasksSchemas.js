const { z } = require('zod');

const TASK_STATUSES = ['OPEN', 'IN_PROGRESS', 'WAITING', 'COMPLETED', 'ARCHIVED'];
const TASK_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];
const TASK_SOURCES = ['MANUAL', 'EMAIL', 'WHATSAPP', 'CALENDAR', 'AI'];
const SORT_FIELDS = ['dueDate', 'priority', 'updatedAt'];

const optionalNullableString = z
  .union([z.string(), z.null()])
  .optional()
  .transform((value) => {
    if (value === undefined) return undefined;
    if (value === null) return null;
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  });

const optionalDueDate = z
  .union([z.string().datetime({ offset: true }), z.string().datetime(), z.null()])
  .optional()
  .transform((value) => {
    if (value === undefined) return undefined;
    if (value === null) return null;
    return value;
  });

const booleanQuery = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .optional()
  .transform((value) => {
    if (value === undefined) return false;
    if (typeof value === 'boolean') return value;
    return value === 'true' || value === '1';
  });

const createTaskSchema = z
  .object({
    title: z.string().trim().min(1, 'title is required').max(500),
    description: optionalNullableString,
    priority: z.enum(TASK_PRIORITIES).optional(),
    status: z.enum(TASK_STATUSES).optional(),
    dueDate: optionalDueDate,
    source: z.enum(TASK_SOURCES).optional(),
    contactId: optionalNullableString,
    conversationId: optionalNullableString,
  })
  .strict();

const updateTaskSchema = z
  .object({
    title: z.string().trim().min(1, 'title cannot be empty').max(500).optional(),
    description: optionalNullableString,
    priority: z.enum(TASK_PRIORITIES).optional(),
    status: z.enum(TASK_STATUSES).optional(),
    dueDate: optionalDueDate,
    source: z.enum(TASK_SOURCES).optional(),
    contactId: optionalNullableString,
    conversationId: optionalNullableString,
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field is required',
  });

const listTasksQuerySchema = z
  .object({
    q: z.string().trim().max(200).optional(),
    status: z.enum(TASK_STATUSES).optional(),
    priority: z.enum(TASK_PRIORITIES).optional(),
    source: z.enum(TASK_SOURCES).optional(),
    contactId: z.string().trim().min(1).optional(),
    includeArchived: booleanQuery,
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    sort: z.enum(SORT_FIELDS).default('updatedAt'),
  })
  .strict();

const taskIdParamSchema = z
  .object({
    id: z.string().trim().min(1, 'id is required'),
  })
  .strict();

/**
 * Format Zod errors into a stable API payload.
 * @param {import('zod').ZodError} error
 */
function formatZodError(error) {
  return {
    error: 'Validation failed',
    details: error.issues.map((issue) => ({
      path: issue.path.join('.') || '(root)',
      message: issue.message,
    })),
  };
}

module.exports = {
  TASK_STATUSES,
  TASK_PRIORITIES,
  TASK_SOURCES,
  SORT_FIELDS,
  createTaskSchema,
  updateTaskSchema,
  listTasksQuerySchema,
  taskIdParamSchema,
  formatZodError,
};
