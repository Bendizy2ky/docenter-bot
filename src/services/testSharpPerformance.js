const sharp = require('sharp');
const { applyBackground } = require('../services/image');

/**
 * Performance Stress Test for Sharp on Railway
 * Generates a high-resolution 4K transparent PNG and processes it.
 * 
 * Execute on server with: node src/utils/testSharpPerformance.js
 */
async function verifyRailwayPerformance() {
  console.log('🚀 Starting DocCenter Sharp Performance Test (4K Stress Test)...');
  
  // Define 4K resolution (3840 x 2160)
  const width = 3840;
  const height = 2160;
  
  console.log(`📸 Generating ${width}x${height} transparent source...`);
  
  try {
    const testBuffer = await sharp({
      create: {
        width,
        height,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      }
    }).png().toBuffer();

    console.log('⚙️ Running applyBackground service...');
    const result = await applyBackground(testBuffer, 'blue');
    
    if (result.success) console.log('✅ Success: Image processed within environment limits.');
    else console.error('❌ Service Error:', result.error);
  } catch (err) {
    console.error('💥 CRITICAL: Performance test failed. Instance may have insufficient memory.', err.message);
  }
}

verifyRailwayPerformance().catch(console.error);