const express = require('express');
const { google } = require('googleapis');
const { loadEnv } = require('./lib/env');
const { checkDatabaseHealth } = require('./lib/db');
const { createContactsRouter } = require('./lib/contactsRouter');
const { createTasksRouter } = require('./lib/tasksRouter');

const SERVICE_NAME = 'family-ai-agent';
const CALENDAR_READONLY_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';

function requireAdmin(env) {
  return function adminAuth(req, res, next) {
    const header = req.headers.authorization;
    if (!header || typeof header !== 'string') {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
    if (!match || match[1] !== env.ADMIN_API_KEY) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    return next();
  };
}

function createOAuthClient(env) {
  const oauth2Client = new google.auth.OAuth2(
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET,
    env.GOOGLE_REDIRECT_URI
  );

  if (env.GOOGLE_REFRESH_TOKEN) {
    oauth2Client.setCredentials({ refresh_token: env.GOOGLE_REFRESH_TOKEN });
  }

  return oauth2Client;
}

async function getCalendarEvents(oauth2Client) {
  try {
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    const now = new Date();
    const end = new Date();
    end.setDate(end.getDate() + 7);
    const kids = ['Avi', 'Rephael', 'Uriel', 'Morielle', 'Gabi', 'Romi'];
    let allEvents = [];
    for (const kid of kids) {
      try {
        const res = await calendar.events.list({
          calendarId: 'primary',
          timeMin: now.toISOString(),
          timeMax: end.toISOString(),
          singleEvents: true,
          orderBy: 'startTime',
          q: kid,
        });
        const events = (res.data.items || []).map((e) => ({
          kid,
          title: e.summary,
          start: e.start.dateTime || e.start.date,
        }));
        allEvents = allEvents.concat(events);
      } catch (_e) {
        // Swallow per-kid failures; continue with remaining kids.
      }
    }
    return allEvents;
  } catch (_e) {
    return [];
  }
}

async function askAI(apiKey, message, calendarContext = '') {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: `You are Meytal's family assistant in Israel.

STRICT RULES — NEVER BREAK THESE:
1. NEVER reply to anyone without Meytal's explicit approval
2. NEVER make up dates, times, or events — only use real calendar data provided to you
3. NEVER fabricate information — if you don't know something, say so
4. ALWAYS translate Hebrew to English in your summaries
5. NEVER take any action — only suggest and wait for approval
6. For class groups: only flag schedule changes, things to bring, deadlines, permission slips
7. For playdates: draft a reply but ALWAYS send to Meytal for approval first
8. For tutors: draft a reply but ALWAYS send to Meytal for approval first

KIDS: Avi(14), Rephael(13), Uriel(11), Morielle(9), Gabi(7), Romi(3)
HUSBAND: Eli — never available for pickups or driving.

CALENDAR DATA (use ONLY this, never invent):
${calendarContext || 'No calendar data available right now.'}

When suggesting a reply, format it exactly like this:
SUMMARY: [what the message is about in English]
SUGGESTED REPLY: [your suggested reply]
REASON: [why you suggest this]`,
      messages: [{ role: 'user', content: message }],
    }),
  });
  const data = await response.json();
  return data.content?.[0]?.text || 'Could not process this message.';
}

/**
 * Build the Express app. WhatsApp/Baileys is intentionally not initialized.
 */
function createApp(env) {
  const app = express();
  app.use(express.json());

  const oauth2Client = createOAuthClient(env);
  const adminAuth = requireAdmin(env);

  app.get('/health', (_req, res) => {
    res.status(200).json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      service: SERVICE_NAME,
    });
  });

  // Database connectivity check (Phase 2). Does not alter /health.
  // Public body never includes error details, connection strings, or credentials.
  app.get('/health/db', async (_req, res) => {
    const result = await checkDatabaseHealth();
    if (!result.ok) {
      // Generic only — never log DATABASE_URL, credentials, or raw driver errors.
      console.error('Database health check failed');
    }
    return res.status(result.ok ? 200 : 503).json({
      status: result.ok ? 'ok' : 'error',
      database: result.ok ? 'up' : 'down',
      latencyMs: result.latencyMs,
      timestamp: new Date().toISOString(),
      service: SERVICE_NAME,
    });
  });

  // Operational: start Google OAuth (Calendar readonly only).
  app.get('/auth', adminAuth, (_req, res) => {
    const url = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: [CALENDAR_READONLY_SCOPE],
    });
    res.redirect(url);
  });

  // Google OAuth callback — must remain reachable without Bearer auth.
  // Never log or return token/code values.
  app.get('/auth/callback', async (req, res) => {
    try {
      const code = req.query.code;
      if (!code || typeof code !== 'string') {
        return res.status(400).send('Google authorization failed.');
      }

      const { tokens } = await oauth2Client.getToken(code);
      oauth2Client.setCredentials(tokens);

      if (tokens.refresh_token) {
        return res
          .status(200)
          .send(
            'Google connected. A refresh token was issued — store GOOGLE_REFRESH_TOKEN in your host environment (never commit it). This page does not display token values.'
          );
      }

      return res
        .status(200)
        .send('Google connected. No new refresh token was returned (an existing one may already be stored).');
    } catch (_err) {
      return res.status(400).send('Google authorization failed.');
    }
  });

  // Operational: morning briefing. WhatsApp delivery is disabled in Phase 1.
  app.get('/morning', adminAuth, async (_req, res) => {
    try {
      const events = await getCalendarEvents(oauth2Client);
      const calendarContext =
        events.length > 0
          ? events.map((e) => `${e.kid}: ${e.title} on ${e.start}`).join('\n')
          : 'No events found.';
      const briefing = await askAI(
        env.ANTHROPIC_API_KEY,
        'Generate a morning briefing for Meytal based ONLY on the real calendar events provided. Do not invent any events.',
        calendarContext
      );

      return res.status(200).json({
        status: 'ok',
        whatsappDelivery: 'disabled',
        briefing,
      });
    } catch (_err) {
      return res.status(500).json({ error: 'Failed to generate morning briefing' });
    }
  });

  // Explicitly reject the former public QR pairing route.
  app.all('/qr', (_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Phase 3: Contacts CRUD (additive — does not alter existing endpoints).
  // Must be registered before the final catch-all 404 handler.
  app.use('/contacts', createContactsRouter({ adminAuth }));

  // Phase 4: Task Engine (additive — does not alter existing endpoints).
  app.use('/tasks', createTasksRouter({ adminAuth }));

  // Final catch-all — must remain the last route/middleware.
  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  return app;
}

function startServer() {
  const env = loadEnv();
  const app = createApp(env);
  const port = Number(env.PORT) || 3000;

  app.listen(port, () => {
    console.log(`Server running on port ${port}`);
    console.log('WhatsApp automation is disabled; unofficial Web client is not started.');
  });

  return app;
}

if (require.main === module) {
  try {
    startServer();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = {
  createApp,
  loadEnv,
  requireAdmin,
  SERVICE_NAME,
  CALENDAR_READONLY_SCOPE,
};
