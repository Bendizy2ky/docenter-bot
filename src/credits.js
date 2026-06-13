// src/credits.js
// ─────────────────────────────────────────────
// Persistent credit storage using a local JSON file (credits.json)
// Functions: loadCredits, saveCredits, getCredits, addCredits, deductCredits
// Uses synchronous file operations for simplicity and robustness.
// ─────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'credits.json');

// Read credits.json from disk. Returns an object mapping userId -> number
function loadCredits() {
  try {
    if (!fs.existsSync(FILE)) return {};
    const raw = fs.readFileSync(FILE, 'utf8');
    if (!raw) return {};
    return JSON.parse(raw || '{}');
  } catch (e) {
    console.error('Failed to load credits.json:', e && e.message);
    return {};
  }
}

// Save credits object to disk synchronously
function saveCredits(obj) {
  try {
    fs.writeFileSync(FILE, JSON.stringify(obj, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('Failed to save credits.json:', e && e.message);
    return false;
  }
}

// Returns numeric balance for userId. If not present, seeds 5 starter credits.
function getCredits(userId) {
  try {
    const id = String(userId);
    const all = loadCredits();
    if (typeof all[id] === 'number') return all[id];
    // Seed starter credits for new user
    all[id] = 5;
    saveCredits(all);
    return all[id];
  } catch (e) {
    console.error('getCredits error:', e && e.message);
    return 5;
  }
}

// Adds amount to user's balance and returns new balance
function addCredits(userId, amount) {
  try {
    const id = String(userId);
    const all = loadCredits();
    const prev = Number(all[id] || 0);
    const next = prev + Number(amount || 0);
    all[id] = next;
    saveCredits(all);
    return next;
  } catch (e) {
    console.error('addCredits error:', e && e.message);
    return null;
  }
}

// Deducts amount (never below 0) and returns new balance
function deductCredits(userId, amount) {
  try {
    const id = String(userId);
    const all = loadCredits();
    const prev = Number(all[id] || 0);
    const next = Math.max(0, prev - Number(amount || 0));
    all[id] = next;
    saveCredits(all);
    return next;
  } catch (e) {
    console.error('deductCredits error:', e && e.message);
    return null;
  }
}

module.exports = {
  loadCredits,
  saveCredits,
  getCredits,
  addCredits,
  deductCredits,
};
