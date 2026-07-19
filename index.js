const express = require('express');
const app = express();
app.use(express.json());

const VERIFY_TOKEN = 'family-ai-verify-123';

// Webhook verification (Meta requires this)
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

// Receive messages
app.post('/webhook', async (req, res) => {
  const body = req.body;
  if (body.object === 'whatsapp_business_account') {
    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const message = changes?.value?.messages?.[0];
    if (message) {
      const from = message.from;
      const text = message.text?.body;
      console.log(`Message from ${from}: ${text}`);
      // TODO: send to Claude and reply
    }
  }
  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.start = app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
module.exports = app;
