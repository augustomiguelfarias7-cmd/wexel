#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLANGXX="${CLANGXX:-clang++}"
OUT="$ROOT/packages/wexel/assets/s-kernel/s1.wasm"
SRC="$ROOT/kernel/s1/s1.cpp"

if ! command -v "$CLANGXX" >/dev/null 2>&1; then
  echo "Clang++ is required to build the S1 WebAssembly kernel." >&2
  exit 1
fi
if ! command -v wasm-ld >/dev/null 2>&1; then
  echo "wasm-ld (LLVM linker) is required to build the S1 WebAssembly kernel." >&2
  exit 1
fi

mkdir -p "$(dirname "$OUT")"
"$CLANGXX" --target=wasm32-unknown-unknown -std=c++20 -O2 \
  -ffreestanding -fno-exceptions -fno-rtti -fno-threadsafe-statics \
  -fno-builtin -nostdlib "$SRC" -o "$OUT" \
  -Wl,--no-entry -Wl,--export-all -Wl,--allow-undefined \
  -Wl,--initial-memory=16777216 -Wl,--max-memory=268435456
echo "S1 built: $OUT"
