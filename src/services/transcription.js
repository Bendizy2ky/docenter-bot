// src/services/transcription.js
// src/services/transcription.js
// AssemblyAI-based transcription service

const axios = require('axios');

/**
 * transcribeAudio
 * Uploads audio to AssemblyAI and polls for the transcript.
 * @param {Buffer} fileBuffer
 * @param {string} filename
 * @returns {object} { success, text } or { success: false, error, detail }
 */
async function transcribeAudio(fileBuffer, filename = 'audio.ogg') {
  const apiKey = process.env.ASSEMBLYAI_API_KEY;
  if (!apiKey) {
    console.error('ASSEMBLYAI_API_KEY not set');
    return { success: false, error: 'Transcription service not configured.' };
  }

  // Create an axios instance so we can attach an httpsAgent when a proxy is configured
  const axiosInstance = axios.create({ timeout: 120000, maxContentLength: Infinity, maxBodyLength: Infinity });
  const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  if (proxyUrl) {
    try {
      const { HttpsProxyAgent } = require('https-proxy-agent');
      axiosInstance.defaults.httpsAgent = new HttpsProxyAgent(proxyUrl);
      axiosInstance.defaults.proxy = false;
      console.log('Using proxy for AssemblyAI requests:', proxyUrl);
    } catch (e) {
      console.error('https-proxy-agent not available:', e.message);
    }
  }

  try {
    // 1) Upload the file to AssemblyAI
    const uploadResp = await axiosInstance.post('https://api.assemblyai.com/v2/upload', fileBuffer, {
      headers: {
        authorization: apiKey,
        'Content-Type': 'application/octet-stream',
        'Transfer-Encoding': 'chunked',
      },
      timeout: 120000,
    });

    const uploadUrl = uploadResp.data?.upload_url;
    if (!uploadUrl) {
      return { success: false, error: 'Upload failed', detail: uploadResp.data };
    }

    // 2) Request a transcript
    const createResp = await axiosInstance.post('https://api.assemblyai.com/v2/transcript', { audio_url: uploadUrl }, {
      headers: { authorization: apiKey, 'Content-Type': 'application/json' },
      timeout: 10000,
    });

    const transcriptId = createResp.data?.id;
    if (!transcriptId) {
      return { success: false, error: 'Failed to create transcript', detail: createResp.data };
    }

    // 3) Poll for completion (up to 3 minutes)
    const start = Date.now();
    const timeoutMs = Number(process.env.TRANSCRIBE_TIMEOUT_MS) || 3 * 60 * 1000;
    while (Date.now() - start < timeoutMs) {
      const statusResp = await axiosInstance.get(`https://api.assemblyai.com/v2/transcript/${transcriptId}`, {
        headers: { authorization: apiKey },
        timeout: 15000,
      });

      const status = statusResp.data?.status;
      if (status === 'completed') {
        return { success: true, text: statusResp.data?.text || '' };
      }
      if (status === 'error') {
        return { success: false, error: 'Transcription error', detail: statusResp.data?.error || statusResp.data };
      }

      // Wait a short period before polling again
      await new Promise((r) => setTimeout(r, 2000));
    }

    return { success: false, error: 'Transcription timed out', detail: 'timeout' };
  } catch (err) {
    const detail = err.response?.data || err.message || String(err);
    console.error('AssemblyAI transcription failed:', detail);
    return { success: false, error: 'Failed to transcribe audio', detail };
  }
}

module.exports = { transcribeAudio };
