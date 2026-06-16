// src/menus.js
// ─────────────────────────────────────────────
// All the text menus the bot sends to users.
// Keeping them here makes it easy to edit
// wording without touching the bot logic.
// ─────────────────────────────────────────────

const menus = {

  welcome: `
💎 *FileForge: Your Elite AI-Powered Document Studio*

Transform your workflow with instant, high-performance tools designed for excellence. From professional AI analysis to studio-quality image editing, we deliver results in seconds.

🚀 *The FileForge Advantage:*
• ✅ *AI Intelligence:* Summarize docs & rewrite CVs.
• ✅ *Studio Visuals:* Background removal & Pro photos.
• ✅ *Seamless Utility:* Compress, convert, & transcribe.
• ✅ *Frictionless:* Pay in ₦ — No account required.

*Select a category to begin:*
🤖 **AI Features** — /ai
📄 **Document Suite** — /pdf
🖼 **Image Studio** — /image
🎙 **Audio Hub** — /audio
 **Get Credits** — /credits
❓ **Support** — /help

*Want more free credits?* Share your referral link: /refer
Earn 3 credits for every friend who joins.
`,

  referralWelcome: `
🎊 *Welcome to FileForge!*

You joined through a friend's referral!

*Your starting credits:*
✅ Free starter credits: 10
✅ Referral bonus waiting: +5
━━━━━━━━━━━━━━━━━━
🎁 Use any tool to claim your bonus!
Total available: *15 credits*

*Try these popular tools:*
/document_photo_pack — 5 credits
/ai_cv_enhancer — 3 credits
/compress_pdf — 1 credit

Share your own link too: /refer
`,

  normalWelcome: `
🎊 *Welcome to FileForge!*

You have *10 FREE credits* to get started.
No payment needed.

*Try these first:*
1️⃣ /document_photo_pack (5 credits)
   → Passport-ready photo in 60 seconds

2️⃣ /compress_pdf (1 credit)
   → Shrink any PDF instantly

3️⃣ /ai_cv_enhancer (3 credits)
   → Professional CV improvement

*Want more free credits?*
Share your referral link: /refer
Earn 3 credits for every friend who joins.
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

  // Sent when user types /ai
  ai: `
🤖 *AI Features*

Choose an AI-powered tool:

1️⃣ /summarize — AI Document Summary (5 credits)
2️⃣ /cv_enhance — Professional CV Enhancement (10 credits)
3️⃣ /generate_image — AI Image Generator (Coming Soon)

💡 Each tool costs credits.
Type /credits to buy credits.
`,

  // Sent when user types /image
  image: `
🖼 *Image Tools*

Choose a tool:

1️⃣ /compress_image — Shrink image file size (1 credit)
2️⃣ /remove_background — Remove image background (2 credits)
3️⃣ /apply_background — Replace with white/red/blue background (3 credits)
4️⃣ /passport_photo — Make a passport photo (3 credits)
5️⃣ /convert_image — Convert image formats (jpg ↔ png, webp) (1 credit)
6️⃣ /image_enhancer — AI Photo Enhancement (Premium) (3 credits)
7️⃣ /passportphoto_pack — Premium Passport + Print Sheet (6 credits)

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
• AI Document Summary — 5 Credits
• CV Enhancement — 10 Credits
`,

  // Sent when user types /help
  help: `
❓ *How FileForge Works*

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
/refer — Refer friends & earn credits
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

  // Sent when a file exceeds the tool's size limit
  fileTooLarge: (limit) => `
📂 *File size exceeds limit*

This file is slightly larger than our current processing limit of *${limit}MB* for this tool. To ensure the best quality and speed, could you please try a smaller version or a different file?
`,

  // Sent when the file type does not match the tool's requirements
  invalidFileType: (expected) => `
❌ *Unsupported File Format*

The file you sent doesn't seem to match what this tool requires. 
Please send a file in one of these formats: *${expected}*
`,

  premiumMarketer: {
    getSuggestion: (tool) => {
      const suggestions = {
        ai_summarize: "Your insights are ready. Would you like me to generate a professionally formatted document of this summary? (3 credits)\n\nAlternatively, ensure your own professional profile is as sharp as this summary—our /ai_cv_enhancer is the perfect next step.",
        cv_enhance: "That's a world-class resume! To complete your elite presentation, I can generate a move-ready Word or PDF version for you. (3 credits)\n\nAlso, our /passport_photo tool ensures your application image is just as high-impact.",
        compress_pdf: "Optimization complete. If you need to dive deeper into this document, our /summarize tool can provide an executive overview in seconds.",
        pdf_to_word: "Seamlessly converted. If this document is part of a career move, our /ai_cv_enhancer is ready to help you land that interview.",
        remove_background: "Visuals refined. For a truly professional finish, use our /passport_photo tool to prepare this image for any corporate or official use.",
        passport_photo: "Excellence delivered! Your passport photo looks great. To make it absolutely perfect for official embassy or corporate use, would you like to add a professional *White, Blue, or Red* background? For just *3 credits*, we'll ensure it meets every requirement with a studio finish. Give it a try: /apply_background",
        transcribe_audio: "Transcription finalized. For a high-level briefing on these notes, our /summarize tool is just one click away.",
        "PassportPhoto Pack": "Your elite passport is ready. If you're preparing for an application, ensure your CV is equally impressive with our /ai_cv_enhancer.",
        image_enhancer: "Visuals reconstructed and refined with Generative Pro AI. Your photo now meets elite studio standards.",
        doc_export: "Your document has been professionally formatted and delivered. To ensure your entire career profile is just as polished, try our /ai_cv_enhancer.",
        referral_promo: "🎁 *Want more free credits?* Invite friends to FileForge! You get 3 credits for every friend who joins. Type /refer for your link."
      };
      return suggestions[tool] || suggestions.default;
    }
  },

  // Sent after a tool completes successfully
  success: (tool, remaining) => {
    const suggestion = menus.premiumMarketer.getSuggestion(tool);
    return `✨ *Premium Results Delivered*\n\n${suggestion}\n\n💳 Credits remaining: *${remaining}*\n\n${menus.premiumMarketer.getSuggestion('referral_promo')}`;
  },

  // Sent when something goes wrong during processing
  error: (tool) => `
⚠️ Something went wrong while processing your *${tool}*.

Please try again. If the problem continues, message @Anene1 for help.
`,

  // Sent when the user's file is being processed
  processing: (tool) => `⏳ Processing your *${tool}*... Please wait.`,

  // Sent when we are waiting for the user to upload a file
  awaitingFile: (instruction) => `📎 ${instruction}`,

  passportGuide: `📸 For best results:
• Position your face in the CENTER of the photo
• Leave space above your head
• Use a plain background`,

  // Workflow specific UI
  workflowCancelled: `❌ *Workflow cancelled.* Your session has been cleared.\n\nType /start to see the main menu.`,

  workflowNextStepPrompt: (nextStepName, cost) => `
✨ *Step Processed Successfully*

Would you like to proceed to the next step: *${nextStepName}*?
Cost: ${cost} credits.

Click /continue to proceed with the current file, or /finish to end this session.
`,

  referralPromptLowCredits: `
🎁 *Low on credits?* Invite friends with /refer and earn 3 credits for every successful referral!
`,


  workflowComplete: (name, remaining) => {
    const suggestion = menus.premiumMarketer.getSuggestion(name);
    return `🎉 *Workflow Complete!*\n\nThe *${name}* process is finished. All processed files have been delivered.\n\n✨ *Premium Suggestion*\n${suggestion}\n\n💳 Credits remaining: *${remaining}*`;
  },

};

module.exports = menus;
