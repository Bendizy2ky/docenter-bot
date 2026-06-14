const { enhanceImage, removeBackground, applyBackground, makePassportPhoto, createPrintGrid } = require('./services/image');
const sharp = require('sharp');

module.exports = (bot, shared) => {
  const { TOOL_COSTS, menus, userState, sendMarkdownSafe } = shared;

  // --- COMMANDS ---

  bot.command('photo_fix', (ctx) => {
    userState.set(ctx.from.id.toString(), { tool: 'photo_fix' });
    sendMarkdownSafe(ctx, `✨ *Complete Photo Fix — 3 credits*\n\nSend me any photo and I will automatically enhance, sharpen and improve the quality.\n\n📸 Send your photo now.`);
  });

  bot.command('document_photo_pack', (ctx) => {
    const userId = ctx.from.id.toString();
    const cost = TOOL_COSTS.document_photo_pack;
    const balance = shared.getCredits(userId);

    if (balance < cost) return sendMarkdownSafe(ctx, menus.notEnoughCredits('Document Pack', cost, balance));

    userState.startWorkflow(userId, 'document_photo_pack', {}, ['document_photo_pack']);
    sendMarkdownSafe(ctx, 
      `📋 *Document Photo Pack — 6 credits*\n\n` +
      `I will enhance, remove background, apply correct colour and format your photo perfectly.\n\n` +
      `Which document is this for?\n\n` +
      `1️⃣ /doc_nigerian — Nigerian Passport\n` +
      `2️⃣ /doc_usvisa — US / UK Visa\n` +
      `3️⃣ /doc_jamb — JAMB\n` +
      `4️⃣ /doc_nin — NIN Enrollment\n` +
      `5️⃣ /doc_drivers — Driver's Licence`
    );
  });

  const docTypes = { 
    doc_nigerian: 'nigerian_passport', doc_usvisa: 'us_visa', 
    doc_jamb: 'jamb', doc_nin: 'nin', doc_drivers: 'drivers_licence' 
  };

  Object.entries(docTypes).forEach(([cmd, type]) => {
    bot.command(cmd, (ctx) => {
      const userId = ctx.from.id.toString();
      const state = userState.get(userId);
      if (!state || state.workflow !== 'document_photo_pack') return;
      
      state.data.docType = type;
      userState.set(userId, state);

      sendMarkdownSafe(ctx, 
        `🎨 *Choose background colour:*\n\n` +
        `1️⃣ /wf_bg_white — White ✅ (Recommended)\n` +
        `2️⃣ /wf_bg_red — Red\n` +
        `3️⃣ /wf_bg_blue — Blue`
      );
    });
  });

  ['white', 'red', 'blue'].forEach(color => {
    bot.command(`wf_bg_${color}`, (ctx) => {
      const userId = ctx.from.id.toString();
      const state = userState.get(userId);
      if (!state || state.workflow !== 'document_photo_pack') return;

      state.data.bgColor = color;
      userState.set(userId, state);

      sendMarkdownSafe(ctx, `📸 *Ready!* Send your photo now.\n\n${menus.passportGuide}\n\nI will process the background and document format automatically.`);
    });
  });

  bot.command('business_photo_pack', (ctx) => {
    const userId = ctx.from.id.toString();
    const cost = TOOL_COSTS.business_photo_pack;
    const balance = shared.getCredits(userId);

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
    canHandle: (tool) => ['photo_fix', 'document_photo_pack', 'business_photo_pack'].includes(tool),
    process: async (ctx, tool, fileBuffer, fileName, mimeType, state, extendedShared) => {
      const { safelySendFile, balance, cost, deleteProcessingMessage } = extendedShared;
      const userId = ctx.from.id.toString();

      if (tool === 'photo_fix') {
        const res = await enhanceImage(fileBuffer);
        if (!res.success) throw new Error(res.error);
        const sent = await safelySendFile(ctx, res.buffer, `fixed_${fileName}`, `✅ *Photo Fix Complete!*\n\nCredits remaining: *${balance - cost}*`);
        return { sent, buffer: res.buffer };
      }

      if (tool === 'document_photo_pack') {
        const { docType, bgColor } = state.data;
        const statusMsg = await ctx.reply("⚙️ Processing your Document Photo Pack...");

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
          await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, "⏳ Step 4 of 4 — Formatting for document...");
          const passport = await makePassportPhoto(withBg.buffer, docType || 'nigerian_passport');
          
          // Step 5: Print Sheet
          const grid = await createPrintGrid(passport.buffer);

          await deleteProcessingMessage(ctx, statusMsg.message_id);

          // Delivery
          const sent1 = await safelySendFile(ctx, passport.buffer, 'passport.jpg', `✅ *Single Passport Ready*`);
          const sent2 = await safelySendFile(ctx, grid.buffer, 'print_sheet.jpg', 
            `✅ *Print Sheet Ready (6 copies on A4)*\n\n` +
            `🎨 Background: ${bgColor || 'white'}\n` +
            `Credits used: 6\n` +
            `Credits remaining: *${balance - cost}*`
          );

          return { sent: sent1 && sent2, buffer: passport.buffer };
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