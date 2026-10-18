#!/usr/bin/env bash
set -euo pipefail

CLANGXX="${CLANGXX:-clang++}"
WASM_LD="${WASM_LD:-wasm-ld}"
OUT_DIR="${OUT_DIR:-build-memory64}"
mkdir -p "$OUT_DIR"

COMMON=(--target=wasm64-unknown-unknown -O2 -nostdlib -fno-exceptions -fno-rtti -fno-threadsafe-statics)
"$CLANGXX" "${COMMON[@]}" -c src/wasm64_memory.cpp -o "$OUT_DIR/wasm64_memory.o"

"$WASM_LD" -mwasm64 --no-entry --export-memory \
  --export=wexel_memory64_pointer_bits \
  --export=wexel_memory64_set_limit \
  --export=wexel_memory64_limit_bytes \
  --export=wexel_memory64_size_bytes \
  --export=wexel_memory64_grow \
  --export=wexel_memory64_alloc \
  --export=wexel_memory64_free \
  --initial-memory=16777216 \
  --max-memory=17179869184 \
  --features=memory64,mutable-globals,reference-types,multivalue,sign-ext \
  "$OUT_DIR/wasm64_memory.o" -o "$OUT_DIR/wexel-core-memory64.wasm"

python3 tools/strip-unused-table.py "$OUT_DIR/wexel-core-memory64.wasm" "$OUT_DIR/wexel-core-memory64.wasm.compat.tmp"
mv "$OUT_DIR/wexel-core-memory64.wasm.compat.tmp" "$OUT_DIR/wexel-core-memory64.wasm"
echo "Created $OUT_DIR/wexel-core-memory64.wasm"
echo "Run a real Memory64 test with: node --experimental-wasm-memory64 tools/test-memory64.mjs"
