const { z } = require('zod');

const envSchema = z.object({
  PORT: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().min(1),
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  GOOGLE_REDIRECT_URI: z.string().url(),
  GOOGLE_REFRESH_TOKEN: z.string().min(1).optional(),
  ADMIN_API_KEY: z.string().min(1),
  MY_WHATSAPP: z.string().min(1).optional(),
});

const REQUIRED_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REDIRECT_URI',
  'ADMIN_API_KEY',
];

/**
 * Validate environment variables.
 * On failure, throws an Error listing missing/invalid variable NAMES only (never values).
 */
function loadEnv(source = process.env) {
  const result = envSchema.safeParse({
    PORT: source.PORT || undefined,
    ANTHROPIC_API_KEY: source.ANTHROPIC_API_KEY || undefined,
    GOOGLE_CLIENT_ID: source.GOOGLE_CLIENT_ID || undefined,
    GOOGLE_CLIENT_SECRET: source.GOOGLE_CLIENT_SECRET || undefined,
    GOOGLE_REDIRECT_URI: source.GOOGLE_REDIRECT_URI || undefined,
    GOOGLE_REFRESH_TOKEN: source.GOOGLE_REFRESH_TOKEN || undefined,
    ADMIN_API_KEY: source.ADMIN_API_KEY || undefined,
    MY_WHATSAPP: source.MY_WHATSAPP || undefined,
  });

  if (result.success) {
    return result.data;
  }

  const missing = [];
  const invalid = [];

  for (const key of REQUIRED_ENV_KEYS) {
    const value = source[key];
    if (value === undefined || value === null || String(value).trim() === '') {
      missing.push(key);
    }
  }

  for (const issue of result.error.issues) {
    const key = issue.path.join('.') || 'unknown';
    if (REQUIRED_ENV_KEYS.includes(key) && missing.includes(key)) {
      continue;
    }
    if (!missing.includes(key) && !invalid.includes(key)) {
      invalid.push(key);
    }
  }

  const parts = [];
  if (missing.length > 0) {
    parts.push(`Missing required environment variables: ${missing.join(', ')}`);
  }
  if (invalid.length > 0) {
    parts.push(`Invalid environment variables: ${invalid.join(', ')}`);
  }
  if (parts.length === 0) {
    parts.push('Environment validation failed');
  }

  throw new Error(parts.join('. '));
}

module.exports = {
  envSchema,
  loadEnv,
  REQUIRED_ENV_KEYS,
};
