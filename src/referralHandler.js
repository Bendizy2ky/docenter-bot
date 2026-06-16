const { getReferralCode, getReferralStats } = require('./credits');
const { getNextMilestone } = require('./referralUtils');

module.exports = (bot, shared) => {
  const { sendMarkdownSafe } = shared;
  const BOT_USERNAME = process.env.BOT_USERNAME || 'FileForgeBot';

  bot.command('refer', async (ctx) => {
    const userId = ctx.from.id.toString();
    const code = await getReferralCode(userId);
    const stats = await getReferralStats(userId);
    const link = `https://t.me/${BOT_USERNAME}?start=${code}`;
    const nextMilestone = getNextMilestone(stats.referralCount);

    const message = `
🎁 *Refer Friends, Earn Credits!*

Your referral link:
\`${link}\`

*How it works:*
- Friend clicks your link and opens the bot
- They get 5 BONUS credits on their first tool use
  (on top of their 10 free starter credits = 15 total!)
- You earn 3 credits per successful referral
- Monthly limit: 30 credits (10 referrals/month)

*Milestone Bonuses:*
🥉 5 referrals  → +10 bonus credits (free Try Pack!)
🥈 10 referrals → +25 bonus credits (free Regular Pack!)
🥇 25 referrals → +60 bonus credits (free Smart Pack!)
👑 50 referrals → +180 bonus credits (free Boss Pack!)

*Your referral stats:*
👥 Total referrals: [${stats.referralCount}]
💰 Total credits earned: [${stats.creditsEarned}]
📅 This month: ${stats.thisMonth}/30 credits
🏆 Next milestone: ${nextMilestone}

*Copy and share this:*
─────────────────────────────
🤖 I use *FileForge Bot* on Telegram!

It does things ChatGPT cannot do:
✅ Passport-ready photos in 60 seconds
✅ PDF compression and Word conversion
✅ Remove and replace image backgrounds
✅ Audio to text transcription
✅ AI CV enhancement — only 3 credits!
✅ AI document summaries — only 1 credit!

Everything paid in *Naira*. No dollar payment.
New users get *10 FREE credits* to start.
Join with my link — get *5 BONUS credits*:

${link}
─────────────────────────────
`;

    sendMarkdownSafe(ctx, message);
  });

  return {
    // This handler only manages specific text commands, 
    // tool processing is handled by others.
    canHandle: () => false 
  };
};