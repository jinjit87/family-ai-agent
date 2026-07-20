/**
 * Gmail connector HTTP routes.
 *
 * Mount under /gmail.
 * - GET  /gmail/connect                 admin → redirect to Google (Bearer never in URL)
 * - GET  /gmail/callback                public OAuth callback (state-verified)
 * - GET  /gmail/accounts                admin → list Gmail accounts
 * - POST /gmail/accounts/:id/disconnect admin → remove credentials, deactivate
 * - POST /gmail/accounts/:id/sync       admin → manual sync one account
 * - POST /gmail/sync-all                admin → manual sync all active accounts
 *
 * Route ordering: static paths (/connect, /callback, /accounts, /sync-all)
 * before parameterized /accounts/:id/* routes.
 */

const express = require('express');
const { z } = require('zod');
const gmail = require('./gmail');

const idParamSchema = z.object({
  id: z.string().min(1).max(128),
});

/**
 * Temporary debug helper: log internal exception metadata server-side only.
 * API responses must remain generic — never echo these details to clients.
 *
 * Never logs OAuth codes, tokens, client secrets, Authorization headers,
 * DATABASE_URL, or TOKEN_ENCRYPTION_KEY (redacted if present in message/stack).
 *
 * @param {string} action
 * @param {unknown} [err]
 */
function logGmailFailure(action, err) {
  // Keep the stable prefix used by ops/tests.
  console.error(`Failed to ${action} gmail resource`);

  if (err === undefined || err === null) {
    return;
  }

  const name =
    err && typeof err === 'object' && 'name' in err && typeof err.name === 'string'
      ? err.name
      : typeof err === 'object'
        ? 'Error'
        : typeof err;

  const rawMessage =
    err && typeof err === 'object' && 'message' in err && typeof err.message === 'string'
      ? err.message
      : String(err);

  const rawStack =
    err && typeof err === 'object' && 'stack' in err && typeof err.stack === 'string'
      ? err.stack
      : '';

  const message = redactSensitive(rawMessage);
  const frames = rawStack
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('at '))
    .slice(0, 5)
    .map(redactSensitive);

  console.error(
    JSON.stringify({
      gmailDebug: true,
      action,
      errorName: name,
      errorMessage: message,
      stackFrames: frames,
    })
  );
}

/**
 * Redact known secret patterns from a log string. Never invent replacements that
 * could still leak partial secrets — replace matches with a fixed marker.
 * Also strips live env secret values when present (without printing them).
 * @param {string} text
 * @returns {string}
 */
function redactSensitive(text) {
  if (!text || typeof text !== 'string') return '';
  let out = text
    // Authorization headers (any scheme) and bare Bearer tokens
    .replace(/Authorization:\s*\S+(?:\s+\S+)*/gi, 'Authorization: [REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/g, 'Bearer [REDACTED]')
    // Common Google token prefixes
    .replace(/\bya29\.[A-Za-z0-9._\-]+/g, '[REDACTED_ACCESS_TOKEN]')
    .replace(/\b1\/\/[A-Za-z0-9_\-]+/g, '[REDACTED_REFRESH_TOKEN]')
    // OAuth authorization codes in query-like fragments
    .replace(/([?&]code=)[^&\s'"]+/gi, '$1[REDACTED_CODE]')
    .replace(/\bcode[=:]\s*['"]?[A-Za-z0-9._\-/+=]+/gi, 'code=[REDACTED_CODE]')
    // Env-style secret assignments that may appear in messages
    .replace(/\bGOOGLE_CLIENT_SECRET[=:]\S+/gi, 'GOOGLE_CLIENT_SECRET=[REDACTED]')
    .replace(/\bTOKEN_ENCRYPTION_KEY[=:]\S+/gi, 'TOKEN_ENCRYPTION_KEY=[REDACTED]')
    .replace(/\bDATABASE_URL[=:]\S+/gi, 'DATABASE_URL=[REDACTED]')
    .replace(/\bADMIN_API_KEY[=:]\S+/gi, 'ADMIN_API_KEY=[REDACTED]')
    // Connection strings
    .replace(/postgres(?:ql)?:\/\/[^\s'"]+/gi, '[REDACTED_DATABASE_URL]')
    // refresh_token / access_token JSON-ish fields
    .replace(/("?(?:access|refresh)_token"?\s*[:=]\s*)["']?[^"',}\s]+/gi, '$1[REDACTED]')
    // Standalone access/refresh token material (including test fixtures)
    .replace(/\b(?:access|refresh)[-_]?token[-_]?[A-Za-z0-9]*\b/gi, '[REDACTED_TOKEN]');

  // Strip live process.env secret values if they appear (compare only; never log values).
  const envSecrets = [
    process.env.TOKEN_ENCRYPTION_KEY,
    process.env.DATABASE_URL,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.ADMIN_API_KEY,
    process.env.GOOGLE_REFRESH_TOKEN,
  ];
  for (const secret of envSecrets) {
    if (typeof secret === 'string' && secret.length >= 8 && out.includes(secret)) {
      out = out.split(secret).join('[REDACTED]');
    }
  }

  return out;
}

/**
 * Simple HTML success page after OAuth (no secrets).
 * @param {string} email
 */
function successHtml(email) {
  const safeEmail = String(email || 'Gmail account')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Gmail connected</title></head>
<body>
  <h1>Gmail connected</h1>
  <p>${safeEmail} is connected. You can close this window and sync from the API.</p>
</body>
</html>`;
}

/**
 * @param {string} message
 */
function failureHtml(message) {
  const safe = String(message)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Gmail connection failed</title></head>
<body>
  <h1>Gmail connection failed</h1>
  <p>${safe}</p>
</body>
</html>`;
}

/**
 * @param {{ adminAuth: import('express').RequestHandler, env: Record<string, string | undefined> }} options
 */
function createGmailRouter({ adminAuth, env }) {
  const router = express.Router();

  // ---- Public callback (must be registered without adminAuth) ----
  // Mounted as a separate handler in index.js for clarity; also available here
  // when the router is used as a whole with selective auth below.

  router.get('/callback', async (req, res) => {
    try {
      // Never reflect raw Google query params (error, error_description, code) in responses.
      const result = await gmail.handleOAuthCallback(
        {
          code: typeof req.query.code === 'string' ? req.query.code : undefined,
          state: typeof req.query.state === 'string' ? req.query.state : undefined,
          error: typeof req.query.error === 'string' ? req.query.error : undefined,
        },
        env
      );
      if (result.account) {
        if (req.query.format === 'json') {
          return res.status(200).json({
            status: 'ok',
            account: {
              id: result.account.id,
              emailAddress: result.account.emailAddress,
              isActive: result.account.isActive,
            },
          });
        }
        return res.status(200).send(successHtml(result.account.emailAddress));
      }

      const message =
        result.error === 'invalid_state'
          ? 'Invalid or expired OAuth state. Start again from /gmail/connect.'
          : result.error === 'not_configured'
            ? 'Gmail connector is not configured.'
            : result.error === 'invalid_request'
              ? 'Missing authorization code or state. Start again from /gmail/connect.'
              : 'Google authorization failed.';

      if (req.query.format === 'json') {
        return res.status(result.status || 400).json({ error: message });
      }
      return res.status(result.status || 400).send(failureHtml(message));
    } catch (err) {
      logGmailFailure('complete oauth callback', err);
      if (req.query.format === 'json') {
        return res.status(400).json({ error: 'Google authorization failed.' });
      }
      return res.status(400).send(failureHtml('Google authorization failed.'));
    }
  });

  // ---- Admin-protected routes ----
  router.get('/connect', adminAuth, async (req, res) => {
    try {
      const result = await gmail.buildConnectUrl(env);
      if (result.notConfigured) {
        return res.status(503).json({ error: 'Gmail connector is not configured' });
      }

      // Prefer JSON when requested so clients can open the URL without following redirects
      // (and without putting the admin Bearer token into a browser URL).
      const wantsJson =
        req.query.format === 'json' ||
        (typeof req.headers.accept === 'string' && req.headers.accept.includes('application/json'));

      if (wantsJson) {
        return res.status(200).json({ authorizationUrl: result.url });
      }
      return res.redirect(result.url);
    } catch (err) {
      // TEMPORARY DEBUG: log internal exception (name/message/top frames) server-side only.
      logGmailFailure('start oauth connect', err);
      return res.status(500).json({ error: 'Failed to start Gmail connection' });
    }
  });

  router.get('/accounts', adminAuth, async (_req, res) => {
    try {
      const result = await gmail.listGmailAccounts();
      return res.status(200).json(result);
    } catch (err) {
      logGmailFailure('list accounts', err);
      return res.status(500).json({ error: 'Failed to list Gmail accounts' });
    }
  });

  // Static /sync-all before /accounts/:id/...
  router.post('/sync-all', adminAuth, async (_req, res) => {
    try {
      const result = await gmail.syncAllGmailAccounts(env);
      if (result.notConfigured) {
        return res.status(503).json({ error: 'Gmail connector is not configured' });
      }
      return res.status(200).json(result);
    } catch (err) {
      logGmailFailure('sync all accounts', err);
      return res.status(500).json({ error: 'Failed to sync Gmail accounts' });
    }
  });

  router.post('/accounts/:id/disconnect', adminAuth, async (req, res) => {
    const parsed = idParamSchema.safeParse(req.params);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid account id' });
    }
    try {
      const result = await gmail.disconnectGmailAccount(parsed.data.id);
      if (result.notFound) {
        return res.status(404).json({ error: 'Gmail account not found' });
      }
      return res.status(200).json({ account: result.account });
    } catch (err) {
      logGmailFailure('disconnect account', err);
      return res.status(500).json({ error: 'Failed to disconnect Gmail account' });
    }
  });

  router.post('/accounts/:id/sync', adminAuth, async (req, res) => {
    const parsed = idParamSchema.safeParse(req.params);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid account id' });
    }
    try {
      const result = await gmail.syncGmailAccount(parsed.data.id, env);
      if (result.notConfigured) {
        return res.status(503).json({ error: 'Gmail connector is not configured' });
      }
      if (result.notFound) {
        return res.status(404).json({ error: 'Gmail account not found' });
      }
      if (result.inactive) {
        return res.status(409).json({ error: 'Gmail account is inactive' });
      }
      if (result.reconnectRequired) {
        return res.status(409).json({
          error: 'Gmail reconnection required',
          code: 'RECONNECT_REQUIRED',
        });
      }
      if (result.syncInProgress) {
        return res.status(409).json({
          error: 'Gmail sync already in progress',
          code: 'SYNC_IN_PROGRESS',
        });
      }
      if (result.authError) {
        return res.status(401).json({ error: 'Gmail authorization failed' });
      }
      if (result.syncFailed) {
        return res.status(503).json({
          error: 'Gmail sync failed',
          cursorUnchanged: true,
          created: result.created || 0,
          skipped: result.skipped || 0,
        });
      }
      return res.status(200).json({
        status: 'ok',
        created: result.created,
        skipped: result.skipped,
        excluded: result.excluded,
        fetched: result.fetched,
        account: result.account,
      });
    } catch (err) {
      logGmailFailure('sync account', err);
      return res.status(500).json({ error: 'Failed to sync Gmail account' });
    }
  });

  return router;
}

module.exports = {
  createGmailRouter,
  successHtml,
  failureHtml,
  logGmailFailure,
  redactSensitive,
};
