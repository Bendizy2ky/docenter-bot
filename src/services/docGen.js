const { Document, Packer, Paragraph, TextRun, AlignmentType } = require('docx');

/**
 * generateDocx
 * Creates a professionally formatted Word document from text.
 * Handles standard paragraphing and spacing.
 */
async function generateDocx(text, title = "Professional Document") {
  // Split by double newlines to identify paragraphs
  const paragraphs = text.split(/\n\s*\n/).map(block => {
    return new Paragraph({
      children: [
        new TextRun({
          text: block.trim(),
          font: "Arial",
          size: 24, // 12pt
        }),
      ],
      spacing: {
        after: 200,
        line: 276, // 1.15 line spacing
      },
      alignment: AlignmentType.JUSTIFIED,
    });
  });

  const doc = new Document({
    sections: [{
      properties: {},
      children: [
        new Paragraph({
          children: [
            new TextRun({ text: title, bold: true, size: 32, font: "Arial" }),
          ],
          spacing: { after: 400 },
          alignment: AlignmentType.CENTER,
        }),
        ...paragraphs,
      ],
    }],
  });

  return await Packer.toBuffer(doc);
}

module.exports = { generateDocx };