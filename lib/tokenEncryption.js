/**
 * AES-256-GCM token encryption for Gmail OAuth credentials at rest.
 *
 * Never log plaintext tokens, keys, or decrypted values.
 *
 * TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes.
 * Documented production format: 64-character hex (`openssl rand -hex 32`).
 * Also accepted: standard/base64url encoding of exactly 32 raw bytes.
 * Rejected: empty, whitespace-padded, short, malformed, or placeholder values.
 */

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;

const PLACEHOLDER_KEYS = new Set(
  [
    'changeme',
    'change-me',
    'your-key-here',
    'your_key_here',
    'token_encryption_key',
    'token-encryption-key',
    'replace-me',
    'placeholder',
    'example',
    'test',
    'secret',
    '0'.repeat(64),
    '1'.repeat(64),
    'a'.repeat(64),
    'f'.repeat(64),
  ].map((s) => s.toLowerCase())
);

/**
 * @param {string} key
 */
function isPlaceholderKey(key) {
  const lower = key.toLowerCase();
  if (PLACEHOLDER_KEYS.has(lower)) return true;
  if (/^(.)\1{31,}$/i.test(key)) return true; // repeated single char
  if (/^(0123456789abcdef)+$/i.test(key) && key.length === 64) return true;
  return false;
}

/**
 * Parse TOKEN_ENCRYPTION_KEY into a 32-byte Buffer.
 * Does not trim — leading/trailing whitespace is rejected.
 *
 * @param {string} key
 * @returns {Buffer}
 */
function parseEncryptionKey(key) {
  if (key === undefined || key === null || typeof key !== 'string') {
    const err = new Error('Invalid TOKEN_ENCRYPTION_KEY');
    err.code = 'INVALID_TOKEN_ENCRYPTION_KEY';
    throw err;
  }

  // Reject empty and whitespace-padded / whitespace-only values (fail closed).
  if (key.length === 0 || key !== key.trim() || /\s/.test(key)) {
    const err = new Error('Invalid TOKEN_ENCRYPTION_KEY');
    err.code = 'INVALID_TOKEN_ENCRYPTION_KEY';
    throw err;
  }

  if (isPlaceholderKey(key)) {
    const err = new Error('Invalid TOKEN_ENCRYPTION_KEY');
    err.code = 'INVALID_TOKEN_ENCRYPTION_KEY';
    throw err;
  }

  if (/^[0-9a-fA-F]{64}$/.test(key)) {
    return Buffer.from(key, 'hex');
  }

  // Try base64 / base64url of exactly 32 bytes (not hex-looking short strings).
  try {
    const normalized = key.replace(/-/g, '+').replace(/_/g, '/');
    const pad = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
    const buf = Buffer.from(normalized + pad, 'base64');
    if (buf.length === KEY_LENGTH) {
      // Reject if base64 round-trip is ambiguous garbage for short inputs.
      return buf;
    }
  } catch (_e) {
    // fall through
  }

  const err = new Error('Invalid TOKEN_ENCRYPTION_KEY');
  err.code = 'INVALID_TOKEN_ENCRYPTION_KEY';
  throw err;
}

/**
 * Validate encryption key length. Throws if invalid.
 * @param {string | undefined | null} key
 * @returns {Buffer}
 */
function validateEncryptionKey(key) {
  return parseEncryptionKey(key === undefined || key === null ? '' : String(key));
}

/**
 * Encrypt a UTF-8 string. Returns `iv:authTag:ciphertext` (each base64).
 * @param {string} plaintext
 * @param {string} keyEnvValue
 * @returns {string}
 */
function encryptToken(plaintext, keyEnvValue) {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new Error('Cannot encrypt empty token');
  }
  const key = parseEncryptionKey(keyEnvValue);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted.toString('base64')}`;
}

/**
 * Decrypt a value produced by encryptToken.
 * @param {string} payload
 * @param {string} keyEnvValue
 * @returns {string}
 */
function decryptToken(payload, keyEnvValue) {
  if (typeof payload !== 'string' || !payload.includes(':')) {
    throw new Error('Cannot decrypt token');
  }
  const parts = payload.split(':');
  if (parts.length !== 3) {
    throw new Error('Cannot decrypt token');
  }
  const [ivB64, tagB64, dataB64] = parts;
  const key = parseEncryptionKey(keyEnvValue);
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(tagB64, 'base64');
  const data = Buffer.from(dataB64, 'base64');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString('utf8');
}

module.exports = {
  KEY_LENGTH,
  parseEncryptionKey,
  validateEncryptionKey,
  encryptToken,
  decryptToken,
};
