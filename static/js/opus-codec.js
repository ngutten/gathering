// opus-codec.js — Opus encoder/decoder using WebCodecs API (primary) with
// raw PCM fallback for browsers without WebCodecs Opus support.
//
// Exports:
//   initOpus()           → Promise<void>
//   opusEncode(Float32Array) → void  (result delivered via onEncoded callback)
//   opusDecode(Uint8Array)   → void  (result delivered via onDecoded callback)
//   setOnEncoded(cb)     → register callback(Uint8Array) for encode output
//   setOnDecoded(cb)     → register callback(Float32Array) for decode output
//   setOnDecodeError(cb) → register callback(Error) for decode errors
//   closeOpus()          → void
//   opusSupported()      → bool  (true if we have real Opus, false = raw PCM fallback)

const SAMPLE_RATE = 48000;
const FRAME_SIZE = 960; // 20ms at 48kHz
const CHANNELS = 1;
const BITRATE = 32000;

let _encoder = null;
let _decoder = null;
let _onEncoded = null;  // callback for encoded Opus packets
let _onDecoded = null;  // callback for decoded PCM frames
let _onDecodeError = null; // callback for decode errors (so caller can sync state)
let _useWebCodecs = false;
let _initialized = false;
let _encodeTimestamp = 0;  // microseconds, monotonically increasing for encoder
let _decodeTimestamp = 0;  // microseconds, monotonically increasing for decoder
const FRAME_DURATION_US = (FRAME_SIZE / SAMPLE_RATE) * 1_000_000; // 20000µs per frame

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
        if (_onEncoded) _onEncoded(buf);
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
        const nFrames = audioData.numberOfFrames;
        const nCh = audioData.numberOfChannels;

        // Use allocationSize() for the correct buffer size — some implementations
        // output interleaved stereo even when configured for mono.
        let allocBytes;
        try { allocBytes = audioData.allocationSize({ planeIndex: 0 }); }
        catch { allocBytes = nFrames * nCh * 4; }

        const raw = new Float32Array(allocBytes / 4);
        audioData.copyTo(raw, { planeIndex: 0 });

        // Downmix to mono if the decoder output more than one channel
        let pcm;
        if (raw.length === nFrames) {
          pcm = raw;
        } else {
          // Interleaved multi-channel → take first channel
          pcm = new Float32Array(nFrames);
          for (let i = 0; i < nFrames; i++) pcm[i] = raw[i * nCh];
        }
        if (_onDecoded) _onDecoded(pcm);
        audioData.close();
      },
      error: (e) => {
        console.error('[opus] Decoder error:', e);
        if (_onDecodeError) _onDecodeError(e);
      },
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

/** Register callback for encoded Opus packets: cb(Uint8Array) */
export function setOnEncoded(cb) { _onEncoded = cb; }

/** Register callback for decoded PCM frames: cb(Float32Array) */
export function setOnDecoded(cb) { _onDecoded = cb; }

/** Register callback for decode errors: cb(Error) — lets caller stay in sync */
export function setOnDecodeError(cb) { _onDecodeError = cb; }

/**
 * Feed a 20ms PCM frame (960 Float32 samples) to the encoder.
 * Result is delivered asynchronously via the onEncoded callback (WebCodecs)
 * or synchronously (PCM fallback).
 */
export function opusEncode(pcmFloat32) {
  if (!_initialized) return;

  if (_useWebCodecs) {
    const audioData = new AudioData({
      format: 'f32-planar',
      sampleRate: SAMPLE_RATE,
      numberOfFrames: pcmFloat32.length,
      numberOfChannels: CHANNELS,
      timestamp: _encodeTimestamp,
      data: pcmFloat32,
    });
    _encoder.encode(audioData);
    audioData.close();
    _encodeTimestamp += FRAME_DURATION_US;
    return;
  }

  // Fallback: convert Float32 → Int16 PCM, deliver synchronously via callback
  const pcm16 = new Int16Array(pcmFloat32.length);
  for (let i = 0; i < pcmFloat32.length; i++) {
    const s = Math.max(-1, Math.min(1, pcmFloat32[i]));
    pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  if (_onEncoded) _onEncoded(new Uint8Array(pcm16.buffer));
}

/**
 * Feed an Opus packet (Uint8Array) to the decoder.
 * Result is delivered asynchronously via the onDecoded callback (WebCodecs)
 * or synchronously (PCM fallback).
 */
export function opusDecode(opusData) {
  if (!_initialized) return;

  if (_useWebCodecs) {
    const chunk = new EncodedAudioChunk({
      type: 'key',
      timestamp: _decodeTimestamp,
      data: opusData,
    });
    _decoder.decode(chunk);
    _decodeTimestamp += FRAME_DURATION_US;
    // Output delivered via _onDecoded callback from decoder output handler
    return;
  }

  // Fallback: Int16 PCM → Float32, deliver synchronously via callback
  const pcm16 = new Int16Array(opusData.buffer, opusData.byteOffset, opusData.byteLength / 2);
  const pcmFloat = new Float32Array(pcm16.length);
  for (let i = 0; i < pcm16.length; i++) {
    pcmFloat[i] = pcm16[i] / (pcm16[i] < 0 ? 0x8000 : 0x7FFF);
  }
  if (_onDecoded) _onDecoded(pcmFloat);
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
  _onEncoded = null;
  _onDecoded = null;
  _onDecodeError = null;
  _encodeTimestamp = 0;
  _decodeTimestamp = 0;
  _initialized = false;
  _useWebCodecs = false;
}

/** Returns true if real Opus compression is in use, false if raw PCM fallback */
export function opusSupported() {
  return _useWebCodecs;
}
