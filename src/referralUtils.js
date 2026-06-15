/**
 * Returns the next milestone target for a user based on their referral count.
 */
function getNextMilestone(count) {
  if (count < 5) return "5 referrals → +10 bonus credits";
  if (count < 10) return "10 referrals → +25 bonus credits";
  if (count < 25) return "25 referrals → +60 bonus credits";
  if (count < 50) return "50 referrals → +180 bonus credits";
  return "All milestones reached! 👑";
}

module.exports = { getNextMilestone };