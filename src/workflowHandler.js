const { enhanceImage, removeBackground, applyBackground, makePassportPhoto, createPrintGrid } = require('./services/image');
const sharp = require('sharp');

module.exports = (bot, shared) => {
  const { TOOL_COSTS, menus, userState, sendMarkdownSafe } = shared;

  // --- COMMANDS ---

  bot.command('image_enhancer', (ctx) => {
    userState.set(ctx.from.id.toString(), { tool: 'image_enhancer' });
    sendMarkdownSafe(ctx, `✨ *Pro AI Image Enhancer — 3 credits*\n\nSend me any photo. I will use **Generative AI Restoration** to reconstruct lost details, smooth skin textures, and optimize lighting for a professional studio finish.\n\n📸 Send your photo now.`);
  });

  bot.command('passportphoto_pack', async (ctx) => {
    const userId = ctx.from.id.toString();
    const cost = TOOL_COSTS.passportphoto_pack;
    const balance = await shared.getCredits(userId);

    if (balance < cost) return sendMarkdownSafe(ctx, menus.notEnoughCredits('PassportPhoto Pack', cost, balance));

    userState.startWorkflow(userId, 'passportphoto_pack', {}, ['passportphoto_pack']);
    sendMarkdownSafe(ctx, 
      `🎨 *PassportPhoto Pack — ${cost} credits*\n\n` +
      `I will automatically enhance, remove background, and format your photo.\n\n` +
      `*Choose background colour:*\n\n` +
        `1️⃣ /wf_bg_white — White ✅ (Recommended)\n` +
        `2️⃣ /wf_bg_red — Red\n` +
        `3️⃣ /wf_bg_blue — Blue`
    );
  });

  ['white', 'red', 'blue'].forEach(color => {
    bot.command(`wf_bg_${color}`, (ctx) => {
      const userId = ctx.from.id.toString();
      const state = userState.get(userId);
      if (!state || state.workflow !== 'passportphoto_pack') return;

      state.data.bgColor = color;
      userState.set(userId, state);

      sendMarkdownSafe(ctx, `📸 *Ready!* Send your photo now.\n\n${menus.passportGuide}\n\nI will process the background and document format automatically.`);
    });
  });

  bot.command('business_photo_pack', async (ctx) => {
    const userId = ctx.from.id.toString();
    const cost = TOOL_COSTS.business_photo_pack;
    const balance = await shared.getCredits(userId);

    if (balance < cost) return sendMarkdownSafe(ctx, menus.notEnoughCredits('Business Pack', cost, balance));

    userState.startWorkflow(userId, 'business_photo_pack', {}, ['business_photo_pack']);
    sendMarkdownSafe(ctx, 
      `🛍️ *Business Photo Pack — 8 credits*\n\n` +
      `I will enhance your photo, remove the background, and create optimized assets for your social media storefront.\n\n` +
      `🎨 *Choose background colour:*\n\n` +
      `1️⃣ /biz_bg_white — Professional White\n` +
      `2️⃣ /biz_bg_black — Sleek Black\n` +
      `3️⃣ /biz_bg_grey  — Modern Grey\n` +
      `4️⃣ /biz_bg_blue  — Corporate Blue`
    );
  });

  ['white', 'black', 'grey', 'blue'].forEach(color => {
    bot.command(`biz_bg_${color}`, (ctx) => {
      const userId = ctx.from.id.toString();
      const state = userState.get(userId);
      if (!state || state.workflow !== 'business_photo_pack') return;
      state.data.bgColor = color;
      userState.set(userId, state);
      sendMarkdownSafe(ctx, `📸 *Ready!* Send your product or portrait photo now.`);
    });
  });

  // --- LOGIC PROCESSOR ---

  return {
    canHandle: (tool) => ['image_enhancer', 'passportphoto_pack', 'business_photo_pack'].includes(tool),
    process: async (ctx, tool, fileBuffer, fileName, mimeType, state, extendedShared) => {
      const { safelySendFile, balance, cost, deleteProcessingMessage, fileId } = extendedShared;
      const userId = ctx.from.id.toString();

      if (tool === 'image_enhancer') {
        const res = await enhanceImage(fileBuffer);
        if (!res.success) throw new Error(res.error);
        const sent = await safelySendFile(ctx, res.buffer, `enhanced_${fileName}`, `✅ *Elite Restoration Complete!*\n\nProcessed with FileForge Generative AI engine\n\nCredits remaining: *${balance - cost}*`);
        return { sent, buffer: res.buffer };
      }

      if (tool === 'passportphoto_pack') {
        const { bgColor } = state.data;
        const statusMsg = await ctx.reply("⚙️ Creating your Premium Passport...");

        try {
          // Step 1: Enhance
          await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, "⏳ Step 1 of 4 — Enhancing photo quality...");
          const enhanced = await enhanceImage(fileBuffer);
          
          // Step 2: Remove BG
          await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, "⏳ Step 2 of 4 — Removing background...");
          const noBg = await removeBackground(enhanced.buffer);
          
          // Step 3: Apply BG
          await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, "⏳ Step 3 of 4 — Applying background colour...");
          const withBg = await applyBackground(noBg.buffer, bgColor || 'white');
          
          // Step 4: Format
          await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, "⏳ Step 4 of 4 — Applying standard dimensions...");
          const passport = await makePassportPhoto(withBg.buffer, 'nigerian_passport');
          
          await deleteProcessingMessage(ctx, statusMsg.message_id);

          // Send High-Quality Passport and offer Print Sheet
          const caption = `✅ *Premium Passport Ready*\n\n` +
            `🎨 Color: ${bgColor || 'white'}\n` +
            `✨ Quality: Optimized for print\n` +
            `💳 Credits remaining: *${balance - cost}*`;

          const sentFileId = await safelySendFile(ctx, passport.buffer, 'Premium_Passport.jpg', caption);
          
          // Add Inline Button for A4 Sheet
          if (sentFileId) {
            const extra = {
              reply_markup: {
                inline_keyboard: [[{ text: '🖨 Reserve Print Sheet (A4)', callback_data: `print_sheet:${sentFileId}` }]]
              }
            };
            await ctx.reply('Need this for printing? I can arrange 6 copies on an A4 sheet for you instantly.', extra);
          }

          return { sent: !!sentFileId, fileId: sentFileId, buffer: passport.buffer };
        } catch (err) {
          await deleteProcessingMessage(ctx, statusMsg.message_id);
          throw err;
        }
      }

      if (tool === 'business_photo_pack') {
        const { bgColor } = state.data;
        const statusMsg = await ctx.reply("⚙️ Creating your Business Pack...");
        try {
          // Step 1: Enhance
          await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, "⏳ Step 1 of 4 — Enhancing image...");
          const enhanced = await enhanceImage(fileBuffer);
          
          // Step 2: Remove BG
          await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, "⏳ Step 2 of 4 — Removing background...");
          const noBg = await removeBackground(enhanced.buffer);
          
          // Step 3: Apply BG
          await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, "⏳ Step 3 of 4 — Applying branding colors...");
          const withBg = await applyBackground(noBg.buffer, bgColor || 'white');
          
          // Step 4: Multi-size Export
          await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, "⏳ Step 4 of 4 — Generating Social Media sizes...");
          const insta = await sharp(withBg.buffer).resize(1080, 1080, { fit: 'contain', background: {r:0,g:0,b:0,alpha:0} }).toBuffer();
          const status = await sharp(withBg.buffer).resize(1080, 1920, { fit: 'contain', background: {r:0,g:0,b:0,alpha:0} }).toBuffer();

          await deleteProcessingMessage(ctx, statusMsg.message_id);

          await safelySendFile(ctx, insta, 'business_square.jpg', '📱 *Instagram Square (1080×1080)*');
          const sentFinal = await safelySendFile(ctx, status, 'whatsapp.jpg', 
            `📲 *WhatsApp Status (1080×1920)*\n\n` +
            `🎨 Color: ${bgColor || 'white'}\n` +
            `💳 Credits remaining: *${balance - cost}*`
          );

          return { sent: sentFinal, buffer: withBg.buffer };
        } catch (err) {
          await deleteProcessingMessage(ctx, statusMsg.message_id);
          throw err;
        }
      }
    }
  };
};