// src/server.js
// ─────────────────────────────────────────────
// Express server to handle Paystack webhook and callback
// Exports startServer()
// ─────────────────────────────────────────────

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const { verifyPayment, CREDIT_PACKS } = require('./payments');
const { addCredits, getCredits, deductCredits } = require('./credits');
const { compressPdf } = require('./services/pdf');
const { removeBackground } = require('./services/image');

// Configure multer for handling memory-stored file uploads (max 20MB)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY
);

// JWT Authentication Middleware for Web Routes
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access denied. Token missing.' });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token.' });
    }
    req.user = user;
    next();
  });
}

function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired session. Please log in again.' });
  }
}

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

  app.use(cors({
    origin: [
      'http://localhost:3000',
      'https://your-vercel-app.vercel.app',
      process.env.WEB_APP_URL,
    ].filter(Boolean),
    credentials: true,
  }));

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

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
      const packKey = verification.packKey;
      const pack = CREDIT_PACKS[packKey] || { name: packKey || 'Credit Pack', credits: creditsToAdd };
      const amountPaid = Number(event?.data?.amount || 0) / 100;

      if (telegramId && creditsToAdd > 0) {
        try {
          const newBal = await addCredits(String(telegramId), creditsToAdd);

          try {
            await supabase.from('credit_purchases').insert({
              user_id: String(telegramId),
              pack_name: pack.name,
              pack_key: packKey,
              credits_added: pack.credits,
              amount_paid: amountPaid,
              paystack_reference: reference,
              status: 'confirmed',
              source: 'telegram',
              confirmed_at: new Date().toISOString(),
            });
          } catch (dbErr) {
            console.error('Failed to log credit purchase:', dbErr && dbErr.message);
          }

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

  app.post('/api/auth/signup', async (req, res) => {
    try {
      const { name, email, password } = req.body || {};

      if (!name || !email || !password) {
        return res.status(400).json({ error: 'Name, email and password are required' });
      }

      const normalizedEmail = String(email).trim().toLowerCase();
      const { data: existingUser, error: lookupError } = await supabase
        .from('users')
        .select('user_id')
        .eq('email', normalizedEmail)
        .maybeSingle();

      if (lookupError) {
        console.error('Signup lookup error:', lookupError.message);
        return res.status(500).json({ error: 'Unable to process signup.' });
      }

      if (existingUser) {
        return res.status(409).json({ error: 'An account with this email already exists' });
      }

      const hash = await bcrypt.hash(password, 12);
      const userId = 'web_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      const referralCode = 'FF-' + userId.slice(-4).toUpperCase() + Math.random().toString(36).slice(2, 4).toUpperCase();

      const { error: insertError } = await supabase.from('users').insert({
        user_id: userId,
        email: normalizedEmail,
        password_hash: hash,
        display_name: name,
        credits: 15,
        referral_code: referralCode,
        signup_source: 'web',
        joined_at: new Date().toISOString(),
      });

      if (insertError) {
        console.error('Signup insert error:', insertError.message);
        return res.status(500).json({ error: 'Unable to create account.' });
      }

      const token = jwt.sign(
        { userId, email: normalizedEmail, source: 'web' },
        process.env.JWT_SECRET,
        { expiresIn: '30d' }
      );

      return res.status(201).json({
        success: true,
        token,
        user: {
          userId,
          name,
          email: normalizedEmail,
          credits: 15,
        },
      });
    } catch (err) {
      console.error('Signup error:', err && err.message);
      return res.status(500).json({ error: 'Signup failed.' });
    }
  });

  app.post('/api/auth/login', async (req, res) => {
    try {
      const { email, password } = req.body || {};

      if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
      }

      const normalizedEmail = String(email).trim().toLowerCase();
      const { data: user, error } = await supabase
        .from('users')
        .select('*')
        .eq('email', normalizedEmail)
        .maybeSingle();

      if (error) {
        console.error('Login lookup error:', error.message);
        return res.status(500).json({ error: 'Unable to process login.' });
      }

      if (!user || !user.password_hash) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      const match = await bcrypt.compare(password, user.password_hash);
      if (!match) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      const token = jwt.sign(
        { userId: user.user_id, email: user.email, source: 'web' },
        process.env.JWT_SECRET,
        { expiresIn: '30d' }
      );

      return res.status(200).json({
        success: true,
        token,
        user: {
          userId: user.user_id,
          name: user.display_name,
          email: user.email,
          credits: user.credits,
        },
      });
    } catch (err) {
      console.error('Login error:', err && err.message);
      return res.status(500).json({ error: 'Login failed.' });
    }
  });

  app.get('/api/user/me', requireAuth, async (req, res) => {
    try {
      const userId = req.user && req.user.userId;
      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const { data: user, error } = await supabase
        .from('users')
        .select('*')
        .eq('user_id', userId)
        .maybeSingle();

      if (error) {
        console.error('Fetch user error:', error.message);
        return res.status(500).json({ error: 'Unable to load user profile.' });
      }

      if (!user) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      return res.status(200).json({
        userId: user.user_id,
        name: user.display_name,
        email: user.email,
        credits: user.credits,
        referralCode: user.referral_code,
        joinedAt: user.joined_at,
      });
    } catch (err) {
      console.error('Get user profile error:', err && err.message);
      return res.status(500).json({ error: 'Unable to load user profile.' });
    }
  });

  app.get('/api/user/balance', requireAuth, async (req, res) => {
    try {
      const userId = req.user && req.user.userId;
      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const { data: user, error } = await supabase
        .from('users')
        .select('credits, referral_code')
        .eq('user_id', userId)
        .maybeSingle();

      if (error) {
        console.error('Fetch balance error:', error.message);
        return res.status(500).json({ error: 'Unable to load balance.' });
      }

      if (!user) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      return res.status(200).json({
        credits: user.credits,
        referralCode: user.referral_code,
      });
    } catch (err) {
      console.error('Get balance error:', err && err.message);
      return res.status(500).json({ error: 'Unable to load balance.' });
    }
  });

  app.get('/api/user/profile', authenticateToken, async (req, res) => {
    try {
      const userId = req.user && (req.user.userId || req.user.user_id || req.user.id);
      if (!userId) {
        return res.status(401).json({ error: 'User not authenticated.' });
      }

      const balance = await getCredits(userId);
      return res.json({ userId, credits: balance });
    } catch (err) {
      console.error('Profile error:', err && err.message);
      return res.status(500).json({ error: 'Unable to load profile.' });
    }
  });

  app.post('/api/tools/compress-pdf', authenticateToken, upload.single('file'), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded.' });
      }

      const userId = req.user && (req.user.userId || req.user.user_id || req.user.id);
      const balance = await getCredits(userId);
      if (balance <= 0) {
        return res.status(402).json({ error: 'Insufficient credits.' });
      }

      const result = await compressPdf(req.file.buffer, req.file.originalname || 'file.pdf');
      if (!result || !result.success || !result.buffer) {
        return res.status(500).json({ error: result && result.error ? result.error : 'Compression failed.' });
      }

      await deductCredits(userId, 1, 'compress-pdf');

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${(req.file.originalname || 'compressed.pdf').replace(/\.pdf$/i, '')}-compressed.pdf"`);
      return res.send(result.buffer);
    } catch (err) {
      console.error('Compress PDF error:', err && err.message);
      return res.status(500).json({ error: 'Compression failed.' });
    }
  });

  app.post('/api/tools/remove-background', authenticateToken, upload.single('file'), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded.' });
      }

      const userId = req.user && (req.user.userId || req.user.user_id || req.user.id);
      const balance = await getCredits(userId);
      if (balance <= 0) {
        return res.status(402).json({ error: 'Insufficient credits.' });
      }

      const result = await removeBackground(req.file.buffer);
      if (!result || !result.success || !result.buffer) {
        return res.status(500).json({ error: result && result.error ? result.error : 'Background removal failed.' });
      }

      await deductCredits(userId, 1, 'remove-background');

      res.setHeader('Content-Type', result.outputMimeType || 'image/png');
      res.setHeader('Content-Disposition', 'attachment; filename="removed-background.png"');
      return res.send(result.buffer);
    } catch (err) {
      console.error('Remove background error:', err && err.message);
      return res.status(500).json({ error: 'Background removal failed.' });
    }
  });

      app.listen(port, "0.0.0.0", () => {
    console.log(`✅ Express server running on port ${port} (Paystack webhook endpoints available)`);
  });

  return app;
}







module.exports = { startServer };
