#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="wasm32-wasip1"
DEST="$ROOT/packages/wexel/assets/native"

mkdir -p "$DEST"
if ! rustc --print target-libdir --target "$TARGET" >/dev/null 2>&1; then
  echo "O alvo $TARGET não está instalado nesta toolchain Rust." >&2
  exit 1
fi

cargo build --manifest-path "$ROOT/native/rustv/Cargo.toml" --release --target "$TARGET"
cp "$ROOT/native/rustv/target/$TARGET/release/rustv.wasm" "$DEST/rustv.wasm"
echo "RustV WASM criado em $DEST/rustv.wasm"
