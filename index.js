// index.js
// ─────────────────────────────────────────────
// Entry point for DocCenter Telegram Bot.
// Run this file with: node index.js
// ─────────────────────────────────────────────

require('dotenv').config(); // Load all variables from .env file
try {
	const { startBot } = require('./src/bot');
	const { startServer } = require('./src/server');

	// Prevent multiple polling instances
process.env.NODE_ENV = process.env.NODE_ENV || 'production';

	// Start HTTP server (webhooks/callbacks)
	try { startServer(); } catch (e) { console.error('Failed to start server:', e && e.message); }

	// Start the bot
	startBot().catch(err => {
		console.error('CRITICAL: Bot startup failed:', err);
		process.exit(1);
	});
} catch (err) {
	console.error('Failed to start DocCenter bot:');
	console.error(err && err.stack ? err.stack : err);
	process.exit(1);
}
