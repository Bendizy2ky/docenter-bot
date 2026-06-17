// src/services/transcribe_queue.js
// Simple on-disk queue for transcription when Groq is unreachable.

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { transcribeAudio } = require('./transcription');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const QUEUE_DIR = path.join(DATA_DIR, 'transcribe_queue');
if (!fs.existsSync(QUEUE_DIR)) fs.mkdirSync(QUEUE_DIR, { recursive: true });

function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2,9)}`;
}

async function enqueue(fileBuffer, meta) {
  const id = makeId();
  const binPath = path.join(QUEUE_DIR, `${id}.bin`);
  const jsonPath = path.join(QUEUE_DIR, `${id}.json`);
  fs.writeFileSync(binPath, fileBuffer);
  fs.writeFileSync(jsonPath, JSON.stringify({ ...meta, binPath }, null, 2));
  console.log(`Enqueued transcription job ${id} for user ${meta.userId}`);
  return id;
}

async function processQueueOnce() {
  const files = fs.readdirSync(QUEUE_DIR).filter((f) => f.endsWith('.json'));
  for (const file of files) {
    const jsonPath = path.join(QUEUE_DIR, file);
    let job;
    try {
      job = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    } catch (e) {
      console.error('Failed to read queued job', jsonPath, e.message);
      continue;
    }

    const { binPath, userId, chatId, originalFileName } = job;
    if (!fs.existsSync(binPath)) {
      console.error('Missing binary for job', jsonPath);
      fs.unlinkSync(jsonPath);
      continue;
    }

    const fileBuffer = fs.readFileSync(binPath);

    try {
      const result = await transcribeAudio(fileBuffer, originalFileName || 'audio.ogg');
      if (!result.success) {
        console.error('Queued transcription failed:', result.error, result.detail || 'no detail');
        // If network error, leave job for later. If unrecoverable, remove and notify user.
        const detail = String(result.detail || '').toLowerCase();
        const networkIssue = detail.includes('enotfound') || detail.includes('could not be resolved') || detail.includes('etimedout');
        if (networkIssue) {
          console.log('Network issue detected, will retry this job later.');
          continue;
        }

        // Unrecoverable error: notify user and remove job
        try {
          await sendMessage(job.chatId, `❌ We couldn't transcribe your queued file. Please try sending it again later. If this keeps happening, message @FileForgeHelpDesk_bot for help.`);
        } catch (e) {}
        fs.unlinkSync(binPath);
        fs.unlinkSync(jsonPath);
        continue;
      }

      // Success: send transcription to user and remove job files
      await sendMessage(job.chatId, `📝 *Queued Transcription result:*
\n${result.text}`);
      fs.unlinkSync(binPath);
      fs.unlinkSync(jsonPath);
      console.log('Queued job processed and removed:', jsonPath);

    } catch (e) {
      console.error('Error processing queued job', jsonPath, e.message);
    }
  }
}

async function sendMessage(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN missing');
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  await axios.post(url, { chat_id: chatId, text: text, parse_mode: 'Markdown' });
}

// Start background loop (non-blocking)
function startBackgroundWorker(intervalMs = 60000) {
  setInterval(() => {
    processQueueOnce().catch((e) => console.error('Queue process error:', e.message));
  }, intervalMs);
  // run immediately once
  processQueueOnce().catch((e) => console.error('Queue process error:', e.message));
}

module.exports = { enqueue, startBackgroundWorker };
