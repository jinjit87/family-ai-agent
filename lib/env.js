const { z } = require('zod');
const { validateEncryptionKey } = require('./tokenEncryption');

const envSchema = z.object({
  PORT: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().min(1),
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  // Preferred Calendar callback. Production: .../auth/callback
  GOOGLE_CALENDAR_REDIRECT_URI: z.string().url().optional(),
  // Preferred Gmail callback. Production: .../gmail/callback
  GOOGLE_GMAIL_REDIRECT_URI: z.string().url().optional(),
  /**
   * Deprecated temporary Calendar-only fallback.
   * Prefer GOOGLE_CALENDAR_REDIRECT_URI. Planned removal after all environments
   * migrate (see README). Never used for Gmail.
   */
  GOOGLE_REDIRECT_URI: z.string().url().optional(),
  GOOGLE_REFRESH_TOKEN: z.string().min(1).optional(),
  ADMIN_API_KEY: z.string().min(1),
  MY_WHATSAPP: z.string().min(1).optional(),
  DATABASE_URL: z.string().min(1).optional(),
  // 64-char hex (32 bytes). Required when Gmail connector is enabled.
  TOKEN_ENCRYPTION_KEY: z.string().min(1).optional(),
  GMAIL_INITIAL_SYNC_MAX_MESSAGES: z.string().optional(),
  GMAIL_HISTORY_MAX_PAGES: z.string().optional(),
  GMAIL_SYNC_TIMEOUT_MS: z.string().optional(),
  GMAIL_API_MAX_RETRIES: z.string().optional(),
  GMAIL_SYNC_LEASE_MS: z.string().optional(),
});

const REQUIRED_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'ADMIN_API_KEY',
];

const GMAIL_REQUIRED_WHEN_ENABLED = [
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_GMAIL_REDIRECT_URI',
  'TOKEN_ENCRYPTION_KEY',
  'DATABASE_URL',
];

/**
 * True when the operator has signaled intent to enable Gmail (any related var set).
 * Fail-closed: partial Gmail config is rejected at startup.
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} source
 */
function hasGmailConfigSignal(source) {
  const gmailUri = source.GOOGLE_GMAIL_REDIRECT_URI;
  const key = source.TOKEN_ENCRYPTION_KEY;
  return (
    (typeof gmailUri === 'string' && gmailUri.trim() !== '') ||
    (typeof key === 'string' && key.length > 0)
  );
}

/**
 * Resolve Calendar redirect URI.
 * Prefers GOOGLE_CALENDAR_REDIRECT_URI; falls back to deprecated GOOGLE_REDIRECT_URI.
 * @param {Record<string, string | undefined>} data
 * @param {{ warn?: (msg: string) => void }} [opts]
 */
function resolveCalendarRedirectUri(data, opts = {}) {
  if (data.GOOGLE_CALENDAR_REDIRECT_URI) {
    return { uri: data.GOOGLE_CALENDAR_REDIRECT_URI, usedDeprecatedFallback: false };
  }
  if (data.GOOGLE_REDIRECT_URI) {
    const warn = opts.warn || ((msg) => console.warn(msg));
    warn(
      'DEPRECATED: GOOGLE_REDIRECT_URI is a temporary Calendar-only fallback. Set GOOGLE_CALENDAR_REDIRECT_URI and remove GOOGLE_REDIRECT_URI.'
    );
    return { uri: data.GOOGLE_REDIRECT_URI, usedDeprecatedFallback: true };
  }
  return { uri: null, usedDeprecatedFallback: false };
}

/**
 * @param {unknown} value
 */
function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === '';
}

/**
 * Validate environment variables.
 * On failure, throws an Error listing missing/invalid variable NAMES only (never values).
 */
function loadEnv(source = process.env) {
  const missing = [];
  const invalid = [];

  for (const key of REQUIRED_ENV_KEYS) {
    if (isBlank(source[key])) missing.push(key);
  }

  const calUri = source.GOOGLE_CALENDAR_REDIRECT_URI;
  const legacyUri = source.GOOGLE_REDIRECT_URI;
  const hasCalendarUri = !isBlank(calUri) || !isBlank(legacyUri);
  if (!hasCalendarUri) {
    missing.push('GOOGLE_CALENDAR_REDIRECT_URI');
  }

  for (const key of [
    'GOOGLE_CALENDAR_REDIRECT_URI',
    'GOOGLE_GMAIL_REDIRECT_URI',
    'GOOGLE_REDIRECT_URI',
  ]) {
    const value = source[key];
    if (isBlank(value)) continue;
    try {
      // eslint-disable-next-line no-new
      new URL(String(value));
    } catch (_e) {
      if (!invalid.includes(key)) invalid.push(key);
    }
  }

  const gmailEnabled = hasGmailConfigSignal(source);
  if (gmailEnabled) {
    for (const key of GMAIL_REQUIRED_WHEN_ENABLED) {
      if (isBlank(source[key]) && !missing.includes(key)) {
        missing.push(key);
      }
    }

    const encKey = source.TOKEN_ENCRYPTION_KEY;
    if (typeof encKey === 'string' && encKey.length > 0) {
      try {
        validateEncryptionKey(encKey);
      } catch (_e) {
        // Present but invalid (including whitespace-padded) — never print the value.
        if (missing.includes('TOKEN_ENCRYPTION_KEY')) {
          missing.splice(missing.indexOf('TOKEN_ENCRYPTION_KEY'), 1);
        }
        if (!invalid.includes('TOKEN_ENCRYPTION_KEY')) {
          invalid.push('TOKEN_ENCRYPTION_KEY');
        }
      }
    }
  }

  const result = envSchema.safeParse({
    PORT: source.PORT || undefined,
    ANTHROPIC_API_KEY: source.ANTHROPIC_API_KEY || undefined,
    GOOGLE_CLIENT_ID: source.GOOGLE_CLIENT_ID || undefined,
    GOOGLE_CLIENT_SECRET: source.GOOGLE_CLIENT_SECRET || undefined,
    GOOGLE_CALENDAR_REDIRECT_URI: source.GOOGLE_CALENDAR_REDIRECT_URI || undefined,
    GOOGLE_GMAIL_REDIRECT_URI: source.GOOGLE_GMAIL_REDIRECT_URI || undefined,
    GOOGLE_REDIRECT_URI: source.GOOGLE_REDIRECT_URI || undefined,
    GOOGLE_REFRESH_TOKEN: source.GOOGLE_REFRESH_TOKEN || undefined,
    ADMIN_API_KEY: source.ADMIN_API_KEY || undefined,
    MY_WHATSAPP: source.MY_WHATSAPP || undefined,
    DATABASE_URL: source.DATABASE_URL || undefined,
    TOKEN_ENCRYPTION_KEY: source.TOKEN_ENCRYPTION_KEY || undefined,
    GMAIL_INITIAL_SYNC_MAX_MESSAGES: source.GMAIL_INITIAL_SYNC_MAX_MESSAGES || undefined,
    GMAIL_HISTORY_MAX_PAGES: source.GMAIL_HISTORY_MAX_PAGES || undefined,
    GMAIL_SYNC_TIMEOUT_MS: source.GMAIL_SYNC_TIMEOUT_MS || undefined,
    GMAIL_API_MAX_RETRIES: source.GMAIL_API_MAX_RETRIES || undefined,
    GMAIL_SYNC_LEASE_MS: source.GMAIL_SYNC_LEASE_MS || undefined,
  });

  if (!result.success) {
    for (const issue of result.error.issues) {
      const key = issue.path.join('.') || 'unknown';
      if (missing.includes(key) || invalid.includes(key)) continue;
      // Optional fields that failed URL parse already handled; required blanks in missing.
      if (!REQUIRED_ENV_KEYS.includes(key) && isBlank(source[key])) continue;
      invalid.push(key);
    }
  }

  if (missing.length > 0 || invalid.length > 0) {
    const parts = [];
    if (missing.length > 0) {
      parts.push(`Missing required environment variables: ${[...new Set(missing)].join(', ')}`);
    }
    if (invalid.length > 0) {
      parts.push(`Invalid environment variables: ${[...new Set(invalid)].join(', ')}`);
    }
    throw new Error(parts.join('. '));
  }

  const data = result.data;
  const resolved = resolveCalendarRedirectUri(data);
  if (!resolved.uri) {
    throw new Error('Missing required environment variables: GOOGLE_CALENDAR_REDIRECT_URI');
  }

  return {
    ...data,
    GOOGLE_CALENDAR_REDIRECT_URI: resolved.uri,
    GOOGLE_GMAIL_REDIRECT_URI: data.GOOGLE_GMAIL_REDIRECT_URI,
    gmailEnabled,
  };
}

/**
 * Runtime check: Gmail connector fully configured (fail closed).
 * @param {Record<string, unknown>} env
 */
function isGmailFullyConfigured(env) {
  if (!env || typeof env !== 'object') return false;
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return false;
  if (!env.GOOGLE_GMAIL_REDIRECT_URI || typeof env.GOOGLE_GMAIL_REDIRECT_URI !== 'string') {
    return false;
  }
  if (!env.DATABASE_URL || typeof env.DATABASE_URL !== 'string') return false;
  if (!env.TOKEN_ENCRYPTION_KEY || typeof env.TOKEN_ENCRYPTION_KEY !== 'string') return false;
  try {
    validateEncryptionKey(env.TOKEN_ENCRYPTION_KEY);
    // eslint-disable-next-line no-new
    new URL(env.GOOGLE_GMAIL_REDIRECT_URI);
    return true;
  } catch (_e) {
    return false;
  }
}

module.exports = {
  envSchema,
  loadEnv,
  REQUIRED_ENV_KEYS,
  GMAIL_REQUIRED_WHEN_ENABLED,
  hasGmailConfigSignal,
  resolveCalendarRedirectUri,
  isGmailFullyConfigured,
};
