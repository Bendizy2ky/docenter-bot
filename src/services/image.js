// src/services/image.js
// ─────────────────────────────────────────────
// Handles all image processing:
// - Compress image (Sharp — free, runs locally)
// - Remove background (Remove.bg API — pay per use)
// - Passport photo maker (Sharp — free, runs locally)
// ─────────────────────────────────────────────

const axios = require('axios');
const sharp = require('sharp');
const FormData = require('form-data');

// ─────────────────────────────────────────────
// Passport Photo Size Definitions
// ─────────────────────────────────────────────
// All sizes are in pixels at 300dpi for print quality
const PASSPORT_SIZES = {
  nigerian_passport: { width: 413,  height: 531,  label: 'Nigerian Passport (35×45mm)' },
  us_visa:           { width: 600,  height: 600,  label: 'US/UK Visa (51×51mm)' },
  jamb:              { width: 150,  height: 180,  label: 'JAMB' },
  nin:               { width: 200,  height: 200,  label: 'NIN Enrollment' },
  drivers_licence:   { width: 413,  height: 531,  label: "Driver's Licence" },
};


// ─────────────────────────────────────────────
// PUBLIC FUNCTIONS
// ─────────────────────────────────────────────

/**
 * compressImage
 * ─────────────
 * Compresses an image buffer using Sharp (free, local, no API needed).
 * Works on JPG, PNG, and WEBP.
 *
 * @param {Buffer} fileBuffer  - Original image as buffer
 * @param {string} mimeType    - e.g. "image/jpeg", "image/png"
 * @returns {object}           - { success, buffer, originalSize, newSize }
 */
async function compressImage(fileBuffer, mimeType = 'image/jpeg') {
  try {
    const originalSize = fileBuffer.length;

    let compressedBuffer;

    if (mimeType.includes('png')) {
      // PNG compression
      compressedBuffer = await sharp(fileBuffer)
        .png({ quality: 70, compressionLevel: 8 })
        .toBuffer();
    } else if (mimeType.includes('webp')) {
      // WEBP compression
      compressedBuffer = await sharp(fileBuffer)
        .webp({ quality: 70 })
        .toBuffer();
    } else {
      // Default: JPEG compression
      compressedBuffer = await sharp(fileBuffer)
        .jpeg({ quality: 70, mozjpeg: true })
        .toBuffer();
    }

    const newSize = compressedBuffer.length;
    console.log(`Image compressed: ${originalSize} bytes → ${newSize} bytes`);

    return {
      success: true,
      buffer: compressedBuffer,
      originalSize,
      newSize,
      savedPercent: Math.round((1 - newSize / originalSize) * 100),
      outputMimeType: mimeType,
    };

  } catch (error) {
    console.error('Image compression error:', error.message);
    return { success: false, error: 'Failed to compress image.' };
  }
}

/**
 * removeBackground
 * ────────────────
 * Removes the background from an image using Remove.bg API.
 * Returns a PNG with a transparent background.
 * Cost: ~$0.02–$0.14 per image (only charged when used).
 * Get your API key at: https://www.remove.bg/api
 *
 * @param {Buffer} fileBuffer  - Original image as buffer
 * @returns {object}           - { success, buffer } or { success: false, error }
 */
async function removeBackground(fileBuffer) {
  try {
    // Build a multipart form request for Remove.bg
    const form = new FormData();
    form.append('image_file', fileBuffer, {
      filename: 'image.jpg',
      contentType: 'image/jpeg',
    });
    form.append('size', 'auto'); // Let Remove.bg decide best output size

    const response = await axios.post(
      'https://api.remove.bg/v1.0/removebg',
      form,
      {
        headers: {
          'X-Api-Key': process.env.REMOVEBG_API_KEY,
          ...form.getHeaders(),
        },
        responseType: 'arraybuffer', // Get raw binary PNG data back
      }
    );

    return {
      success: true,
      buffer: Buffer.from(response.data),
      outputMimeType: 'image/png',
    };

  } catch (error) {
    console.error('Remove background error:', error.response?.data?.toString() || error.message);
    return { success: false, error: 'Failed to remove background.' };
  }
}

/**
 * makePassportPhoto
 * ─────────────────
 * Takes a photo and formats it as a print-ready passport photo.
 * Creates a single image at the correct dimensions with white background.
 * Uses Sharp — completely free, no API needed.
 *
 * @param {Buffer} fileBuffer  - Original photo as buffer
 * @param {string} docType     - One of the keys in PASSPORT_SIZES above
 * @returns {object}           - { success, buffer, label } or { success: false, error }
 */
async function makePassportPhoto(fileBuffer, docType = 'nigerian_passport') {
  try {
    const size = PASSPORT_SIZES[docType];

    if (!size) {
      return { success: false, error: 'Unknown document type.' };
    }

    // Step 1: Get image metadata to understand dimensions
    const metadata = await sharp(fileBuffer).metadata();

    // Step 2: Calculate a centre crop to a square first
    // This prevents stretching when we resize to passport dimensions
    const squareSize = Math.min(metadata.width, metadata.height);
    const leftOffset = Math.floor((metadata.width - squareSize) / 2);
    const topOffset = Math.floor((metadata.height - squareSize) / 2);

    // Step 3: Crop to square, resize to passport dimensions, add white background
    const passportBuffer = await sharp(fileBuffer)
      .extract({
        left: leftOffset,
        top: topOffset,
        width: squareSize,
        height: squareSize,
      })
      .resize(size.width, size.height, {
        fit: 'cover',       // Fill the entire space
        position: 'top',    // Bias toward keeping the top (face area)
      })
      .flatten({ background: { r: 255, g: 255, b: 255 } }) // White background
      .jpeg({ quality: 95 }) // High quality for printing
      .toBuffer();

    return {
      success: true,
      buffer: passportBuffer,
      label: size.label,
      outputMimeType: 'image/jpeg',
    };

  } catch (error) {
    console.error('Passport photo error:', error.message);
    return { success: false, error: 'Failed to create passport photo.' };
  }
}

/**
 * convertImage
 * Converts an image buffer to the requested target format using Sharp.
 * Supported target formats: 'png', 'jpg' (jpeg), 'webp'.
 * Converting to SVG from raster is not supported.
 * @param {Buffer} fileBuffer
 * @param {string} targetFormat - one of 'png','jpg','webp'
 * @returns {object} { success, buffer, outputMimeType } or { success:false, error }
 */
async function convertImage(fileBuffer, targetFormat) {
  try {
    targetFormat = (targetFormat || '').toLowerCase();
    if (!['png', 'jpg', 'jpeg', 'webp'].includes(targetFormat)) {
      return { success: false, error: 'Unsupported target format. Use png, jpg, or webp.' };
    }

    const fmt = targetFormat === 'jpg' ? 'jpeg' : targetFormat;

    let transformer = sharp(fileBuffer);

    // For JPEG output, ensure background is white for inputs with transparency
    if (fmt === 'jpeg') {
      transformer = transformer.flatten({ background: { r: 255, g: 255, b: 255 } });
    }

    let outBuffer;
    if (fmt === 'png') {
      outBuffer = await transformer.png({ quality: 90 }).toBuffer();
    } else if (fmt === 'jpeg') {
      outBuffer = await transformer.jpeg({ quality: 90, mozjpeg: true }).toBuffer();
    } else if (fmt === 'webp') {
      outBuffer = await transformer.webp({ quality: 90 }).toBuffer();
    }

    const mime = fmt === 'png' ? 'image/png' : fmt === 'webp' ? 'image/webp' : 'image/jpeg';
    return { success: true, buffer: outBuffer, outputMimeType: mime };

  } catch (error) {
    console.error('Image conversion error:', error.message);
    return { success: false, error: 'Failed to convert image.' };
  }
}

module.exports = {
  compressImage,
  removeBackground,
  makePassportPhoto,
  convertImage,
  PASSPORT_SIZES,
};

