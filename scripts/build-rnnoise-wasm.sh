#!/usr/bin/env bash
# build-rnnoise-wasm.sh — Compile xiph/rnnoise to standalone WASM for AudioWorklet use
#
# Requires: Emscripten (emcc), autoconf, automake, libtool, git
#   Or: Docker (pass --docker flag to use emscripten/emsdk image instead)
# Output:   static/wasm/rnnoise.wasm
#
# The resulting WASM module exports:
#   rnnoise_create()                     → pointer to RNNoise state
#   rnnoise_destroy(st)                  → free state
#   rnnoise_process_frame(st, buf, buf)  → returns VAD probability (float)
#   malloc(size)                         → allocate WASM heap memory
#   free(ptr)                            → free WASM heap memory
#
# RNNoise processes 480 float32 samples (10ms at 48kHz) per call.
# The input/output buffer is modified in-place with denoised audio.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
OUTPUT_DIR="$PROJECT_DIR/static/wasm"
BUILD_DIR="/tmp/rnnoise-build-$$"

cleanup() { rm -rf "$BUILD_DIR"; }
trap cleanup EXIT

echo "==> Cloning rnnoise (BSD-3-Clause)..."
mkdir -p "$BUILD_DIR"
git clone --depth 1 https://gitlab.xiph.org/xiph/rnnoise.git "$BUILD_DIR/rnnoise"

echo "==> Configuring..."
cd "$BUILD_DIR/rnnoise"
./autogen.sh
emconfigure ./configure \
  --disable-shared \
  --disable-examples \
  --disable-doc \
  --host=wasm32-unknown-emscripten

echo "==> Compiling..."
emmake make -j"$(nproc)"

echo "==> Linking standalone WASM..."
mkdir -p "$OUTPUT_DIR"
emcc -O3 \
  -s EXPORTED_FUNCTIONS='["_rnnoise_create","_rnnoise_destroy","_rnnoise_process_frame","_malloc","_free"]' \
  -s EXPORTED_RUNTIME_METHODS='[]' \
  -s STANDALONE_WASM=1 \
  -s INITIAL_MEMORY=16777216 \
  -s TOTAL_STACK=65536 \
  -s ERROR_ON_UNDEFINED_SYMBOLS=0 \
  --no-entry \
  .libs/librnnoise.a \
  -o "$OUTPUT_DIR/rnnoise.wasm"

echo "==> Done! Output: $OUTPUT_DIR/rnnoise.wasm"
ls -lh "$OUTPUT_DIR/rnnoise.wasm"
