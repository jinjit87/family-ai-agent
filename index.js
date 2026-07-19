const express = require('express');
const crypto = require('crypto');
const { google } = require('googleapis');
const app = express();

app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

const VERIFY_TOKEN = 'family-ai-verify-123';

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  'https://web-production-a96f23.up.railway.app/auth/callback'
);

const KIDS = [
  { name: 'Avi', age: 14, calendar: 'Avi' },
  { name: 'Rephael', age: 13, calendar: 'Rephael' },
  { name: 'Uriel', age: 11, calendar: 'Uriel' },
  { name: 'Morielle', age: 9, calendar: 'Morielle' },
  { name: 'Gabi', age: 7, calendar: 'Gabi' },
  { name: 'Romi', age: 3, calendar: 'Romi' }
];

function verifyMetaSignature(req) {
  const signature = req.headers['x-hub-signature-256'];
  if (!signature) return false;
  const expectedSignature = 'sha256=' + crypto
    .createHmac('sha256', process.env.META_APP_SECRET)
    .update(req.rawBody)
    .digest('hex');
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
}

async function askAI(message, context = '') {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'llama3-8b-8192',
      messages: [
        {
          role: 'system',
          content: `You are a family assistant for Meytal, a busy working mom with 6 kids in Israel.

KIDS: Avi(14), Rephael(13), Uriel(11), Morielle(9), Gabi(7), Romi(3)
HUSBAND: Eli — never available for pickups or driving. Don't factor him in for logistics.
LANGUAGE: Always reply in English, even if message is in Hebrew.

You handle:
1. PLAYDATES: Check calendar, accept/decline/suggest times. Always confirm before replying.
2. CLASS CHANNELS: Filter noise. Only flag: schedule changes, things to bring, deadlines, permission slips, anything requiring parent action.
3. STUDY SCHEDULES: Extract from kids' schedule images/texts → create calendar events.
4. TUTORS: Handle professionally and efficiently. Don't over-apologize.
5. MAKELAB: When MakeLab posts classes, match to right kids by age, alert Meytal, wait for approval before signing up.
6. CONSTRUCTION: Summarize contractor messages. Flag decisions needed vs just updates.
7. GMAIL: Flag emails needing action. Draft replies for approval.

APPROVE MODE: For replies to others → draft and wait for Meytal's approval.
AUTO MODE: For calendar entries → create automatically, just confirm what you did.

${context}`
        },
        {
          role: 'user',
          content: message
        }
      ]
    })
  });
  const data = await response.json();
  return data.choices?.[0]?.message?.content || 'Sorry, I could not process that.';
}

async function sendWhatsAppMessage(to, message) {
  await fetch(`https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: to,
      text: { body: message }
    })
  });
}

async function getMorningBriefing() {
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const prompt = `Generate a morning briefing for Meytal for ${today}. 
  Check all kids calendars and summarize:
  - What each kid has today
  - Anything requiring action this week
  - Keep it under 10 lines, warm but efficient tone.`;
  return await askAI(prompt);
}

// Google OAuth login
app.get('/auth', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/gmail.modify'
    ]
  });
  res.redirect(url);
});

// Google OAuth callback
app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);
  process.env.GOOGLE_REFRESH_TOKEN = tokens.refresh_token;
  console.log('SAVE THIS REFRESH TOKEN:', tokens.refresh_token);
  res.send('Connected! You can close this tab.');
});

// Morning briefing endpoint
app.get('/morning', async (req, res) => {
  const briefing = await getMorningBriefing();
  await sendWhatsAppMessage(process.env.MY_PHONE_NUMBER, briefing);
  res.send('Morning briefing sent!');
});

// Webhook verification
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Receive WhatsApp messages
app.post('/webhook', async (req, res) => {
  if (!verifyMetaSignature(req)) {
    return res.sendStatus(403);
  }
  const body = req.body;
  if (body.object === 'whatsapp_business_account') {
    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const message = changes?.value?.messages?.[0];
    if (message && message.text) {
      const from = message.from;
      const text = message.text.body;
      console.log(`Message from ${from}: ${text}`);
      const reply = await askAI(text);
      await sendWhatsAppMessage(from, reply);
    }
  }
  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
module.exports = app;
