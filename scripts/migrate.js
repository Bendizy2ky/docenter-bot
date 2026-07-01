#!/usr/bin/env node
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { generateReferralCode } = require('../src/credits');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY
);

const creditsFile = path.join(__dirname, '..', 'data', 'credits.json');

async function migrate() {
  if (!fs.existsSync(creditsFile)) {
    console.log('No credits.json found. Nothing to migrate.');
    return;
  }

  const raw = fs.readFileSync(creditsFile, 'utf8');
  const data = JSON.parse(raw || '{}');
  const entries = Object.entries(data);

  console.log(`Starting migration for ${entries.length} users...`);

  let migrated = 0;
  for (const [userId, value] of entries) {
    const credits = typeof value === 'number' ? value : value?.credits || 0;
    const referralCode = typeof value === 'object' && value?.referralCode ? value.referralCode : null;
    const referredBy = typeof value === 'object' && value?.referredBy ? value.referredBy : null;
    const referralCount = typeof value === 'object' && value?.referralCount ? value.referralCount : 0;
    const referralCreditsEarned = typeof value === 'object' && value?.referralCreditsEarned ? value.referralCreditsEarned : 0;
    const referralCreditsThisMonth = typeof value === 'object' && value?.referralCreditsThisMonth ? value.referralCreditsThisMonth : 0;
    const milestonesEarned = typeof value === 'object' && Array.isArray(value?.milestonesEarned) ? value.milestonesEarned : [];
    const firstToolUsed = typeof value === 'object' && Boolean(value?.firstToolUsed);
    const joinedAt = typeof value === 'object' && value?.joinedAt ? value.joinedAt : new Date().toISOString();

    const payload = {
      user_id: String(userId),
      credits,
      referral_code: referralCode || null,
      referred_by: referredBy || null,
      referral_count: referralCount,
      referral_credits_earned: referralCreditsEarned,
      referral_credits_this_month: referralCreditsThisMonth,
      milestones_earned: milestonesEarned,
      first_tool_used: firstToolUsed,
      joined_at: joinedAt,
    };

    const { error } = await supabase.from('users').upsert(payload, { onConflict: 'user_id' });
    if (error) {
      console.error(`Failed to migrate ${userId}:`, error.message);
      continue;
    }

    if (!payload.referral_code) {
      const generated = await generateReferralCode(userId);
      await supabase.from('users').update({ referral_code: generated }).eq('user_id', String(userId));
      payload.referral_code = generated;
    }

    migrated += 1;
    console.log(`Migrated ${userId} -> credits=${credits}, referral=${payload.referral_code || 'none'}`);
  }

  console.log(`Migration complete. Total users migrated: ${migrated}`);
}

migrate().catch((err) => {
  console.error('Migration failed:', err && err.message);
  process.exit(1);
});
