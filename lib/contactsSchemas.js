const { z } = require('zod');

const CONTACT_ROLES = ['SELF', 'FAMILY', 'SCHOOL', 'TUTOR', 'OTHER'];
const SORT_FIELDS = ['name', 'updatedAt'];

const optionalEmail = z
  .union([z.string().email(), z.literal(''), z.null()])
  .optional()
  .transform((value) => {
    if (value === undefined) return undefined;
    if (value === '' || value === null) return null;
    return value;
  });

const optionalNullableString = z
  .union([z.string(), z.null()])
  .optional()
  .transform((value) => {
    if (value === undefined) return undefined;
    if (value === null) return null;
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  });

const createContactSchema = z
  .object({
    name: z.string().trim().min(1, 'name is required').max(200),
    phone: optionalNullableString,
    email: optionalEmail,
    company: optionalNullableString,
    role: z.enum(CONTACT_ROLES).optional(),
    notes: optionalNullableString,
  })
  .strict();

const updateContactSchema = z
  .object({
    name: z.string().trim().min(1, 'name cannot be empty').max(200).optional(),
    phone: optionalNullableString,
    email: optionalEmail,
    company: optionalNullableString,
    role: z.enum(CONTACT_ROLES).optional(),
    notes: optionalNullableString,
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field is required',
  });

const listContactsQuerySchema = z
  .object({
    q: z.string().trim().max(200).optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    sort: z.enum(SORT_FIELDS).default('name'),
  })
  .strict();

const contactIdParamSchema = z
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
  CONTACT_ROLES,
  SORT_FIELDS,
  createContactSchema,
  updateContactSchema,
  listContactsQuerySchema,
  contactIdParamSchema,
  formatZodError,
};
