const { compressImage, removeBackground, makePassportPhoto, convertImage, applyBackground, enhanceImage, createPrintGrid } = require('./services/image');

module.exports = (bot, shared) => {
  const { TOOL_COSTS, menus, userState, sendMarkdownSafe } = shared;

  // Setup Commands
  bot.command('compress_image', (ctx) => {
    userState.set(ctx.from.id.toString(), { tool: 'compress_image' });
    sendMarkdownSafe(ctx, menus.awaitingFile(`Please send your *image* (JPG or PNG).\n\nCost: ${TOOL_COSTS.compress_image} credit(s)`));
  });

  bot.command('remove_background', (ctx) => {
    userState.set(ctx.from.id.toString(), { tool: 'remove_background' });
    sendMarkdownSafe(ctx, menus.awaitingFile(`Please send your *image* (JPG or PNG).\n\nCost: ${TOOL_COSTS.remove_background} credit(s)`));
  });

  bot.command('apply_background', (ctx) => {
    userState.set(ctx.from.id.toString(), { tool: 'apply_background' });
    sendMarkdownSafe(ctx, 
      `🎨 *Apply Background*\n\n` +
      `First I need to remove your existing background, then apply the new colour.\n\n` +
      `Choose your background colour:\n\n` +
      `1️⃣ /bg_white — White (passport, ID, JAMB)\n` +
      `2️⃣ /bg_red   — Red (some institution IDs)\n` +
      `3️⃣ /bg_blue  — Blue (visa applications)\n` +
      `4️⃣ /bg_grey  — Light grey (professional)`
    );
  });

  const backgroundColors = {
    bg_white: 'white',
    bg_red: 'red',
    bg_blue: 'blue',
    bg_grey: 'grey',
  };

  Object.entries(backgroundColors).forEach(([command, color]) => {
    bot.command(command, (ctx) => {
      userState.set(ctx.from.id.toString(), { tool: 'apply_background', bgColor: color });
      sendMarkdownSafe(ctx, 
        `📸 Now send your photo.\nI will remove the background and apply *${color.toUpperCase()}* automatically.\n\nCost: ${TOOL_COSTS.apply_background} credit(s)`
      );
    });
  });

  bot.command('convert_image', (ctx) => {
    sendMarkdownSafe(ctx, `🖼 *Image Conversion*\n\nChoose output format:\n• /to_png — Convert to PNG\n• /to_jpg — Convert to JPG\n• /to_webp — Convert to WebP`);
  });

  // Format Aliases
  const formats = { png: 'png', jpg: 'jpg', webp: 'webp', topng: 'png', tpjpg: 'jpg', towebp: 'webp' };
  Object.entries(formats).forEach(([cmd, target]) => {
    bot.command(cmd, (ctx) => {
      userState.set(ctx.from.id.toString(), { tool: 'convert_image', target });
      sendMarkdownSafe(ctx, menus.awaitingFile(`Please send your *image* now.\n\nCost: ${TOOL_COSTS.convert_image} credit(s)`));
    });
  });

  // Passport sub-commands
  const passportDocTypes = { pp_nigerian: 'nigerian_passport', pp_usvisa: 'us_visa', pp_jamb: 'jamb', pp_nin: 'nin', pp_drivers: 'drivers_licence' };
  Object.entries(passportDocTypes).forEach(([command, docType]) => {
    bot.command(command, (ctx) => {
      userState.set(ctx.from.id.toString(), { tool: 'passport_photo', docType });
      sendMarkdownSafe(ctx, menus.awaitingFile(`Great! Now send a *clear, front-facing photo*.\n\n${menus.passportGuide}\n\nCost: ${TOOL_COSTS.passport_photo} credit(s)`));
    });
  });

  return {
    canHandle: (tool) => ['compress_image', 'remove_background', 'passport_photo', 'convert_image', 'apply_background', 'create_print_grid'].includes(tool),
    process: async (ctx, tool, fileBuffer, fileName, mimeType, state, extendedShared) => {
      const { safelySendFile, balance, cost } = extendedShared;

      if (tool === 'create_print_grid') {
        const res = await createPrintGrid(fileBuffer);
        if (!res.success) throw new Error('Grid creation failed');
        const sent = await safelySendFile(ctx, res.buffer, `print_sheet_${fileName}`, `✅ *Print Grid Ready!*`);
        return { sent, buffer: res.buffer };
      }

      if (tool === 'compress_image') {
        const res = await compressImage(fileBuffer, mimeType || 'image/jpeg');
        if (!res.success) throw new Error('Compression failed');
        const sent = await safelySendFile(ctx, res.buffer, `compressed_${fileName || 'img.jpg'}`, 
          `✅ *Image Compressed!*\n\n📦 Before: ${(res.originalSize/1024).toFixed(1)} KB\n📦 After: ${(res.newSize/1024).toFixed(1)} KB\n\nCredits remaining: *${balance - cost}*`);
        return { sent, buffer: res.buffer };
      }

      if (tool === 'remove_background') {
        const res = await removeBackground(fileBuffer);
        if (!res.success) throw new Error('Background removal failed');
        const sent = await safelySendFile(ctx, res.buffer, 'no_background.png', `✅ *Background Removed!*\n\nCredits remaining: *${balance - cost}*`);
        return { sent, buffer: res.buffer };
      }

      if (tool === 'passport_photo') {
        const res = await makePassportPhoto(fileBuffer, state.docType || 'nigerian_passport');
        if (!res.success) throw new Error('Passport photo generation failed');
        const sent = await safelySendFile(ctx, res.buffer, 'passport.jpg', `✅ *${res.label} Ready!*\n\nCredits remaining: *${balance - cost}*`);
        return { sent, buffer: res.buffer };
      }

      if (tool === 'convert_image') {
        const target = state.target || 'png';
        const res = await convertImage(fileBuffer, target);
        if (!res.success) throw new Error('Conversion failed');
        const sent = await safelySendFile(ctx, res.buffer, `converted.${target}`, `✅ *Converted to ${target.toUpperCase()}!*\n\nCredits remaining: *${balance - cost}*`);
        return { sent, buffer: res.buffer };
      }

      if (tool === 'apply_background') {
        const bgColor = state.bgColor || 'white';
        const removedBgResult = await removeBackground(fileBuffer);
        if (!removedBgResult.success) throw new Error('Background removal failed.');

        const finalImageResult = await applyBackground(removedBgResult.buffer, bgColor);
        if (!finalImageResult.success) throw new Error('Applying solid background failed.');

        const sent = await safelySendFile(
          ctx,
          finalImageResult.buffer,
          `photo_${bgColor}_background.jpg`,
          `✅ *Done! ${bgColor.toUpperCase()} background applied.*\n\n` +
          `Ready to format as a passport photo?\nType /passport_photo to continue.\n\n` +
          `Credits used: ${TOOL_COSTS.apply_background}\nCredits remaining: *${balance - cost}*`
        );
        return { sent, buffer: finalImageResult.buffer };
      }
    }
  };
};