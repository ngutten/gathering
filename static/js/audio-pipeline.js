// audio-pipeline.js — Shared audio preprocessing pipeline
//
// Builds: mic source → high-pass filter → noise gate → [rnnoise] → output
// Used by both WebRTC (voice.js) and SFU (sfu-voice.js) modes.
//
// RNNoise (neural noise suppression) runs in an AudioWorklet with WASM.
// The noise gate handles inter-speech suppression; RNNoise cleans up
// intra-speech noise (background voices, typing while talking, fan hum).

const HIGHPASS_FREQ = 85;   // Hz — below deepest male voice (~85Hz fundamental)
const HIGHPASS_Q = 0.707;   // Butterworth — flat passband, no resonance

/**
 * Build the audio processing chain.
 *
 * @param {AudioContext} ctx - AudioContext to use
 * @param {MediaStream} micStream - Raw microphone MediaStream
 * @param {{ rnnoiseEnabled?: boolean }} [options] - Pipeline options
 * @returns {Promise<AudioPipeline>}
 */
export async function buildAudioPipeline(ctx, micStream, options = {}) {
  const source = ctx.createMediaStreamSource(micStream);

  // ── High-pass filter: removes rumble, wind noise, handling noise ──
  const highpass = ctx.createBiquadFilter();
  highpass.type = 'highpass';
  highpass.frequency.value = HIGHPASS_FREQ;
  highpass.Q.value = HIGHPASS_Q;

  source.connect(highpass);

  // ── Noise gate AudioWorklet ──
  let noiseGate = null;
  let lastNode = highpass;

  try {
    const processorUrl = new URL('./noise-gate-processor.js', import.meta.url).href;
    await ctx.audioWorklet.addModule(processorUrl);
    noiseGate = new AudioWorkletNode(ctx, 'noise-gate-processor');
    highpass.connect(noiseGate);
    lastNode = noiseGate;
  } catch (err) {
    // AudioWorklet may already be registered, or not available
    if (err.name === 'InvalidStateError' || err.message?.includes('already')) {
      // Already registered — just create the node
      try {
        noiseGate = new AudioWorkletNode(ctx, 'noise-gate-processor');
        highpass.connect(noiseGate);
        lastNode = noiseGate;
      } catch (e2) {
        console.warn('[audio-pipeline] Noise gate unavailable, highpass only:', e2.message);
      }
    } else {
      console.warn('[audio-pipeline] Noise gate unavailable, highpass only:', err.message);
    }
  }

  // ── RNNoise neural denoiser ──
  let rnnoiseNode = null;
  const rnnoiseEnabled = options.rnnoiseEnabled !== false; // default on

  try {
    // Fetch the WASM binary from main thread (most reliable across browsers)
    const wasmUrl = new URL('../wasm/rnnoise.wasm', import.meta.url).href;
    const wasmResponse = await fetch(wasmUrl);
    if (!wasmResponse.ok) throw new Error(`WASM fetch failed: ${wasmResponse.status}`);
    const wasmBytes = await wasmResponse.arrayBuffer();

    // Register the AudioWorklet processor
    const processorUrl = new URL('./rnnoise-processor.js', import.meta.url).href;
    try {
      await ctx.audioWorklet.addModule(processorUrl);
    } catch (err) {
      if (!err.message?.includes('already')) throw err;
    }

    rnnoiseNode = new AudioWorkletNode(ctx, 'rnnoise-processor');

    // Transfer WASM binary to worklet for instantiation
    rnnoiseNode.port.postMessage({ type: 'init', wasmBytes: wasmBytes }, [wasmBytes]);

    // Set initial enable state
    rnnoiseNode.port.postMessage({ type: 'enable', enabled: rnnoiseEnabled });

    lastNode.connect(rnnoiseNode);
    lastNode = rnnoiseNode;

    console.info('[audio-pipeline] RNNoise loaded, enabled:', rnnoiseEnabled);
  } catch (err) {
    console.warn('[audio-pipeline] RNNoise unavailable, skipping:', err.message);
    rnnoiseNode = null;
  }

  return {
    /** First node in chain (MediaStreamSource) */
    source,
    /** Last node — connect your destination to this */
    outputNode: lastNode,
    /** Noise gate node (if available) for parameter tuning */
    noiseGateNode: noiseGate,
    /** RNNoise node (if available) for enable/disable toggling */
    rnnoiseNode,
    /** Disconnect and clean up all nodes */
    cleanup() {
      try { source.disconnect(); } catch {}
      try { highpass.disconnect(); } catch {}
      if (noiseGate) try { noiseGate.disconnect(); } catch {}
      if (rnnoiseNode) try { rnnoiseNode.disconnect(); } catch {}
    }
  };
}

/**
 * Toggle RNNoise on an active pipeline at runtime.
 * @param {AudioPipeline} pipeline
 * @param {boolean} enabled
 */
export function setRnnoiseEnabled(pipeline, enabled) {
  if (pipeline && pipeline.rnnoiseNode) {
    pipeline.rnnoiseNode.port.postMessage({ type: 'enable', enabled });
  }
}

/** getUserMedia audio constraints — explicit browser-level processing */
export const MIC_CONSTRAINTS = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};
