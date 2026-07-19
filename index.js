const express = require('express');
const crypto = require('crypto');
const app = express();

app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

const VERIFY_TOKEN = 'family-ai-verify-123';

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

async function askAI(message) {
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
          content: `You are a family assistant for Meytal. You help with:
1. PLAYDATES: Check if kids are free and coordinate schedules
2. CLASS CHANNELS: Filter WhatsApp messages, translate Hebrew to English, only flag what parents need to know
3. STUDY SCHEDULES: When kids send their school schedule, extract study times
4. TUTORS: Handle tutor messages professionally but efficiently
Always reply in English. Be concise.`
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

async function sendWhatsAppReply(to, message) {
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

app.post('/webhook', async (req, res) => {
  if (!verifyMetaSignature(req)) {
    console.log('Invalid signature - rejected');
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
      await sendWhatsAppReply(from, reply);
    }
  }
  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
module.exports = app;
