/**
 * AES-256-GCM token encryption for Gmail OAuth credentials at rest.
 *
 * Never log plaintext tokens, keys, or decrypted values.
 */

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;

/**
 * Parse TOKEN_ENCRYPTION_KEY into a 32-byte Buffer.
 * Accepts: 64-char hex, standard/base64url of 32 bytes, or exact 32-byte utf8 string.
 *
 * @param {string} key
 * @returns {Buffer}
 */
function parseEncryptionKey(key) {
  if (!key || typeof key !== 'string' || key.trim() === '') {
    const err = new Error('Invalid TOKEN_ENCRYPTION_KEY');
    err.code = 'INVALID_TOKEN_ENCRYPTION_KEY';
    throw err;
  }

  const trimmed = key.trim();

  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, 'hex');
  }

  // Try base64 / base64url
  try {
    const normalized = trimmed.replace(/-/g, '+').replace(/_/g, '/');
    const pad = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
    const buf = Buffer.from(normalized + pad, 'base64');
    if (buf.length === KEY_LENGTH) {
      return buf;
    }
  } catch (_e) {
    // fall through
  }

  if (Buffer.byteLength(trimmed, 'utf8') === KEY_LENGTH) {
    return Buffer.from(trimmed, 'utf8');
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
  return parseEncryptionKey(key || '');
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
