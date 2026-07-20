const { z } = require('zod');
const { validateEncryptionKey } = require('./tokenEncryption');

const envSchema = z.object({
  PORT: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().min(1),
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  GOOGLE_REDIRECT_URI: z.string().url(),
  GOOGLE_REFRESH_TOKEN: z.string().min(1).optional(),
  ADMIN_API_KEY: z.string().min(1),
  MY_WHATSAPP: z.string().min(1).optional(),
  // Optional in Phase 2 so existing app startup/API behavior is unchanged.
  // Required for Prisma migrations, seeds, and /health/db connectivity.
  DATABASE_URL: z.string().min(1).optional(),
  // Gmail connector: when set, enables encrypted per-account OAuth token storage.
  // Must decode to exactly 32 bytes (64-char hex, base64 of 32 bytes, or 32-byte utf8).
  TOKEN_ENCRYPTION_KEY: z.string().min(1).optional(),
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
 * When TOKEN_ENCRYPTION_KEY is present (Gmail enabled), key length is validated at startup.
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
    DATABASE_URL: source.DATABASE_URL || undefined,
    TOKEN_ENCRYPTION_KEY: source.TOKEN_ENCRYPTION_KEY || undefined,
  });

  if (result.success) {
    // Gmail enabled when TOKEN_ENCRYPTION_KEY is set — validate key material now.
    if (result.data.TOKEN_ENCRYPTION_KEY) {
      try {
        validateEncryptionKey(result.data.TOKEN_ENCRYPTION_KEY);
      } catch (_e) {
        throw new Error('Invalid environment variables: TOKEN_ENCRYPTION_KEY');
      }
    }
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

  // Also surface invalid encryption key when present but wrong length.
  if (source.TOKEN_ENCRYPTION_KEY && String(source.TOKEN_ENCRYPTION_KEY).trim() !== '') {
    try {
      validateEncryptionKey(source.TOKEN_ENCRYPTION_KEY);
    } catch (_e) {
      if (!invalid.includes('TOKEN_ENCRYPTION_KEY')) {
        invalid.push('TOKEN_ENCRYPTION_KEY');
      }
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
