// opus-codec.js — Opus encoder/decoder using WebCodecs API (primary) with
// raw PCM fallback for browsers without WebCodecs Opus support.
//
// Exports:
//   initOpus()           → Promise<void>
//   opusEncode(Float32Array) → Uint8Array | null
//   opusDecode(Uint8Array)   → Float32Array | null
//   closeOpus()          → void
//   opusSupported()      → bool  (true if we have real Opus, false = raw PCM fallback)

const SAMPLE_RATE = 48000;
const FRAME_SIZE = 960; // 20ms at 48kHz
const CHANNELS = 1;
const BITRATE = 32000;

let _encoder = null;
let _decoder = null;
let _encodedChunks = [];  // queue of encoded Uint8Array
let _decodedChunks = [];  // queue of decoded Float32Array
let _useWebCodecs = false;
let _initialized = false;

/** Detect WebCodecs Opus support */
async function detectWebCodecs() {
  if (typeof AudioEncoder === 'undefined' || typeof AudioDecoder === 'undefined') {
    return false;
  }
  try {
    const support = await AudioEncoder.isConfigSupported({
      codec: 'opus',
      sampleRate: SAMPLE_RATE,
      numberOfChannels: CHANNELS,
      bitrate: BITRATE,
    });
    return support.supported === true;
  } catch {
    return false;
  }
}

/** Initialize encoder and decoder */
export async function initOpus() {
  if (_initialized) return;

  _useWebCodecs = await detectWebCodecs();

  if (_useWebCodecs) {
    _encoder = new AudioEncoder({
      output: (chunk) => {
        const buf = new Uint8Array(chunk.byteLength);
        chunk.copyTo(buf);
        _encodedChunks.push(buf);
      },
      error: (e) => console.error('[opus] Encoder error:', e),
    });
    _encoder.configure({
      codec: 'opus',
      sampleRate: SAMPLE_RATE,
      numberOfChannels: CHANNELS,
      bitrate: BITRATE,
    });

    _decoder = new AudioDecoder({
      output: (audioData) => {
        const pcm = new Float32Array(audioData.numberOfFrames);
        audioData.copyTo(pcm, { planeIndex: 0 });
        _decodedChunks.push(pcm);
        audioData.close();
      },
      error: (e) => console.error('[opus] Decoder error:', e),
    });
    _decoder.configure({
      codec: 'opus',
      sampleRate: SAMPLE_RATE,
      numberOfChannels: CHANNELS,
    });

    console.log('[opus] Using WebCodecs Opus encoder/decoder');
  } else {
    console.log('[opus] WebCodecs Opus not available, using raw PCM fallback (higher bandwidth)');
  }

  _initialized = true;
}

/**
 * Encode a 20ms PCM frame (960 Float32 samples) to Opus.
 * Returns Uint8Array (Opus packet) or null if not ready.
 * In fallback mode, returns 16-bit PCM.
 */
export function opusEncode(pcmFloat32) {
  if (!_initialized) return null;

  if (_useWebCodecs) {
    const audioData = new AudioData({
      format: 'f32-planar',
      sampleRate: SAMPLE_RATE,
      numberOfFrames: pcmFloat32.length,
      numberOfChannels: CHANNELS,
      timestamp: 0, // encoder doesn't care about absolute timestamp
      data: pcmFloat32,
    });
    _encoder.encode(audioData);
    audioData.close();

    // Return the latest encoded chunk (synchronous drain)
    return _encodedChunks.shift() || null;
  }

  // Fallback: convert Float32 → Int16 PCM
  const pcm16 = new Int16Array(pcmFloat32.length);
  for (let i = 0; i < pcmFloat32.length; i++) {
    const s = Math.max(-1, Math.min(1, pcmFloat32[i]));
    pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  return new Uint8Array(pcm16.buffer);
}

/**
 * Decode an Opus packet (Uint8Array) to PCM Float32Array.
 * Returns Float32Array or null if not ready.
 * In fallback mode, expects 16-bit PCM.
 */
export function opusDecode(opusData) {
  if (!_initialized) return null;

  if (_useWebCodecs) {
    const chunk = new EncodedAudioChunk({
      type: 'key',
      timestamp: 0,
      data: opusData,
    });
    _decoder.decode(chunk);

    // Return the latest decoded chunk (synchronous drain)
    return _decodedChunks.shift() || null;
  }

  // Fallback: Int16 PCM → Float32
  const pcm16 = new Int16Array(opusData.buffer, opusData.byteOffset, opusData.byteLength / 2);
  const pcmFloat = new Float32Array(pcm16.length);
  for (let i = 0; i < pcm16.length; i++) {
    pcmFloat[i] = pcm16[i] / (pcm16[i] < 0 ? 0x8000 : 0x7FFF);
  }
  return pcmFloat;
}

/** Close encoder and decoder, release resources */
export function closeOpus() {
  if (_encoder && _encoder.state !== 'closed') {
    try { _encoder.close(); } catch {}
  }
  if (_decoder && _decoder.state !== 'closed') {
    try { _decoder.close(); } catch {}
  }
  _encoder = null;
  _decoder = null;
  _encodedChunks = [];
  _decodedChunks = [];
  _initialized = false;
  _useWebCodecs = false;
}

/** Returns true if real Opus compression is in use, false if raw PCM fallback */
export function opusSupported() {
  return _useWebCodecs;
}
