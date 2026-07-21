const { z } = require('zod');

const INBOX_ACCOUNT_SOURCES = ['GMAIL', 'OUTLOOK', 'WHATSAPP', 'SMS', 'MANUAL', 'API'];
const INBOX_STATUSES = [
  'NEW',
  'PROCESSING',
  'READY_FOR_REVIEW',
  'APPROVED',
  'REJECTED',
  'ARCHIVED',
  'FAILED',
];
const URGENCIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT', 'CRITICAL'];
const EMAIL_CATEGORIES = [
  'BILL',
  'RECEIPT',
  'PACKAGE',
  'TRAVEL',
  'WORK',
  'PERSONAL',
  'LEGAL',
  'FINANCIAL',
  'SECURITY',
  'MARKETING',
  'OTHER',
];
const SUGGESTION_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'APPLIED'];
const TASK_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];
const BUSINESS_UNITS = ['TERAMIND', 'MILA', 'TAURUS', 'DOLCE_MILA', 'HOUSE', 'FAMILY', 'OTHER'];
const SORT_FIELDS = ['receivedAt', 'updatedAt', 'urgency'];

const optionalNullableString = z
  .union([z.string(), z.null()])
  .optional()
  .transform((value) => {
    if (value === undefined) return undefined;
    if (value === null) return null;
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  });

const requiredTrimmedString = (field) =>
  z.string().trim().min(1, `${field} is required`).max(500);

const isoDateTime = z.union([z.string().datetime({ offset: true }), z.string().datetime()]);

const optionalIsoDateTime = z
  .union([isoDateTime, z.null()])
  .optional()
  .transform((value) => {
    if (value === undefined) return undefined;
    if (value === null) return null;
    return value;
  });

const recipientsSchema = z
  .union([z.array(z.string().max(320)), z.null()])
  .optional()
  .transform((value) => {
    if (value === undefined) return undefined;
    if (value === null) return null;
    return value.map((v) => v.trim()).filter(Boolean);
  });

const createInboxAccountSchema = z
  .object({
    name: requiredTrimmedString('name'),
    source: z.enum(INBOX_ACCOUNT_SOURCES),
    emailAddress: optionalNullableString,
    externalAccountId: optionalNullableString,
    isActive: z.boolean().optional(),
  })
  .strict();

const updateInboxAccountSchema = z
  .object({
    name: z.string().trim().min(1, 'name cannot be empty').max(500).optional(),
    emailAddress: optionalNullableString,
    externalAccountId: optionalNullableString,
    isActive: z.boolean().optional(),
    syncCursor: optionalNullableString,
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field is required',
  });

const createInboxItemSchema = z
  .object({
    inboxAccountId: requiredTrimmedString('inboxAccountId'),
    source: z.enum(INBOX_ACCOUNT_SOURCES).optional(),
    externalId: requiredTrimmedString('externalId').max(1000),
    threadExternalId: optionalNullableString,
    senderName: optionalNullableString,
    senderIdentifier: requiredTrimmedString('senderIdentifier').max(500),
    recipients: recipientsSchema,
    subject: optionalNullableString,
    rawContent: z.string().min(1, 'rawContent is required').max(500000),
    summary: optionalNullableString,
    status: z.enum(INBOX_STATUSES).optional(),
    confidence: z.number().min(0).max(1).optional().nullable(),
    urgency: z.enum(URGENCIES).optional().nullable(),
    receivedAt: isoDateTime,
  })
  .strict();

const updateInboxItemSchema = z
  .object({
    threadExternalId: optionalNullableString,
    senderName: optionalNullableString,
    senderIdentifier: z.string().trim().min(1).max(500).optional(),
    recipients: recipientsSchema,
    subject: optionalNullableString,
    rawContent: z.string().min(1).max(500000).optional(),
    summary: optionalNullableString,
    status: z.enum(INBOX_STATUSES).optional(),
    confidence: z.number().min(0).max(1).optional().nullable(),
    urgency: z.enum(URGENCIES).optional().nullable(),
    receivedAt: optionalIsoDateTime,
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field is required',
  });

const listInboxItemsQuerySchema = z
  .object({
    q: z.string().trim().max(200).optional(),
    inboxAccountId: z.string().trim().min(1).optional(),
    source: z.enum(INBOX_ACCOUNT_SOURCES).optional(),
    status: z.enum(INBOX_STATUSES).optional(),
    urgency: z.enum(URGENCIES).optional(),
    senderIdentifier: z.string().trim().min(1).max(500).optional(),
    receivedFrom: isoDateTime.optional(),
    receivedTo: isoDateTime.optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    sort: z.enum(SORT_FIELDS).default('receivedAt'),
  })
  .strict();

const idParamSchema = z
  .object({
    id: z.string().trim().min(1, 'id is required'),
  })
  .strict();

const suggestionParamSchema = z
  .object({
    id: z.string().trim().min(1, 'id is required'),
    suggestionId: z.string().trim().min(1, 'suggestionId is required'),
  })
  .strict();

const analyzeInboxBatchSchema = z
  .object({
    messageIds: z.array(z.string().trim().min(1)).max(100).optional(),
    unprocessedOnly: z.boolean().optional(),
    limit: z.number().int().min(1).max(100).optional(),
    inboxAccountId: z.string().trim().min(1).optional(),
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
  INBOX_ACCOUNT_SOURCES,
  INBOX_STATUSES,
  URGENCIES,
  EMAIL_CATEGORIES,
  SUGGESTION_STATUSES,
  TASK_PRIORITIES,
  BUSINESS_UNITS,
  SORT_FIELDS,
  createInboxAccountSchema,
  updateInboxAccountSchema,
  createInboxItemSchema,
  updateInboxItemSchema,
  listInboxItemsQuerySchema,
  idParamSchema,
  suggestionParamSchema,
  analyzeInboxBatchSchema,
  formatZodError,
};
