#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

: "${GO_BIN:=go}"
: "${ZIG_BIN:=zig}"
OUT="${OUT_DIR:-dist/languages}"
GO_OUT="$OUT/go"
ZIG_OUT="$OUT/zig"
mkdir -p "$GO_OUT" "$ZIG_OUT"

if ! command -v "$GO_BIN" >/dev/null 2>&1; then
  echo "Go toolchain not found. Install Go; only the compiler is needed at build time." >&2
  exit 1
fi
if ! command -v "$ZIG_BIN" >/dev/null 2>&1; then
  echo "Zig toolchain not found. Install Zig; only the compiler is needed at build time." >&2
  exit 1
fi

GOROOT="$("$GO_BIN" env GOROOT)"
GOOS=js GOARCH=wasm "$GO_BIN" build -trimpath -o "$GO_OUT/hello.wasm" ./examples/languages/go
cp "$GOROOT/misc/wasm/wasm_exec.js" "$GO_OUT/wasm_exec.js"

"$ZIG_BIN" build-exe examples/languages/zig/main.zig \
  -target wasm32-wasi -O ReleaseSmall \
  -femit-bin="$ZIG_OUT/hello.wasm"

echo "Built separate language artifacts:"
ls -lh "$GO_OUT/hello.wasm" "$ZIG_OUT/hello.wasm"
echo "Run Go:  node scripts/run-go-wasm.mjs $GO_OUT/hello.wasm"
echo "Run Zig: node scripts/run-wasi-wasm.mjs $ZIG_OUT/hello.wasm"
