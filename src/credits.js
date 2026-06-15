// src/credits.js
// ─────────────────────────────────────────────
// Persistent credit storage using a local JSON file (credits.json)
// Functions: loadCredits, saveCredits, getCredits, addCredits, deductCredits
// Uses synchronous file operations for simplicity and robustness.
// ─────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const FILE = path.join(DATA_DIR, 'credits.json');

// Simple async queue to prevent concurrent write issues (Race Conditions)
let writeQueue = Promise.resolve();

// In-memory cache to prevent reading stale data from disk
let creditsCache = null;

/**
 * Internal helper to queue file writes
 */
async function queueSave(obj) {
  writeQueue = writeQueue.then(async () => {
    try {
      fs.writeFileSync(FILE, JSON.stringify(obj, null, 2), 'utf8');
    } catch (e) {
      console.error('Critical: Failed to save credits.json:', e.message);
    }
  });
  return writeQueue;
}

// Read credits.json from disk. Returns an object mapping userId -> number
function loadCredits() {
  try {
    if (!fs.existsSync(FILE)) return {};
    const raw = fs.readFileSync(FILE, 'utf8');
    const data = JSON.parse(raw || '{}');
    return data;
  } catch (e) {
    console.error('Failed to load credits.json:', e.message);
    return {};
  }
}

// Save credits object to disk synchronously
async function saveCredits(obj) {
  try {
    await queueSave(obj);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Migrates old number format to new object format or initializes new user.
 * @private
 */
async function _ensureUserObject(all, id) {
  const currentMonth = new Date().toISOString().slice(0, 7);
  
  // If new user
  if (!all[id]) {
    all[id] = {
      credits: 10, // Default starter credits
      referralCode: generateReferralCode(id, all),
      referredBy: null,
      referralCount: 0,
      referralCreditsEarned: 0,
      referralCreditsThisMonth: 0,
      referralMonthKey: currentMonth,
      milestonesEarned: [],
      firstToolUsed: false,
      joinedAt: new Date().toISOString()
    };
    await saveCredits(all);
    return;
  }

  // If old number format
  if (typeof all[id] === 'number') {
    all[id] = {
      credits: all[id],
      referralCode: generateReferralCode(id, all),
      referredBy: null,
      referralCount: 0,
      referralCreditsEarned: 0,
      referralCreditsThisMonth: 0,
      referralMonthKey: currentMonth,
      milestonesEarned: [],
      firstToolUsed: false,
      joinedAt: new Date().toISOString()
    };
    await saveCredits(all);
  }
}

// Returns numeric balance for userId. Handles migration automatically.
async function getCredits(userId) {
  try {
    const id = String(userId);
    const all = loadCredits();
    await _ensureUserObject(all, id);
    return all[id].credits;
  } catch (e) {
    console.error('getCredits error:', e && e.message);
    return 5;
  }
}

// Adds amount to user's balance and returns new balance
/**
 * Atomic Credit Operation
 * Prevents race conditions by using the writeQueue for the entire Read-Modify-Write cycle.
 */
async function atomicUpdate(userId, updateFn) {
    const id = String(userId);
    return writeQueue = writeQueue.then(async () => {
        const all = loadCredits();
        await _ensureUserObject(all, id);
        const result = updateFn(all[id]);
        await fs.promises.writeFile(FILE, JSON.stringify(all, null, 2), 'utf8');
        creditsCache = all;
        return result;
    });
}

async function addCredits(userId, amount) {
    return atomicUpdate(userId, (user) => {
        user.credits += Number(amount);
        return user.credits;
    });
}

async function deductCredits(userId, amount) {
    return atomicUpdate(userId, (user) => {
        const cost = Number(amount);
        if (user.credits < cost) throw new Error("Insufficient credits");
        user.credits -= cost;
        return user.credits;
    });
}

/**
 * Creates a unique code: "DOC-" + last 4 digits of userId + random 2 letter suffix
 */
function generateReferralCode(userId, all = null) {
  const idStr = String(userId);
  const suffix = Math.random().toString(36).substring(2, 4).toUpperCase();
  const code = `DOC-${idStr.slice(-4)}${suffix}`;
  
  // If data was provided, ensure uniqueness
  if (all) {
    const exists = Object.values(all).some(u => u.referralCode === code);
    if (exists) return generateReferralCode(userId, all);
  }
  return code;
}

/**
 * Returns existing referral code for userId
 */
async function getReferralCode(userId) {
  const all = loadCredits();
  await _ensureUserObject(all, String(userId));
  return all[String(userId)].referralCode;
}

/**
 * Searches for user with matching referralCode
 */
function findUserByReferralCode(code) {
  const all = loadCredits();
  const found = Object.entries(all).find(([id, data]) => data.referralCode === code);
  return found ? found[0] : null;
}

/**
 * Called when new user joins with a referral code
 */
async function registerReferral(newUserId, referralCode) {
  const all = loadCredits();
  const id = String(newUserId);
  
  const referrerId = findUserByReferralCode(referralCode);
  if (!referrerId) return { success: false, reason: 'Invalid' };
  if (referrerId === id) return { success: false, reason: 'Self' };
  
  await _ensureUserObject(all, id);
  if (all[id].referredBy) return { success: false, reason: 'Re-referred' };

  // Rule 7: Referrer must have used at least one tool
  if (!all[referrerId].firstToolUsed) return { success: false, reason: 'Inactive Referrer' };
  
  all[id].referredBy = referrerId;
  await saveCredits(all);
  return { success: true, referrerId };
}

/**
 * Rewards both parties after first tool use
 */
async function completeReferral(userId) {
  const all = loadCredits();
  const id = String(userId);
  await _ensureUserObject(all, id);
  
  const user = all[id];
  if (user.firstToolUsed) return { newUserBonus: 0, referrerRewarded: false };
  
  let newUserBonus = 0;
  let referrerRewarded = false;
  let referrerId = user.referredBy;
  let milestoneMsg = null;

  // Mark first use
  user.firstToolUsed = true;

  if (referrerId) {
    await _ensureUserObject(all, referrerId);
    const referrer = all[referrerId];
    const currentMonth = new Date().toISOString().slice(0, 7);

    // Anti-Farming: Check if user joined at least 24 hours ago. 
    // Default to a very old date if joinedAt is missing to prevent errors.
    const joinedAt = user.joinedAt ? new Date(user.joinedAt).getTime() : 0;
    const now = Date.now();
    if (now - joinedAt < 24 * 60 * 60 * 1000 && joinedAt !== 0) {
      console.log(`Referral ignored for ${id}: Account too new (farming protection).`);
      referrerId = null; 
    }
    
    // Give new user bonus
    if (referrerId) {
      user.credits += 5;
      newUserBonus = 5;

      // Handle Referrer reward with Monthly Cap
      if (referrer.referralMonthKey !== currentMonth) {
        referrer.referralCreditsThisMonth = 0;
        referrer.referralMonthKey = currentMonth;
      }

      if (referrer.referralCreditsThisMonth < 30) {
        referrer.credits += 3;
        referrer.referralCreditsEarned += 3;
        referrer.referralCreditsThisMonth += 3;
        referrerRewarded = true;
      }
      
      referrer.referralCount += 1;

      // Check Milestones
      milestoneMsg = await checkReferralMilestones(referrerId, all);
    }
  }

  await saveCredits(all);
  return { 
    newUserBonus, 
    referrerRewarded, 
    referrerId,
    newBalance: user.credits,
    referrerTotalEarned: referrerId ? all[referrerId].referralCreditsEarned : 0,
    referrerThisMonth: referrerId ? all[referrerId].referralCreditsThisMonth : 0,
    referrerBalance: referrerId ? all[referrerId].credits : 0,
    milestoneMsg
  };
}

/**
 * Internal milestone checker
 */
async function checkReferralMilestones(userId, all) {
  const u = all[userId];
  const count = u.referralCount;
  const earned = u.milestonesEarned || [];

  const milestones = [
    { threshold: 5, bonus: 10, name: 'Try Pack' },
    { threshold: 10, bonus: 25, name: 'Regular Pack' },
    { threshold: 25, bonus: 60, name: 'Smart Pack' },
    { threshold: 50, bonus: 180, name: 'Boss Pack' }
  ];

  for (const m of milestones) {
    if (count >= m.threshold && !earned.includes(m.threshold)) {
      u.credits += m.bonus;
      u.milestonesEarned = [...earned, m.threshold];
      return {
        threshold: m.threshold,
        bonus: m.bonus,
        packName: m.name,
        newBalance: u.credits
      };
    }
  }
  return null;
}

/**
 * Returns stats for /refer command
 */
async function getReferralStats(userId) {
  const all = loadCredits();
  const id = String(userId);
  await _ensureUserObject(all, id);
  const u = all[id];
  
  const currentMonth = new Date().toISOString().slice(0, 7);
  let thisMonth = u.referralCreditsThisMonth;
  if (u.referralMonthKey !== currentMonth) thisMonth = 0;

  return {
    code: u.referralCode,
    referralCount: u.referralCount,
    creditsEarned: u.referralCreditsEarned,
    thisMonth: thisMonth,
    monthlyCapRemaining: 30 - thisMonth
  };
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
  getReferralStats
};
