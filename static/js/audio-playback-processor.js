// audio-playback-processor.js — AudioWorklet for gapless playback from a ring buffer
//
// Receives decoded PCM frames via port.postMessage({ pcm: Float32Array }).
// Outputs a continuous audio stream, eliminating inter-frame clicks caused
// by scheduling discrete AudioBufferSourceNodes back-to-back.

class AudioPlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // Ring buffer: ~200ms capacity at 48kHz (9600 samples)
    this._bufSize = 9600;
    this._buf = new Float32Array(this._bufSize);
    this._writePos = 0;
    this._readPos = 0;
    this._count = 0; // samples available

    this.port.onmessage = (e) => {
      const pcm = e.data.pcm;
      if (!pcm) return;
      for (let i = 0; i < pcm.length; i++) {
        if (this._count >= this._bufSize) break; // drop if full
        this._buf[this._writePos] = pcm[i];
        this._writePos = (this._writePos + 1) % this._bufSize;
        this._count++;
      }
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    if (!out || !out[0]) return true;
    const outData = out[0];

    for (let i = 0; i < outData.length; i++) {
      if (this._count > 0) {
        outData[i] = this._buf[this._readPos];
        this._readPos = (this._readPos + 1) % this._bufSize;
        this._count--;
      } else {
        outData[i] = 0; // underrun — output silence
      }
    }

    return true;
  }
}

registerProcessor('audio-playback-processor', AudioPlaybackProcessor);
