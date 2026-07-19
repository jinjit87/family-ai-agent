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
2. CLASS CHANNELS: Filter WhatsApp messages, translate Hebrew to English, only flag what parents need to know (schedule changes, things to bring, deadlines, permission slips)
3. STUDY
