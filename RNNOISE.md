# RNNoise Integration Plan

This document covers options for adding neural noise suppression to Gathering's
voice chat, building on the audio pipeline already in place (high-pass filter +
noise gate in `audio-pipeline.js`).

## Current State

The audio pipeline (`static/js/audio-pipeline.js`) already has a marked
insertion point for a denoiser between the noise gate and the output node.
Both WebRTC and SFU voice modes use this pipeline. The system operates at
48 kHz mono, 20 ms frames (960 samples) for Opus encoding.

---

## 1. What Is RNNoise?

A tiny recurrent neural network (GRU-based) that suppresses noise in real time.
Created by Jean-Marc Valin (Xiph.Org, also the creator of Opus and Speex).

**Key specs:**
- 48 kHz mono (matches our pipeline exactly)
- 10 ms frames (480 samples) — we'd process 2 per our 20 ms frame
- 42 input features (22 Bark-band cepstral coefficients + derivatives + pitch)
- 22 output gains (one per Bark frequency band, 0..1)
- ~88,000 weights, **85 KB quantized** (8-bit)
- 60x faster than real-time on x86
- Handles: keyboard typing, fans, background voices, music, street noise

### Architecture

| Layer     | Type  | Size | Activation |
|-----------|-------|------|------------|
| Input     | —     | 42   | —          |
| Hidden 1  | Dense | 24   | tanh       |
| Hidden 2  | GRU   | 24   | ReLU       |
| Hidden 3  | GRU   | 48   | ReLU       |
| Hidden 4  | GRU   | 96   | ReLU       |
| Output    | Dense | 22   | sigmoid    |
| VAD       | Dense | 1    | sigmoid    |

Processing pipeline per 10 ms frame:
1. FFT → 22 Bark-scale band energies
2. DCT on log energies → cepstral coefficients
3. Compute temporal derivatives + pitch features → 42-dim vector
4. Feed through GRU network → 22 band gains + VAD
5. Apply gains to spectral bands
6. Pitch comb filter at detected harmonics
7. Inverse FFT → clean audio

---

## 2. Licensing Analysis

### RNNoise Source Code: BSD-3-Clause

The library itself is BSD-3-Clause — fully compatible with our project. No
copyleft, no patent concerns, no attribution-in-binary requirements beyond the
license file.

### Pre-trained Weights

The weights shipped with RNNoise are embedded in `rnn_data.c` and distributed
under the same BSD-3-Clause license. They were trained on the McGill TSP speech
database and NTT Multi-Lingual Speech Database, plus various noise sources.

An argument exists (per the `rnnoise-models` project) that trained neural
network weights are not copyrightable creative works — they're mathematical
transformations of data. This is legally untested in most jurisdictions but
is a common position in the ML community.

### Existing WASM Builds

| Package | License | Maintained | Notes |
|---------|---------|------------|-------|
| `@shiguredo/rnnoise-wasm` | Apache-2.0 | Yes (2025) | Best maintained, TypeScript, tests |
| `@jitsi/rnnoise-wasm` | Apache-2.0 | Minimal | Used in production by Jitsi Meet |
| `@sapphi-red/web-noise-suppressor` | MIT | Yes | Higher-level wrapper, includes AudioWorklet helpers |

All are permissive licenses compatible with our project.

### Verdict

**Using an existing WASM build with pre-trained weights is legally safe** for a
permissively licensed project. BSD-3-Clause (code) + Apache-2.0 (WASM wrapper)
is fully compatible with CC0 downstream use. If paranoia about weight
provenance is a concern, we can train our own using CC0 data (see Section 5).

---

## 3. Integration Options

### Option A: Use Existing WASM Build (fastest)

Use `@shiguredo/rnnoise-wasm` or compile from upstream C source ourselves.

**Steps:**
1. Download the WASM file from a release or compile via Emscripten
2. Create `rnnoise-processor.js` AudioWorklet that loads WASM internally
3. In the worklet: feed 480-sample chunks, apply output gains
4. Wire into `audio-pipeline.js` at the marked insertion point

**Pros:** Done in hours, battle-tested weights, known quality
**Cons:** Using someone else's compiled binary (trust issue), weights trained
on non-CC0 data

### Option B: Compile From Source (recommended)

Clone `xiph/rnnoise`, compile to WASM ourselves with Emscripten. Use the
upstream pre-trained weights (BSD-3-Clause).

**Steps:**
1. `git clone https://gitlab.xiph.org/xiph/rnnoise.git`
2. Compile with Emscripten: `emcc` with `-O3 -s WASM=1`
3. Export the key C functions: `rnnoise_create`, `rnnoise_process_frame`,
   `rnnoise_destroy`, `rnnoise_get_vad_prob`
4. Bundle the `.wasm` file in `static/js/` or `static/wasm/`
5. Create AudioWorklet wrapper (see Section 4)

**Pros:** Full control, reproducible build, known provenance
**Cons:** Requires Emscripten toolchain, weights still from upstream training

### Option C: Train Our Own Weights (most independent)

Use the RNNoise training pipeline with CC0/public-domain data only.

**Pros:** Complete independence, CC0-compatible data provenance
**Cons:** Significant effort, may not match upstream quality without tuning

See Section 5 for details.

---

## 4. AudioWorklet Integration Design

### File: `static/js/rnnoise-processor.js`

```
AudioWorklet processor that:
1. Loads rnnoise.wasm on construction
2. Allocates WASM memory for one 480-sample frame
3. Buffers input into 480-sample chunks (we receive 128-sample blocks from Web Audio)
4. Calls rnnoise_process_frame() per chunk
5. Outputs processed audio
6. Exposes VAD probability via port.postMessage()
```

### File: `static/js/audio-pipeline.js` (modification)

```js
// After the noise gate, before the output:
const rnnoiseUrl = new URL('./rnnoise-processor.js', import.meta.url).href;
await ctx.audioWorklet.addModule(rnnoiseUrl);
const rnnoise = new AudioWorkletNode(ctx, 'rnnoise-processor');
lastNode.connect(rnnoise);
lastNode = rnnoise;
```

### Frame Size Alignment

- Web Audio delivers 128 samples per `process()` call
- RNNoise needs 480 samples per frame
- Solution: buffer in the worklet (same pattern as `audio-capture-processor.js`)
- Every 480 samples → call `rnnoise_process_frame()` → output 480 processed samples
- Latency added: 10 ms (one RNNoise frame) on top of existing pipeline latency

### Memory Layout

RNNoise WASM needs ~200 KB heap:
- RNNoise state struct: ~90 KB (includes FFT tables, GRU state)
- Input/output buffers: ~4 KB
- Model weights: ~85 KB

### Interaction With Existing Pipeline

```
mic → [browser AEC/NS/AGC] → highpass(85Hz) → noiseGate → [rnnoise] → output
```

The noise gate and RNNoise are complementary:
- **Noise gate:** hard suppression between speech (0 bandwidth when not talking)
- **RNNoise:** clean up noise *during* speech (background voices, typing while
  talking, fan hum that AEC doesn't catch)
- **Combined:** gate catches inter-speech noise instantly (150ms hold + fade),
  RNNoise handles the harder intra-speech case

The noise gate also reduces unnecessary RNNoise processing — when the gate is
closed, RNNoise receives silence and does minimal work.

### WASM in AudioWorklet

Loading WASM inside an AudioWorklet requires either:
1. **Inline WASM** (base64-encoded in JS) — simpler, ~113 KB overhead for 85 KB WASM
2. **Fetch in worklet** — worklets can `fetch()` but some browsers restrict this
3. **Transfer from main thread** — main thread fetches, sends `ArrayBuffer` via
   `port.postMessage()` to worklet, worklet instantiates

Option 3 is most reliable across browsers. The AudioWorklet constructor receives
the WASM binary, calls `WebAssembly.instantiate()`, and stores the instance.

---

## 5. Training Our Own Weights

If we want full data provenance (CC0-only training data), here's the plan.

### CC0/Public Domain Speech Data

| Dataset | License | Hours | Sample Rate | Notes |
|---------|---------|-------|-------------|-------|
| Mozilla Common Voice | CC0 | 30,000+ | 48 kHz (MP3) | Best option — huge, multilingual, native 48 kHz |
| LibriVox / LibriSpeech | Public Domain | 1,000 | 16 kHz | Needs upsampling to 48 kHz |
| RNNoise CC0 contributions | CC0 | ~100 hrs | 48 kHz | Crowdsourced, needs cleaning |

### Noise Data (CC0 / permissive)

| Source | License | Notes |
|--------|---------|-------|
| Freesound.org (CC0 filter) | CC0 | Keyboard typing, fans, street, rain, wind, crowds |
| FSD50K (CC0 subset) | CC0 | ~84.7% of clips are CC0 |
| Self-recorded | CC0 | Record our own: typing on various keyboards, fans, wind, cafe |
| Synthetic | CC0 | Generate pink/brown noise, hum at 50/60 Hz, clicks, pops |

### Training Pipeline

RNNoise provides training tools in the repository:

```
1. Prepare data:
   - Clean speech files (48 kHz, 16-bit PCM, mono)
   - Noise files (same format)
   - denoise_training tool mixes them at random SNRs

2. Feature extraction:
   - denoise_training reads raw audio pairs
   - Outputs .f32 feature files (42 features + 22 target gains per frame)

3. Training:
   - Python script (train_rnnoise.py) using Keras/TensorFlow
   - Trains GRU network on extracted features
   - ~200,000 sequences recommended
   - Outputs weight dump (rnn_data.c or .bin)

4. Quantization:
   - Weights constrained to [-0.5, 0.5] during training
   - Quantize to 8-bit → 85 KB model file
```

### Data Requirements

- **Minimum viable:** ~50 hours of speech + ~10 hours of diverse noise
- **Recommended:** ~200+ hours speech, ~50 hours noise, heavily augmented
- **Augmentation strategies:**
  - Mix at random SNRs (-5 dB to +20 dB)
  - Random time offsets
  - Room impulse response convolution (simulates reverb)
  - Speed perturbation (0.9x - 1.1x)
  - Gain variation

### Estimated Effort

- Data collection and preparation: 1-2 days
- Training pipeline setup: 1 day
- Training runs + tuning: 1-2 days (GPU helps but CPU is viable)
- Validation and A/B testing: 1 day
- **Total: ~1 week**

The original RNNoise was trained in "a few hours" on a single GPU according to
the paper. The architecture is small enough that CPU training is feasible
(just slower).

---

## 6. Alternatives Considered

### DeepFilterNet3 (MIT/Apache-2.0)

- Higher quality than RNNoise on benchmarks
- Also 48 kHz native
- But: model is several MB (vs 85 KB), heavier compute, WASM ecosystem
  less mature
- Could be a future upgrade path if RNNoise proves insufficient

### DTLN (MIT)

- Proven WASM implementation by Datadog (`dtln-rs` in Rust)
- But: **16 kHz only** — would require resampling in both directions
- Model ~2 MB
- Not suitable for our 48 kHz pipeline without significant overhead

### Speex Preprocessor (BSD-3-Clause)

- Traditional DSP, no neural network
- Already available via `@sapphi-red/web-noise-suppressor`
- Much lower quality than neural approaches
- Our existing noise gate already provides similar functionality

---

## 7. Recommended Path

### Phase 1: Compile RNNoise to WASM ourselves

1. Clone `xiph/rnnoise` (BSD-3-Clause)
2. Set up Emscripten build (can be done in Docker for reproducibility)
3. Compile to WASM, exporting only the needed C API surface
4. Use the upstream pre-trained weights (they're part of the BSD-3 source)
5. Commit the build script + resulting WASM to our repo

### Phase 2: AudioWorklet integration

1. Create `rnnoise-processor.js` with 480-sample buffering
2. Main thread fetches WASM, transfers to worklet via `postMessage`
3. Wire into `audio-pipeline.js` at the existing insertion point
4. Add a UI toggle (noise suppression on/off) — respect user preference
5. Use VAD output to improve speaking detection (replace FFT threshold)

### Phase 3 (optional): Train on CC0 data

1. Download Mozilla Common Voice (CC0, 48 kHz)
2. Collect noise samples from Freesound CC0 + self-recorded
3. Use RNNoise's training pipeline
4. Compare quality against upstream weights via listening tests
5. If comparable, switch to CC0-trained weights

### Phase 4 (future): Evaluate DeepFilterNet3

If RNNoise quality proves insufficient (e.g., background voices not
separated well enough), evaluate DeepFilterNet3 as a higher-quality
replacement. Same AudioWorklet pattern, just a larger model.

---

## 8. Risk Assessment

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| WASM in AudioWorklet browser compat | Low | Well-trodden path (Jitsi, Teams, Meet all do this) |
| Latency increase noticeable | Low | Only +10 ms (one frame), inaudible in practice |
| CPU usage on low-end devices | Medium | RNNoise is 60x real-time on x86; add UI toggle to disable |
| Upstream weights quality for our use case | Low | Trained on multilingual speech + diverse noise |
| CC0-trained weights lower quality | Medium | Compare via listening tests; keep upstream as fallback |
| Emscripten build complexity | Low | Many reference builds exist; Docker makes it reproducible |
