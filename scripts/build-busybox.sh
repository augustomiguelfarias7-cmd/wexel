#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR="$ROOT/vendor/busybox-wasm"
if ! command -v emcc >/dev/null; then
  echo "Emscripten (emcc) é obrigatório para compilar o BusyBox WASM." >&2
  exit 1
fi
if [ ! -d "$VENDOR" ]; then
  gh repo clone mayflower/busybox-wasm "$VENDOR" -- --depth=1
fi
make -C "$VENDOR" -j2 build/wasm/busybox_unstripped.js
mkdir -p "$ROOT/packages/wexel/assets/busybox"
cp "$VENDOR/build/wasm/busybox_unstripped.js" "$ROOT/packages/wexel/assets/busybox/busybox.js"
cp "$VENDOR/build/wasm/busybox_unstripped.wasm" "$ROOT/packages/wexel/assets/busybox/busybox.wasm"
echo "BusyBox WASM copied to packages/wexel/assets/busybox"
emcc --version | head -1
