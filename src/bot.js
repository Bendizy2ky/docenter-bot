// src/bot.js
// ─────────────────────────────────────────────
// The brain of FileForge bot.
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
const fs = require('fs');
const os = require('os');
const path = require('path');
let HttpsProxyAgent;

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
try { console.log('Requiring ./services/transcribe_queue...'); ({ startBackgroundWorker } = require('./services/transcribe_queue')); } catch (e) { console.error('Failed to require transcribe_queue:', e.message); }
try { HttpsProxyAgent = require('https-proxy-agent'); } catch (e) { console.warn('https-proxy-agent not found.'); }

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
  apply_background:   3,
  ai_summarize:       5,
  ai_cv_enhancer:     10,
  ai_image_generator: 2,
  image_enhancer:     3,
  passportphoto_pack: 6,
  business_photo_pack: 8,
  create_print_grid:   2,
  doc_export:         3
};

// ─────────────────────────────────────────────
// Strict Type Guard: Allowed MIME Types per Tool
// ─────────────────────────────────────────────
const ALLOWED_MIMES = {
  ai_summarize:       ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ai_cv_enhancer:     ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  compress_pdf:       ['application/pdf'],
  pdf_to_word:        ['application/pdf'],
  docx_to_pdf:        ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  transcribe_audio:   ['audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/x-wav', 'audio/mp3', 'audio/mp4', 'audio/vnd.dlna.adts', 'audio/x-m4a'],
  compress_image:     ['image/jpeg', 'image/png', 'image/webp'],
  remove_background:  ['image/jpeg', 'image/png', 'image/webp'],
  apply_background:   ['image/jpeg', 'image/png', 'image/webp'],
  passport_photo:     ['image/jpeg', 'image/png', 'image/webp'],
  convert_image:      ['image/jpeg', 'image/png', 'image/webp'],
  image_enhancer:     ['image/jpeg', 'image/png', 'image/webp'],
  passportphoto_pack: ['image/jpeg', 'image/png', 'image/webp'],
  business_photo_pack: ['image/jpeg', 'image/png', 'image/webp']
};

/**
 * verifyFileSignature
 * Performs "Magic Number" validation to ensure file content matches expectations.
 * Prevents "Metadata Spoofing" (e.g., renaming a virus.exe to document.pdf).
 */
function verifyFileSignature(buffer, tool) {
  if (!buffer || buffer.length < 4) return false;

  const isPdf = buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46;
  const isZip = buffer[0] === 0x50 && buffer[1] === 0x4B && buffer[2] === 0x03 && buffer[3] === 0x04; // Used by .docx
  const isJpeg = buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF;
  const isPng = buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47;
  const isWebp = buffer.slice(8, 12).toString('ascii') === 'WEBP';

  if (['compress_pdf', 'pdf_to_word'].includes(tool)) return isPdf;
  if (tool === 'docx_to_pdf') return isZip;
  if (['ai_summarize', 'ai_cv_enhancer'].includes(tool)) return isPdf || isZip;
  
  if (['compress_image', 'remove_background', 'passport_photo', 'convert_image', 'image_enhancer', 'apply_background', 'passportphoto_pack', 'business_photo_pack'].includes(tool)) {
    return isJpeg || isPng || isWebp;
  }

  // Audio formats vary significantly (MP3/OGG); we rely on MIME for those as they are lower risk
  return true;
}

// ─────────────────────────────────────────────
// Persistent Credit Storage
// Uses src/credits.js to persist balances to credits.json
// ─────────────────────────────────────────────
const { 
  getCredits, addCredits, deductCredits, 
  registerReferral, completeReferral,
  getGlobalStats
} = require('./credits');
const userState = require('./state');
// Tracks the processing message id for each user so global errors can clear it
const processingMessages = new Map();

const LOW_CREDIT_THRESHOLD = 5;

// Rate Limiter Storage
const userLastRequests = new Map();

const BOT_USERNAME = process.env.BOT_USERNAME || 'FileForgeBot';

// Safely escape Markdown characters
function escapeMarkdown(text) {
  // Removing the aggressive escaping that caused unwanted backslashes.
  return String(text);
}

// Safely send Markdown text
async function sendMarkdownSafe(ctx, text, userId = null, checkLowCredits = false, extra = {}) {
  try {
    // Senior Fix: Transition to HTML parse mode for reliability.
    // Telegram's Markdown parser is notoriously fragile, especially with underscores in commands.
    let html = String(text)
      .replace(/\\/g, '') // Remove existing backslashes per user request
      .replace(/&/g, '&amp;') // Escape HTML special characters
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      // Convert Markdown bold (** or *) to HTML <b>
      .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')
      .replace(/\*(.*?)\*/g, '<b>$1</b>')
      // Convert Markdown italics (_) to HTML <i>, but only if not part of a word/command
      .replace(/(^|\s)_(.*?)_(\s|$|[.,!?;:])/g, '$1<i>$2</i>$3')
      // Convert Markdown code (`) to HTML <code>
      .replace(/`(.*?)`/g, '<code>$1</code>');

    // Append referral prompt if credits are low
    if (checkLowCredits && userId) {
      const balance = await getCredits(userId);
      if (balance <= LOW_CREDIT_THRESHOLD) {
        const promo = menus.referralPromptLowCredits || "\n\n🎁 *Low on credits?* Share your link via /refer to earn free credits!";
        // Process promo text for basic bold/italic support
        const processedPromo = promo
          .replace(/\*(.*?)\*/g, '<b>$1</b>')
          .replace(/(^|\s)_(.*?)_(\s|$|[.,!?;:])/g, '$1<i>$2</i>$3');
        html += `\n${processedPromo}`;
      }
    }

    return await ctx.reply(html, { parse_mode: 'HTML', ...extra });
  } catch (e) {
    // Fallback: send as plain text
    try { return await ctx.reply(String(text), extra); } catch (er) { console.error('Failed to send message:', er); }
  }
}

// (Credit helpers moved to src/credits.js)
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
 * Returns the file_id if successful, null if it failed.
 * Credits are NEVER deducted if this returns false.
 */
async function safelySendFile(ctx, buffer, filename, caption) {
  try {
    // Senior Fix: Use HTML for captions to prevent "can't parse entities" errors
    // when commands like /passport_photo are present in the text.
    const processedCaption = caption ? String(caption)
      .replace(/\\/g, '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')
      .replace(/\*(.*?)\*/g, '<b>$1</b>')
      .replace(/(^|\s)_(.*?)_(\s|$|[.,!?;:])/g, '$1<i>$2</i>$3')
      .replace(/`(.*?)`/g, '<code>$1</code>') : '';

    const FormData = require('form-data');
    const form = new FormData();
    form.append('chat_id', String(ctx.chat.id));
    form.append('caption', processedCaption);
    form.append('parse_mode', 'HTML');
    form.append('document', buffer, {
      filename: filename,
      knownLength: buffer.length,
    });

    const response = await axios.post(
      `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendDocument`,
      form,
      {
        headers: { ...form.getHeaders() },
        timeout: 120000,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      }
    );
    return response.data?.result?.document?.file_id || response.data?.result?.photo?.pop()?.file_id || null;
  } catch (err) {
    console.error(
      'safelySendFile error:',
      err.response ? err.response.data : err.message
    );
    return null;
  }
}

/**
 * notifyReferrer
 * Sends a message to the person who referred the current user.
 */
async function notifyReferrer(referrerId, data) {
  try {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    let text = `🎉 *Referral Success!*\n\nSomeone just used FileForge for the first time through your referral link!\n\n*+3 credits* added to your account.\nTotal from referrals: *${data.totalEarned}* credits\nThis month: *${data.thisMonth}/30* credits\n\nKeep sharing: /refer`;

    if (data.milestone) {
      text += `\n\n🏆 *Amazing! You reached ${data.milestone.threshold} referrals!*\n\n+${data.milestone.bonus} bonus credits added.\nThat is a free ${data.milestone.packName} worth of credits!\n\nYour balance: *${data.milestone.newBalance}* credits`;
    }

    await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      chat_id: referrerId,
      text: text,
      parse_mode: 'Markdown'
    });
  } catch (e) {
    console.error('Failed to notify referrer:', e.message);
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

async function startBot() {
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    throw new Error('TELEGRAM_BOT_TOKEN is not set in environment. Please add it to your .env file.');
  }

  const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN, { handlerTimeout: 300000 }); // 5 minutes

  // --- Security Middleware: Global Rate Limiter ---
  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id?.toString();
    if (!userId) return next();

    const now = Date.now();
    const userHistory = userLastRequests.get(userId) || [];
    // Keep only requests from the last 60 seconds
    const recentRequests = userHistory.filter(time => now - time < 60000);
    
    if (recentRequests.length >= 10) {
      return ctx.reply('⚠️ Slow down! You are sending requests too fast. Please wait a minute.');
    }

    recentRequests.push(now);
    userLastRequests.set(userId, recentRequests);
    return next();
  });

  console.log('FileForge bot is starting...');

  // --- Maintenance: Temp File Scavenger ---
  const cleanupTempFiles = () => {
    const tmpDir = os.tmpdir();
    fs.readdir(tmpDir, (err, files) => {
      if (err) return;
      const now = Date.now();
      files.forEach(file => {
        const filePath = path.join(tmpDir, file);
        if (file.startsWith('fileforge-') || file.startsWith('pdf2word-')) {
          const stats = fs.statSync(filePath);
          if (now - stats.mtimeMs > 3600000) { // 1 hour old
            try { fs.rmSync(filePath, { recursive: true, force: true }); } catch(e) {}
          }
        }
      });
    });
  };
  setInterval(cleanupTempFiles, 1800000); // Run every 30 mins

  // If ADMIN_TELEGRAM_ID is set, seed that user with admin credits for testing
  try {
    const adminId = process.env.ADMIN_TELEGRAM_ID;
    if (adminId) {
      const adminCredits = Number(process.env.ADMIN_CREDITS) || 30;
      try {
        const current = Number(await getCredits(adminId.toString()) || 0);
        if (current < adminCredits) {
          await addCredits(adminId.toString(), adminCredits - current);
        }
      } catch (e) {
        console.error('Failed to seed admin credits (credits module):', e && e.message);
      }
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
  bot.start(async (ctx) => {
    const userId = ctx.from.id.toString();
    userState.delete(userId);

    const payload = ctx.startPayload;
    let referralNote = "";

    if (payload && payload.startsWith('DOC-')) {
      const reg = await registerReferral(userId, payload);
      if (reg.success) {
        referralNote = "\n\n🎊 *Referral bonus pending!* Use any tool to claim your +5 bonus credits.";
      }
    }

    const balance = await getCredits(userId);
    let welcomeText = menus.welcome;

    if (referralNote) welcomeText += referralNote;

    const adminId = process.env.ADMIN_TELEGRAM_ID;
    if (adminId && ctx.from.id.toString() === adminId.toString()) {
      welcomeText += '\n\n⚙️ Admin: /diagnose — Run network diagnostics';
    }

    welcomeText += `\n\n────────────────────\n💳 *Account Balance:* ${balance} credits`;

    return sendMarkdownSafe(ctx, welcomeText, userId, true);
  });

  // ── /cancel ─────────────────────────────────
  bot.command('cancel', (ctx) => {
    const userId = ctx.from.id.toString();
    userState.cancelWorkflow(userId);
    sendMarkdownSafe(ctx, menus.workflowCancelled, userId, true);
  });

  // ── /help ───────────────────────────────────
  bot.command('help', (ctx) => {
    sendMarkdownSafe(ctx, menus.help, ctx.from.id.toString(), true);
  });

  // ── /balance ────────────────────────────────
  bot.command('balance', async (ctx) => {
    const userId = ctx.from.id.toString();
    const credits = await getCredits(userId);
    sendMarkdownSafe(ctx, `💳 Your current balance: *${credits} credits*`, userId, true);
  });

  // ── /pdf ────────────────────────────────────
  bot.command('pdf', (ctx) => {
    const userId = ctx.from.id.toString();
    userState.delete(userId);
    sendMarkdownSafe(ctx, menus.pdf, userId, true);
  });

  // ── /ai ─────────────────────────────────────
  bot.command('ai', (ctx) => {
    const userId = ctx.from.id.toString();
    userState.delete(userId);
    sendMarkdownSafe(ctx, menus.ai, userId, true);
  });

  // Audio tools
  bot.command('audio', (ctx) => {
    const userId = ctx.from.id.toString();
    userState.delete(userId);
    sendMarkdownSafe(ctx, menus.audio, userId, true);
  });

  // ── /image ──────────────────────────────────
  bot.command('image', (ctx) => {
    const userId = ctx.from.id.toString();
    userState.delete(userId);
    sendMarkdownSafe(ctx, menus.image, userId, true);
  });


  // ── /credits ────────────────────────────────
  bot.command('credits', (ctx) => {
    const userId = ctx.from.id.toString();
    userState.delete(userId);
    sendMarkdownSafe(ctx, menus.credits, userId, true);
  });

  // ── Workflows ───────────────────────────────
  bot.command('passport_pack', (ctx) => {
    const userId = ctx.from.id.toString();
    userState.startWorkflow(userId, 'Professional Passport Pack', {}, ['remove_background', 'passport_photo']);
    sendMarkdownSafe(ctx,
      `🗂 *Professional Passport Pack (2 Steps)*\n\n` +
      `Step 1: Background Removal\n` +
      `Step 2: Passport Resizing\n\n` +
      `📎 Please send your photo to begin Step 1.`, userId, true);
  });

  // ── Tool Command Triggers ──────────────────
  bot.command('compress_pdf', (ctx) => {
    const userId = ctx.from.id.toString();
    userState.set(userId, { tool: 'compress_pdf' });
    sendMarkdownSafe(ctx, menus.awaitingFile('Please send the *PDF* you want to compress. (Max 10MB)'), userId, true);
  });

  bot.command('pdf_to_word', (ctx) => {
    const userId = ctx.from.id.toString();
    userState.set(userId, { tool: 'pdf_to_word' });
    sendMarkdownSafe(ctx, menus.awaitingFile('Please send the *PDF* you want to convert to Word. (Max 10MB)'), userId, true);
  });

  bot.command('docx_to_pdf', (ctx) => {
    const userId = ctx.from.id.toString();
    userState.set(userId, { tool: 'docx_to_pdf' });
    sendMarkdownSafe(ctx, menus.awaitingFile('Please send the *Word (.docx)* file you want to convert to PDF. (Max 10MB)'), userId, true);
  });

  bot.command('transcribe', (ctx) => {
    const userId = ctx.from.id.toString();
    userState.set(userId, { tool: 'transcribe_audio' });
    sendMarkdownSafe(ctx, menus.awaitingFile('Please send an *audio file or voice note* to transcribe. (Max 10MB)'), userId, true);
  });

  bot.command(['apply_background', 'applybackground'], (ctx) => {
    const userId = ctx.from.id.toString();
    userState.set(userId, { tool: 'apply_background' });
    sendMarkdownSafe(ctx, menus.awaitingFile('Please send the *image* you want to change the background for. (Max 5MB)'), userId, true);
  });

  bot.command(['convert_image', 'convertimage'], (ctx) => {
    const userId = ctx.from.id.toString();
    userState.delete(userId);
    sendMarkdownSafe(ctx, menus.image + '\n\nChoose an output format above to begin.', userId, true);
  });

  // ── Admin Commands ──────────────────────────
  bot.command('add_credits', async (ctx) => {
    const adminId = process.env.ADMIN_TELEGRAM_ID;
    const adminPass = process.env.ADMIN_PASSPHRASE;
    
    if (ctx.from.id.toString() !== adminId) return;

    const parts = ctx.message.text.split(' ');
    if (parts.length < 4) return ctx.reply('Usage: /add_credits [userId] [amount] [passphrase]');

    if (adminPass && parts[3] !== adminPass) return ctx.reply('❌ Invalid Admin Passphrase.');

    const targetId = parts[1];
    const amount = parseInt(parts[2]);
    const newBal = await addCredits(targetId, amount);
    ctx.reply(`✅ Added ${amount} to ${targetId}. New balance: ${newBal}`);
  });

  bot.command(['sessions', 'session'], (ctx) => {
    const adminId = process.env.ADMIN_TELEGRAM_ID;
    if (ctx.from.id.toString() !== adminId) return;
    
    ctx.reply(`📊 Current In-Memory Sessions: ${userState.getActiveCount ? userState.getActiveCount() : 'N/A'}`);
  });

  bot.command('stats', async (ctx) => {
    const adminId = process.env.ADMIN_TELEGRAM_ID;
    if (!adminId || ctx.from.id.toString() !== adminId.toString()) return;

    const stats = await getGlobalStats();
    const conversionRate = stats.total > 0 ? ((stats.active / stats.total) * 100).toFixed(1) : 0;

    let message = `📊 *FileForge Bot Stats*\n\n` +
      `👥 *Total Registered (Visitors):* ${stats.total}\n` +
      `✅ *Converted Users (Active):* ${stats.active} (${conversionRate}%)\n\n` +
      `🆕 *New Users (Last 24h):* ${stats.daily}\n` +
      `📅 *New Users (Last 7d):* ${stats.weekly}\n`;

    message += `\n🎁 *Referral Growth:*\n` +
      `📈 *Total Successful Referrals:* ${stats.totalReferrals}\n`;

    if (stats.topReferrers && stats.topReferrers.length > 0) {
      message += `🏆 *Top Referrers:*\n`;
      stats.topReferrers.forEach((ref, i) => {
        message += `${i + 1}. <code>${ref.id}</code> — ${ref.count} invites\n`;
      });
    }

    if (stats.rankedTools && stats.rankedTools.length > 0) {
      message += `\n🛠 *Most Used Tools (All Time):*\n`;
      stats.rankedTools.forEach(([tool, count], index) => {
        message += `${index + 1}. <code>${tool}</code>: ${count}\n`;
      });
    }

    message += `\n_Stats are derived from the current credits database._`;

    await sendMarkdownSafe(ctx, message, adminId, false);
  });

  bot.command('continue', async (ctx) => {
    const userId = ctx.from.id.toString();
    const state = userState.get(userId);
    if (!state || !state.isWorkflow) return;

    const tempPath = state.tempFilePath;
    if (!tempPath || !fs.existsSync(tempPath)) {
      return ctx.reply("⚠️ Your session file has expired. Please upload the file again.");
    }

    const buffer = fs.readFileSync(tempPath);
    const cost = TOOL_COSTS[state.tool];
    const balance = await getCredits(userId);

    if (balance < cost) return sendMarkdownSafe(ctx, menus.notEnoughCredits(state.tool, cost, balance), userId, true);

    const msg = await sendMarkdownSafe(ctx, menus.processing(state.tool), userId);
    processingMessages.set(userId, msg.message_id);

    try {
      let result = { sent: false };
      for (const handler of handlers) {
        if (handler.canHandle(state.tool)) {
          result = await handler.process(ctx, state.tool, buffer, "workflow_file", "application/octet-stream", state, { ...shared, balance, cost });
          break;
        }
      }

      await deleteProcessingMessage(ctx, msg.message_id);
      if (result.sent || result.fileId) {
        const finalBalance = await deductCredits(userId, cost, state.tool);
        
        // Check Referral Completion
        const refRes = await completeReferral(userId);
        if (refRes.newUserBonus > 0) {
          await sendMarkdownSafe(ctx, `🎁 *Referral Bonus Unlocked!*\n\nYou joined through a friend's link.\n*+5 bonus credits* have been added!\n\nYour updated balance: *${refRes.newBalance}* credits\n\nEnjoy FileForge! 😊`);
        }
        if (refRes.referrerRewarded) {
          await notifyReferrer(refRes.referrerId, {
            totalEarned: refRes.referrerTotalEarned,
            thisMonth: refRes.referrerThisMonth,
            milestone: refRes.milestoneMsg
          });
        }

        await handleWorkflowProgression(ctx, userId, state, result.buffer, finalBalance);
      }
    } catch (e) {
      console.error('Workflow continue error:', e);
      await deleteProcessingMessage(ctx, msg.message_id);
    }
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

    // Additional checks for Hugging Face
    await send('\n🔎 Running network diagnostics for Hugging Face (api-inference.huggingface.co)...');
    try {
      const hfAddrs = await dnsPromises.resolve4('api-inference.huggingface.co');
      await send(`✅ System DNS resolved api-inference.huggingface.co -> ${hfAddrs.join(', ')}`);
    } catch (e) {
      await send(`❌ System DNS failed to resolve api-inference.huggingface.co: ${e.message}`);
    }

    try {
      dns.setServers(['8.8.8.8', '1.1.1.1']);
      const hfAddrsPublic = await dnsPromises.resolve4('api-inference.huggingface.co');
      await send(`✅ Public DNS resolved api-inference.huggingface.co -> ${hfAddrsPublic.join(', ')}`);
    } catch (e) {
      await send(`❌ Public DNS failed to resolve api-inference.huggingface.co: ${e.message}`);
    } finally {
      dns.setServers(origServers);
    }

    try {
      const hfCf = await axios.get('https://cloudflare-dns.com/dns-query', {
        params: { name: 'api-inference.huggingface.co', type: 'A' },
        headers: { Accept: 'application/dns-json' },
        timeout: 8000,
      });
      const hfAnswers = hfCf.data?.Answer || [];
      if (hfAnswers.length) await send(`✅ Cloudflare DoH resolved api-inference.huggingface.co -> ${hfAnswers.map(a => a.data).join(', ')}`);
      else await send('❌ Cloudflare DoH returned no answers for api-inference.huggingface.co');
    } catch (e) {
      await send(`❌ Cloudflare DoH failed for Hugging Face: ${e.message}`);
    }

    // 4) Show proxy env vars
    await send(`Proxy env: HTTP_PROXY=${process.env.HTTP_PROXY || ''} HTTPS_PROXY=${process.env.HTTPS_PROXY || ''}`);

    await send('🔚 Diagnostics complete. If api.groq.ai fails to resolve with system DNS but succeeds with public DNS, update your host or DNS settings, or configure a proxy.');
  });

  // --- Callback Query: Document Export ---
  bot.on('callback_query', async (ctx) => {
    const userId = ctx.from.id.toString();
    const data = ctx.callbackQuery.data;
    const state = userState.get(userId);

    // Handle balance check after payment
    if (data === 'check_balance') {
      await ctx.answerCbQuery('Checking your balance...');
      const balance = await getCredits(userId);
      return sendMarkdownSafe(
        ctx,
        `💳 *Your Current Balance*\n\n` +
        `Credits: *${balance}*\n\n` +
        `If your payment was successful your ` +
        `credits have been added automatically.\n\n` +
        `If credits have not appeared yet please ` +
        `wait 30 seconds and check again with /balance`,
        userId,
        false
      );
    }

    if (!state || state.tool !== 'export_suggest' || !state.aiText) {
      return ctx.answerCbQuery('⚠️ Your session has expired. Please process the document again to export.');
    }
    if (data !== 'exp_docx' && data !== 'exp_pdf') return;

    const exportCost = TOOL_COSTS.doc_export;
    const balance = await getCredits(userId);
    if (balance < exportCost) {
      await ctx.answerCbQuery('❌ Not enough credits.');
      return sendMarkdownSafe(ctx, menus.notEnoughCredits('Document Export', exportCost, balance), userId, true);
    }

    await ctx.answerCbQuery('🚀 Generating your document...');
    const editMsg = await ctx.reply('⏳ Crafting your premium document...');

    try {
      const { generateDocx } = require('./services/docGen');
      const { docxToPdf } = require('./services/pdf');
      
      const title = state.sourceTool === 'ai_cv_enhancer' ? 'Elite Enhanced CV' : 'Executive Document Summary';
      let buffer = await generateDocx(state.aiText, title);
      let ext = '.docx';

      if (data === 'exp_pdf') {
        const pdfRes = await docxToPdf(buffer, 'document.docx');
        if (!pdfRes.success) throw new Error(pdfRes.error);
        buffer = pdfRes.buffer;
        ext = '.pdf';
      }

      const fileName = `FileForge_Elite_${Date.now()}${ext}`;
      const caption = `✨ *Premium Export Complete*\n\nYour ${ext.toUpperCase()} has been professionally formatted.\n\nCredits used: ${exportCost}`;
      
      const sent = await safelySendFile(ctx, buffer, fileName, caption);
      if (sent) {
        const remaining = await deductCredits(userId, exportCost, 'doc_export');
        await ctx.telegram.deleteMessage(ctx.chat.id, editMsg.message_id);
        await sendMarkdownSafe(ctx, menus.success('doc_export', remaining), userId, true);
        userState.delete(userId);
      }
    } catch (e) {
      console.error('Export error:', e);
      await ctx.telegram.deleteMessage(ctx.chat.id, editMsg.message_id);
      await ctx.reply('⚠️ Export failed. Please try again later.');
    }
  });

  // --- Callback Query: Passport Print Sheet ---
  bot.action(/^print_sheet:(.+)$/, async (ctx) => {
    const userId = ctx.from.id.toString();
    const fileId = ctx.match[1];
    
    await ctx.answerCbQuery('🖨 Generating your A4 print sheet...');
    const editMsg = await ctx.reply('⏳ Arranging 6 copies on A4 canvas...');

    try {
      const { createPrintGrid } = require('./services/image');
      const fileBuffer = await downloadTelegramFile(fileId, ctx);
      
      const grid = await createPrintGrid(fileBuffer);
      if (!grid.success) throw new Error(grid.error);

      const sent = await safelySendFile(
        ctx, 
        grid.buffer, 
        'Passport_Print_Sheet.jpg', 
        '✅ *Print Sheet Ready*\n\nYour 6 passport copies have been arranged on an A4 sheet for easy printing.'
      );

      if (sent) {
        await ctx.telegram.deleteMessage(ctx.chat.id, editMsg.message_id);
      }
    } catch (e) {
      console.error('Print sheet generation error:', e);
      await ctx.telegram.deleteMessage(ctx.chat.id, editMsg.message_id);
      await ctx.reply('⚠️ Failed to generate print sheet. Please try again.');
    }
  });

  // ── Buy Pack Commands ────────────────────────
  async function handleBuyPack(ctx, packKey) {
    const userId = ctx.from.id.toString();
    const pack   = CREDIT_PACKS[packKey];

    await sendMarkdownSafe(ctx, `⏳ Generating payment link for *${pack.name} Pack*...`, userId, true);

    const result = await generatePaymentLink(userId, packKey);

    let checkoutUrl = null;
    if (result && result.success) {
      // Check all possible property names
      // payments.js returns it as result.paymentUrl
      const rawUrl = result.paymentUrl 
        || result.url 
        || result.authorization_url 
        || (result.data && (result.data.authorization_url || result.data.url));
      if (typeof rawUrl === 'string' && rawUrl.startsWith('http')) {
        checkoutUrl = rawUrl;
      }
    }

    // Also add better error logging to help debug
    if (!checkoutUrl) {
      console.error(
        '[Payment Error] Could not extract URL. ' +
        'result.success:', result?.success,
        'result keys:', result ? Object.keys(result) : 'null',
        'result.paymentUrl:', result?.paymentUrl
      );
      return ctx.reply(
        '⚠️ Could not generate a secure payment link.\n' +
        'Please try again or contact support.'
      );
    }

    const messageText = `💳 <b>${pack.name} Pack — ₦${pack.price.toLocaleString()}</b>\n` +
                        `You will receive <b>${pack.credits} credits</b>.\n\n` +
                        `Please tap the button below to pay securely via Paystack. Credits are added automatically after payment.`;

    return ctx.reply(messageText, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "🛍️ Pay Securely Now",
              web_app: { url: checkoutUrl }
            }
          ]
        ]
      }
    });
  }

  bot.command('buy_starter',  (ctx) => handleBuyPack(ctx, 'starter'));
  bot.command('buy_standard', (ctx) => handleBuyPack(ctx, 'standard'));
  bot.command('buy_pro',      (ctx) => handleBuyPack(ctx, 'pro'));
  bot.command('buy_power',    (ctx) => handleBuyPack(ctx, 'power'));

  // ── Initialize Modular Handlers ──────────────
  const shared = {
    TOOL_COSTS, menus, userState, processingMessages,
    getCredits, deductCredits, sendMarkdownSafe,
    downloadTelegramFile, safelySendFile, deleteProcessingMessage
  };

  const handlers = [
    require('./pdfHandler')(bot, shared),
    require('./imageHandler')(bot, shared),
    require('./audioHandler')(bot, shared),
    require('./aiHandler')(bot, shared),
    require('./referralHandler')(bot, shared),
    require('./workflowHandler')(bot, shared)
  ];

  bot.on(['document', 'photo', 'audio', 'voice'], async (ctx) => {
    const userId = ctx.from.id.toString();
    const state = userState.get(userId);
    if (!state) return sendMarkdownSafe(ctx, 'Please choose a tool first.\n\nType /pdf for PDF tools or /image for image tools.');
    
    // --- Proactive File Sensitivity: Metadata Gatekeeping ---
    const photoArr = ctx.message.photo;
    const fileSize = ctx.message.document?.file_size ||
                     ctx.message.audio?.file_size ||
                     ctx.message.voice?.file_size ||
                     (photoArr ? photoArr[photoArr.length - 1].file_size : 0) || 0;
    
    let toolLimitMB = 20; // Global fallback

    if (['ai_summarize', 'ai_cv_enhancer'].includes(state.tool)) {
      toolLimitMB = 5; 
    } else if (['compress_image', 'remove_background', 'passport_photo', 'apply_background', 'convert_image', 'image_enhancer'].includes(state.tool)) {
      toolLimitMB = 5; 
    } else if (state.tool === 'transcribe_audio') {
      toolLimitMB = 10;
    } else if (state.tool.includes('pdf') || state.tool.includes('docx')) {
      toolLimitMB = 10;
    }

    const MAX_SIZE = toolLimitMB * 1024 * 1024;

    if (fileSize > MAX_SIZE) {
      return sendMarkdownSafe(ctx, menus.fileTooLarge(toolLimitMB), userId, true);
    }

    const cost = TOOL_COSTS[state.tool];
    const balance = await getCredits(userId);
    if (balance < cost) return sendMarkdownSafe(ctx, menus.notEnoughCredits(state.tool, cost, balance), userId, true);

    // --- Strict Type Guard: Format Validation ---
    const mimeType = ctx.message.document?.mime_type || 
                     ctx.message.audio?.mime_type || 
                     ctx.message.voice?.mime_type || 
                     (ctx.message.photo ? 'image/jpeg' : null);

    const allowed = ALLOWED_MIMES[state.tool];
    if (allowed && mimeType) {
      const isAllowed = allowed.some(type => mimeType.startsWith(type) || type === mimeType);
      if (!isAllowed) {
        const friendlyMap = {
          'application/pdf': 'PDF',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word (.docx)',
          'image/jpeg': 'JPG',
          'image/png': 'PNG',
          'image/webp': 'WebP',
          'audio/mpeg': 'MP3',
          'audio/ogg': 'Voice/Ogg'
        };
        const expectedNames = allowed.map(t => friendlyMap[t] || t.split('/')[1].toUpperCase()).join(', ');
        return sendMarkdownSafe(ctx, menus.invalidFileType(expectedNames), userId, true);
      }
    } else if (allowed && !mimeType) {
      return sendMarkdownSafe(ctx, '⚠️ I could not verify the type of this file. Please send it as a standard file or photo.', userId, true);
    }

    const msg = await sendMarkdownSafe(ctx, menus.processing(state.tool), userId);
    processingMessages.set(userId, msg.message_id);
    
    try {
      const fileId = ctx.message.document?.file_id || 
                     ctx.message.audio?.file_id || 
                     ctx.message.voice?.file_id || 
                     ctx.message.photo?.pop().file_id;
      const buffer = await downloadTelegramFile(fileId, ctx);
      let result = { sent: false };

      // --- Magic Number Verification: Anti-Spoofing ---
      if (!verifyFileSignature(buffer, state.tool)) {
        throw new Error('The file content does not match its extension. Please send a valid, uncorrupted file.');
      }
      
      const fileName = ctx.message.document?.file_name || 
                       ctx.message.audio?.file_name || 
                       (ctx.message.voice ? 'voice_note.ogg' : ctx.message.photo ? 'photo.jpg' : 'file.pdf');

      // Registry Loop: Delegate to the correct handler
      for (const handler of handlers) {
        if (handler.canHandle(state.tool)) {
          result = await handler.process(ctx, state.tool, buffer, fileName, mimeType, state, { ...shared, balance, cost, fileId });
          break;
        }
      }

      await deleteProcessingMessage(ctx, msg.message_id);

      if (result.sent) {
        const finalBalance = await deductCredits(userId, cost, state.tool);

        // Check Referral Completion
        const refRes = await completeReferral(userId);
        if (refRes.newUserBonus > 0) {
          await sendMarkdownSafe(ctx, `🎁 *Referral Bonus Unlocked!*\n\nYou joined through a friend's link.\n*+5 bonus credits* have been added!\n\nYour updated balance: *${refRes.newBalance}* credits\n\nEnjoy FileForge! 😊`);
        }
        if (refRes.referrerRewarded) {
          await notifyReferrer(refRes.referrerId, {
            totalEarned: refRes.referrerTotalEarned,
            thisMonth: refRes.referrerThisMonth,
            milestone: refRes.milestoneMsg
          });
        }

        if (!state.isWorkflow) {
          if (result.aiText) {
            // Upgrade user state to suggest export
            userState.set(userId, {
              tool: 'export_suggest',
              aiText: result.aiText,
              sourceTool: result.tool,
              originalFileName: fileName
            });

            const extra = {
              reply_markup: {
                inline_keyboard: [[
                  { text: '📄 Word (3 cr)', callback_data: 'exp_docx' },
                  { text: '📑 PDF (3 cr)', callback_data: 'exp_pdf' }
                ]]
              }
            };
            await sendMarkdownSafe(ctx, menus.success(state.tool, finalBalance), userId, true, extra);
          } else {
            await sendMarkdownSafe(ctx, menus.success(state.tool, finalBalance), userId, true);
          }
        }

        await handleWorkflowProgression(ctx, userId, state, result.buffer, finalBalance);
      } else {
        await ctx.reply('⚠️ Processing failed or file could not be delivered. No credits were deducted.');
      }
      
      // --- Memory Management: Clear buffer explicitly ---
      result.buffer = null;
    } catch (e) {
      console.error('Document handling error:', e);
      await deleteProcessingMessage(ctx, msg.message_id);

      // Friendly user feedback
      const toolFriendly = (state.tool || 'request').replace(/_/g, ' ');
      await ctx.reply(`⚠️ Sorry, I encountered an error while processing your ${toolFriendly}. This can happen with complex or password-protected files. Please try again or contact support.`);

      userState.delete(userId);
    }
  });

  async function handleWorkflowProgression(ctx, userId, state, buffer, finalBalance) {
    if (state.isWorkflow && state.currentStep < state.totalSteps - 1) {
      userState.advanceWorkflow(userId, { step: state.currentStep });
      userState.setTempFile(userId, buffer);
      
      const newState = userState.get(userId);
      const nextTool = newState.steps[newState.currentStep];
      
      await sendMarkdownSafe(ctx, menus.workflowNextStepPrompt(
        nextTool.replace(/_/g, ' '),
        TOOL_COSTS[nextTool]), userId, true
      );
    } else if (state.isWorkflow) {
      await sendMarkdownSafe(ctx, menus.workflowComplete(state.workflow, finalBalance), userId, true);
      userState.delete(userId);
    } else {
      // Don't delete if we are waiting for an export selection
      const currentState = userState.get(userId);
      if (!currentState || currentState.tool !== 'export_suggest') {
        userState.delete(userId);
      }
    }
  }

  bot.on('text', async (ctx) => {
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

      // Senior Fix: Prevent middleware leakage. If user has an active tool state, 
      // we assume a modular handler is processing this.
      const state = userState.get(userId);
      if (state && state.tool) {
        // Allow through if it's a command, OR if it's the AI Image Generator (which needs the text prompt)
        const isCommand = msg.text?.startsWith('/');
        const isAIInput = state.tool === 'ai_image_generator';
        if (!isCommand && !isAIInput) {
          return; 
        }
      }

      // Handle Workflow Navigation
      if (cmd === 'cancel') {
        userState.cancelWorkflow(userId);
        return sendMarkdownSafe(ctx, menus.workflowCancelled, userId, true);
      }
      if (cmd === 'finish') {
        userState.delete(userId);
        return sendMarkdownSafe(ctx, `✅ Session finished. Credits saved. Type /start for new tools.`, userId, true);
      }

      // Map common menu commands to the same behavior as bot.command handlers
      if (cmd === 'compress_image' || cmd === 'compressimage') {
        userState.set(userId, { tool: 'compress_image' });
        return sendMarkdownSafe(ctx, menus.awaitingFile('Please send your *image* (JPG or PNG). (Max 5MB)'), userId, true);
      }
      if (cmd === 'remove_background' || cmd === 'removebackground') {
        userState.set(userId, { tool: 'remove_background' });
        return sendMarkdownSafe(ctx, menus.awaitingFile('Please send your *image* (JPG or PNG). (Max 5MB)'), userId, true);
      }
      if (cmd === 'passport_photo' || cmd === 'passportphoto') {
        userState.set(userId, { tool: 'passport_photo' });
        return sendMarkdownSafe(ctx, menus.awaitingFile('Please send a *clear, front-facing photo*. (Max 5MB)\n\n' + menus.passportGuide), userId, true);
      }
      if (cmd === 'apply_background' || cmd === 'applybackground') {
        userState.set(userId, { tool: 'apply_background' });
        return sendMarkdownSafe(ctx, menus.awaitingFile('Please send the *image* you want to change the background for. (Max 5MB)'), userId, true);
      }
      if (cmd === 'convert_image' || cmd === 'convertimage') {
        return sendMarkdownSafe(ctx,
          `🖼 *Image Conversion*\n\nChoose output format:\n• /to_png — Convert to PNG (1 credit)\n• /to_jpg — Convert to JPG (1 credit)\n• /to_webp — Convert to WebP (1 credit)\n\n_Then send your image (photo or file).`,
          userId, true);
      }
      if (cmd === 'to_png' || cmd === 'topng') {
        userState.set(userId, { tool: 'convert_image', target: 'png' });
        return sendMarkdownSafe(ctx, menus.awaitingFile('Please send your *image* now. (Max 5MB)'), userId, true);
      }
      if (cmd === 'to_jpg' || cmd === 'tpjpg') {
        userState.set(userId, { tool: 'convert_image', target: 'jpg' });
        return sendMarkdownSafe(ctx, menus.awaitingFile('Please send your *image* now. (Max 5MB)'), userId, true);
      }
      if (cmd === 'to_webp' || cmd === 'towebp') {
        userState.set(userId, { tool: 'convert_image', target: 'webp' });
        return sendMarkdownSafe(ctx, menus.awaitingFile('Please send your *image* now. (Max 5MB)'), userId, true);
      }
      
      // AI & Professional Tools Re-routing
      if (cmd === 'generate_image' || cmd === 'generateimage') {
        return sendMarkdownSafe(ctx,
          '🎨 *AI Image Generator*\n\n' + 
          '⚙️ This feature is currently being upgraded ' +
          'for better quality and speed.\n\n' +
          'It will be available very soon!\n\n' +
          'In the meantime try our other AI tools:\n' +
          '/ai_summarise — Summarise any document\n' +
          '/ai_cv_enhancer — Improve your CV\n\n' +
          '_No credits deducted._'
        , userId, true);
      }
      if (cmd === 'image_enhancer' || cmd === 'imageenhancer') {
        userState.set(userId, { tool: 'image_enhancer' });
        return sendMarkdownSafe(ctx, menus.awaitingFile('Please send the *photo* you want me to enhance. (Max 5MB)'), userId, true);
      }
      if (cmd === 'passportphoto_pack' || cmd === 'passport_photo_pack') {
        const cost = TOOL_COSTS.passportphoto_pack;
        userState.startWorkflow(userId, 'passportphoto_pack', {}, ['passportphoto_pack']);
        return sendMarkdownSafe(ctx, 
          `🎨 *PassportPhoto Pack — ${cost} credits*\n\nChoose background colour to begin:\n\n` +
          `1️⃣ /wf_bg_white — White ✅ (Recommended)\n` +
          `2️⃣ /wf_bg_red — Red\n` +
          `3️⃣ /wf_bg_blue — Blue`, userId, true);
      }
      if (cmd === 'transcribe') {
        userState.set(userId, { tool: 'transcribe_audio' });
        return sendMarkdownSafe(ctx, menus.awaitingFile('Please send an *audio file or voice note* to transcribe. (Max 10MB)'), userId, true);
      }
      if (cmd === 'summarize' || cmd === 'ai_summarise' || cmd === 'ai_summarize') {
        userState.set(userId, { tool: 'ai_summarize' });
        return sendMarkdownSafe(ctx, menus.awaitingFile('Please send the *document* you want me to summarize. (Best for documents up to 15 pages)'), userId, true);
      }
      if (cmd === 'ai_cv_enhancer') {
        userState.set(userId, { tool: 'ai_cv_enhancer' });
        return sendMarkdownSafe(ctx, menus.awaitingFile('Send your *CV (PDF or Word)* for enhancement. (Max 5 pages recommended)'), userId, true);
      }
      if (cmd === 'compress_pdf' || cmd === 'compresspdf') {
        userState.set(userId, { tool: 'compress_pdf' });
        return sendMarkdownSafe(ctx, menus.awaitingFile('Please send the *PDF* you want to compress. (Max 10MB)'), userId, true);
      }
      if (cmd === 'pdf_to_word' || cmd === 'pdftoword') {
        userState.set(userId, { tool: 'pdf_to_word' });
        return sendMarkdownSafe(ctx, menus.awaitingFile('Please send the *PDF* you want to convert to Word. (Max 10MB)'), userId, true);
      }

      // Re-route top-level menu clicks
      if (cmd === 'start') return sendMarkdownSafe(ctx, menus.welcome + `\n💳 Your credits: *${await getCredits(userId)}*`, userId, true);
      if (cmd === 'pdf') { userState.delete(userId); return sendMarkdownSafe(ctx, menus.pdf, userId, true); }
      if (cmd === 'ai') { userState.delete(userId); return sendMarkdownSafe(ctx, menus.ai, userId, true); }
      if (cmd === 'image') { userState.delete(userId); return sendMarkdownSafe(ctx, menus.image, userId, true); }
      if (cmd === 'audio') { userState.delete(userId); return sendMarkdownSafe(ctx, menus.audio, userId, true); }
      if (cmd === 'credits') { userState.delete(userId); return sendMarkdownSafe(ctx, menus.credits, userId, true); }
      if (cmd === 'help') return sendMarkdownSafe(ctx, menus.help, userId, true);

      // Fallthrough: unrecognized text
      return sendMarkdownSafe(ctx, `I didn't understand that 😅\n\nType /start to see the main menu.`, userId, true);
    } catch (e) {
      console.error('Error in text handler:', e);
      return sendMarkdownSafe(ctx, `I didn't understand that 😅\n\nType /start to see the main menu.`, ctx.from.id.toString(), true);
    }
  });

  
  // ────────────────────────────────────────────
  // LAUNCH
  // ────────────────────────────────────────────

  async function startPollingWithRetries() {
    const maxAttempts = 10;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        // Ensure Telegram is reachable by calling getMe with a short timeout
        await bot.telegram.getMe();
        await bot.launch({ dropPendingUpdates: true });
        console.log('✅ FileForge bot is running! Open Telegram and send /start to your bot.');
        try { startBackgroundWorker(); } catch (e) { console.error('Failed to start background worker:', e.message); }
        return true;
      } catch (err) {
        const isConflict = err?.response?.error_code === 409;
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
        console.error('Failed to launch bot after multiple attempts.');
        return false;
      }
    }
    return false;
  }

  // Robust launch logic: try to get botInfo first and retry on network errors
  const useWebhook = (process.env.USE_WEBHOOK === 'true') || !!process.env.WEBHOOK_URL;

  if (useWebhook) {
    const webhookUrl = process.env.WEBHOOK_URL;
    const port = Number(process.env.PORT) || 3000;
    const hookPath = process.env.WEBHOOK_PATH || `/telegraf/${bot.secretPathComponent()}`;

    try {
        await bot.launch({ webhook: { domain: webhookUrl, port, hookPath } });
        console.log('✅ FileForge bot is running in webhook mode!');
        console.log(`Webhook URL: ${webhookUrl}${hookPath}`);
        try { startBackgroundWorker(); } catch (e) { console.error('Failed to start background worker:', e.message); }
      } catch (err) {
        console.error('Failed to launch in webhook mode:', err?.message || err);
        console.error('Will attempt polling mode as fallback.');
      if (!(await startPollingWithRetries())) process.exit(1);
    }
  } else {
    if (!(await startPollingWithRetries())) process.exit(1);
  }

  const shutdown = (signal) => {
    console.log(`Received ${signal}. Shutting down gracefully...`);
    bot.stop(signal);
    // Force exit after a short timeout to prevent Intervals/Workers from hanging the process
    setTimeout(() => process.exit(0), 1000).unref();
  };

  process.once('SIGINT',  () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

module.exports = { startBot };
