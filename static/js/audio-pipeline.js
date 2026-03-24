// audio-pipeline.js — Shared audio preprocessing pipeline
//
// Builds: mic source → high-pass filter → noise gate → output
// Used by both WebRTC (voice.js) and SFU (sfu-voice.js) modes.
//
// Architecture note: future RNNoise (or similar denoiser) slots in
// between the noise gate and the output node.  The gate handles
// inter-speech suppression; a denoiser would clean up intra-speech
// noise (background voices, music, etc.).

const HIGHPASS_FREQ = 85;   // Hz — below deepest male voice (~85Hz fundamental)
const HIGHPASS_Q = 0.707;   // Butterworth — flat passband, no resonance

/**
 * Build the audio processing chain.
 *
 * @param {AudioContext} ctx - AudioContext to use
 * @param {MediaStream} micStream - Raw microphone MediaStream
 * @returns {Promise<AudioPipeline>}
 */
export async function buildAudioPipeline(ctx, micStream) {
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

  // ── Future insertion point ──
  // const rnnoise = new AudioWorkletNode(ctx, 'rnnoise-processor');
  // lastNode.connect(rnnoise);
  // lastNode = rnnoise;

  return {
    /** First node in chain (MediaStreamSource) */
    source,
    /** Last node — connect your destination to this */
    outputNode: lastNode,
    /** Noise gate node (if available) for parameter tuning */
    noiseGateNode: noiseGate,
    /** Disconnect and clean up all nodes */
    cleanup() {
      try { source.disconnect(); } catch {}
      try { highpass.disconnect(); } catch {}
      if (noiseGate) try { noiseGate.disconnect(); } catch {}
    }
  };
}

/** getUserMedia audio constraints — explicit browser-level processing */
export const MIC_CONSTRAINTS = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};
