// index.js
// ─────────────────────────────────────────────
// Entry point for DocCenter Telegram Bot.
// Run this file with: node index.js
// ─────────────────────────────────────────────

require('dotenv').config(); // Load all variables from .env file
try {
	const { startBot } = require('./src/bot');
	// Start the bot
	startBot();
} catch (err) {
	console.error('Failed to start DocCenter bot:');
	console.error(err && err.stack ? err.stack : err);
	process.exit(1);
}
