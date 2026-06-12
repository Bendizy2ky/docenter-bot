// src/services/convert.js
// Cloudmersive primary + iLovePDF fallback conversion helpers
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');

const pdfService = require('./pdf'); // existing iLovePDF helpers (exports pdfToWord)

const CLOUDMERSIVE_API_KEY = process.env.CLOUDMERSIVE_API_KEY;

async function callCloudmersive(endpointPath, inputPath) {
  const url = `https://api.cloudmersive.com${endpointPath}`;
  const form = new FormData();
  form.append('file', fs.createReadStream(inputPath));

  const headers = {
    ...form.getHeaders(),
    Apikey: CLOUDMERSIVE_API_KEY,
  };

  const resp = await axios.post(url, form, {
    headers,
    responseType: 'arraybuffer',
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    validateStatus: () => true,
    timeout: 120000,
  });

  if (resp.status >= 200 && resp.status < 300) {
    return Buffer.from(resp.data);
  }
  const err = new Error(`Cloudmersive error ${resp.status}`);
  err.status = resp.status;
  err.responseData = resp.data;
  throw err;
}

async function cloudmersiveDocxToPdf(inputPath) {
  return callCloudmersive('/convert/docx/to/pdf', inputPath);
}

async function cloudmersivePdfToDocx(inputPath) {
  return callCloudmersive('/convert/pdf/to/docx', inputPath);
}

// --- Minimal iLovePDF helpers (JWT + start/upload/process) - kept local so we don't modify src/services/pdf.js
async function getIlovepdfAuthToken() {
  const resp = await axios.post('https://api.ilovepdf.com/v1/auth', { public_key: process.env.ILOVEPDF_PUBLIC_KEY }, { timeout: 10000 });
  return resp.data.token;
}

async function startIlovepdfTask(token, taskType) {
  const url = `https://api.ilovepdf.com/v1/start/${taskType}`;
  const resp = await axios.get(url, { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 });
  return { server: resp.data.server, taskId: resp.data.task };
}

async function uploadIlovepdfFile(token, server, taskId, fileBuffer, fileName) {
  const form = new FormData();
  form.append('task', taskId);
  // let API infer content type from filename
  form.append('file', fileBuffer, { filename: fileName });

  const resp = await axios.post(`https://${server}/v1/upload`, form, {
    headers: { Authorization: `Bearer ${token}`, ...form.getHeaders() },
    timeout: 60000,
  });
  return resp.data.server_filename;
}

async function processAndDownloadIlovepdf(token, server, taskId, serverFilename, taskType, extraParams = {}) {
  await axios.post(`https://${server}/v1/process`, {
    task: taskId,
    tool: taskType,
    files: [{ server_filename: serverFilename, filename: path.basename(serverFilename) }],
    ...extraParams,
  }, { headers: { Authorization: `Bearer ${token}` }, timeout: 60000 });

  const downloadResp = await axios.get(`https://${server}/v1/download/${taskId}`, {
    headers: { Authorization: `Bearer ${token}` },
    responseType: 'arraybuffer',
    timeout: 60000,
  });
  return Buffer.from(downloadResp.data);
}

function isPdfBuffer(buf) {
  if (!buf || buf.length < 4) return false;
  return buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46; // %PDF
}

async function ilovepdfDocxToPdf(inputPath, outputPath) {
  const fileBuffer = fs.readFileSync(inputPath);
  const fileName = path.basename(inputPath);
  const token = await getIlovepdfAuthToken();
  const { server, taskId } = await startIlovepdfTask(token, 'officepdf');
  const serverFilename = await uploadIlovepdfFile(token, server, taskId, fileBuffer, fileName);
  const resultBuffer = await processAndDownloadIlovepdf(token, server, taskId, serverFilename, 'officepdf', { output_format: 'pdf' });
  if (!isPdfBuffer(resultBuffer)) throw new Error('iLovePDF did not return a PDF buffer');
  fs.writeFileSync(outputPath, resultBuffer);
  return outputPath;
}

/**
 * Public: docxToPdf
 * Try Cloudmersive first; on any error, fallback to iLovePDF.
 */
async function docxToPdf(inputPath, outputPath) {
  try {
    const buf = await cloudmersiveDocxToPdf(inputPath);
    fs.writeFileSync(outputPath, buf);
    return { provider: 'cloudmersive', outputPath };
  } catch (err) {
    try {
      await ilovepdfDocxToPdf(inputPath, outputPath);
      return { provider: 'ilovepdf', outputPath };
    } catch (err2) {
      const e = new Error('Both Cloudmersive and iLovePDF conversions failed (docx->pdf)');
      e.cloudmersive = err;
      e.ilovepdf = err2;
      throw e;
    }
  }
}

/**
 * Public: pdfToDocx
 * Try Cloudmersive first; on any error, fallback to existing iLovePDF `pdfToWord` helper
 */
async function pdfToDocx(inputPath, outputPath) {
  try {
    const buf = await cloudmersivePdfToDocx(inputPath);
    fs.writeFileSync(outputPath, buf);
    return { provider: 'cloudmersive', outputPath };
  } catch (err) {
    // Fallback: reuse existing iLovePDF logic in src/services/pdf.js which already implements
    // pdf->word with multiple task candidates and a LibreOffice fallback.
    try {
      const inputBuffer = fs.readFileSync(inputPath);
      const res = await pdfService.pdfToWord(inputBuffer, path.basename(inputPath));
      if (!res || !res.success) {
        throw new Error(res?.error || 'iLovePDF pdfToWord returned failure');
      }
      fs.writeFileSync(outputPath, res.buffer);
      return { provider: 'ilovepdf', outputPath };
    } catch (err2) {
      const e = new Error('Both Cloudmersive and iLovePDF conversions failed (pdf->docx)');
      e.cloudmersive = err;
      e.ilovepdf = err2;
      throw e;
    }
  }
}

module.exports = {
  docxToPdf,
  pdfToDocx,
};
