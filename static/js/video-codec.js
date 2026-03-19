// video-codec.js — VP8 video encoder/decoder using WebCodecs API
//
// Same init/encode/decode/close pattern as opus-codec.js.
// Exports:
//   initVideoCodec(width, height, bitrate) → Promise<void>
//   videoEncode(VideoFrame) → { data: Uint8Array, isKey: bool } | null
//   videoDecode(data: Uint8Array, isKey: bool) → VideoFrame | null
//   requestKeyframe()   → void
//   closeVideoCodec()   → void
//   videoCodecSupported() → bool

let _encoder = null;
let _decoder = null;
let _encodedChunks = [];  // queue of { data: Uint8Array, isKey: bool }
let _decodedFrames = [];  // queue of VideoFrame
let _initialized = false;
let _supported = false;
let _forceKeyframe = false;
let _keyframeTimer = null;
let _frameCount = 0;

const KEYFRAME_INTERVAL = 150; // Force keyframe every 150 frames (~5s at 30fps)

/** Detect WebCodecs VP8 support */
async function detectSupport() {
  if (typeof VideoEncoder === 'undefined' || typeof VideoDecoder === 'undefined') {
    return false;
  }
  try {
    const support = await VideoEncoder.isConfigSupported({
      codec: 'vp8',
      width: 640,
      height: 480,
      bitrate: 500000,
    });
    return support.supported === true;
  } catch {
    return false;
  }
}

/**
 * Initialize VP8 encoder and decoder.
 * @param {number} width - Video width in pixels
 * @param {number} height - Video height in pixels
 * @param {number} [bitrate=500000] - Target bitrate in bits/sec
 */
export async function initVideoCodec(width, height, bitrate = 500000) {
  if (_initialized) return;

  _supported = await detectSupport();
  if (!_supported) {
    console.warn('[video-codec] WebCodecs VP8 not available');
    return;
  }

  _encoder = new VideoEncoder({
    output: (chunk) => {
      const buf = new Uint8Array(chunk.byteLength);
      chunk.copyTo(buf);
      _encodedChunks.push({
        data: buf,
        isKey: chunk.type === 'key',
      });
    },
    error: (e) => console.error('[video-codec] Encoder error:', e),
  });

  _encoder.configure({
    codec: 'vp8',
    width,
    height,
    bitrate,
    framerate: 30,
  });

  _decoder = new VideoDecoder({
    output: (frame) => {
      _decodedFrames.push(frame);
    },
    error: (e) => console.error('[video-codec] Decoder error:', e),
  });

  _decoder.configure({
    codec: 'vp8',
  });

  _frameCount = 0;
  _initialized = true;
  console.log(`[video-codec] VP8 encoder/decoder initialized (${width}x${height} @ ${bitrate}bps)`);
}

/**
 * Encode a VideoFrame to VP8.
 * Caller must close the frame after calling this.
 * @param {VideoFrame} frame
 * @returns {{ data: Uint8Array, isKey: boolean } | null}
 */
export function videoEncode(frame) {
  if (!_initialized || !_encoder || _encoder.state === 'closed') return null;

  _frameCount++;
  const forceKey = _forceKeyframe || (_frameCount % KEYFRAME_INTERVAL === 0);
  _forceKeyframe = false;

  _encoder.encode(frame, { keyFrame: forceKey });

  return _encodedChunks.shift() || null;
}

/**
 * Decode a VP8 packet to a VideoFrame.
 * Caller is responsible for closing the returned frame.
 * @param {Uint8Array} data
 * @param {boolean} isKey
 * @returns {VideoFrame | null}
 */
export function videoDecode(data, isKey) {
  if (!_initialized || !_decoder || _decoder.state === 'closed') return null;

  const chunk = new EncodedVideoChunk({
    type: isKey ? 'key' : 'delta',
    timestamp: 0,
    data,
  });
  _decoder.decode(chunk);

  return _decodedFrames.shift() || null;
}

/** Force the next encode to produce a keyframe */
export function requestKeyframe() {
  _forceKeyframe = true;
}

/** Close encoder and decoder, release resources */
export function closeVideoCodec() {
  if (_encoder && _encoder.state !== 'closed') {
    try { _encoder.close(); } catch {}
  }
  if (_decoder && _decoder.state !== 'closed') {
    try { _decoder.close(); } catch {}
  }
  // Close any queued decoded frames
  _decodedFrames.forEach(f => { try { f.close(); } catch {} });

  _encoder = null;
  _decoder = null;
  _encodedChunks = [];
  _decodedFrames = [];
  _initialized = false;
  _supported = false;
  _frameCount = 0;
  if (_keyframeTimer) { clearInterval(_keyframeTimer); _keyframeTimer = null; }
}

/** Returns true if VP8 WebCodecs is available */
export function videoCodecSupported() {
  return _supported;
}
