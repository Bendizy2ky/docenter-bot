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
  cv_enhance:         10,
  ai_image_generator: 2,
  photo_fix:          3,
  document_photo_pack: 6,
  business_photo_pack: 8,
  create_print_grid:   2
};

// ─────────────────────────────────────────────
// Persistent Credit Storage
// Uses src/credits.js to persist balances to credits.json
// ─────────────────────────────────────────────
const { 
  getCredits, addCredits, deductCredits, 
  registerReferral, completeReferral 
} = require('./credits');
const userState = require('./state');
// Tracks the processing message id for each user so global errors can clear it
const processingMessages = new Map();

// Rate Limiter Storage
const userLastRequests = new Map();

const BOT_USERNAME = process.env.BOT_USERNAME || 'DocCenterBot';

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
 * Returns true if successful, false if it failed.
 * Credits are NEVER deducted if this returns false.
 */
async function safelySendFile(ctx, buffer, filename, caption) {
  try {
    const FormData = require('form-data');
    const form = new FormData();
    form.append('chat_id', String(ctx.chat.id));
    form.append('caption', caption || '');
    form.append('parse_mode', 'Markdown');
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
    return !!(response.data && response.data.ok);
  } catch (err) {
    console.error(
      'safelySendFile error:',
      err.response ? err.response.data : err.message
    );
    return false;
  }
}

/**
 * notifyReferrer
 * Sends a message to the person who referred the current user.
 */
async function notifyReferrer(referrerId, totalEarned) {
  try {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      chat_id: referrerId,
      text: `💰 *Referral Reward!*\n\nSomeone you invited just used their first tool. You've earned *3 credits*!\n\nTotal earned: *${totalEarned}* credits.`,
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

  console.log('DocCenter bot is starting...');

  // --- Maintenance: Temp File Scavenger ---
  const cleanupTempFiles = () => {
    const tmpDir = os.tmpdir();
    fs.readdir(tmpDir, (err, files) => {
      if (err) return;
      const now = Date.now();
      files.forEach(file => {
        const filePath = path.join(tmpDir, file);
        if (file.startsWith('docenter-') || file.startsWith('pdf2word-')) {
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

    let referralLine = "";
    const payload = ctx.startPayload;
    if (payload && payload.startsWith('DOC-')) {
      const reg = await registerReferral(userId, payload);
      if (reg.success) {
        referralLine = "\n\n🎁 *You joined through a referral!* Use any tool to claim your 3 BONUS credits.";
      }
    }

    // Show admin-only commands in the welcome message when applicable
    let welcomeText = menus.welcome;
    const adminId = process.env.ADMIN_TELEGRAM_ID;
    if (adminId && ctx.from.id.toString() === adminId.toString()) {
      welcomeText += '\n\n⚙️ Admin: /diagnose — Run network diagnostics';
    }
    sendMarkdownSafe(ctx, welcomeText + referralLine + `\n\n💳 Your credits: *${await getCredits(userId)}*`);
  });

  // ── /cancel ─────────────────────────────────
  bot.command('cancel', (ctx) => {
    const userId = ctx.from.id.toString();
    userState.cancelWorkflow(userId);
    sendMarkdownSafe(ctx, menus.workflowCancelled);
  });

  // ── /help ───────────────────────────────────
  bot.command('help', (ctx) => {
    sendMarkdownSafe(ctx, menus.help);
  });

  // ── /balance ────────────────────────────────
  bot.command('balance', async (ctx) => {
    const credits = await getCredits(ctx.from.id.toString());
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

  // ── /packs ──────────────────────────────────
  bot.command('packs', (ctx) => {
    userState.delete(ctx.from.id.toString());
    sendMarkdownSafe(ctx, menus.packsMenu);
  });

  // ── /credits ────────────────────────────────
  bot.command('credits', (ctx) => {
    userState.delete(ctx.from.id.toString());
    sendMarkdownSafe(ctx, menus.credits);
  });

  // ── Workflows ───────────────────────────────
  bot.command('passport_pack', (ctx) => {
    const userId = ctx.from.id.toString();
    userState.startWorkflow(userId, 'Professional Passport Pack', {}, ['remove_background', 'passport_photo']);
    sendMarkdownSafe(ctx, 
      `🗂 *Professional Passport Pack (2 Steps)*\n\n` +
      `Step 1: Background Removal\n` +
      `Step 2: Passport Resizing\n\n` +
      `📎 Please send your photo to begin Step 1.`
    );
  });

  // ── Tool Command Triggers ──────────────────
  bot.command('compress_pdf', (ctx) => {
    userState.set(ctx.from.id.toString(), { tool: 'compress_pdf' });
    sendMarkdownSafe(ctx, menus.awaitingFile('Please send the *PDF* you want to compress.'));
  });

  bot.command('pdf_to_word', (ctx) => {
    userState.set(ctx.from.id.toString(), { tool: 'pdf_to_word' });
    sendMarkdownSafe(ctx, menus.awaitingFile('Please send the *PDF* you want to convert to Word.'));
  });

  bot.command('docx_to_pdf', (ctx) => {
    userState.set(ctx.from.id.toString(), { tool: 'docx_to_pdf' });
    sendMarkdownSafe(ctx, menus.awaitingFile('Please send the *Word (.docx)* file you want to convert to PDF.'));
  });

  bot.command('transcribe', (ctx) => {
    userState.set(ctx.from.id.toString(), { tool: 'transcribe_audio' });
    sendMarkdownSafe(ctx, menus.awaitingFile('Please send an *audio file or voice note* to transcribe.'));
  });

  bot.command(['apply_background', 'applybackground'], (ctx) => {
    userState.set(ctx.from.id.toString(), { tool: 'apply_background' });
    sendMarkdownSafe(ctx, menus.awaitingFile('Please send the *image* you want to change the background for.'));
  });

  bot.command(['convert_image', 'convertimage'], (ctx) => {
    userState.delete(ctx.from.id.toString());
    sendMarkdownSafe(ctx, menus.image + '\n\nChoose an output format above to begin.');
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

  bot.command('sessions', (ctx) => {
    const adminId = process.env.ADMIN_TELEGRAM_ID;
    if (ctx.from.id.toString() !== adminId) return;
    
    ctx.reply(`📊 Active sessions: ${userState.getActiveCount ? userState.getActiveCount() : 'N/A'}`);
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

    if (balance < cost) return sendMarkdownSafe(ctx, menus.notEnoughCredits(state.tool, cost, balance));

    const msg = await sendMarkdownSafe(ctx, menus.processing(state.tool));
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
      if (result.sent) {
        await deductCredits(userId, cost);
        
        // Check Referral Completion
        const refRes = await completeReferral(userId);
        if (refRes.newUserBonus > 0) {
          await sendMarkdownSafe(ctx, `🎁 *Bonus!* You earned 3 referral credits for joining through a friend's link!\n\nYour updated balance: *${refRes.newBalance}* credits`);
        }
        if (refRes.referrerRewarded) {
          await notifyReferrer(refRes.referrerId, refRes.referrerTotalEarned);
        }

        await handleWorkflowProgression(ctx, userId, state, result.buffer);
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

  bot.on(['document', 'photo'], async (ctx) => {
    const userId = ctx.from.id.toString();
    const state = userState.get(userId);
    if (!state) return sendMarkdownSafe(ctx, 'Please choose a tool first.\n\nType /pdf for PDF tools or /image for image tools.');
    
    // --- Security: File Size Validation ---
    const fileSize = ctx.message.document?.file_size || ctx.message.photo?.[0]?.file_size || 0;
    const MAX_SIZE = (Number(process.env.MAX_FILE_SIZE_MB) || 20) * 1024 * 1024;

    if (fileSize > MAX_SIZE) {
      return ctx.reply(`⚠️ File too large. Max limit is ${process.env.MAX_FILE_SIZE_MB || 20}MB.`);
    }

    const cost = TOOL_COSTS[state.tool];
    const balance = await getCredits(userId);
    if (balance < cost) return sendMarkdownSafe(ctx, menus.notEnoughCredits(state.tool, cost, balance));

    const msg = await sendMarkdownSafe(ctx, menus.processing(state.tool));
    processingMessages.set(userId, msg.message_id);
    
    try {
      const fileId = ctx.message.document?.file_id || ctx.message.photo?.pop().file_id;
      const buffer = await downloadTelegramFile(fileId, ctx);
      let result = { sent: false };
      
      const fileName = ctx.message.document?.file_name || (ctx.message.photo ? 'photo.jpg' : 'file.pdf');
      const mimeType = ctx.message.document?.mime_type || (ctx.message.photo ? 'image/jpeg' : 'application/pdf');

      // Registry Loop: Delegate to the correct handler
      for (const handler of handlers) {
        if (handler.canHandle(state.tool)) {
          result = await handler.process(ctx, state.tool, buffer, fileName, mimeType, state, { ...shared, balance, cost });
          break;
        }
      }

      await deleteProcessingMessage(ctx, msg.message_id);

      if (result.sent) {
        await deductCredits(userId, cost);

        // Check Referral Completion
        const refRes = await completeReferral(userId);
        if (refRes.newUserBonus > 0) {
          await sendMarkdownSafe(ctx, `🎁 *Bonus!* You earned 3 referral credits for joining through a friend's link!\n\nYour updated balance: *${refRes.newBalance}* credits`);
        }
        if (refRes.referrerRewarded) {
          await notifyReferrer(refRes.referrerId, refRes.referrerTotalEarned);
        }

        await handleWorkflowProgression(ctx, userId, state, result.buffer);
      } else {
        await ctx.reply('⚠️ Processing failed or file could not be delivered. No credits were deducted.');
      }
      
      // --- Memory Management: Clear buffer explicitly ---
      result.buffer = null;
    } catch (e) {
      console.error('Document handling error:', e);
      await deleteProcessingMessage(ctx, msg.message_id);
      userState.delete(userId);
    }
  });

  async function handleWorkflowProgression(ctx, userId, state, buffer) {
    if (state.isWorkflow && state.currentStep < state.totalSteps - 1) {
      userState.advanceWorkflow(userId, { step: state.currentStep });
      userState.setTempFile(userId, buffer);
      
      const newState = userState.get(userId);
      const nextTool = newState.steps[newState.currentStep];
      
      await sendMarkdownSafe(ctx, menus.workflowNextStepPrompt(
        nextTool.replace(/_/g, ' '), 
        TOOL_COSTS[nextTool]
      ));
    } else if (state.isWorkflow) {
      await sendMarkdownSafe(ctx, menus.workflowComplete(state.workflow));
      userState.delete(userId);
    } else {
      userState.delete(userId);
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
        return sendMarkdownSafe(ctx, menus.workflowCancelled);
      }
      if (cmd === 'finish') {
        userState.delete(userId);
        return sendMarkdownSafe(ctx, `✅ Session finished. Credits saved. Type /start for new tools.`);
      }

      // Map common menu commands to the same behavior as bot.command handlers
      if (cmd === 'compress_image' || cmd === 'compressimage') {
        userState.set(userId, { tool: 'compress_image' });
        return sendMarkdownSafe(ctx, menus.awaitingFile('Please send your *image* (JPG or PNG).'));
      }
      if (cmd === 'remove_background' || cmd === 'removebackground') {
        userState.set(userId, { tool: 'remove_background' });
        return sendMarkdownSafe(ctx, menus.awaitingFile('Please send your *image* (JPG or PNG).'));
      }
      if (cmd === 'passport_photo' || cmd === 'passportphoto') {
        userState.set(userId, { tool: 'passport_photo' });
        return sendMarkdownSafe(ctx, menus.awaitingFile('Please send a *clear, front-facing photo*.\n\n' + menus.passportGuide));
      }
      if (cmd === 'apply_background' || cmd === 'applybackground') {
        userState.set(userId, { tool: 'apply_background' });
        return sendMarkdownSafe(ctx, menus.awaitingFile('Please send the *image* you want to change the background for.'));
      }
      if (cmd === 'convert_image' || cmd === 'convertimage') {
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
      
      // AI & Professional Tools Re-routing
      if (cmd === 'generate_image' || cmd === 'generateimage') {
        userState.set(userId, { tool: 'ai_image_generator' });
        return sendMarkdownSafe(ctx, "🎨 *AI Image Generator*\n\nDescribe the image you want to create.\n\nCost: 2 credits.");
      }
      if (cmd === 'photo_fix' || cmd === 'photofix') {
        userState.set(userId, { tool: 'photo_fix' });
        return sendMarkdownSafe(ctx, menus.awaitingFile('Please send the *photo* you want me to enhance.'));
      }
      if (cmd === 'transcribe') {
        userState.set(userId, { tool: 'transcribe_audio' });
        return sendMarkdownSafe(ctx, menus.awaitingFile('Please send an *audio file or voice note* to transcribe.'));
      }
      if (cmd === 'summarize') {
        userState.set(userId, { tool: 'ai_summarize' });
        return sendMarkdownSafe(ctx, menus.awaitingFile('Please send the *document* you want me to summarize.'));
      }
      if (cmd === 'cv_enhance' || cmd === 'cvenhance') {
        userState.set(userId, { tool: 'cv_enhance' });
        return sendMarkdownSafe(ctx, menus.awaitingFile('Send your *CV (PDF or Word)* for enhancement.'));
      }
      if (cmd === 'compress_pdf' || cmd === 'compresspdf') {
        userState.set(userId, { tool: 'compress_pdf' });
        return sendMarkdownSafe(ctx, menus.awaitingFile('Please send the *PDF* you want to compress.'));
      }
      if (cmd === 'pdf_to_word' || cmd === 'pdftoword') {
        userState.set(userId, { tool: 'pdf_to_word' });
        return sendMarkdownSafe(ctx, menus.awaitingFile('Please send the *PDF* you want to convert to Word.'));
      }

      // Re-route top-level menu clicks
      if (cmd === 'start') return sendMarkdownSafe(ctx, menus.welcome + `\n💳 Your credits: *${await getCredits(userId)}*`);
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
