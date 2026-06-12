// src/menus.js
// ─────────────────────────────────────────────
// All the text menus the bot sends to users.
// Keeping them here makes it easy to edit
// wording without touching the bot logic.
// ─────────────────────────────────────────────

const menus = {

  // Sent when user first messages the bot or types /start
  welcome: `
👋 Welcome to *DocCenter* — Your Digital Business Center!

I can help you process documents and images instantly. Pay in Naira. No account needed.

*What do you need?*

📄 PDF Tools — /pdf
🖼 Image Tools — /image
🔊 Audio Tools — /audio
💳 Buy Credits — /credits
❓ Help — /help
`,

  // Sent when user types /pdf
  pdf: `
📄 *PDF Tools*

Choose a tool:

  1️⃣ /compress_pdf — Shrink your PDF file size (1 credit)
  2️⃣ /pdf_to_word — Convert PDF to Word document (2 credits)
  3️⃣ /docx_to_pdf — Convert Word (.docx) to PDF (2 credits)

💡 Each tool costs credits.
Type /credits to buy credits.
`,

  // Sent when user types /image
  image: `
🖼 *Image Tools*

Choose a tool:

1️⃣ /compress_image — Shrink image file size (1 credit)
2️⃣ /remove_background — Remove image background (2 credits)
3️⃣ /passport_photo — Make a passport photo (3 credits)
4️⃣ /convert_image — Convert image formats (jpg ↔ png, webp) (1 credit)

💡 Each tool costs credits.
Type /credits to buy credits.
`,

    // Sent when user types /audio
    audio: `
  🔊 *Audio Tools*

  Choose a tool:

  1️⃣ /transcribe — Convert audio/voice to text (transcription) (5 credits)

  💡 Each Usage costs 5 credits.
  Type /credits to buy credits.
  `,

  // Sent when user types /credits
  credits: `
💳 *Buy Credits*

Credits never expire. Pay once, use anytime.

*Available Packs:*

🟢 /buy_starter — ₦500 → 10 Credits
🔵 /buy_standard — ₦1,000 → 25 Credits  
⭐ /buy_pro — ₦2,000 → 60 Credits _(Best Value)_
💼 /buy_power — ₦5,000 → 180 Credits

*Credit costs per tool:*
• Compress PDF — 1 Credit
• Compress Image — 1 Credit
• Convert Image — 1 Credit
• PDF to Word — 2 Credits
• Remove Background — 2 Credits
• Passport Photo — 3 Credits
• Transcription (audio) — 5 Credits
`,

  // Sent when user types /help
  help: `
❓ *How DocCenter Works*

1. Choose a tool from the menu
2. Send your file when asked
3. If you have credits, result is instant
4. If not, buy credits first with /credits

*Commands:*
/start — Main menu
/pdf — PDF tools
/image — Image tools
/credits — Buy credits
/balance — Check your credits
/help — This message

📞 *Need help?* Message @Anene1
`,

  // Sent when a user does not have enough credits
  notEnoughCredits: (tool, cost, balance) => `
❌ *Not enough credits*

*${tool}* costs *${cost} credits*
Your balance: *${balance} credits*

Type /credits to top up.
`,

  // Sent after a tool completes successfully
  success: (tool, remaining) => `
✅ *Done! Your ${tool} result is above.*

Credits remaining: *${remaining}*

Need more tools? Type /start
`,

  // Sent when something goes wrong during processing
  error: (tool) => `
⚠️ Something went wrong while processing your *${tool}*.

Please try again. If the problem continues, message @Anene1 for help.
`,

  // Sent when the user's file is being processed
  processing: (tool) => `⏳ Processing your *${tool}*... Please wait.`,

  // Sent when we are waiting for the user to upload a file
  awaitingFile: (instruction) => `📎 ${instruction}`,

};

module.exports = menus;
