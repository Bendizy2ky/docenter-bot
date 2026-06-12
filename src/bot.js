// src/bot.js
// ─────────────────────────────────────────────
// The brain of DocCenter bot.
// KEY FIXES in this version:
// 1. "Processing..." message is DELETED after task completes or fails
//    — users never see it stuck on screen
// 2. Credits only deducted AFTER file is confirmed delivered
// 3. Every error shows a friendly message in Telegram
// 4. Bot never crashes — all errors are caught
// ─────────────────────────────────────────────

let Telegraf;
let axios;
let menus;
let generatePaymentLink, CREDIT_PACKS;
let compressPdf, pdfToWord;
let transcribeAudio;
let enqueue, startBackgroundWorker;
let compressImage, removeBackground, makePassportPhoto, convertImage;
let HttpsProxyAgent;
let docxToPdf;
const fs = require('fs');
const os = require('os');
const path = require('path');

try {
  console.log('Requiring telegraf...');
  Telegraf = require('telegraf').Telegraf;
} catch (e) {
  console.error('Failed to require telegraf:', e && e.message);
  throw e;
}

try { console.log('Requiring axios...'); axios = require('axios'); } catch (e) { console.error('Failed to require axios:', e && e.message); throw e; }
try { console.log('Requiring ./menus...'); menus = require('./menus'); } catch (e) { console.error('Failed to require ./menus:', e && e.message); throw e; }
try { console.log('Requiring ./payments...'); ({ generatePaymentLink, CREDIT_PACKS } = require('./payments')); } catch (e) { console.error('Failed to require ./payments:', e && e.message); throw e; }
try { console.log('Requiring ./services/pdf...'); ({ compressPdf, pdfToWord } = require('./services/pdf')); } catch (e) { console.error('Failed to require ./services/pdf:', e && e.message); throw e; }
try { console.log('Requiring ./services/convert...'); ({ docxToPdf, pdfToDocx } = require('./services/convert')); } catch (e) { console.error('Failed to require ./services/convert (optional):', e && e.message); }
try { console.log('Requiring ./services/transcription...'); ({ transcribeAudio } = require('./services/transcription')); } catch (e) { console.error('Failed to require ./services/transcription:', e && e.message); throw e; }
try { console.log('Requiring ./services/transcribe_queue...'); ({ enqueue, startBackgroundWorker } = require('./services/transcribe_queue')); } catch (e) { console.error('Failed to require ./services/transcribe_queue:', e && e.message); throw e; }
try { console.log('Requiring ./services/image...'); ({ compressImage, removeBackground, makePassportPhoto, convertImage } = require('./services/image')); } catch (e) { console.error('Failed to require ./services/image:', e && e.message); throw e; }
try { console.log('Requiring https-proxy-agent (optional)...'); HttpsProxyAgent = require('https-proxy-agent'); } catch (e) { console.log('https-proxy-agent not available or failed to load; proxy support will be limited.'); }

// ─────────────────────────────────────────────
// Credit costs per tool
// ─────────────────────────────────────────────
const TOOL_COSTS = {
  compress_pdf:       1,
  compress_image:     1,
  convert_image:      1,
  pdf_to_word:        2,
  docx_to_pdf:        2,
  remove_background:  2,
  passport_photo:     3,
  transcribe_audio:   5,
};

// ─────────────────────────────────────────────
// In-Memory Storage
// ─────────────────────────────────────────────
const userCredits = new Map();
const userState   = new Map();
// Tracks the processing message id for each user so global errors can clear it
const processingMessages = new Map();

// Safely send Markdown text while escaping underscores and brackets (which break Markdown v1)
async function sendMarkdownSafe(ctx, text) {
  try {
    let s = String(text);
    // Protect slash-commands so they remain clickable (e.g. /compress_image)
    const placeholders = [];
    s = s.replace(/\/[A-Za-z0-9_@]+/g, (m) => {
      const key = `@@CMD${placeholders.length}@@`;
      placeholders.push(m);
      return key;
    });
    // Escape remaining problematic Markdown chars
    let safe = s.replace(/([_\[\]])/g, '\\$1');
    // Restore commands
    placeholders.forEach((cmd, i) => {
      safe = safe.replace(`@@CMD${i}@@`, cmd);
    });
    return await ctx.reply(safe, { parse_mode: 'Markdown' });
  } catch (e) {
    // Fallback: send as plain text
    try { return await ctx.reply(String(text)); } catch (er) { console.error('Failed to send message:', er); }
  }
}

// ─────────────────────────────────────────────
// Credit Helpers
// ─────────────────────────────────────────────

function getCredits(userId) {
  if (!userCredits.has(userId)) {
    userCredits.set(userId, 5); // Every new user starts with 5 free starter credits
  }
  return userCredits.get(userId);
}

function addCredits(userId, amount) {
  userCredits.set(userId, getCredits(userId) + amount);
}

function deductCredits(userId, amount) {
  userCredits.set(userId, getCredits(userId) - amount);
}

// ─────────────────────────────────────────────
// File Download Helper
// ─────────────────────────────────────────────

async function downloadTelegramFile(fileId, botOrTokenOrCtx) {
  const maxAttempts = 4;
  const timeoutMs = 60000;
  const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || null;
  const httpsAgent = proxy && HttpsProxyAgent ? new HttpsProxyAgent(proxy) : undefined;

  // If a Telegraf ctx is passed, prefer using getFileLink which may be more reliable
  const tryGetFileLink = (obj) => {
    try {
      if (!obj) return null;
      // ctx.telegram.getFileLink exists on Telegraf context
      if (obj.telegram && typeof obj.telegram.getFileLink === 'function') return obj.telegram.getFileLink.bind(obj.telegram);
    } catch (e) {}
    return null;
  };

  const getFileLinkFn = tryGetFileLink(botOrTokenOrCtx);
  const botToken = typeof botOrTokenOrCtx === 'string' ? botOrTokenOrCtx : process.env.TELEGRAM_BOT_TOKEN;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (getFileLinkFn) {
        // Use Telegraf helper to get a direct file URL
        const url = await getFileLinkFn(fileId);
        const fileResp = await axios.get(String(url), { responseType: 'arraybuffer', timeout: timeoutMs, httpsAgent });
        return Buffer.from(fileResp.data);
      }

      const fileInfo = await axios.get(
        `https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`,
        { timeout: timeoutMs, httpsAgent }
      );
      const filePath = fileInfo.data.result.file_path;

      const fileData = await axios.get(
        `https://api.telegram.org/file/bot${botToken}/${filePath}`,
        { responseType: 'arraybuffer', timeout: timeoutMs, httpsAgent }
      );

      return Buffer.from(fileData.data);
    } catch (err) {
      console.error(`downloadTelegramFile attempt ${attempt} failed:`, err && (err.message || err.code));
      if (attempt === maxAttempts) throw err;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
}

// ─────────────────────────────────────────────
// Safe Send Helper
// ─────────────────────────────────────────────

/**
 * safelySendFile
 * ──────────────
 * Sends a file back to the user.
 * Returns true if successful, false if it failed.
 * Credits are NEVER deducted if this returns false.
 */
async function safelySendFile(ctx, buffer, filename, caption) {
  try {
    await ctx.replyWithDocument(
      { source: buffer, filename: filename },
      { caption: caption, parse_mode: 'Markdown' }
    );
    return true;
  } catch (err) {
    console.error(`Failed to send file "${filename}":`, err.message);
    return false;
  }
}

/**
 * deleteProcessingMessage
 * ───────────────────────
 * Deletes the "⏳ Processing..." message once done.
 * Users never see it stuck on screen.
 */
async function deleteProcessingMessage(ctx, messageId) {
  try {
    await ctx.telegram.deleteMessage(ctx.chat.id, messageId);
  } catch (err) {
    // Silently ignore — message may be too old or already deleted
  }
  try {
    const userId = ctx?.from?.id?.toString();
    if (userId) processingMessages.delete(userId);
  } catch (e) {}
}

// ─────────────────────────────────────────────
// Main Bot
// ─────────────────────────────────────────────

function startBot() {
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    throw new Error('TELEGRAM_BOT_TOKEN is not set in environment. Please add it to your .env file.');
  }

  const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN, { handlerTimeout: 300000 }); // 5 minutes
  console.log('DocCenter bot is starting...');

  // If ADMIN_TELEGRAM_ID is set, seed that user with admin credits for testing
  try {
    const adminId = process.env.ADMIN_TELEGRAM_ID;
    if (adminId) {
      const adminCredits = Number(process.env.ADMIN_CREDITS) || 30;
      userCredits.set(adminId.toString(), adminCredits);
      console.log(`Admin user ${adminId} seeded with ${adminCredits} credits`);
    }
  } catch (e) {
    console.error('Failed to seed admin credits:', e.message);
  }

  // Global error handler to avoid crashing the process on timeouts or other errors
  bot.catch(async (err, ctx) => {
    try {
      console.error('Unhandled error while processing', ctx.update);
      console.error(err);

      const userId = ctx?.from?.id?.toString();
      const procId = userId ? processingMessages.get(userId) : undefined;
      if (procId) {
        await deleteProcessingMessage(ctx, procId);
      }

      try { await ctx.reply('⚠️ Something went wrong processing your request. Please try again later.'); } catch (e) {}
    } catch (e) {
      console.error('Error in global error handler:', e);
    }
  });

    // Global process-level handlers to log unexpected failures and keep the process alive
    process.on('unhandledRejection', (reason, p) => {
      console.error('Unhandled Rejection at:', p, 'reason:', reason);
    });

    process.on('uncaughtException', (err) => {
      console.error('Uncaught Exception thrown:', err);
      // Do not exit to keep the bot available; log and continue
    });

  // ── /start ──────────────────────────────────
  bot.start((ctx) => {
    const userId = ctx.from.id.toString();
    userState.delete(userId);
    // Show admin-only commands in the welcome message when applicable
    let welcomeText = menus.welcome;
    const adminId = process.env.ADMIN_TELEGRAM_ID;
    if (adminId && ctx.from.id.toString() === adminId.toString()) {
      welcomeText += '\n\n⚙️ Admin: /diagnose — Run network diagnostics';
    }
    sendMarkdownSafe(ctx, welcomeText + `\n💳 Your credits: *${getCredits(userId)}*`);
  });

  // ── /help ───────────────────────────────────
  bot.command('help', (ctx) => {
    sendMarkdownSafe(ctx, menus.help);
  });

  // ── /balance ────────────────────────────────
  bot.command('balance', (ctx) => {
    const credits = getCredits(ctx.from.id.toString());
    sendMarkdownSafe(ctx, `💳 Your current balance: *${credits} credits*`);
  });

  // ── /pdf ────────────────────────────────────
  bot.command('pdf', (ctx) => {
    userState.delete(ctx.from.id.toString());
    sendMarkdownSafe(ctx, menus.pdf);
  });

  // Audio tools
  bot.command('audio', (ctx) => {
    userState.delete(ctx.from.id.toString());
    sendMarkdownSafe(ctx, menus.audio);
  });

  // ── /image ──────────────────────────────────
  bot.command('image', (ctx) => {
    userState.delete(ctx.from.id.toString());
    sendMarkdownSafe(ctx, menus.image);
  });

  // ── /credits ────────────────────────────────
  bot.command('credits', (ctx) => {
    userState.delete(ctx.from.id.toString());
    sendMarkdownSafe(ctx, menus.credits);
  });

  // Admin-only network diagnostic command to help identify DNS / connectivity issues
  bot.command('diagnose', async (ctx) => {
    const adminId = process.env.ADMIN_TELEGRAM_ID;
    if (!adminId || ctx.from.id.toString() !== adminId.toString()) {
      return ctx.reply('❌ Unauthorized. This command is for the bot admin only.');
    }

    const send = async (text) => {
      try { await ctx.reply(text); } catch (e) { console.error('Reply failed:', e.message); }
    };

    await send('🔎 Running network diagnostics for api.groq.ai...');

    const dns = require('dns');
    const dnsPromises = require('dns').promises;
    const origServers = dns.getServers();

    // 1) Resolve with system DNS
    try {
      const addrs = await dnsPromises.resolve4('api.groq.ai');
      await send(`✅ System DNS resolved api.groq.ai -> ${addrs.join(', ')}`);
    } catch (e) {
      await send(`❌ System DNS failed to resolve api.groq.ai: ${e.message}`);
    }

    // 2) Try public DNS servers (Google/Cloudflare)
    try {
      dns.setServers(['8.8.8.8', '1.1.1.1']);
      const addrsPublic = await dnsPromises.resolve4('api.groq.ai');
      await send(`✅ Public DNS resolved api.groq.ai -> ${addrsPublic.join(', ')}`);
    } catch (e) {
      await send(`❌ Public DNS failed to resolve api.groq.ai: ${e.message}`);
    } finally {
      dns.setServers(origServers);
    }

    // 2.5) Try DNS-over-HTTPS (Cloudflare + Google) to check global resolution
    try {
      const cf = await axios.get('https://cloudflare-dns.com/dns-query', {
        params: { name: 'api.groq.ai', type: 'A' },
        headers: { Accept: 'application/dns-json' },
        timeout: 8000,
      });
      const answers = cf.data?.Answer || cf.data?.answer || [];
      if (answers.length) await send(`✅ Cloudflare DoH resolved api.groq.ai -> ${answers.map(a => a.data).join(', ')}`);
      else await send('❌ Cloudflare DoH returned no answers for api.groq.ai');
    } catch (e) {
      await send(`❌ Cloudflare DoH failed: ${e.message}`);
    }

    try {
      const gg = await axios.get('https://dns.google/resolve', {
        params: { name: 'api.groq.ai', type: 'A' },
        timeout: 8000,
      });
      const answers = gg.data?.Answer || gg.data?.answer || [];
      if (answers.length) await send(`✅ Google DoH resolved api.groq.ai -> ${answers.map(a => a.data).join(', ')}`);
      else await send('❌ Google DoH returned no answers for api.groq.ai');
    } catch (e) {
      await send(`❌ Google DoH failed: ${e.message}`);
    }

    // 3) HTTP HEAD to Groq and Telegram
    try {
      await axios.head('https://api.groq.ai/v1/transcriptions', { timeout: 10000 });
      await send('✅ HTTP HEAD to https://api.groq.ai/v1/transcriptions succeeded');
    } catch (e) {
      await send(`❌ HTTP HEAD to https://api.groq.ai failed: ${e.message}`);
    }

    try {
      await axios.head('https://api.telegram.org', { timeout: 10000 });
      await send('✅ HTTP HEAD to https://api.telegram.org succeeded');
    } catch (e) {
      await send(`❌ HTTP HEAD to https://api.telegram.org failed: ${e.message}`);
    }

    // Additional checks for AssemblyAI (new provider)
    await send('\n🔎 Running network diagnostics for AssemblyAI (api.assemblyai.com)...');
    try {
      const addrs = await dnsPromises.resolve4('api.assemblyai.com');
      await send(`✅ System DNS resolved api.assemblyai.com -> ${addrs.join(', ')}`);
    } catch (e) {
      await send(`❌ System DNS failed to resolve api.assemblyai.com: ${e.message}`);
    }

    try {
      dns.setServers(['8.8.8.8', '1.1.1.1']);
      const addrsPublic = await dnsPromises.resolve4('api.assemblyai.com');
      await send(`✅ Public DNS resolved api.assemblyai.com -> ${addrsPublic.join(', ')}`);
    } catch (e) {
      await send(`❌ Public DNS failed to resolve api.assemblyai.com: ${e.message}`);
    } finally {
      dns.setServers(origServers);
    }

    // DoH for AssemblyAI
    try {
      const cf = await axios.get('https://cloudflare-dns.com/dns-query', {
        params: { name: 'api.assemblyai.com', type: 'A' },
        headers: { Accept: 'application/dns-json' },
        timeout: 8000,
      });
      const answers = cf.data?.Answer || cf.data?.answer || [];
      if (answers.length) await send(`✅ Cloudflare DoH resolved api.assemblyai.com -> ${answers.map(a => a.data).join(', ')}`);
      else await send('❌ Cloudflare DoH returned no answers for api.assemblyai.com');
    } catch (e) {
      await send(`❌ Cloudflare DoH failed for AssemblyAI: ${e.message}`);
    }

    try {
      const gg = await axios.get('https://dns.google/resolve', {
        params: { name: 'api.assemblyai.com', type: 'A' },
        timeout: 8000,
      });
      const answers = gg.data?.Answer || gg.data?.answer || [];
      if (answers.length) await send(`✅ Google DoH resolved api.assemblyai.com -> ${answers.map(a => a.data).join(', ')}`);
      else await send('❌ Google DoH returned no answers for api.assemblyai.com');
    } catch (e) {
      await send(`❌ Google DoH failed for AssemblyAI: ${e.message}`);
    }

    try {
      await axios.head('https://api.assemblyai.com/v2/transcript', { timeout: 10000 });
      await send('✅ HTTP HEAD to https://api.assemblyai.com/v2/transcript succeeded');
    } catch (e) {
      await send(`❌ HTTP HEAD to https://api.assemblyai.com failed: ${e.message}`);
    }

    // 4) Show proxy env vars
    await send(`Proxy env: HTTP_PROXY=${process.env.HTTP_PROXY || ''} HTTPS_PROXY=${process.env.HTTPS_PROXY || ''}`);

    await send('🔚 Diagnostics complete. If api.groq.ai fails to resolve with system DNS but succeeds with public DNS, update your host or DNS settings, or configure a proxy.');
  });

  // ── Buy Pack Commands ────────────────────────
  async function handleBuyPack(ctx, packKey) {
    const userId = ctx.from.id.toString();
    const pack   = CREDIT_PACKS[packKey];

    await sendMarkdownSafe(ctx, `⏳ Generating payment link for *${pack.name} Pack*...`);

    const result = await generatePaymentLink(userId, packKey);

    if (!result.success) {
      return ctx.reply('⚠️ Could not generate payment link. Please try again.');
    }

    await sendMarkdownSafe(ctx, `💳 *${pack.name} Pack — ₦${pack.price.toLocaleString()}*\n` +
      `You will receive *${pack.credits} credits*.\n\n` +
      `👉 [Tap here to pay securely](${result.paymentUrl})\n\n` +
      `_Credits are added automatically after payment._`);
  }

  bot.command('buy_starter',  (ctx) => handleBuyPack(ctx, 'starter'));
  bot.command('buy_standard', (ctx) => handleBuyPack(ctx, 'standard'));
  bot.command('buy_pro',      (ctx) => handleBuyPack(ctx, 'pro'));
  bot.command('buy_power',    (ctx) => handleBuyPack(ctx, 'power'));

  // ── Tool Selection Commands ──────────────────
  bot.command('compress_pdf', (ctx) => {
    userState.set(ctx.from.id.toString(), { tool: 'compress_pdf' });
    sendMarkdownSafe(ctx, menus.awaitingFile(`Please send your *PDF file* now.\n\nCost: ${TOOL_COSTS.compress_pdf} credit(s)`));
  });

  bot.command('transcribe', (ctx) => {
    userState.set(ctx.from.id.toString(), { tool: 'transcribe_audio' });
    sendMarkdownSafe(ctx, menus.awaitingFile(`Please send your *audio file* or voice message now.\n\nMax file size: 18 MB. Larger files may fail or cause errors — try a shorter clip if possible.\n\nCost: ${TOOL_COSTS.transcribe_audio} credit(s)`));
  });

  bot.command('pdf_to_word', (ctx) => {
    userState.set(ctx.from.id.toString(), { tool: 'pdf_to_word' });
    sendMarkdownSafe(ctx, menus.awaitingFile(`Please send your *PDF file* now.\n\nCost: ${TOOL_COSTS.pdf_to_word} credit(s)`));
  });

  bot.command('docx_to_pdf', (ctx) => {
    userState.set(ctx.from.id.toString(), { tool: 'docx_to_pdf' });
    sendMarkdownSafe(ctx, menus.awaitingFile(`Please send your *Word (.docx) file* now.\n\nCost: ${TOOL_COSTS.docx_to_pdf} credit(s)`));
  });

  bot.command('compress_image', (ctx) => {
    userState.set(ctx.from.id.toString(), { tool: 'compress_image' });
    sendMarkdownSafe(ctx, menus.awaitingFile(`Please send your *image* (JPG or PNG).\n\nCost: ${TOOL_COSTS.compress_image} credit(s)`));
  });

  bot.command('remove_background', (ctx) => {
    userState.set(ctx.from.id.toString(), { tool: 'remove_background' });
    sendMarkdownSafe(ctx, menus.awaitingFile(`Please send your *image* (JPG or PNG).\n\nCost: ${TOOL_COSTS.remove_background} credit(s)`));
  });

  bot.command('convert_image', (ctx) => {
    // Offer quick sub-commands to choose target format
    sendMarkdownSafe(ctx, `🖼 *Image Conversion*\n\nChoose output format:\n• /to_png — Convert to PNG\n• /to_jpg — Convert to JPG\n• /to_webp — Convert to WebP\n\n_Then send your image (photo or file).`);
  });

  bot.command('to_png', (ctx) => {
    userState.set(ctx.from.id.toString(), { tool: 'convert_image', target: 'png' });
    sendMarkdownSafe(ctx, menus.awaitingFile(`Please send your *image* now.\n\nCost: ${TOOL_COSTS.convert_image} credit(s)`));
  });

  bot.command('to_jpg', (ctx) => {
    userState.set(ctx.from.id.toString(), { tool: 'convert_image', target: 'jpg' });
    sendMarkdownSafe(ctx, menus.awaitingFile(`Please send your *image* now.\n\nCost: ${TOOL_COSTS.convert_image} credit(s)`));
  });

  bot.command('to_webp', (ctx) => {
    userState.set(ctx.from.id.toString(), { tool: 'convert_image', target: 'webp' });
    sendMarkdownSafe(ctx, menus.awaitingFile(`Please send your *image* now.\n\nCost: ${TOOL_COSTS.convert_image} credit(s)`));
  });

  // Short aliases without underscore (user convenience)
  bot.command('topng', (ctx) => {
    userState.set(ctx.from.id.toString(), { tool: 'convert_image', target: 'png' });
    sendMarkdownSafe(ctx, menus.awaitingFile('Please send your *image* now.'));
  });

  bot.command('tpjpg', (ctx) => {
    userState.set(ctx.from.id.toString(), { tool: 'convert_image', target: 'jpg' });
    sendMarkdownSafe(ctx, menus.awaitingFile('Please send your *image* now.'));
  });

  bot.command('towebp', (ctx) => {
    userState.set(ctx.from.id.toString(), { tool: 'convert_image', target: 'webp' });
    sendMarkdownSafe(ctx, menus.awaitingFile('Please send your *image* now.'));
  });

  bot.command('passport_photo', (ctx) => {
    userState.set(ctx.from.id.toString(), { tool: 'passport_photo' });
    sendMarkdownSafe(ctx,
      `🪪 *Passport Photo Maker*\n\n` +
      `Which document is this for?\n\n` +
      `1️⃣ /pp_nigerian — Nigerian Passport\n` +
      `2️⃣ /pp_usvisa — US / UK Visa\n` +
      `3️⃣ /pp_jamb — JAMB\n` +
      `4️⃣ /pp_nin — NIN Enrollment\n` +
      `5️⃣ /pp_drivers — Driver's Licence`
    );
  });

  // Robust hears handlers to catch clicked/escaped variants and plain text
  bot.hears(/(^|\s)\/??compress[_ ]?image(\s|$)/i, (ctx) => {
    const userId = ctx.from.id.toString();
    if (userState.get(userId)) return; // already handled by command handler
    userState.set(userId, { tool: 'compress_image' });
    return sendMarkdownSafe(ctx, menus.awaitingFile(`Please send your *image* (JPG or PNG).\n\nCost: ${TOOL_COSTS.compress_image} credit(s)`));
  });

  bot.hears(/(^|\s)\/??remove[_ ]?background(\s|$)/i, (ctx) => {
    const userId = ctx.from.id.toString();
    if (userState.get(userId)) return;
    userState.set(userId, { tool: 'remove_background' });
    return sendMarkdownSafe(ctx, menus.awaitingFile(`Please send your *image* (JPG or PNG).\n\nCost: ${TOOL_COSTS.remove_background} credit(s)`));
  });

  bot.hears(/(^|\s)\/??passport[_ ]?photo(\s|$)/i, (ctx) => {
    const userId = ctx.from.id.toString();
    if (userState.get(userId)) return;
    userState.set(userId, { tool: 'passport_photo' });
    return sendMarkdownSafe(ctx, menus.awaitingFile(`Please send a *clear, front-facing photo*.\n\nCost: ${TOOL_COSTS.passport_photo} credit(s)`));
  });

  bot.hears(/(^|\s)\/??convert[_ ]?image(\s|$)/i, (ctx) => {
    const userId = ctx.from.id.toString();
    if (userState.get(userId)) return;
    return sendMarkdownSafe(ctx, `🖼 *Image Conversion*\n\nChoose output format:\n• /to_png — Convert to PNG (1 credit)\n• /to_jpg — Convert to JPG (1 credit)\n• /to_webp — Convert to WebP (1 credit)\n\n_Then send your image (photo or file).`);
  });

  bot.hears(/(^|\s)\/?to[_ ]?png(\s|$)|(^|\s)\/??topng(\s|$)/i, (ctx) => {
    const userId = ctx.from.id.toString();
    if (userState.get(userId)) return;
    userState.set(userId, { tool: 'convert_image', target: 'png' });
    return sendMarkdownSafe(ctx, menus.awaitingFile(`Please send your *image* now.\n\nCost: ${TOOL_COSTS.convert_image} credit(s)`));
  });

  bot.hears(/(^|\s)\/?to[_ ]?jpg(\s|$)|(^|\s)\/??tpjpg(\s|$)/i, (ctx) => {
    const userId = ctx.from.id.toString();
    if (userState.get(userId)) return;
    userState.set(userId, { tool: 'convert_image', target: 'jpg' });
    return sendMarkdownSafe(ctx, menus.awaitingFile(`Please send your *image* now.\n\nCost: ${TOOL_COSTS.convert_image} credit(s)`));
  });

  bot.hears(/(^|\s)\/?to[_ ]?webp(\s|$)|(^|\s)\/??towebp(\s|$)/i, (ctx) => {
    const userId = ctx.from.id.toString();
    if (userState.get(userId)) return;
    userState.set(userId, { tool: 'convert_image', target: 'webp' });
    return sendMarkdownSafe(ctx, menus.awaitingFile(`Please send your *image* now.\n\nCost: ${TOOL_COSTS.convert_image} credit(s)`));
  });

  const passportDocTypes = {
    pp_nigerian: 'nigerian_passport',
    pp_usvisa:   'us_visa',
    pp_jamb:     'jamb',
    pp_nin:      'nin',
    pp_drivers:  'drivers_licence',
  };

  Object.entries(passportDocTypes).forEach(([command, docType]) => {
    bot.command(command, (ctx) => {
      userState.set(ctx.from.id.toString(), { tool: 'passport_photo', docType });
      sendMarkdownSafe(ctx,
        menus.awaitingFile(
          `Great! Now send a *clear, front-facing photo*.\n` +
          `_Plain background gives best results._\n\nCost: ${TOOL_COSTS.passport_photo} credit(s)`
        )
      );
    });
  });


  // ────────────────────────────────────────────
  // DOCUMENT HANDLER
  // Runs when user sends any file (PDF, image as file, etc.)
  // ────────────────────────────────────────────

  bot.on('document', async (ctx) => {
    const userId = ctx.from.id.toString();
    const state  = userState.get(userId);

    // No tool chosen yet
    if (!state) {
      return sendMarkdownSafe(ctx, `Please choose a tool first.\n\nType /pdf for PDF tools or /image for image tools.`);
    }

    const { tool } = state;
    const cost     = TOOL_COSTS[tool];
    const balance  = getCredits(userId);

    // Not enough credits
    if (balance < cost) {
      return sendMarkdownSafe(ctx, menus.notEnoughCredits(tool.replace(/_/g, ' '), cost, balance));
    }

    // Send processing message — save its ID so we can delete it later
    const processingMsg   = await sendMarkdownSafe(ctx, menus.processing(tool.replace(/_/g, ' ')));
    const processingMsgId = processingMsg.message_id;
    processingMessages.set(userId, processingMsgId);

    try {
      const fileId   = ctx.message.document.file_id;
      const fileName = ctx.message.document.file_name || 'file.pdf';
      const mimeType = ctx.message.document.mime_type  || 'application/pdf';

      const fileBuffer = await downloadTelegramFile(fileId, ctx);

      let result;
      let sent = false;

      // ── Compress PDF ──
      if (tool === 'compress_pdf') {
        result = await compressPdf(fileBuffer, fileName);

        if (!result.success) {
          await deleteProcessingMessage(ctx, processingMsgId);
          return ctx.reply('❌ Could not compress this PDF. Please make sure it is a valid PDF and try again.');
        }

        sent = await safelySendFile(
          ctx,
          result.buffer,
          `compressed_${fileName}`,
          `✅ *PDF Compressed!*\n\n` +
          `📦 Before: ${(result.originalSize / 1024).toFixed(1)} KB\n` +
          `📦 After:  ${(result.newSize / 1024).toFixed(1)} KB\n` +
          `💾 Saved:  ${result.savedPercent}%\n\n` +
          `Credits remaining: *${balance - cost}*`
        );

      // ── PDF to Word ──
      } else if (tool === 'pdf_to_word') {
        // Use Cloudmersive primary via convert.pdfToDocx, fallback to iLovePDF handled inside that service.
        if (!pdfToDocx) {
          await deleteProcessingMessage(ctx, processingMsgId);
          return ctx.reply('⚠️ PDF→Word conversion is not available on this server.');
        }

        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf2docx-'));
        const inName = (fileName || 'input.pdf').replace(/[^a-z0-9\.\-\_]/gi, '_');
        const inputPath = path.join(tmpDir, inName);
        const outputPath = path.join(tmpDir, inName.replace(/\.pdf$/i, '.docx'));
        try {
          fs.writeFileSync(inputPath, fileBuffer);
          const res = await pdfToDocx(inputPath, outputPath);
          // pdfToDocx either writes outputPath or throws. Read and send.
          const outBuf = fs.readFileSync(outputPath);
          sent = await safelySendFile(
            ctx,
            outBuf,
            path.basename(outputPath),
            `✅ *PDF converted to Word!*\n\nCredits remaining: *${balance - cost}*`
          );
        } catch (e) {
          await deleteProcessingMessage(ctx, processingMsgId);
          console.error('PDF->DOCX conversion failed:', e);
          return ctx.reply('❌ Could not convert this PDF. Please ensure it is a valid PDF and try again later. If this keeps happening, message @Anene1 for help.');
        } finally {
          try { fs.unlinkSync(inputPath); } catch (e) {}
          try { fs.unlinkSync(outputPath); } catch (e) {}
          try { fs.rmdirSync(tmpDir); } catch (e) {}
        }

      // ── DOCX to PDF ──
      } else if (tool === 'docx_to_pdf') {
        if (!docxToPdf) {
          await deleteProcessingMessage(ctx, processingMsgId);
          return ctx.reply('⚠️ DOCX→PDF conversion is not available on this server.');
        }

        // Create temp dir and files
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docx2pdf-'));
        const inName = (fileName || 'input.docx').replace(/[^a-z0-9\.\-\_]/gi, '_');
        const inputPath = path.join(tmpDir, inName);
        const outputPath = path.join(tmpDir, inName.replace(/\.docx$/i, '.pdf'));
        try {
          fs.writeFileSync(inputPath, fileBuffer);
          const res = await docxToPdf(inputPath, outputPath);
          const outBuf = fs.readFileSync(outputPath);
          sent = await safelySendFile(ctx, outBuf, path.basename(outputPath), `✅ *Word converted to PDF!*\n\nCredits remaining: *${balance - cost}*`);
        } finally {
          // cleanup
          try { fs.unlinkSync(inputPath); } catch (e) {}
          try { fs.unlinkSync(outputPath); } catch (e) {}
          try { fs.rmdirSync(tmpDir); } catch (e) {}
        }


      // ── Compress Image ──
      } else if (tool === 'compress_image') {
        result = await compressImage(fileBuffer, mimeType);

        if (!result.success) {
          await deleteProcessingMessage(ctx, processingMsgId);
          return ctx.reply('❌ Could not compress this image. Please send a valid JPG or PNG.');
        }

        sent = await safelySendFile(
          ctx,
          result.buffer,
          `compressed_${fileName}`,
          `✅ *Image Compressed!*\n\n` +
          `📦 Before: ${(result.originalSize / 1024).toFixed(1)} KB\n` +
          `📦 After:  ${(result.newSize / 1024).toFixed(1)} KB\n` +
          `💾 Saved:  ${result.savedPercent}%\n\n` +
          `Credits remaining: *${balance - cost}*`
        );

      // ── Remove Background ──
      } else if (tool === 'remove_background') {
        result = await removeBackground(fileBuffer);

        if (!result.success) {
          await deleteProcessingMessage(ctx, processingMsgId);
          return ctx.reply('❌ Could not remove the background. Please send a clear JPG or PNG image.');
        }

        sent = await safelySendFile(
          ctx,
          result.buffer,
          'no_background.png',
          `✅ *Background Removed!*\n\nCredits remaining: *${balance - cost}*`
        );
      }

      // ── Convert Image ──
      if (tool === 'convert_image') {
        const target = state.target || 'png';
        result = await convertImage(fileBuffer, target);

        if (!result.success) {
          await deleteProcessingMessage(ctx, processingMsgId);
          return ctx.reply('❌ Could not convert this image. Please try a different image or format and try again.');
        }

        const outExt = target === 'jpg' ? 'jpg' : target === 'webp' ? 'webp' : 'png';
        sent = await safelySendFile(
          ctx,
          result.buffer,
          `converted_image.${outExt}`,
          `✅ *Image Converted!*\n\nCredits remaining: *${balance - cost}*`
        );
      }

      // Always delete the processing message when done
      await deleteProcessingMessage(ctx, processingMsgId);

      if (sent) {
        // File delivered — now safe to deduct credits
        deductCredits(userId, cost);
        console.log(`✅ ${tool} delivered to user ${userId}`);
      } else {
        // Processing worked but Telegram failed to deliver the file
        await ctx.reply(
          '⚠️ Your file was processed but I had trouble sending it back.\n' +
          'No credits were deducted. Please try again.'
        );
      }

      userState.delete(userId);

    } catch (error) {
      console.error(`Error in document handler [${tool}]:`, error);
      await deleteProcessingMessage(ctx, processingMsgId);
      const em = String(error && (error.code || error.message || error)).toLowerCase();
      if (em.includes('etimedout') || em.includes('connect') || em.includes('getaddrinfo') || em.includes('enotfound')) {
        await ctx.reply('⚠️ Network error or timeout while contacting Telegram. Please try again in a moment. No credits were deducted.');
      } else {
        await ctx.reply('⚠️ Something went wrong processing your file. No credits were deducted. Please try again.');
      }
      userState.delete(userId);
    }
  });


  // ────────────────────────────────────────────
  // PHOTO HANDLER
  // Runs when user sends a photo (not as a file attachment)
  // ────────────────────────────────────────────

  bot.on('photo', async (ctx) => {
    const userId = ctx.from.id.toString();
    const state  = userState.get(userId);

    if (!state) {
      return sendMarkdownSafe(ctx, 'Please choose a tool first. Type /image');
    }

    const { tool } = state;
    const cost     = TOOL_COSTS[tool];
    const balance  = getCredits(userId);

    if (balance < cost) {
      return sendMarkdownSafe(ctx, menus.notEnoughCredits(tool.replace(/_/g, ' '), cost, balance));
    }

    const processingMsg   = await sendMarkdownSafe(ctx, menus.processing(tool.replace(/_/g, ' ')));
    const processingMsgId = processingMsg.message_id;

    try {
      const photos     = ctx.message.photo;
      const bestPhoto  = photos[photos.length - 1]; // Highest resolution available
      const fileBuffer = await downloadTelegramFile(bestPhoto.file_id, ctx);

      let result;
      let sent = false;

      if (tool === 'compress_image') {
        result = await compressImage(fileBuffer, 'image/jpeg');

        if (!result.success) {
          await deleteProcessingMessage(ctx, processingMsgId);
          return ctx.reply('❌ Could not compress this image. Please try again.');
        }

        sent = await safelySendFile(
          ctx,
          result.buffer,
          'compressed_image.jpg',
          `✅ *Image Compressed!*\n\n` +
          `📦 Before: ${(result.originalSize / 1024).toFixed(1)} KB\n` +
          `📦 After:  ${(result.newSize / 1024).toFixed(1)} KB\n` +
          `💾 Saved:  ${result.savedPercent}%\n\n` +
          `Credits remaining: *${balance - cost}*`
        );

      } else if (tool === 'remove_background') {
        result = await removeBackground(fileBuffer);

        if (!result.success) {
          await deleteProcessingMessage(ctx, processingMsgId);
          return ctx.reply('❌ Could not remove the background. Please try a clearer image.');
        }

        sent = await safelySendFile(
          ctx,
          result.buffer,
          'no_background.png',
          `✅ *Background Removed!*\n\nCredits remaining: *${balance - cost}*`
        );

      } else if (tool === 'passport_photo') {
        const docType = state.docType || 'nigerian_passport';
        result = await makePassportPhoto(fileBuffer, docType);

        if (!result.success) {
          await deleteProcessingMessage(ctx, processingMsgId);
          return ctx.reply('❌ Could not create passport photo. Please send a clear front-facing photo.');
        }

        sent = await safelySendFile(
          ctx,
          result.buffer,
          'passport_photo.jpg',
          `✅ *${result.label} Photo Ready!*\n\n` +
          `🖨️ Print at any business center.\n\n` +
          `Credits remaining: *${balance - cost}*`
        );

      } else if (tool === 'convert_image') {
        const target = state.target || 'png';
        result = await convertImage(fileBuffer, target);

        if (!result.success) {
          await deleteProcessingMessage(ctx, processingMsgId);
          return ctx.reply('❌ Could not convert this image. Please try a different image or format and try again.');
        }

        const outExt = target === 'jpg' ? 'jpg' : target === 'webp' ? 'webp' : 'png';
        sent = await safelySendFile(
          ctx,
          result.buffer,
          `converted_image.${outExt}`,
          `✅ *Image Converted!*\n\nCredits remaining: *${balance - cost}*`
        );

      } else {
        // If the user's selected tool isn't an image tool, assume they selected a PDF tool
        // (e.g. compress_pdf or pdf_to_word) and prompt them to send a PDF instead.
        await deleteProcessingMessage(ctx, processingMsgId);
        return sendMarkdownSafe(ctx, `⚠️ You selected a *PDF tool*. Please send a PDF file using the 📎 attachment button instead.`);
      }

      await deleteProcessingMessage(ctx, processingMsgId);

      if (sent) {
        deductCredits(userId, cost);
        console.log(`✅ ${tool} (photo) delivered to user ${userId}`);
      } else {
        await ctx.reply(
          '⚠️ Your file was processed but I had trouble sending it back.\n' +
          'No credits were deducted. Please try again.'
        );
      }

      userState.delete(userId);

    } catch (error) {
      console.error(`Error in photo handler [${tool}]:`, error);
      await deleteProcessingMessage(ctx, processingMsgId);
      const em = String(error && (error.code || error.message || error)).toLowerCase();
      if (em.includes('etimedout') || em.includes('connect') || em.includes('getaddrinfo') || em.includes('enotfound')) {
        await ctx.reply('⚠️ Network error or timeout while contacting Telegram. Please try again in a moment. No credits were deducted.');
      } else {
        await ctx.reply('⚠️ Something went wrong. No credits were deducted. Please try again.');
      }
      userState.delete(userId);
    }
  });


  // ────────────────────────────────────────────
  // FALLBACK — unrecognised text
  // ────────────────────────────────────────────

  // ────────────────────────────────────────────
  // VOICE / AUDIO HANDLER
  // Handles voice messages and audio files for transcription
  // ────────────────────────────────────────────

  bot.on('voice', async (ctx) => {
    const userId = ctx.from.id.toString();
    const state  = userState.get(userId);

    if (!state || state.tool !== 'transcribe_audio') {
      return sendMarkdownSafe(ctx, 'Please choose /transcribe first to use audio transcription.');
    }

    const processingMsg   = await sendMarkdownSafe(ctx, menus.processing('transcription'));
    const processingMsgId = processingMsg.message_id;
    processingMessages.set(userId, processingMsgId);

    try {
      const fileId = ctx.message.voice.file_id;
      const fileBuffer = await downloadTelegramFile(fileId, ctx);

      const result = await transcribeAudio(fileBuffer, 'voice.ogg');

      await deleteProcessingMessage(ctx, processingMsgId);

      if (!result.success) {
        const detail = String(result.detail || '').toLowerCase();
        const networkIssue = detail.includes('enotfound') || detail.includes('could not be resolved') || detail.includes('etimedout');
        if (networkIssue) {
          await enqueue(fileBuffer, { userId, chatId: ctx.chat.id, originalFileName: 'voice.ogg' });
          await ctx.reply('⚠️ Transcription service is temporarily unavailable. Your file has been queued and will be processed when the service returns. No credits were deducted.');
          userState.delete(userId);
          return;
        }

        console.error('Transcription failed for user', userId, result.error, result.detail);
        return ctx.reply('❌ Could not transcribe your audio. Please try again later or send a clearer recording. No credits were deducted.');
      }

      // If transcription returned empty text, do not deduct credits
      if (!result.text || !String(result.text).trim()) {
        console.warn('Transcription returned empty text for user', userId);
        await ctx.reply('⚠️ Transcription completed but returned no text. No credits were deducted. Try again with a clearer audio sample.');
        userState.delete(userId);
        return;
      }

      await sendMarkdownSafe(ctx, `📝 *Transcription result:*\n\n${result.text}`);

      // Deduct credits only after successful delivery
      deductCredits(userId, TOOL_COSTS.transcribe_audio);
      userState.delete(userId);

    } catch (err) {
      console.error('Voice handler error:', err.message);
      await deleteProcessingMessage(ctx, processingMsgId);
      await ctx.reply('⚠️ Something went wrong during transcription. No credits were deducted.');
      userState.delete(userId);
    }
  });

  bot.on('audio', async (ctx) => {
    const userId = ctx.from.id.toString();
    const state  = userState.get(userId);

    if (!state || state.tool !== 'transcribe_audio') {
      return sendMarkdownSafe(ctx, 'Please choose /transcribe first to use audio transcription.');
    }

    const processingMsg   = await sendMarkdownSafe(ctx, menus.processing('transcription'));
    const processingMsgId = processingMsg.message_id;
    processingMessages.set(userId, processingMsgId);

    try {
      const fileId = ctx.message.audio.file_id;
      const fileName = ctx.message.audio.file_name || 'audio.mp3';
      const fileBuffer = await downloadTelegramFile(fileId, ctx);

      // Enforce a soft size limit for Groq API (recommend 15 MB)
      const maxBytes = Number(process.env.TRANSCRIBE_MAX_BYTES) || 18 * 1024 * 1024;
      if (fileBuffer.length > maxBytes) {
        await deleteProcessingMessage(ctx, processingMsgId);
        return ctx.reply(`⚠️ File too large for transcription. Max allowed ${Math.round(maxBytes/1024/1024)} MB. Larger files may fail or produce errors — please send a shorter clip.`);
      }

      const result = await transcribeAudio(fileBuffer, fileName);

      await deleteProcessingMessage(ctx, processingMsgId);

      if (!result.success) {
        const detail = String(result.detail || '').toLowerCase();
        const networkIssue = detail.includes('enotfound') || detail.includes('could not be resolved') || detail.includes('etimedout');
        if (networkIssue) {
          await enqueue(fileBuffer, { userId, chatId: ctx.chat.id, originalFileName: fileName });
          await ctx.reply('⚠️ Transcription service is temporarily unavailable. Your file has been queued and will be processed when the service returns. No credits were deducted.');
          userState.delete(userId);
          return;
        }

        console.error('Transcription failed for user', userId, result.error, result.detail);
        return ctx.reply('❌ Could not transcribe your audio. Please try again later or send a clearer recording. No credits were deducted.');
      }

      // If transcription returned empty text, do not deduct credits
      if (!result.text || !String(result.text).trim()) {
        console.warn('Transcription returned empty text for user', userId);
        await ctx.reply('⚠️ Transcription completed but returned no text. No credits were deducted. Try again with a clearer audio sample.');
        userState.delete(userId);
        return;
      }

      await sendMarkdownSafe(ctx, `📝 *Transcription result:*\n\n${result.text}`);

      deductCredits(userId, TOOL_COSTS.transcribe_audio);
      userState.delete(userId);

    } catch (err) {
      console.error('Audio handler error:', err.message);
      await deleteProcessingMessage(ctx, processingMsgId);
      await ctx.reply('⚠️ Something went wrong during transcription. No credits were deducted.');
      userState.delete(userId);
    }
  });

  bot.on('text', (ctx) => {
    try {
      const msg = ctx.message || {};
      let token = '';

      // Prefer bot_command entity if present (more reliable for clicked commands)
      if (Array.isArray(msg.entities)) {
        const cmdEnt = msg.entities.find(e => e.type === 'bot_command');
        if (cmdEnt && typeof cmdEnt.offset === 'number' && typeof cmdEnt.length === 'number') {
          token = msg.text.substr(cmdEnt.offset, cmdEnt.length);
        }
      }

      // Fallback to first whitespace-separated token
      if (!token) {
        token = String(msg.text || '').trim().split(' ')[0] || '';
      }

      // Normalize: strip zero-width chars, remove backslashes, leading slashes and bot username suffix
      const cleaned = String(token).replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\\/g, '');
      const cmd = cleaned.replace(/^\/+/, '').replace(/@.*$/, '').toLowerCase();
      const userId = ctx.from.id.toString();

      // Map common menu commands to the same behavior as bot.command handlers
      if (cmd === 'compress_image') {
        userState.set(userId, { tool: 'compress_image' });
        return sendMarkdownSafe(ctx, menus.awaitingFile('Please send your *image* (JPG or PNG).'));
      }
      if (cmd === 'remove_background') {
        userState.set(userId, { tool: 'remove_background' });
        return sendMarkdownSafe(ctx, menus.awaitingFile('Please send your *image* (JPG or PNG).'));
      }
      if (cmd === 'passport_photo') {
        userState.set(userId, { tool: 'passport_photo' });
        return sendMarkdownSafe(ctx, menus.awaitingFile('Please send a *clear, front-facing photo*.'));
      }
      if (cmd === 'convert_image') {
        return sendMarkdownSafe(ctx,
          `🖼 *Image Conversion*\n\nChoose output format:\n• /to_png — Convert to PNG (1 credit)\n• /to_jpg — Convert to JPG (1 credit)\n• /to_webp — Convert to WebP (1 credit)\n\n_Then send your image (photo or file).`
        );
      }
      if (cmd === 'to_png' || cmd === 'topng') {
        userState.set(userId, { tool: 'convert_image', target: 'png' });
        return sendMarkdownSafe(ctx, menus.awaitingFile('Please send your *image* now.'));
      }
      if (cmd === 'to_jpg' || cmd === 'tpjpg') {
        userState.set(userId, { tool: 'convert_image', target: 'jpg' });
        return sendMarkdownSafe(ctx, menus.awaitingFile('Please send your *image* now.'));
      }
      if (cmd === 'to_webp' || cmd === 'towebp') {
        userState.set(userId, { tool: 'convert_image', target: 'webp' });
        return sendMarkdownSafe(ctx, menus.awaitingFile('Please send your *image* now.'));
      }

      // Re-route top-level menu clicks
      if (cmd === 'start') return sendMarkdownSafe(ctx, menus.welcome + `\n💳 Your credits: *${getCredits(userId)}*`);
      if (cmd === 'pdf') { userState.delete(userId); return sendMarkdownSafe(ctx, menus.pdf); }
      if (cmd === 'image') { userState.delete(userId); return sendMarkdownSafe(ctx, menus.image); }
      if (cmd === 'audio') { userState.delete(userId); return sendMarkdownSafe(ctx, menus.audio); }
      if (cmd === 'credits') { userState.delete(userId); return sendMarkdownSafe(ctx, menus.credits); }
      if (cmd === 'help') return sendMarkdownSafe(ctx, menus.help);

      // Fallthrough: unrecognized text
      return sendMarkdownSafe(ctx, `I didn't understand that 😅\n\nType /start to see the main menu.`);
    } catch (e) {
      console.error('Error in text handler:', e);
      return sendMarkdownSafe(ctx, `I didn't understand that 😅\n\nType /start to see the main menu.`);
    }
  });

  
  // ────────────────────────────────────────────
  // LAUNCH
  // ────────────────────────────────────────────

  (async () => {
    // Robust launch logic: try to get botInfo first and retry on network errors
    const useWebhook = (process.env.USE_WEBHOOK === 'true') || !!process.env.WEBHOOK_URL;

    async function startPollingWithRetries() {
      const maxAttempts = 10;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          // Ensure Telegram is reachable by calling getMe with a short timeout
          await bot.telegram.getMe();
          await bot.launch({ dropPendingUpdates: true });
          console.log('✅ DocCenter bot is running! Open Telegram and send /start to your bot.');
          try { startBackgroundWorker(); } catch (e) { console.error('Failed to start background worker:', e.message); }
          return true;
        } catch (err) {
          const isConflict = err?.response?.error_code === 409;
          const isNetwork = err?.code === 'ETIMEDOUT' || err?.code === 'ENOTFOUND' || String(err).includes('getaddrinfo');
          if (isConflict) {
            console.error('Telegram polling conflict (409). Ensure only one instance is running.');
            return false;
          }
          console.error(`Launch attempt ${attempt} failed:`, err?.response?.data || err.message || err);
          if (attempt < maxAttempts) {
            const backoff = Math.min(30000, 2000 * attempt);
            console.error(`Retrying in ${backoff/1000}s...`);
            await new Promise((r) => setTimeout(r, backoff));
            continue;
          }
          console.error('Failed to launch bot after multiple attempts. Will keep running and retry later.');
          return false;
        }
      }
      return false;
    }

    if (useWebhook) {
      const webhookUrl = process.env.WEBHOOK_URL;
      const port = Number(process.env.PORT) || 3000;
      const hookPath = process.env.WEBHOOK_PATH || `/telegraf/${bot.secretPathComponent()}`;

      try {
        await bot.launch({ webhook: { domain: webhookUrl, port, hookPath } });
        console.log('✅ DocCenter bot is running in webhook mode!');
        console.log(`Webhook URL: ${webhookUrl}${hookPath}`);
        try { startBackgroundWorker(); } catch (e) { console.error('Failed to start background worker:', e.message); }
      } catch (err) {
        console.error('Failed to launch in webhook mode:', err?.message || err);
        console.error('Will attempt polling mode as fallback.');
        await startPollingWithRetries();
      }
    } else {
      await startPollingWithRetries();
    }
  })();

  process.once('SIGINT',  () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

module.exports = { startBot };
