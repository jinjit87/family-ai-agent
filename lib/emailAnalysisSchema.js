const { z } = require('zod');

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

const EMAIL_URGENCIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

/**
 * Accept ISO datetime, date-only (YYYY-MM-DD), or null. Normalize to ISO UTC string or null.
 */
const dueDateSchema = z.union([z.string(), z.null()]).superRefine((value, ctx) => {
  if (value === null) return;
  const trimmed = value.trim();
  if (!trimmed) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'dueDate cannot be empty' });
    return;
  }
  // Date-only → midnight UTC
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const d = new Date(`${trimmed}T00:00:00.000Z`);
    if (Number.isNaN(d.getTime())) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid dueDate' });
    }
    return;
  }
  const d = new Date(trimmed);
  if (Number.isNaN(d.getTime())) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid dueDate' });
  }
}).transform((value) => {
  if (value === null) return null;
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return `${trimmed}T00:00:00.000Z`;
  }
  return new Date(trimmed).toISOString();
});

/**
 * Strict schema for AI email analysis output.
 * Rejects unknown keys and partial/malformed payloads.
 * If validation fails, callers must mark the message for retry and save nothing.
 */
const emailAnalysisResultSchema = z
  .object({
    category: z.enum(EMAIL_CATEGORIES),
    urgency: z.enum(EMAIL_URGENCIES),
    requiresAction: z.boolean(),
    dueDate: dueDateSchema,
    conciseSummary: z.string().trim().min(1).max(2000),
    suggestedTask: z.union([z.string().trim().min(1).max(1000), z.null()]),
    confidence: z.number().min(0).max(1),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.requiresAction && data.suggestedTask === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['suggestedTask'],
        message: 'suggestedTask is required when requiresAction is true',
      });
    }
  });

/**
 * Parse and validate AI JSON output. Throws ZodError / Error on failure.
 * @param {unknown} raw
 */
function parseEmailAnalysisResult(raw) {
  return emailAnalysisResultSchema.parse(raw);
}

/**
 * Try to extract a JSON object from a model response that may include fences.
 * Does not evaluate code — JSON.parse only.
 * @param {string} text
 * @returns {unknown}
 */
function extractJsonObject(text) {
  if (typeof text !== 'string') {
    throw new Error('AI response is not text');
  }
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error('AI response is empty');
  }

  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1].trim() : trimmed;

  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('AI response does not contain a JSON object');
  }
  const slice = candidate.slice(start, end + 1);
  return JSON.parse(slice);
}

module.exports = {
  EMAIL_CATEGORIES,
  EMAIL_URGENCIES,
  emailAnalysisResultSchema,
  parseEmailAnalysisResult,
  extractJsonObject,
};
