// src/payments.js
// ─────────────────────────────────────────────
// Handles all Paystack payment logic.
// Generates a payment link and sends it to user.
// When user pays, Paystack notifies our webhook.
// ─────────────────────────────────────────────

const axios = require('axios');
const crypto = require('crypto');

// Credit pack definitions
// Each pack has a name, price in Naira, and credits given
const CREDIT_PACKS = {
  starter:  { name: 'Starter',  price: 500,   credits: 10  },
  standard: { name: 'Standard', price: 1000,  credits: 25  },
  pro:      { name: 'Pro',      price: 2000,  credits: 60  },
  power:    { name: 'Power',    price: 5000,  credits: 180 },
};

/**
 * generatePaymentLink
 * ───────────────────
 * Creates a Paystack payment link for a user buying a credit pack.
 *
 * @param {string} telegramId  - The user's Telegram ID (used as reference)
 * @param {string} packKey     - One of: "starter", "standard", "pro", "power"
 * @returns {object}           - { success, paymentUrl, pack } or { success: false, error }
 */
async function generatePaymentLink(telegramId, packKey) {
  const pack = CREDIT_PACKS[packKey];

  // Check that the pack exists
  if (!pack) {
    return { success: false, error: 'Invalid credit pack selected.' };
  }

  try {
    // Paystack expects amount in KOBO (multiply Naira by 100)
    const amountInKobo = pack.price * 100;

    // Create a unique reference for this transaction
    // Format: telegramId_packKey_timestamp
    const reference = `fileforge_${telegramId}_${packKey}_${Date.now()}`;

    // Build payload for Paystack initialize. Optionally include a callback_url
    // so users are redirected back to our app after payment.
    const callbackHost = process.env.APP_URL ? String(process.env.APP_URL).replace(/\/$/, '') : null;
    const callbackPath = process.env.PAYSTACK_CALLBACK_PATH || '/paystack/callback';
    const callbackUrl = callbackHost ? `${callbackHost}${callbackPath}` : undefined;

    const payload = {
      amount: amountInKobo,
      email: `user${telegramId}@fileforge.ng`, // Paystack requires an email
      reference: reference,
      currency: 'NGN',
      metadata: {
        telegram_id: telegramId,       // We use this in the webhook
        pack_key: packKey,             // To know which pack was bought
        credits: pack.credits,         // Credits to add after payment
        custom_fields: [
          {
            display_name: 'Pack',
            variable_name: 'pack',
            value: pack.name,
          },
        ],
      },
    };

    // Prefer explicit env var PAYSTACK_CALLBACK_URL if provided
    payload.callback_url = process.env.PAYSTACK_CALLBACK_URL || callbackUrl;

    // Call Paystack API to initialize a transaction
    const response = await axios.post(
      'https://api.paystack.co/transaction/initialize',
      payload,
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    // Return the payment link and pack details
    return {
      success: true,
      paymentUrl: response.data.data.authorization_url,
      reference: reference,
      pack: pack,
    };

  } catch (error) {
    console.error('Paystack error:', error.response?.data || error.message);
    return { success: false, error: 'Failed to generate payment link.' };
  }
}

/**
 * verifyWebhookSignature
 * Verifies that the request actually came from Paystack.
 */
function verifyWebhookSignature(body, signature) {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) return false;
  
  const hash = crypto.createHmac('sha512', secret)
                     .update(JSON.stringify(body))
                     .digest('hex');
  return hash === signature;
}

/**
 * verifyPayment
 * ─────────────
 * Checks with Paystack if a payment was actually completed.
 * Called when Paystack sends a webhook notification.
 *
 * @param {string} reference - The payment reference to verify
 * @returns {object}         - { success, data } or { success: false }
 */
async function verifyPayment(reference) {
  try {
    const response = await axios.get(
      `https://api.paystack.co/transaction/verify/${reference}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        },
      }
    );

    const data = response.data.data;

    // Only treat as success if status is "success"
    if (data.status === 'success') {
      return {
        success: true,
        telegramId: data.metadata.telegram_id,
        packKey: data.metadata.pack_key,
        credits: data.metadata.credits,
        reference: reference,
      };
    }

    return { success: false };

  } catch (error) {
    console.error('Payment verification error:', error.message);
    return { success: false };
  }
}

module.exports = {
  generatePaymentLink,
  verifyPayment,
  CREDIT_PACKS,
};
