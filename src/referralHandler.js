const { getReferralCode, getReferralStats } = require('./credits');

module.exports = (bot, shared) => {
  const { sendMarkdownSafe } = shared;
  const BOT_USERNAME = process.env.BOT_USERNAME || 'DocCenterBot';

  bot.command('refer', (ctx) => {
    const userId = ctx.from.id.toString();
    const code = getReferralCode(userId);
    const stats = getReferralStats(userId);
    const link = `https://t.me/${BOT_USERNAME}?start=${code}`;

    const message = `
🎁 *Refer Friends, Earn Credits!*

Your referral link:
\`${link}\`

👆 Share this link with friends and family.

*How it works:*
• Friend clicks your link and opens the bot
• They get 3 BONUS credits when they first use a tool
• You earn 3 credits per successful referral
• Monthly limit: 15 referral credits (5 referrals)

*Your referral stats:*
👥 Total referrals: ${stats.referralCount}
💰 Credits earned: ${stats.creditsEarned}
📅 This month: ${stats.thisMonth}/15 credits

*Share this message:*
─────────────────
🤖 I use DocCenter Bot on Telegram for:
✅ Compressing PDFs
✅ Removing image backgrounds  
✅ Making passport photos
✅ Transcribing audio to text
✅ AI document summaries

All in Naira — no dollar payment!

Join with my link and get 3 FREE bonus credits:
${link}
─────────────────
`;

    sendMarkdownSafe(ctx, message);
  });

  return {
    // This handler only manages specific text commands, 
    // tool processing is handled by others.
    canHandle: () => false 
  };
};