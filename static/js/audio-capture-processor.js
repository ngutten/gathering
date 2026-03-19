// AudioWorklet processor for capturing mic PCM at 48kHz mono.
// Collects samples into 960-sample frames (20ms at 48kHz) and posts them
// to the main thread for Opus encoding.

class AudioCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Float32Array(960);
    this._pos = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const samples = input[0]; // mono channel
    let offset = 0;

    while (offset < samples.length) {
      const remaining = 960 - this._pos;
      const toCopy = Math.min(remaining, samples.length - offset);
      this._buffer.set(samples.subarray(offset, offset + toCopy), this._pos);
      this._pos += toCopy;
      offset += toCopy;

      if (this._pos >= 960) {
        // Post a copy of the 20ms frame
        this.port.postMessage(this._buffer.slice());
        this._pos = 0;
      }
    }

    return true;
  }
}

registerProcessor('audio-capture-processor', AudioCaptureProcessor);
