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
    this._inputPtr = 0;      // pointer to float[480] input buffer in WASM heap
    this._outputPtr = 0;     // pointer to float[480] output buffer in WASM heap
    this._enabled = true;
    this._ready = false;
    this._errorLogged = false;

    // Input accumulator: collects 128-sample browser blocks into 480-sample RNNoise frames
    this._inBuf = new Float32Array(RNNOISE_FRAME_SIZE);
    this._inPos = 0;

    // Output ring buffer: large enough to hold 2 processed frames (960 samples)
    // so a new frame can be appended while the previous one is still being drained.
    // This prevents the old single-buffer overwrite bug where unread samples were lost
    // when processing triggered mid-block (480 % 128 != 0).
    this._ringBuf = new Float32Array(960);
    this._ringRead = 0;
    this._ringWrite = 0;
    this._ringCount = 0; // samples available

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

    // Call WASM initializer to set up heap/internal state
    if (typeof exports._initialize === 'function') {
      exports._initialize();
    }

    // Allocate RNNoise state
    this._rnnoiseState = exports.rnnoise_create(0); // NULL for default model
    if (!this._rnnoiseState) {
      throw new Error('rnnoise_create returned null');
    }

    // Allocate separate input and output float buffers in WASM heap (480 * 4 bytes each).
    // Using the same pointer for both in/out can cause OOB access in some WASM builds
    // because the RNN reads input while simultaneously writing output.
    this._inputPtr = exports.malloc(RNNOISE_FRAME_SIZE * 4);
    this._outputPtr = exports.malloc(RNNOISE_FRAME_SIZE * 4);
    if (!this._inputPtr || !this._outputPtr) {
      throw new Error('malloc failed for audio buffers');
    }
  }

  _processFrame() {
    // Temporary buffer for this frame's output
    let processed;

    if (!this._ready || !this._enabled) {
      // Pass through unchanged
      processed = this._inBuf;
    } else {
      try {
        const exports = this._wasm.exports;
        // Re-create view each call — buffer reference can change after WASM ops
        const heap = new Float32Array(exports.memory.buffer);
        const inOffset = this._inputPtr >> 2;
        const outOffset = this._outputPtr >> 2;

        // RNNoise expects samples scaled to 16-bit range (-32768..32767)
        for (let i = 0; i < RNNOISE_FRAME_SIZE; i++) {
          heap[inOffset + i] = this._inBuf[i] * 32768.0;
        }

        // Process with separate input/output buffers to avoid aliasing issues
        const vad = exports.rnnoise_process_frame(this._rnnoiseState, this._outputPtr, this._inputPtr);

        // Re-acquire view in case WASM internals modified memory layout
        const heapOut = new Float32Array(exports.memory.buffer);

        // Scale back to float range
        for (let i = 0; i < RNNOISE_FRAME_SIZE; i++) {
          this._inBuf[i] = heapOut[outOffset + i] / 32768.0;
        }
        processed = this._inBuf;

        this.port.postMessage({ type: 'vad', probability: vad });
      } catch (err) {
        // WASM trap (e.g. memory access out of bounds) — disable to avoid repeated crashes
        if (!this._errorLogged) {
          console.error('[rnnoise-processor] WASM error, disabling noise suppression:', err.message);
          this._errorLogged = true;
          this.port.postMessage({ type: 'error', message: err.message });
        }
        this._ready = false;
        processed = this._inBuf;
      }
    }

    // Append processed samples to ring buffer
    const cap = this._ringBuf.length;
    for (let i = 0; i < RNNOISE_FRAME_SIZE; i++) {
      if (this._ringCount >= cap) break; // ring full, drop (shouldn't happen)
      this._ringBuf[this._ringWrite] = processed[i];
      this._ringWrite = (this._ringWrite + 1) % cap;
      this._ringCount++;
    }
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input[0] || !output || !output[0]) return true;

    const inData = input[0];
    const outData = output[0];

    // 1. Accumulate all input samples into the RNNoise input buffer.
    //    Process a frame each time we hit 480 samples.
    for (let i = 0; i < inData.length; i++) {
      this._inBuf[this._inPos++] = inData[i];
      if (this._inPos >= RNNOISE_FRAME_SIZE) {
        this._processFrame();
        this._inPos = 0;
      }
    }

    // 2. Drain output ring buffer into the output block.
    //    If the ring buffer has fewer samples than needed, output silence
    //    for the remainder (only happens during the initial fill).
    for (let i = 0; i < outData.length; i++) {
      if (this._ringCount > 0) {
        outData[i] = this._ringBuf[this._ringRead];
        this._ringRead = (this._ringRead + 1) % this._ringBuf.length;
        this._ringCount--;
      } else {
        outData[i] = 0;
      }
    }

    return true;
  }
}

registerProcessor('rnnoise-processor', RnnoiseProcessor);
