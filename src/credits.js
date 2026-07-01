// src/credits.js
// ─────────────────────────────────────────────
// Supabase-backed credit storage for FileForge.
// Keeps the same public function names/signatures,
// but stores users and referral data in Supabase.
// ─────────────────────────────────────────────

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY
);

let creditsCache = {};
const ADMIN_ID = process.env.ADMIN_TELEGRAM_ID || '772990882';

function normalizeUserId(userId) {
  return String(userId);
}

function normalizeCreditValue(value) {
  const num = Number(value || 0);
  return Number.isFinite(num) ? num : 0;
}

function buildDefaultUser(userId) {
  return {
    user_id: normalizeUserId(userId),
    credits: 15,
    referral_code: null,
    referred_by: null,
    referral_count: 0,
    referral_credits_this_month: 0,
    referral_credits_earned: 0,
    referral_month_key: new Date().toISOString().slice(0, 7),
    milestones_earned: [],
    first_tool_used: false,
    joined_at: new Date().toISOString(),
  };
}

function mapRowToLegacyShape(row) {
  return {
    credits: normalizeCreditValue(row.credits),
    referralCode: row.referral_code || null,
    referredBy: row.referred_by || null,
    referralCount: normalizeCreditValue(row.referral_count),
    referralCreditsEarned: normalizeCreditValue(row.referral_credits_earned),
    referralCreditsThisMonth: normalizeCreditValue(row.referral_credits_this_month),
    referralMonthKey: row.referral_month_key || null,
    milestonesEarned: Array.isArray(row.milestones_earned) ? row.milestones_earned : [],
    firstToolUsed: Boolean(row.first_tool_used),
    joinedAt: row.joined_at || null,
  };
}

function mapLegacyShapeToRow(userId, data) {
  const base = buildDefaultUser(userId);
  const incoming = data || {};
  return {
    user_id: normalizeUserId(userId),
    credits: normalizeCreditValue(incoming.credits ?? base.credits),
    referral_code: incoming.referralCode || base.referral_code,
    referred_by: incoming.referredBy || base.referred_by,
    referral_count: normalizeCreditValue(incoming.referralCount ?? base.referral_count),
    referral_credits_this_month: normalizeCreditValue(incoming.referralCreditsThisMonth ?? base.referral_credits_this_month),
    referral_credits_earned: normalizeCreditValue(incoming.referralCreditsEarned ?? base.referral_credits_earned),
    referral_month_key: incoming.referralMonthKey || base.referral_month_key,
    milestones_earned: Array.isArray(incoming.milestonesEarned) ? incoming.milestonesEarned : base.milestones_earned,
    first_tool_used: Boolean(incoming.firstToolUsed ?? base.first_tool_used),
    joined_at: incoming.joinedAt || base.joined_at,
  };
}

async function ensureUser(userId) {
  const id = normalizeUserId(userId);
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('user_id', id)
    .maybeSingle();

  if (error) throw error;
  if (data) {
    creditsCache[id] = mapRowToLegacyShape(data);
    return data;
  }

  const payload = buildDefaultUser(id);
  const { data: created, error: createError } = await supabase
    .from('users')
    .insert(payload)
    .select('*')
    .maybeSingle();

  if (createError) throw createError;
  creditsCache[id] = mapRowToLegacyShape(created || payload);
  return created || payload;
}

async function updateUser(userId, updates) {
  const id = normalizeUserId(userId);
  const { data, error } = await supabase
    .from('users')
    .update(updates)
    .eq('user_id', id)
    .select('*')
    .maybeSingle();

  if (error) throw error;
  if (data) {
    creditsCache[id] = mapRowToLegacyShape(data);
  }
  return data;
}

async function loadCredits() {
  try {
    const { data, error } = await supabase.from('users').select('*');
    if (error) throw error;
    const result = {};
    (data || []).forEach((row) => {
      result[normalizeUserId(row.user_id)] = mapRowToLegacyShape(row);
    });
    creditsCache = result;
    return result;
  } catch (e) {
    console.error('Failed to load credits from Supabase:', e && e.message);
    return creditsCache;
  }
}

async function saveCredits(obj) {
  try {
    if (!obj || typeof obj !== 'object') return false;
    const entries = Object.entries(obj);
    for (const [userId, value] of entries) {
      const payload = mapLegacyShapeToRow(userId, value);
      const { error } = await supabase.from('users').upsert(payload, { onConflict: 'user_id' });
      if (error) throw error;
    }
    creditsCache = obj;
    return true;
  } catch (e) {
    console.error('Failed to save credits to Supabase:', e && e.message);
    return false;
  }
}

async function getCredits(userId) {
  try {
    const user = await ensureUser(userId);
    return normalizeCreditValue(user.credits);
  } catch (e) {
    console.error('getCredits error:', e && e.message);
    return 15;
  }
}

async function addCredits(userId, amount, isPurchase = false) {
  try {
    const id = normalizeUserId(userId);
    const user = await ensureUser(id);
    const newBalance = normalizeCreditValue(user.credits) + normalizeCreditValue(amount);
    const updated = await updateUser(id, { credits: newBalance });
    if (updated) {
      return normalizeCreditValue(updated.credits);
    }
    return newBalance;
  } catch (e) {
    console.error('addCredits error:', e && e.message);
    return 0;
  }
}

async function deductCredits(userId, amount, toolName = null) {
  try {
    const id = normalizeUserId(userId);
    const user = await ensureUser(id);
    const cost = normalizeCreditValue(amount);
    const current = normalizeCreditValue(user.credits);
    if (current < cost) {
      return 0;
    }
    const newBalance = current - cost;
    const updated = await updateUser(id, { credits: newBalance });
    if (updated) {
      return normalizeCreditValue(updated.credits);
    }
    return newBalance;
  } catch (e) {
    console.error('deductCredits error:', e && e.message);
    return 0;
  }
}

async function generateReferralCode(userId) {
  const idStr = normalizeUserId(userId);
  while (true) {
    const suffix = Math.random().toString(36).substring(2, 4).toUpperCase();
    const code = `FF-${idStr.slice(-4)}${suffix}`;
    const { data, error } = await supabase
      .from('users')
      .select('user_id')
      .eq('referral_code', code)
      .maybeSingle();

    if (error) throw error;
    if (!data) return code;
  }
}

async function getReferralCode(userId) {
  const id = normalizeUserId(userId);
  const user = await ensureUser(id);
  if (!user.referral_code) {
    const code = await generateReferralCode(id);
    await updateUser(id, { referral_code: code });
    return code;
  }
  return user.referral_code;
}

async function findUserByReferralCode(code) {
  if (!code) return null;
  const { data, error } = await supabase
    .from('users')
    .select('user_id')
    .eq('referral_code', code)
    .maybeSingle();

  if (error) throw error;
  return data ? normalizeUserId(data.user_id) : null;
}

async function registerReferral(newUserId, referralCode) {
  const id = normalizeUserId(newUserId);
  const referrerId = await findUserByReferralCode(referralCode);
  if (!referrerId) return { success: false, reason: 'Invalid' };
  if (referrerId === id) return { success: false, reason: 'Self' };

  const newUser = await ensureUser(id);
  if (newUser.referred_by) return { success: false, reason: 'Re-referred' };

  await updateUser(id, { referred_by: referrerId });
  return { success: true, referrerId };
}

async function completeReferral(userId) {
  const id = normalizeUserId(userId);
  const user = await ensureUser(id);
  if (user.first_tool_used) return { newUserBonus: 0, referrerRewarded: false, referrerId: null };

  let newUserBonus = 0;
  let referrerRewarded = false;
  let referrerId = user.referred_by;

  await updateUser(id, { first_tool_used: true });

  if (referrerId) {
    const joinedAt = user.joined_at ? new Date(user.joined_at).getTime() : 0;
    const now = Date.now();
    const isOldEnough = joinedAt > 0 && (now - joinedAt) >= 24 * 60 * 60 * 1000;

    const referrer = await ensureUser(referrerId);
    if (isOldEnough) {
      const newUserBalance = normalizeCreditValue(user.credits) + 5;
      await updateUser(id, { credits: newUserBalance });
      newUserBonus = 5;

      const currentMonth = new Date().toISOString().slice(0, 7);
      if (normalizeCreditValue(referrer.referral_month_key) !== currentMonth && referrer.referral_month_key) {
        await updateUser(referrerId, { referral_credits_this_month: 0, referral_month_key: currentMonth });
      }

      const currentThisMonth = normalizeCreditValue(referrer.referral_credits_this_month);
      if (currentThisMonth < 30) {
        const referrerBalance = normalizeCreditValue(referrer.credits) + 3;
        const referrerEarned = normalizeCreditValue(referrer.referral_credits_earned) + 3;
        const referrerThisMonth = currentThisMonth + 3;
        const referrerCount = normalizeCreditValue(referrer.referral_count) + 1;
        await updateUser(referrerId, {
          credits: referrerBalance,
          referral_count: referrerCount,
          referral_credits_this_month: referrerThisMonth,
          referral_credits_earned: referrerEarned,
          referral_month_key: currentMonth,
        });
        referrerRewarded = true;
      }
    }
  }

  if (referrerRewarded) {
    await checkReferralMilestones(referrerId);
  }

  return { newUserBonus, referrerRewarded, referrerId };
}

async function checkReferralMilestones(userId) {
  const id = normalizeUserId(userId);
  const user = await ensureUser(id);
  const count = normalizeCreditValue(user.referral_count);
  const earned = Array.isArray(user.milestones_earned) ? user.milestones_earned : [];

  const milestones = [
    { threshold: 5, bonus: 10, name: 'Try Pack' },
    { threshold: 10, bonus: 25, name: 'Regular Pack' },
    { threshold: 25, bonus: 60, name: 'Smart Pack' },
    { threshold: 50, bonus: 180, name: 'Boss Pack' },
  ];

  for (const milestone of milestones) {
    if (count >= milestone.threshold && !earned.includes(milestone.threshold)) {
      const currentCredits = normalizeCreditValue(user.credits);
      const nextArray = [...earned, milestone.threshold];
      await updateUser(id, {
        credits: currentCredits + milestone.bonus,
        milestones_earned: nextArray,
      });
      return `Milestone reached: ${milestone.threshold} referrals -> +${milestone.bonus} credits`;
    }
  }

  return null;
}

async function getReferralStats(userId) {
  const id = normalizeUserId(userId);
  const user = await ensureUser(id);
  const code = user.referral_code || (await getReferralCode(id));
  const referralCount = normalizeCreditValue(user.referral_count);
  const creditsEarned = normalizeCreditValue(user.referral_credits_earned);
  const thisMonth = normalizeCreditValue(user.referral_credits_this_month);
  const thresholds = [5, 10, 25, 50];
  const nextMilestone = thresholds.find((threshold) => referralCount < threshold) || null;

  return {
    code,
    referralCount,
    creditsEarned,
    thisMonth,
    monthlyCapRemaining: Math.max(30 - thisMonth, 0),
    nextMilestone,
  };
}

async function getGlobalStats() {
  try {
    const all = await loadCredits();
    const now = new Date();
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const userIds = Object.keys(all).filter((id) => id !== ADMIN_ID);
    let total = userIds.length;
    let daily = 0;
    let weekly = 0;
    let active = 0;
    let totalReferrals = 0;
    let referrersList = [];
    let toolUsageAggregated = {};

    userIds.forEach((id) => {
      const u = all[id];
      if (!u) return;
      if (u.joinedAt) {
        const joinDate = new Date(u.joinedAt);
        if (joinDate > dayAgo) daily++;
        if (joinDate > weekAgo) weekly++;
      }

      if (u.firstToolUsed) active++;
      if (u.referralCount > 0) {
        totalReferrals += u.referralCount;
        referrersList.push({ id, count: u.referralCount });
      }
      if (u.toolUsage) {
        for (const [tool, count] of Object.entries(u.toolUsage)) {
          toolUsageAggregated[tool] = (toolUsageAggregated[tool] || 0) + count;
        }
      }
    });

    return {
      total,
      daily,
      weekly,
      active,
      rankedTools: Object.entries(toolUsageAggregated).sort(([, a], [, b]) => b - a),
      totalReferrals,
      topReferrers: referrersList.sort((a, b) => b.count - a.count).slice(0, 5),
    };
  } catch (e) {
    console.error('getGlobalStats error:', e && e.message);
    return {};
  }
}

async function logTransaction(userId, toolUsed, creditsDeducted, status, source = 'telegram') {
  try {
    const payload = {
      user_id: normalizeUserId(userId),
      tool_used: toolUsed,
      credits_deducted: normalizeCreditValue(creditsDeducted),
      status,
      source,
    };
    await supabase.from('transactions').insert(payload);
  } catch (e) {
    console.error('Transaction logging failed:', e && e.message);
  }
}

module.exports = {
  loadCredits,
  saveCredits,
  getCredits,
  addCredits,
  deductCredits,
  generateReferralCode,
  getReferralCode,
  findUserByReferralCode,
  registerReferral,
  completeReferral,
  checkReferralMilestones,
  getReferralStats,
  getGlobalStats,
  logTransaction,
};
