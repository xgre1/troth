// SPDX-License-Identifier: AGPL-3.0-only
// Vision validator — detect oversized images before forwarding to Anthropic.
//
// Opus 4.7 specifies a per-image limit of 2,576 pixels on the longest edge
// (≈ 3.75 megapixels). Sending a larger image triggers server-side
// downsampling which degrades visual fidelity. We detect the dimensions
// from the base64-encoded image header and surface a warning in stats.
//
// Auto-downscale would require an image-processing dependency (sharp/pngjs).
// We keep this module dependency-free: it validates and reports, leaving
// the actual rescaling to callers who can opt into the heavier lib.
//
var MAX_LONG_EDGE_PX = 2576;

var state = {
  scanned: 0,
  oversized: 0,
  lastOversize: null
};

// Decode just enough of a base64 PNG to read IHDR (bytes 16-23 → width, height big-endian).
function parsePngSize(buf) {
  if (buf.length < 24) return null;
  // PNG signature = 89 50 4E 47 0D 0A 1A 0A (8 bytes), then IHDR chunk
  if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4E || buf[3] !== 0x47) return null;
  var width  = (buf[16] << 24) | (buf[17] << 16) | (buf[18] << 8) | buf[19];
  var height = (buf[20] << 24) | (buf[21] << 16) | (buf[22] << 8) | buf[23];
  return { width: width >>> 0, height: height >>> 0 };
}

// Scan a JPEG for the SOF (Start-Of-Frame) marker. SOF0=0xFFC0, SOF1=0xC1..SOF15
// (skipping the SOF4/SOF8/SOF12 reserved ones). Width/height follow 5 bytes later.
function parseJpegSize(buf) {
  if (buf.length < 4) return null;
  if (buf[0] !== 0xFF || buf[1] !== 0xD8) return null; // SOI
  var i = 2;
  while (i < buf.length - 8) {
    if (buf[i] !== 0xFF) { i++; continue; }
    var marker = buf[i + 1];
    // SOF markers: 0xC0..0xCF except 0xC4/0xC8/0xCC (DHT, JPG, DAC — not SOF)
    if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
      // Bytes after marker: length(2) precision(1) height(2) width(2)
      var height = (buf[i + 5] << 8) | buf[i + 6];
      var width  = (buf[i + 7] << 8) | buf[i + 8];
      return { width: width, height: height };
    }
    // Skip this segment: marker(2) + length(2 big-endian, includes itself)
    var segLen = (buf[i + 2] << 8) | buf[i + 3];
    if (segLen < 2) return null; // corrupt
    i += 2 + segLen;
  }
  return null;
}

// WebP VP8/VP8L/VP8X: dimensions encoded differently. Simplified handler.
function parseWebpSize(buf) {
  if (buf.length < 30) return null;
  if (buf[0] !== 0x52 || buf[1] !== 0x49 || buf[2] !== 0x46 || buf[3] !== 0x46) return null; // "RIFF"
  if (buf[8] !== 0x57 || buf[9] !== 0x45 || buf[10] !== 0x42 || buf[11] !== 0x50) return null; // "WEBP"
  var sig = String.fromCharCode(buf[12], buf[13], buf[14], buf[15]);
  if (sig === 'VP8 ') {
    // VP8 lossy: width/height at bytes 26-29 (14 bits each)
    var w = ((buf[27] << 8) | buf[26]) & 0x3FFF;
    var h = ((buf[29] << 8) | buf[28]) & 0x3FFF;
    return { width: w, height: h };
  }
  if (sig === 'VP8L') {
    // VP8 lossless: width/height at bytes 21-24 (14 bits each, +1)
    var b0 = buf[21], b1 = buf[22], b2 = buf[23], b3 = buf[24];
    var wl = ((b1 & 0x3F) << 8 | b0) + 1;
    var hl = (((b3 & 0x0F) << 10) | (b2 << 2) | ((b1 >> 6) & 0x03)) + 1;
    return { width: wl, height: hl };
  }
  if (sig === 'VP8X') {
    // Extended: canvas size at bytes 24-29 (24-bit LE, +1)
    var wx = ((buf[26] << 16) | (buf[25] << 8) | buf[24]) + 1;
    var hx = ((buf[29] << 16) | (buf[28] << 8) | buf[27]) + 1;
    return { width: wx, height: hx };
  }
  return null;
}

// Attempt to parse image dimensions from base64 data + media type.
// Returns { width, height } or null on failure.
function parseDimensions(base64Data, mediaType) {
  if (!base64Data) return null;
  try {
    // Decode just the first 2KB — enough for any header parse above.
    var prefix = base64Data.slice(0, 3000);
    var buf = Buffer.from(prefix, 'base64');
    if (mediaType === 'image/png') return parsePngSize(buf);
    if (mediaType === 'image/jpeg' || mediaType === 'image/jpg') return parseJpegSize(buf);
    if (mediaType === 'image/webp') return parseWebpSize(buf);
    // GIF: bytes 6-9 (little-endian) — width, height
    if (mediaType === 'image/gif' && buf.length >= 10) {
      if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
        return { width: (buf[7] << 8) | buf[6], height: (buf[9] << 8) | buf[8] };
      }
    }
  } catch (e) { /* fall through */ }
  return null;
}

// Validate a single image block. Returns { valid, width, height, longEdge, reason }.
function validateImage(base64Data, mediaType) {
  state.scanned++;
  var dims = parseDimensions(base64Data, mediaType);
  if (!dims || !dims.width || !dims.height) {
    return { valid: true, width: null, height: null, longEdge: null, reason: 'unparseable' };
  }
  var longEdge = Math.max(dims.width, dims.height);
  var valid = longEdge <= MAX_LONG_EDGE_PX;
  if (!valid) {
    state.oversized++;
    state.lastOversize = { width: dims.width, height: dims.height, longEdge: longEdge, at: Date.now() };
  }
  return { valid: valid, width: dims.width, height: dims.height, longEdge: longEdge, reason: valid ? 'ok' : 'oversize' };
}

// Scan a request body for image blocks. Returns array of { location, result }.
function scanBody(bodyStr) {
  var findings = [];
  try {
    var data = JSON.parse(bodyStr);
    if (!Array.isArray(data.messages)) return findings;
    for (var mi = 0; mi < data.messages.length; mi++) {
      var msg = data.messages[mi];
      if (!Array.isArray(msg.content)) continue;
      for (var bi = 0; bi < msg.content.length; bi++) {
        var block = msg.content[bi];
        if (!block || block.type !== 'image') continue;
        if (!block.source || block.source.type !== 'base64') continue;
        var result = validateImage(block.source.data, block.source.media_type);
        findings.push({ msgIndex: mi, blockIndex: bi, result: result });
      }
    }
  } catch (e) {}
  return findings;
}

function getStats() {
  return {
    module: 'visionvalidator',
    maxLongEdge: MAX_LONG_EDGE_PX,
    scanned: state.scanned,
    oversized: state.oversized,
    lastOversize: state.lastOversize
  };
}

module.exports = {
  validateImage: validateImage,
  parseDimensions: parseDimensions,
  scanBody: scanBody,
  getStats: getStats,
  MAX_LONG_EDGE_PX: MAX_LONG_EDGE_PX
};
