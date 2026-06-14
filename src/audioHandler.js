const { transcribeAudio } = require('./services/transcription');
const { enqueue } = require('./services/transcribe_queue');

module.exports = (bot, shared) => {
  const { TOOL_COSTS, menus, userState, sendMarkdownSafe } = shared;

  bot.command('transcribe', (ctx) => {
    userState.set(ctx.from.id.toString(), { tool: 'transcribe_audio' });
    sendMarkdownSafe(ctx, menus.awaitingFile(`Please send your *audio file* or voice message now.\n\nCost: ${TOOL_COSTS.transcribe_audio} credit(s)`));
  });

  const handleAudio = async (ctx, fileId, fileName) => {
    const userId = ctx.from.id.toString();
    const state = userState.get(userId);
    if (!state || state.tool !== 'transcribe_audio') return;

    const { getCredits, deductCredits, downloadTelegramFile, deleteProcessingMessage } = shared;
    const balance = await getCredits(userId);
    const cost = TOOL_COSTS.transcribe_audio;

    if (balance < cost) return sendMarkdownSafe(ctx, menus.notEnoughCredits('transcription', cost, balance));

    const msg = await sendMarkdownSafe(ctx, menus.processing('transcription'));
    
    try {
      const buffer = await downloadTelegramFile(fileId, ctx);
      const result = await transcribeAudio(buffer, fileName);

      await deleteProcessingMessage(ctx, msg.message_id);

      if (!result.success) {
        const detail = String(result.detail || '').toLowerCase();
        if (detail.includes('timeout') || detail.includes('enotfound')) {
          await enqueue(buffer, { userId, chatId: ctx.chat.id, originalFileName: fileName });
          return ctx.reply('⚠️ Service busy. File queued for later processing. No credits deducted.');
        }
        return ctx.reply('❌ Transcription failed.');
      }

      await sendMarkdownSafe(ctx, `📝 *Result:*\n\n${result.text}`);
      deductCredits(userId, cost);
      userState.delete(userId);
    } catch (e) {
      await deleteProcessingMessage(ctx, msg.message_id);
      ctx.reply('⚠️ Error during transcription.');
    }
  };

  bot.on('voice', (ctx) => handleAudio(ctx, ctx.message.voice.file_id, 'voice.ogg'));
  bot.on('audio', (ctx) => handleAudio(ctx, ctx.message.audio.file_id, ctx.message.audio.file_name || 'audio.mp3'));

  return {
    canHandle: (tool) => tool === 'transcribe_audio',
    process: async (ctx, tool, buffer, fileName) => {
      const userId = ctx.from.id.toString();
      const { deductCredits } = shared;
      const cost = TOOL_COSTS.transcribe_audio;

      try {
        const result = await transcribeAudio(buffer, fileName);
        if (!result.success) {
          const detail = String(result.detail || '').toLowerCase();
          if (detail.includes('timeout') || detail.includes('enotfound')) {
            await enqueue(buffer, { userId, chatId: ctx.chat.id, originalFileName: fileName });
            await ctx.reply('⚠️ Service busy. File queued for later processing. No credits deducted.');
            return false;
          }
          return false;
        }
        await sendMarkdownSafe(ctx, `📝 *Result:*\n\n${result.text}`);
        return true; 
      } catch (e) {
        return false;
      }
    }
  };
};