// src/services/pdf.js
// ─────────────────────────────────────────────
// Handles all PDF processing.
// Uses iLovePDF API for compression and conversion.
// iLovePDF is pay-per-use — you only pay when someone
// actually uses a tool. Free tier gives 250 tasks/month.
// Sign up at: https://developer.ilovepdf.com
// ─────────────────────────────────────────────

const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function isSofficeAvailable() {
  try {
    const prog = process.platform === 'win32' ? 'soffice.exe' : 'soffice';
    const res = spawnSync(prog, ['--version'], { timeout: 10000 });
    if (res.error) return false;
    return res.status === 0 || Boolean(res.stdout);
  } catch (e) {
    return false;
  }
}

// ─────────────────────────────────────────────
// iLovePDF API Helper
// ─────────────────────────────────────────────
// iLovePDF works in 3 steps for every task:
// Step 1: Start a task (get a server + task token)
// Step 2: Upload your file to that task
// Step 3: Process the task and download the result

/**
 * getAuthToken
 * ────────────
 * iLovePDF requires a JWT token for all API calls.
 * We get this by sending our public key to their auth endpoint.
 */
async function getAuthToken() {
  try {
    const response = await axios.post(
      'https://api.ilovepdf.com/v1/auth',
      { public_key: process.env.ILOVEPDF_PUBLIC_KEY },
      { timeout: 10000 }
    );
    return response.data.token;
  } catch (err) {
    console.error('getAuthToken failed:', err.response?.status, err.response?.data || err.message);
    throw err;
  }
}

/**
 * startTask
 * ─────────
 * Starts an iLovePDF task and returns the server + task ID.
 * @param {string} token     - JWT auth token
 * @param {string} taskType  - e.g. "compress" or "officepdf"
 */
async function startTask(token, taskType) {
  try {
    const url = `https://api.ilovepdf.com/v1/start/${taskType}`;
    const response = await axios.get(url, { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 });
    return {
      server: response.data.server,
      taskId: response.data.task,
    };
  } catch (err) {
    console.error(`startTask failed for type=${taskType}:`, err.response?.status, err.response?.data || err.message);
    throw err;
  }
}

/**
 * uploadFile
 * ──────────
 * Uploads a file buffer to iLovePDF.
 * @param {string} token       - JWT auth token
 * @param {string} server      - Server from startTask
 * @param {string} taskId      - Task ID from startTask
 * @param {Buffer} fileBuffer  - The PDF file as a buffer
 * @param {string} fileName    - Original filename
 */
async function uploadFile(token, server, taskId, fileBuffer, fileName) {
  const form = new FormData();
  form.append('task', taskId);
  form.append('file', fileBuffer, { filename: fileName, contentType: 'application/pdf' });

  const response = await axios.post(
    `https://${server}/v1/upload`,
    form,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        ...form.getHeaders(),
      },
      timeout: 60000,
    }
  );
  return response.data.server_filename;
}

/**
 * processAndDownload
 * ──────────────────
 * Tells iLovePDF to process the task, then downloads the result.
 * @param {string} token          - JWT auth token
 * @param {string} server         - Server from startTask
 * @param {string} taskId         - Task ID
 * @param {string} serverFilename - Uploaded file reference
 * @param {string} taskType       - e.g. "compress" or "officepdf"
 * @param {object} extraParams    - Any extra parameters for the task
 */
async function processAndDownload(token, server, taskId, serverFilename, taskType, extraParams = {}) {
  // Step 1: Tell iLovePDF what to process
  await axios.post(
    `https://${server}/v1/process`,
    {
      task: taskId,
      tool: taskType,
      files: [{ server_filename: serverFilename, filename: 'file.pdf' }],
      ...extraParams,
    },
    { headers: { Authorization: `Bearer ${token}` }, timeout: 60000 }
  );

  // Step 2: Download the processed result as a buffer
  const downloadResponse = await axios.get(
    `https://${server}/v1/download/${taskId}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      responseType: 'arraybuffer',
      timeout: 60000,
    }
  );

  const buf = Buffer.from(downloadResponse.data);
  // Basic validation for DOCX/ZIP outputs only.
  // iLovePDF returns different binary types depending on the task (PDF for compress,
  // DOCX for office conversions). Only enforce ZIP/DOCX check when we expect a DOCX.
  const expectsDocx = (extraParams && String(extraParams.output_format || '').toLowerCase() === 'docx')
    || (typeof taskType === 'string' && /office|pdf2office|pdfoffice/i.test(taskType));
  if (expectsDocx) {
    if (!isZipBuffer(buf)) {
      console.error('processAndDownload: downloaded result does not appear to be a ZIP/DOCX file. First bytes:', buf.slice(0,8));
      throw new Error('Downloaded result invalid or not a downloadable file (not a ZIP/DOCX).');
    }
  }

  return buf;
}

function isZipBuffer(buf) {
  if (!buf || buf.length < 4) return false;
  return buf[0] === 0x50 && buf[1] === 0x4B && buf[2] === 0x03 && buf[3] === 0x04;
}


// ─────────────────────────────────────────────
// PUBLIC FUNCTIONS
// ─────────────────────────────────────────────

/**
 * compressPdf
 * ───────────
 * Takes a PDF buffer and returns a compressed PDF buffer.
 * Reduces file size significantly while keeping it readable.
 *
 * @param {Buffer} fileBuffer  - The original PDF as a buffer
 * @param {string} fileName    - Original filename for reference
 * @returns {object}           - { success, buffer, originalSize, newSize }
 */
async function compressPdf(fileBuffer, fileName = 'file.pdf') {
  try {
    const originalSize = fileBuffer.length;

    // Get auth token from iLovePDF
    const token = await getAuthToken();

    // Start a compress task
    const { server, taskId } = await startTask(token, 'compress');

    // Upload the PDF
    const serverFilename = await uploadFile(token, server, taskId, fileBuffer, fileName);

    // Process and download compressed result
    const compressedBuffer = await processAndDownload(
      token, server, taskId, serverFilename, 'compress',
      { compression_level: 'recommended' } // Options: low, recommended, extreme
    );

    const newSize = compressedBuffer.length;

    console.log(`PDF compressed: ${originalSize} bytes → ${newSize} bytes`);

    return {
      success: true,
      buffer: compressedBuffer,
      originalSize,
      newSize,
      savedPercent: Math.round((1 - newSize / originalSize) * 100),
    };

  } catch (error) {
    console.error('PDF compression error:', error.response?.data || error.message);
    return { success: false, error: 'Failed to compress PDF.' };
  }
}

/**
 * pdfToWord
 * ─────────
 * Converts a PDF buffer to a .docx Word document buffer.
 *
 * @param {Buffer} fileBuffer  - The original PDF as a buffer
 * @param {string} fileName    - Original filename
 * @returns {object}           - { success, buffer } or { success: false, error }
 */
async function pdfToWord(fileBuffer, fileName = 'file.pdf') {
  try {
    const token = await getAuthToken();

    // Try several possible iLovePDF task types — APIs sometimes change names.
    // Prefer the most commonly available tasks first to avoid 404s.
    const candidateTasks = ['officepdf', 'office', 'pdf2office', 'pdfoffice'];
    let lastErr = null;
    for (const taskType of candidateTasks) {
      try {
        const { server, taskId } = await startTask(token, taskType);
        const serverFilename = await uploadFile(token, server, taskId, fileBuffer, fileName);
        const wordBuffer = await processAndDownload(
          token, server, taskId, serverFilename, taskType,
          { output_format: 'docx' }
        );

        // Verify the returned buffer looks like a DOCX (ZIP)
        if (!isZipBuffer(wordBuffer)) {
          console.warn(`pdfToWord: taskType=${taskType} returned non-ZIP result; will try next candidate.`);
          lastErr = new Error('Downloaded result not a ZIP/DOCX');
          continue;
        }

        return {
          success: true,
          buffer: wordBuffer,
        };
      } catch (err) {
        lastErr = err;
        // If it's a 404 / NotFound for this task type, try the next candidate
        const status = err?.response?.status;
        const data = err?.response?.data;
        const url = err?.config?.url || '(unknown url)';
        console.warn(`pdfToWord: taskType=${taskType} failed:`, status || err.message, url, data || '');
        if (status && status === 404) {
          continue; // try next taskType
        }
        // For other errors, break and surface the error
        break;
      }
    }

    // If iLovePDF attempts failed, try a local LibreOffice (soffice) fallback if available
    console.warn('iLovePDF PDF→Word attempts failed.');
    if (isSofficeAvailable()) {
      console.warn('Local LibreOffice detected — attempting fallback conversion...');
      try {
        const local = await tryLocalLibreOfficeConversion(fileBuffer, fileName);
        if (local && local.success) {
          return { success: true, buffer: local.buffer };
        }
      } catch (le) {
        console.error('Local LibreOffice conversion attempt failed:', le?.message || le);
      }
      console.error('PDF to Word failed for all iLovePDF task types and local conversion failed:', lastErr?.response?.data || lastErr?.message || lastErr);
      return { success: false, error: 'Failed to convert PDF to Word. Remote service returned an error and local conversion failed.' };
    } else {
      console.error('PDF to Word failed and LibreOffice is not installed on this host. iLovePDF error:', lastErr?.response?.data || lastErr?.message || lastErr);
      return { success: false, error: 'Failed to convert PDF to Word. iLovePDF failed and LibreOffice is not installed on the server.' };
    }

  } catch (error) {
    console.error('PDF to Word error:', error.response?.data || error.message);
    return { success: false, error: 'Failed to convert PDF to Word.' };
  }
}

/**
 * docxToPdf
 * Converts a .docx Word buffer to a PDF buffer using local LibreOffice.
 */
async function docxToPdf(fileBuffer, fileName = 'document.docx') {
  try {
    if (!isSofficeAvailable()) {
      return { success: false, error: 'LibreOffice is not installed on the server to handle Word conversions.' };
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'word2pdf-'));
    const inputPath = path.join(tmpDir, fileName.replace(/[^a-z0-9\.\-_]/gi, '_'));
    fs.writeFileSync(inputPath, fileBuffer);

    // Redirect user profile to tmpDir to avoid permission errors on restricted hosts
    const userProfile = `file://${tmpDir}/profile`;
    const prog = process.platform === 'win32' ? 'soffice.exe' : 'soffice';
    const res = spawnSync(prog, [
      `-env:UserInstallation=${userProfile}`,
      '--headless',
      '--convert-to',
      'pdf',
      '--outdir',
      tmpDir,
      inputPath
    ], { 
      timeout: 120000, 
      maxBuffer: 50 * 1024 * 1024, // Protect against "Output Bombs" (max 50MB stdout)
      killSignal: 'SIGKILL' 
    });

    if (res.status !== 0) {
      cleanupTmp(tmpDir);
      return { success: false, error: 'Conversion process failed.' };
    }

    const baseName = path.basename(inputPath).replace(/\.docx$/i, '');
    const outPath = path.join(tmpDir, `${baseName}.pdf`);
    
    if (!fs.existsSync(outPath)) {
      const files = fs.readdirSync(tmpDir).filter(f => f.toLowerCase().endsWith('.pdf'));
      if (files.length === 0) {
        cleanupTmp(tmpDir);
        return { success: false, error: 'Resulting PDF not found.' };
      }
      const buf = fs.readFileSync(path.join(tmpDir, files[0]));
      cleanupTmp(tmpDir);
      return { success: true, buffer: buf };
    }

    const buf = fs.readFileSync(outPath);
    cleanupTmp(tmpDir);
    return { success: true, buffer: buf };
  } catch (error) {
    console.error('Word to PDF error:', error.message);
    return { success: false, error: 'Failed to convert Word to PDF.' };
  }
}

module.exports = {
  compressPdf,
  pdfToWord,
  docxToPdf
};

/**
 * tryLocalLibreOfficeConversion
 * Attempts to convert PDF -> DOCX using the local LibreOffice `soffice` CLI.
 * Returns { success: true, buffer } on success, otherwise { success: false }.
 */
async function tryLocalLibreOfficeConversion(fileBuffer, fileName) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf2word-'));
  const inputPath = path.join(tmpDir, fileName.replace(/[^a-z0-9\.\-_]/gi, '_'));
  fs.writeFileSync(inputPath, fileBuffer);

  // Spawn soffice to convert to docx in the same tmp dir
  // Example: soffice --headless --convert-to docx --outdir <tmpDir> <inputPath>
  try {
    const prog = process.platform === 'win32' ? 'soffice.exe' : 'soffice';
    const userProfile = `file://${tmpDir}/profile`;
    const res = spawnSync(prog, [
      `-env:UserInstallation=${userProfile}`,
      '--headless',
      '--convert-to',
      'docx',
      '--outdir',
      tmpDir,
      inputPath
    ], { 
      timeout: 120000, 
      maxBuffer: 50 * 1024 * 1024, 
      killSignal: 'SIGKILL' 
    });
    if (res.error) {
      console.warn('LibreOffice convert spawn error:', res.error && res.error.message);
      cleanupTmp(tmpDir);
      return { success: false };
    }
    if (res.status !== 0) {
      console.warn('LibreOffice convert failed, status:', res.status, 'stderr:', res.stderr && res.stderr.toString());
      cleanupTmp(tmpDir);
      return { success: false };
    }

    // Find the produced .docx file
    const baseName = path.basename(inputPath).replace(/\.pdf$/i, '');
    const outPath = path.join(tmpDir, `${baseName}.docx`);
    if (!fs.existsSync(outPath)) {
      // Try to pick any .docx in tmpDir
      const files = fs.readdirSync(tmpDir).filter(f => f.toLowerCase().endsWith('.docx'));
      if (files.length === 0) {
        cleanupTmp(tmpDir);
        return { success: false };
      }
      const pick = files[0];
      const full = path.join(tmpDir, pick);
      const buf = fs.readFileSync(full);
      if (!isZipBuffer(buf)) {
        console.warn('tryLocalLibreOfficeConversion: produced file is not a ZIP/DOCX');
        cleanupTmp(tmpDir);
        return { success: false };
      }
      cleanupTmp(tmpDir);
      return { success: true, buffer: buf };
    }

    const buf = fs.readFileSync(outPath);
    if (!isZipBuffer(buf)) {
      console.warn('tryLocalLibreOfficeConversion: produced file is not a ZIP/DOCX');
      cleanupTmp(tmpDir);
      return { success: false };
    }
    cleanupTmp(tmpDir);
    return { success: true, buffer: buf };
  } catch (err) {
    console.error('tryLocalLibreOfficeConversion error:', err && err.message);
    cleanupTmp(tmpDir);
    return { success: false };
  }
}

function cleanupTmp(dir) {
  try {
    const files = fs.readdirSync(dir || '');
    for (const f of files) {
      try { fs.unlinkSync(path.join(dir, f)); } catch (e) {}
    }
    try { fs.rmdirSync(dir); } catch (e) {}
  } catch (e) {}
}
