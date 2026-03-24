// noise-gate-processor.js — AudioWorklet noise gate with attack/release
//
// Suppresses audio below a threshold with smooth gain transitions.
// Kills typing, paper rustling, distant sounds between speech.
// Parameters can be updated at runtime via port.postMessage().
//
// Future: a denoising processor (e.g. RNNoise WASM) can be chained
// after this gate for deeper noise removal during speech.

class NoiseGateProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // Gate parameters
    this._openThreshold = 0.015;   // Gate opens above this amplitude (~-36dB)
    this._closeThreshold = 0.008;  // Gate closes below this (hysteresis band)
    this._holdMs = 150;            // Keep gate open this long after signal drops
    this._attackMs = 3;            // Gain ramp-up time (speech onset)
    this._releaseMs = 80;          // Gain ramp-down time (smooth fade)

    // Internal state
    this._envelope = 0;
    this._gateGain = 0;
    this._holdCounter = 0;
    this._gateOpen = false;

    this._computeCoeffs();

    this.port.onmessage = (e) => {
      const d = e.data;
      if (d.openThreshold !== undefined) this._openThreshold = d.openThreshold;
      if (d.closeThreshold !== undefined) this._closeThreshold = d.closeThreshold;
      if (d.holdMs !== undefined) this._holdMs = d.holdMs;
      if (d.attackMs !== undefined) this._attackMs = d.attackMs;
      if (d.releaseMs !== undefined) this._releaseMs = d.releaseMs;
      this._computeCoeffs();
    };
  }

  _computeCoeffs() {
    // Envelope follower coefficients (fast attack, slower release for peak tracking)
    this._envAttackCoeff = 1 - Math.exp(-1 / (sampleRate * 0.001));  // 1ms
    this._envReleaseCoeff = 1 - Math.exp(-1 / (sampleRate * 0.020)); // 20ms

    // Gain smoothing coefficients
    this._gainAttackCoeff = 1 - Math.exp(-1 / (sampleRate * this._attackMs / 1000));
    this._gainReleaseCoeff = 1 - Math.exp(-1 / (sampleRate * this._releaseMs / 1000));

    // Hold time in samples
    this._holdSamples = Math.round(sampleRate * this._holdMs / 1000);
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input[0] || !output || !output[0]) return true;

    const inData = input[0];
    const outData = output[0];

    for (let i = 0; i < inData.length; i++) {
      const sample = inData[i];
      const absVal = Math.abs(sample);

      // Peak envelope follower
      if (absVal > this._envelope) {
        this._envelope += this._envAttackCoeff * (absVal - this._envelope);
      } else {
        this._envelope += this._envReleaseCoeff * (absVal - this._envelope);
      }

      // Gate state machine with hysteresis and hold
      if (this._envelope > this._openThreshold) {
        this._gateOpen = true;
        this._holdCounter = this._holdSamples;
      } else if (this._gateOpen) {
        if (this._holdCounter > 0) {
          this._holdCounter--;
        } else if (this._envelope < this._closeThreshold) {
          this._gateOpen = false;
        }
      }

      // Smooth gain transition (avoids clicks)
      const targetGain = this._gateOpen ? 1.0 : 0.0;
      if (targetGain > this._gateGain) {
        this._gateGain += this._gainAttackCoeff * (targetGain - this._gateGain);
      } else {
        this._gateGain += this._gainReleaseCoeff * (targetGain - this._gateGain);
      }

      outData[i] = sample * this._gateGain;
    }

    return true;
  }
}

registerProcessor('noise-gate-processor', NoiseGateProcessor);
