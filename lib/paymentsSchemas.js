const { z } = require('zod');

const PAYMENT_STATUSES = [
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'PAID',
  'OVERDUE',
  'CANCELLED',
  'ARCHIVED',
];

const PAYMENT_SOURCES = ['MANUAL', 'EMAIL', 'WHATSAPP', 'INVOICE', 'AI'];

const BUSINESS_UNITS = [
  'TERAMIND',
  'MILA',
  'TAURUS',
  'DOLCE_MILA',
  'HOUSE',
  'FAMILY',
  'OTHER',
];

const SORT_FIELDS = ['dueDate', 'amount', 'updatedAt', 'payeeName'];

const optionalNullableString = z
  .union([z.string(), z.null()])
  .optional()
  .transform((value) => {
    if (value === undefined) return undefined;
    if (value === null) return null;
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  });

const dueDateSchema = z
  .union([z.string().datetime({ offset: true }), z.string().datetime()])
  .transform((value) => value);

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

/**
 * Money amount: never store as float. Accept string or integer-like number,
 * normalize to a decimal string with up to 4 fractional digits.
 */
const amountSchema = z
  .union([z.string(), z.number()])
  .transform((value, ctx) => {
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'amount must be a finite number' });
        return z.NEVER;
      }
      if (!Number.isInteger(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'amount must be a decimal string (avoid floating-point numbers)',
        });
        return z.NEVER;
      }
      if (value < 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'amount must be non-negative' });
        return z.NEVER;
      }
      return String(value);
    }

    const trimmed = value.trim();
    if (!/^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/.test(trimmed)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'amount must be a non-negative decimal string with up to 4 fractional digits',
      });
      return z.NEVER;
    }
    return trimmed;
  });

const optionalAmountSchema = amountSchema.optional();

/** ISO 4217 three-letter currency codes (uppercase). */
const currencySchema = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .refine((value) => /^[A-Z]{3}$/.test(value), {
    message: 'currency must be an ISO 4217 three-letter code',
  });

const createPaymentSchema = z
  .object({
    payeeName: z.string().trim().min(1, 'payeeName is required').max(500),
    contactId: optionalNullableString,
    businessUnit: z.enum(BUSINESS_UNITS),
    category: optionalNullableString,
    description: optionalNullableString,
    amount: amountSchema,
    currency: currencySchema,
    dueDate: dueDateSchema,
    status: z.enum(PAYMENT_STATUSES).optional(),
    invoiceNumber: optionalNullableString,
    paymentMethod: optionalNullableString,
    notes: optionalNullableString,
    source: z.enum(PAYMENT_SOURCES).optional(),
  })
  .strict();

const updatePaymentSchema = z
  .object({
    payeeName: z.string().trim().min(1, 'payeeName cannot be empty').max(500).optional(),
    contactId: optionalNullableString,
    businessUnit: z.enum(BUSINESS_UNITS).optional(),
    category: optionalNullableString,
    description: optionalNullableString,
    amount: optionalAmountSchema,
    currency: currencySchema.optional(),
    dueDate: optionalDueDate,
    status: z.enum(PAYMENT_STATUSES).optional(),
    invoiceNumber: optionalNullableString,
    paymentMethod: optionalNullableString,
    notes: optionalNullableString,
    source: z.enum(PAYMENT_SOURCES).optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field is required',
  });

const listPaymentsQuerySchema = z
  .object({
    q: z.string().trim().max(200).optional(),
    status: z.enum(PAYMENT_STATUSES).optional(),
    businessUnit: z.enum(BUSINESS_UNITS).optional(),
    currency: currencySchema.optional(),
    contactId: z.string().trim().min(1).optional(),
    dueFrom: optionalDueDate,
    dueTo: optionalDueDate,
    includeArchived: booleanQuery,
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    sort: z.enum(SORT_FIELDS).default('dueDate'),
  })
  .strict()
  .refine(
    (data) => {
      if (data.dueFrom == null || data.dueTo == null) return true;
      return new Date(data.dueFrom).getTime() <= new Date(data.dueTo).getTime();
    },
    { message: 'dueFrom must be on or before dueTo', path: ['dueFrom'] }
  );

const paymentIdParamSchema = z
  .object({
    id: z.string().trim().min(1, 'id is required'),
  })
  .strict();

const markPaidSchema = z
  .object({
    paymentMethod: optionalNullableString,
    notes: optionalNullableString,
  })
  .strict()
  .refine(
    (data) => {
      const method = data.paymentMethod;
      const notes = data.notes;
      return (method != null && method !== '') || (notes != null && notes !== '');
    },
    {
      message: 'paymentMethod or notes explaining the payment is required',
      path: ['paymentMethod'],
    }
  );

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
  PAYMENT_STATUSES,
  PAYMENT_SOURCES,
  BUSINESS_UNITS,
  SORT_FIELDS,
  createPaymentSchema,
  updatePaymentSchema,
  listPaymentsQuerySchema,
  paymentIdParamSchema,
  markPaidSchema,
  formatZodError,
  amountSchema,
  currencySchema,
};
