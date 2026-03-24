// rnnoise-processor.js — AudioWorklet processor for RNNoise WASM noise suppression
//
// Receives WASM binary from main thread via port.postMessage, instantiates it,
// and runs rnnoise_process_frame() on 480-sample (10ms) chunks.
//
// Messages accepted:
//   { type: 'init', wasmBytes: ArrayBuffer }  — load the WASM module
//   { type: 'enable', enabled: boolean }       — toggle processing on/off
//
// Messages sent:
//   { type: 'ready' }                          — WASM loaded successfully
//   { type: 'vad', probability: float }        — voice activity (0..1), every 10ms frame

const RNNOISE_FRAME_SIZE = 480; // 10ms at 48kHz

class RnnoiseProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    // WASM state
    this._wasm = null;       // WebAssembly instance
    this._rnnoiseState = 0;  // pointer to RNNoiseState
    this._inputPtr = 0;      // pointer to float[480] in WASM heap
    this._enabled = true;
    this._ready = false;

    // Ring buffer for accumulating 128-sample blocks into 480-sample frames
    this._inBuf = new Float32Array(RNNOISE_FRAME_SIZE);
    this._outBuf = new Float32Array(RNNOISE_FRAME_SIZE);
    this._inPos = 0;    // write position in _inBuf
    this._outPos = 0;   // read position in _outBuf
    this._outAvail = 0; // samples available in _outBuf

    this.port.onmessage = (e) => this._handleMessage(e.data);
  }

  async _handleMessage(msg) {
    if (msg.type === 'init') {
      try {
        await this._initWasm(msg.wasmBytes);
        this._ready = true;
        this.port.postMessage({ type: 'ready' });
      } catch (err) {
        console.error('[rnnoise-processor] WASM init failed:', err);
      }
    } else if (msg.type === 'enable') {
      this._enabled = !!msg.enabled;
    }
  }

  async _initWasm(wasmBytes) {
    // Minimal import object — RNNoise standalone WASM needs very little
    const imports = {
      env: {
        // RNNoise may reference these math functions
        exp: Math.exp,
        log: Math.log,
        pow: Math.pow,
        sqrt: Math.sqrt,
        floor: Math.floor,
        ceil: Math.ceil,
        sin: Math.sin,
        cos: Math.cos,
        // Emscripten standalone may need these stubs
        emscripten_memcpy_js: (dest, src, n) => {
          const mem = new Uint8Array(this._wasm.exports.memory.buffer);
          mem.copyWithin(dest, src, src + n);
        },
      },
      wasi_snapshot_preview1: {
        fd_write: () => 0,
        fd_seek: () => 0,
        fd_close: () => 0,
        proc_exit: () => {},
      },
    };

    const { instance } = await WebAssembly.instantiate(wasmBytes, imports);
    this._wasm = instance;

    const exports = instance.exports;

    // Allocate RNNoise state
    this._rnnoiseState = exports.rnnoise_create(0); // NULL for default model
    if (!this._rnnoiseState) {
      throw new Error('rnnoise_create returned null');
    }

    // Allocate float buffer in WASM heap for one frame (480 * 4 bytes)
    this._inputPtr = exports.malloc(RNNOISE_FRAME_SIZE * 4);
    if (!this._inputPtr) {
      throw new Error('malloc failed for input buffer');
    }
  }

  _processFrame() {
    if (!this._ready || !this._enabled) {
      // Pass through unchanged
      this._outBuf.set(this._inBuf);
      this._outAvail = RNNOISE_FRAME_SIZE;
      this._outPos = 0;
      return;
    }

    const exports = this._wasm.exports;
    const heap = new Float32Array(exports.memory.buffer);
    const offset = this._inputPtr >> 2; // byte offset to float index

    // RNNoise expects samples scaled to 16-bit range (-32768..32767)
    for (let i = 0; i < RNNOISE_FRAME_SIZE; i++) {
      heap[offset + i] = this._inBuf[i] * 32768.0;
    }

    // Process — modifies buffer in-place, returns VAD probability
    const vad = exports.rnnoise_process_frame(this._rnnoiseState, this._inputPtr, this._inputPtr);

    // Scale back to float range
    for (let i = 0; i < RNNOISE_FRAME_SIZE; i++) {
      this._outBuf[i] = heap[offset + i] / 32768.0;
    }

    this._outAvail = RNNOISE_FRAME_SIZE;
    this._outPos = 0;

    // Report VAD (throttle to avoid flooding — only send if significant change)
    this.port.postMessage({ type: 'vad', probability: vad });
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input[0] || !output || !output[0]) return true;

    const inData = input[0];
    const outData = output[0];
    let inOffset = 0;
    let outOffset = 0;

    while (inOffset < inData.length || outOffset < outData.length) {
      // Fill input ring buffer from incoming samples
      while (inOffset < inData.length && this._inPos < RNNOISE_FRAME_SIZE) {
        this._inBuf[this._inPos++] = inData[inOffset++];
      }

      // If we have a full frame, process it
      if (this._inPos >= RNNOISE_FRAME_SIZE) {
        this._processFrame();
        this._inPos = 0;
      }

      // Drain output buffer to output
      while (outOffset < outData.length && this._outAvail > 0) {
        outData[outOffset++] = this._outBuf[this._outPos++];
        this._outAvail--;
      }

      // If no more input and no more output available, fill remainder with silence
      if (inOffset >= inData.length && this._outAvail <= 0) {
        while (outOffset < outData.length) {
          outData[outOffset++] = 0;
        }
        break;
      }
    }

    return true;
  }
}

registerProcessor('rnnoise-processor', RnnoiseProcessor);
