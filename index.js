const express = require('express');
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { google } = require('googleapis');
const pino = require('pino');
const QRCode = require('qrcode');
const app = express();
app.use(express.json());

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  'https://web-production-a96f23.up.railway.app/auth/callback'
);
if (process.env.GOOGLE_REFRESH_TOKEN) {
  oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
}

const pendingApprovals = new Map();
let approvalCounter = 1;
const MY_NUMBER = process.env.MY_PHONE_NUMBER + '@s.whatsapp.net';
const MONITORED_GROUPS = process.env.MONITORED_GROUPS ?
  process.env.MONITORED_GROUPS.split(',') : [];

let sock;
let latestQR = null;

async function getCalendarEvents() {
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
          q: kid
        });
        const events = (res.data.items || []).map(e => ({
          kid,
          title: e.summary,
          start: e.start.dateTime || e.start.date
        }));
        allEvents = allEvents.concat(events);
      } catch (e) {}
    }
    return allEvents;
  } catch (e) {
    return [];
  }
}

async function askAI(message, calendarContext = '') {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
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
      messages: [{ role: 'user', content: message }]
    })
  });
  const data = await response.json();
  return data.content?.[0]?.text || 'Could not process this message.';
}

async function sendToMeytal(message) {
  if (!sock) return;
  await sock.sendMessage(MY_NUMBER, { text: message });
}

async function createApproval(from, originalText, suggestion, isGroup = false) {
  const id = approvalCounter++;
  pendingApprovals.set(id.toString(), { from, originalText, suggestion, isGroup });
  const parts = suggestion.split('\n');
  const suggestedReply = parts.find(p => p.startsWith('SUGGESTED REPLY:'))?.replace('SUGGESTED REPLY:', '').trim();
  const summary = parts.find(p => p.startsWith('SUMMARY:'))?.replace('SUMMARY:', '').trim();
  let msg = `📨 *Message #${id}*\nFrom: ${isGroup ? 'Class group' : from}\n\n📝 *Summary:* ${summary || 'See original'}\n💬 *Original:* "${originalText}"`;
  if (suggestedReply) {
    msg += `\n\n✏️ *Suggested reply:*\n"${suggestedReply}"\n\nReply with:\n✅ *SEND ${id}*\n✏️ *EDIT ${id} your text*\n❌ *SKIP ${id}*`;
  } else {
    msg += `\n\nReply *OK ${id}* to acknowledge.`;
  }
  await sendToMeytal(msg);
}

async function handleMeytalCommand(text) {
  const upper = text.toUpperCase().trim();
  if (upper.startsWith('SEND ')) {
    const id = upper.replace('SEND ', '').trim();
    const approval = pendingApprovals.get(id);
    if (!approval) return sendToMeytal(`❌ No pending message #${id}`);
    const parts = approval.suggestion.split('\n');
    const suggestedReply = parts.find(p => p.startsWith('SUGGESTED REPLY:'))?.replace('SUGGESTED REPLY:', '').trim();
    if (suggestedReply && sock) {
      await sock.sendMessage(approval.from, { text: suggestedReply });
      pendingApprovals.delete(id);
      await sendToMeytal(`✅ Reply sent for message #${id}`);
    }
    return;
  }
  if (upper.startsWith('EDIT ')) {
    const rest = text.replace(/^EDIT /i, '').trim();
    const spaceIdx = rest.indexOf(' ');
    const id = rest.substring(0, spaceIdx);
    const customReply = rest.substring(spaceIdx + 1).trim();
    const approval = pendingApprovals.get(id);
    if (!approval) return sendToMeytal(`❌ No pending message #${id}`);
    if (sock) {
      await sock.sendMessage(approval.from, { text: customReply });
      pendingApprovals.delete(id);
      await sendToMeytal(`✅ Your reply sent for message #${id}`);
    }
    return;
  }
  if (upper.startsWith('SKIP ') || upper.startsWith('OK ')) {
    const id = upper.replace('SKIP ', '').replace('OK ', '').trim();
    pendingApprovals.delete(id);
    await sendToMeytal(`✅ Message #${id} skipped`);
    return;
  }
  if (upper === 'LIST') {
    if (pendingApprovals.size === 0) return sendToMeytal('✅ No pending messages!');
    let list = `📋 *Pending (${pendingApprovals.size}):*\n`;
    pendingApprovals.forEach((v, k) => { list += `\n#${k}: "${v.originalText.substring(0, 50)}..."`; });
    await sendToMeytal(list);
  }
}

async function connectWhatsApp() {
  console.log('Starting WhatsApp connection...');
  const { state, saveCreds } = await useMultiFileAuthState('/app/auth_info');
  console.log('Auth state loaded');

  sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      latestQR = qr;
      console.log('QR ready — visit /qr');
    }
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) connectWhatsApp();
    }
    if (connection === 'open') {
      latestQR = null;
      console.log('WhatsApp connected!');
      await sendToMeytal('✅ *Meytal OS is online!*\n\nCommands:\n• *SEND {id}* — approve reply\n• *EDIT {id} your text* — send your own reply\n• *SKIP {id}* — ignore\n• *LIST* — see pending');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const message of messages) {
      if (message.key.fromMe) continue;
      const from = message.key.remoteJid;
      const isGroup = from.endsWith('@g.us');
      const text = message.message?.conversation || message.message?.extendedTextMessage?.text || '';
      if (!text) continue;
      if (from === MY_NUMBER) { await handleMeytalCommand(text); continue; }
      const events = await getCalendarEvents();
      const calendarContext = events.map(e => `${e.kid}: ${e.title} on ${e.start}`).join('\n');
      if (isGroup) {
        if (MONITORED_GROUPS.length > 0 && !MONITORED_GROUPS.includes(from)) continue;
        const analysis = await askAI(`Group message: "${text}"\n\nIs this important for a parent? Translate and summarize in English. If not important, reply with just IGNORE.`, calendarContext);
        if (!analysis.includes('IGNORE')) await sendToMeytal(`📢 *Class group alert:*\n${analysis}`);
        continue;
      }
      const analysis = await askAI(`Direct message from ${from}: "${text}"\n\nAnalyze and draft a reply if needed. Use ONLY the calendar data provided.`, calendarContext);
      await createApproval(from, text, analysis, false);
    }
  });
}

app.get('/qr', async (req, res) => {
  if (!latestQR) return res.send('<h2>✅ WhatsApp already connected!</h2>');
  const qrImage = await QRCode.toDataURL(latestQR);
  res.send(`<html><body style="text-align:center;font-family:sans-serif;padding:40px"><h1>Scan with WhatsApp</h1><p>WhatsApp → Settings → Linked Devices → Link a Device</p><img src="${qrImage}" style="width:300px"/><p><a href="/qr">Refresh</a></p></body></html>`);
});

app.get('/auth', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/gmail.modify']
  });
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);
  console.log('SAVE THIS REFRESH TOKEN:', tokens.refresh_token);
  res.send('Google connected!');
});

app.get('/morning', async (req, res) => {
  const events = await getCalendarEvents();
  const calendarContext = events.length > 0 ? events.map(e => `${e.kid}: ${e.title} on ${e.start}`).join('\n') : 'No events found.';
  const briefing = await askAI('Generate a morning briefing for Meytal based ONLY on the real calendar events provided. Do not invent any events.', calendarContext);
  await sendToMeytal(`☀️ *Good morning Meytal!*\n\n${briefing}`);
  res.send('Morning briefing sent!');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  await connectWhatsApp();
});

module.exports = app;
