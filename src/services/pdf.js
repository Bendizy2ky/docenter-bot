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

let cachedSofficePath = null;
/**
 * getSofficePath
 * Locates the LibreOffice/soffice binary on the host system.
 */
function getSofficePath() {
  if (cachedSofficePath) return cachedSofficePath;
  try {
    const candidates = process.platform === 'win32' 
      ? ['soffice.exe'] 
      : ['soffice', 'libreoffice', '/usr/bin/soffice', '/usr/bin/libreoffice'];
    
    for (const prog of candidates) {
      const res = spawnSync(prog, ['--version'], { timeout: 5000 });
      if (!res.error && (res.status === 0 || res.stdout)) {
        cachedSofficePath = prog;
        return prog;
      }
    }
  } catch (e) {
    console.error('getSofficePath error:', e.message);
  }
  return null;
}

function isSofficeAvailable() {
  return !!getSofficePath();
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
  // Root Cause Fix: Ensure taskType is a plain string, never an array.
  // Iteration oversights can sometimes pass an array element as an object/array.
  const tool = Array.isArray(taskType) ? taskType[0] : taskType;
  try {
    const url = `https://api.ilovepdf.com/v1/start/${tool}`;
    const response = await axios.get(url, { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 });
    return {
      server: response.data.server,
      taskId: response.data.task,
    };
  } catch (err) {
    console.error(`startTask failed for type=${tool}:`, err.response?.status, err.response?.data || err.message);
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

  // Detect content type from filename to support Word-to-PDF correctly
  const isPdf = fileName.toLowerCase().endsWith('.pdf');
  const contentType = isPdf ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  form.append('file', fileBuffer, { filename: fileName, contentType });

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
  // Standardize the internal filename iLovePDF uses for processing
  const isDocxInput = taskType === 'officepdf';
  const internalFilename = isDocxInput ? 'file.docx' : 'file.pdf';

  // Step 1: Tell iLovePDF what to process
  await axios.post(
    `https://${server}/v1/process`,
    {
      task: taskId,
      tool: taskType,
      files: [{ server_filename: serverFilename, filename: internalFilename }],
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
    || (typeof taskType === 'string' && /^(pdfword|pdf2word|office|pdfoffice)$/i.test(taskType));
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
 * Converts a PDF buffer to a .docx Word document buffer using Cloudmersive.
 *
 * @param {Buffer} fileBuffer  - The original PDF as a buffer
 * @param {string} fileName    - Original filename
 * @returns {object}           - { success, buffer } or { success: false, error }
 */
async function pdfToWord(fileBuffer, fileName = 'file.pdf') {
  if (!process.env.CLOUDMERSIVE_API_KEY) {
    console.error('[PDF→Word] CLOUDMERSIVE_API_KEY not set');
    return {
      success: false,
      error: 'PDF to Word conversion is not configured. Please contact support.'
    };
  }

  try {
    console.log('[PDF→Word] Starting conversion via Cloudmersive...');
    
    const FormData = require('form-data');
    const axios = require('axios');
    
    const form = new FormData();
    form.append('inputFile', fileBuffer, {
      filename: fileName || 'document.pdf',
      contentType: 'application/pdf',
      knownLength: fileBuffer.length
    });
    
    const response = await axios.post(
      'https://api.cloudmersive.com/convert/pdf/to/docx',
      form,
      {
        headers: {
          'Apikey': process.env.CLOUDMERSIVE_API_KEY,
          ...form.getHeaders()
        },
        responseType: 'arraybuffer',
        timeout: 120000
      }
    );
    
    // Verify response is a valid DOCX file
    // DOCX files start with PK (zip format: 0x50 0x4B)
    const resultBuffer = Buffer.from(response.data);
    if (resultBuffer.length < 4) {
      throw new Error('Cloudmersive returned empty response');
    }
    
    const isValidDocx = resultBuffer[0] === 0x50 && 
                        resultBuffer[1] === 0x4B;
    if (!isValidDocx) {
      const preview = resultBuffer.toString('utf8').slice(0, 200);
      console.error('[PDF→Word] Invalid DOCX response:', preview);
      throw new Error('Cloudmersive did not return a valid DOCX file');
    }
    
    console.log(`[PDF→Word] Success. Output size: ${resultBuffer.length} bytes`);
    
    return {
      success: true,
      buffer: resultBuffer,
      outputFileName: fileName 
        ? fileName.replace(/\.pdf$/i, '.docx') 
        : 'converted.docx'
    };
    
  } catch (error) {
    const status = error.response?.status || 0;
    console.error(`[PDF→Word] Cloudmersive error (${status}):`, 
      error.message);
    
    if (status === 401) {
      return {
        success: false,
        error: 'PDF to Word conversion service authentication failed. Contact support.'
      };
    }
    
    if (status === 429) {
      return {
        success: false,
        error: 'PDF to Word conversion limit reached for today. Please try again tomorrow.'
      };
    }
    
    return {
      success: false,
      error: 'Failed to convert PDF to Word. Please ensure your PDF contains readable text and try again.'
    };
  }
}

/**
 * docxToPdf
 * Converts a .docx Word buffer to a PDF buffer.
 * Tries iLovePDF Cloud API first, then falls back to local LibreOffice.
 */
async function docxToPdf(fileBuffer, fileName = 'document.docx') {
  try {
    // 1. Try iLovePDF Cloud API first (Standard for Railway/Serverless)
    try {
      const token = await getAuthToken();
      const { server, taskId } = await startTask(token, 'officepdf');
      const serverFilename = await uploadFile(token, server, taskId, fileBuffer, fileName);
      const pdfBuffer = await processAndDownload(token, server, taskId, serverFilename, 'officepdf');
      
      if (pdfBuffer && pdfBuffer.length > 0) return { success: true, buffer: pdfBuffer };
    } catch (apiErr) {
      console.warn('docxToPdf: Cloud conversion failed, trying local fallback...', apiErr.message);
    }

    // 2. Fallback to local LibreOffice (if installed)
    const soffice = getSofficePath();
    if (!soffice) {
      return { success: false, error: 'Cloud conversion failed and LibreOffice is not installed on this server.' };
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'word2pdf-'));
    const inputPath = path.join(tmpDir, fileName.replace(/[^a-z0-9\.\-_]/gi, '_'));
    fs.writeFileSync(inputPath, fileBuffer);
    
    // Ensure input file has .docx extension for soffice
    const finalInputPath = inputPath.toLowerCase().endsWith('.docx') ? inputPath : `${inputPath}.docx`;
    if (finalInputPath !== inputPath) fs.renameSync(inputPath, finalInputPath);

    const userProfile = `file://${tmpDir}/profile`;
    
    const res = spawnSync(soffice, [
      `-env:UserInstallation=${userProfile}`,
      '--headless',
      '--convert-to',
      'pdf',
      '--outdir',
      tmpDir,
      finalInputPath
    ], { 
      timeout: 120000, 
      maxBuffer: 50 * 1024 * 1024, // Protect against "Output Bombs" (max 50MB stdout)
      killSignal: 'SIGKILL' 
    });

    if (res.status !== 0) {
      cleanupTmp(tmpDir);
      return { success: false, error: 'Conversion process failed.' };
    }

    const baseName = path.basename(finalInputPath).replace(/\.docx$/i, '');
    let outPath = path.join(tmpDir, `${baseName}.pdf`);
    
    if (!fs.existsSync(outPath)) {
      // More robust check: find any PDF if exact match fails
      const files = fs.readdirSync(tmpDir).filter(f => f.toLowerCase().endsWith('.pdf'));
      if (files.length === 0) {
        cleanupTmp(tmpDir);
        return { success: false, error: 'Resulting PDF not found.' };
      }
      outPath = path.join(tmpDir, files.find(f => f.includes(baseName)) || files[0]);
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
  docxToPdf,
  getSofficePath,
  isSofficeAvailable
};

/**
 * tryLocalLibreOfficeConversion
 * Attempts to convert PDF -> DOCX using the local LibreOffice `soffice` CLI.
 * Returns { success: true, buffer } on success, otherwise { success: false }.
 */
async function tryLocalLibreOfficeConversion(fileBuffer, fileName) {
  const soffice = getSofficePath();
  if (!soffice) {
    return { success: false };
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf2word-'));
  const inputPath = path.join(tmpDir, fileName.replace(/[^a-z0-9\.\-_]/gi, '_'));
  fs.writeFileSync(inputPath, fileBuffer);

  // Spawn soffice to convert to docx in the same tmp dir
  // Example: soffice --headless --convert-to docx --outdir <tmpDir> <inputPath>
  try {
    const userProfile = `file://${tmpDir}/profile`;
    const res = spawnSync(soffice, [
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
