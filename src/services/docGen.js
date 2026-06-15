const { Document, Packer, Paragraph, TextRun, AlignmentType } = require('docx');

/**
 * generateDocx
 * Creates a professionally formatted Word document from text.
 * Handles standard paragraphing and spacing.
 */
async function generateDocx(text, title = "Professional Document") {
  // Split by double newlines to identify paragraphs
  const blocks = text.split(/\n/);
  const docParagraphs = [];

  blocks.forEach(line => {
    const trimmed = line.trim();
    if (!trimmed) return;

    // Determine if it's a heading
    const isHeading = trimmed.startsWith('#') || (trimmed.toUpperCase() === trimmed && trimmed.length > 3 && !trimmed.includes(':'));
    const cleanText = trimmed.replace(/^#+\s*/, '');

    // Handle bold sections within text
    const parts = cleanText.split(/(\*\*.*?\*\*)/);
    const children = parts.map(part => {
      if (part.startsWith('**') && part.endsWith('**')) {
        return new TextRun({
          text: part.replace(/\*\*/g, ''),
          bold: true,
          font: "Arial",
          size: isHeading ? 28 : 22,
        });
      }
      return new TextRun({
        text: part,
        font: "Arial",
        size: isHeading ? 28 : 22,
      });
    });

    docParagraphs.push(new Paragraph({
        children: children,
      spacing: {
          before: isHeading ? 240 : 120,
          after: 120,
          line: 276,
        },
        heading: isHeading ? "Heading2" : undefined,
        bullet: trimmed.startsWith('*') || trimmed.startsWith('-') ? { level: 0 } : undefined,
        alignment: isHeading ? AlignmentType.LEFT : AlignmentType.JUSTIFIED,
      })
    );
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
        ...docParagraphs,
      ],
    }],
  });

  return await Packer.toBuffer(doc);
}

module.exports = { generateDocx };