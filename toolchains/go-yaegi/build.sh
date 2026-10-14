#!/usr/bin/env bash
set -euo pipefail

TOOLCHAIN_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$TOOLCHAIN_DIR/../.." && pwd)"
ASSET_DIR="$ROOT/packages/wexel/assets/toolchains/go"
GOROOT="$(go env GOROOT)"

mkdir -p "$ASSET_DIR"
cd "$TOOLCHAIN_DIR"
GOOS=js GOARCH=wasm go build -trimpath -ldflags='-s -w' -o "$ASSET_DIR/yaegi.wasm" .
gzip -9 -n -f "$ASSET_DIR/yaegi.wasm"

WASM_EXEC=""
for candidate in \
  "$GOROOT/lib/wasm/wasm_exec.js" \
  "$GOROOT/misc/wasm/wasm_exec.js"; do
  if [[ -f "$candidate" ]]; then WASM_EXEC="$candidate"; break; fi
done
if [[ -z "$WASM_EXEC" ]]; then
  echo "Could not find wasm_exec.js under GOROOT=$GOROOT" >&2
  exit 1
fi
cp "$WASM_EXEC" "$ASSET_DIR/wasm_exec.js"

echo "Built Yaegi js/wasm using $(go version) -> $ASSET_DIR/yaegi.wasm.gz"
