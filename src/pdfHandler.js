const { compressPdf, pdfToWord, docxToPdf } = require('./services/pdf');

module.exports = (bot, shared) => {
  const { TOOL_COSTS, menus, userState, sendMarkdownSafe } = shared;

  // Commands
  bot.command('compress_pdf', (ctx) => {
    userState.set(ctx.from.id.toString(), { tool: 'compress_pdf' });
    sendMarkdownSafe(ctx, menus.awaitingFile(`Please send your *PDF file* now.\n\nCost: ${TOOL_COSTS.compress_pdf} credit(s)`));
  });

  bot.command('pdf_to_word', (ctx) => {
    userState.set(ctx.from.id.toString(), { tool: 'pdf_to_word' });
    sendMarkdownSafe(ctx, menus.awaitingFile(`Please send your *PDF file* now.\n\nCost: ${TOOL_COSTS.pdf_to_word} credit(s)`));
  });

  bot.command('docx_to_pdf', (ctx) => {
    userState.set(ctx.from.id.toString(), { tool: 'docx_to_pdf' });
    sendMarkdownSafe(ctx, menus.awaitingFile(`Please send your *Word (.docx) file* now.\n\nCost: ${TOOL_COSTS.docx_to_pdf} credit(s)`));
  });

  // Logic Processor
  return {
    canHandle: (tool) => ['compress_pdf', 'pdf_to_word', 'docx_to_pdf'].includes(tool),
    process: async (ctx, tool, fileBuffer, fileName, mimeType, state, extendedShared) => {
      const { safelySendFile, balance, cost } = extendedShared;
      
      if (tool === 'compress_pdf') {
        const result = await compressPdf(fileBuffer, fileName);
        if (!result.success) throw new Error('Compression failed');
        
        const sent = await safelySendFile(
          ctx, result.buffer, `compressed_${fileName}`,
          `✅ *PDF Compressed!*\n\n📦 Before: ${(result.originalSize / 1024).toFixed(1)} KB\n📦 After: ${(result.newSize / 1024).toFixed(1)} KB\n💾 Saved: ${result.savedPercent}%\n\nCredits remaining: *${balance - cost}*`
        );
        return { sent, buffer: result.buffer };
      }

      if (tool === 'pdf_to_word') {
        const result = await pdfToWord(fileBuffer, fileName);
        if (!result.success) throw new Error(result.error || 'Conversion failed');
        
        const outName = fileName.replace(/\.pdf$/i, '.docx');
        const sent = await safelySendFile(ctx, result.buffer, outName, `✅ *PDF converted to Word!*\n\nCredits remaining: *${balance - cost}*`);
        return { sent, buffer: result.buffer };
      }

      if (tool === 'docx_to_pdf') {
        const result = await docxToPdf(fileBuffer, fileName);
        if (!result.success) throw new Error(result.error || 'Conversion failed');
        
        const outName = fileName.replace(/\.docx$/i, '.pdf');
        const sent = await safelySendFile(ctx, result.buffer, outName, `✅ *Word converted to PDF!*\n\nCredits remaining: *${balance - cost}*`);
        return { sent, buffer: result.buffer };
      }
    }
  };
}