// src/server.js
// ─────────────────────────────────────────────
// Express server to handle Paystack webhook and callback
// Exports startServer()
// ─────────────────────────────────────────────

const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const { verifyPayment } = require('./payments');
const { addCredits } = require('./credits');

/**
 * verifyPaystackSignature
 * Verifies HMAC SHA512 signature from Paystack using raw body
 */
function verifyPaystackSignature(rawBody, signature) {
  try {
    const secret = process.env.PAYSTACK_WEBHOOK_SECRET;
    if (!secret) {
      console.error('PAYSTACK_WEBHOOK_SECRET is not set');
      return false;
    }
    const hash = crypto.createHmac('sha512', secret).update(rawBody).digest('hex');
    return hash === signature;
  } catch (e) {
    console.error('Signature verification error:', e && e.message);
    return false;
  }
}

function startServer() {
  const app = express();
  const port = process.env.PORT || 3000;

  // Paystack webhook - must use raw body for signature verification
  app.post('/paystack/webhook', express.raw({ type: '*/*' }), async (req, res) => {
    try {
      const signature = req.headers['x-paystack-signature'];
      const raw = req.body;

      if (!verifyPaystackSignature(raw, signature)) {
        console.error('Paystack webhook signature mismatch');
        return res.status(200).send('invalid signature');
      }

      let event;
      try { event = JSON.parse(raw.toString()); } catch (e) { console.error('Invalid JSON in webhook body'); return res.status(400).end(); }

      const eventType = event?.event;
      if (eventType !== 'charge.success') {
        // We only process successful charges
        return res.status(200).send('ignored');
      }

      const reference = event?.data?.reference;
      if (!reference) return res.status(200).send('no reference');

      // Verify transaction with Paystack server-side
      let verification;
      try {
        verification = await verifyPayment(reference);
      } catch (e) {
        console.error('verifyPayment threw error:', e && e.message);
        return res.status(200).send('verify failed');
      }

      if (!verification || !verification.success) {
        console.error('Payment verification failed for reference', reference);
        return res.status(200).send('not successful');
      }

      const telegramId = verification.telegramId;
      const creditsToAdd = Number(verification.credits) || 0;

      if (telegramId && creditsToAdd > 0) {
        try {
          const newBal = await addCredits(String(telegramId), creditsToAdd);
          // Notify user on Telegram
          if (process.env.TELEGRAM_BOT_TOKEN) {
            const text = `✅ Payment confirmed! ${creditsToAdd} credits have been added.\nYour new balance: ${newBal} credits.\nType /start to continue.`;
            await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
              chat_id: telegramId,
              text: text,
              parse_mode: 'Markdown',
            });
          }
        } catch (e) {
          console.error('Failed to add credits or notify user:', e && e.message);
        }
      }

      // Respond 200 to acknowledge delivery
      return res.status(200).send('ok');
    } catch (err) {
      console.error('Error processing webhook:', err && err.message);
      // Return 200 so Paystack does not keep retrying
      return res.status(200).send('error');
    }
  });

  // Callback route where user lands after successful payment
  app.get('/paystack/callback', (req, res) => {
    const html = `
      <!doctype html>
      <html lang="en">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <script src="https://telegram.org/js/telegram-web-app.js"></script>
        <title>Payment Successful</title>
        <style>
          body { font-family: Arial, Helvetica, sans-serif; background: #f6f9fb; color: #111; display:flex; align-items:center; justify-content:center; height:100vh; margin:0; }
          .card { background:#fff; padding:32px; border-radius:12px; box-shadow:0 8px 24px rgba(0,0,0,0.08); text-align:center; max-width:560px; }
          .check { font-size:48px; color:#16a34a; }
          h1 { margin:12px 0; font-size:20px; }
          p { color:#374151; }
          .button { display:inline-block; margin-top:16px; padding:12px 24px; background:#2563eb; color:#fff; border-radius:8px; text-decoration:none; border:none; font-weight:bold; cursor:pointer; font-size:16px; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="check">✅</div>
          <h1>Payment Successful!</h1>
          <p>Return to Telegram and check your balance. Your credits have been added automatically.</p>
          <button class="button" onclick="closeApp()">Return to Bot ➜</button>
        </div>
        <script>
          const tg = window.Telegram.WebApp;
          tg.ready();
          tg.expand();
          
          function closeApp() {
            tg.close();
          }
          
          // Auto-close after 5 seconds to get the user back to the chat
          setTimeout(() => { tg.close(); }, 5000);
        </script>
      </body>
      </html>
    `;
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  });

  app.listen(port, () => {
    console.log(`✅ Express server running on port ${port} (Paystack webhook endpoints available)`);
  });

  return app;
}

module.exports = { startServer };
