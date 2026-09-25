#!/usr/bin/env bash
# build-deno-runtime.sh — compila wexel-deno-runtime para WASM
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CRATE="$ROOT/rust/deno-runtime"
OUT="$ROOT/packages/wexel/assets"

echo "==> Compilando wexel-deno-runtime para wasm32-unknown-unknown..."

# Adiciona o target WASM se não tiver
rustup target add wasm32-unknown-unknown 2>/dev/null || true

cd "$CRATE"

# Compila em release para WASM
RUSTFLAGS="-C target-feature=+atomics,+bulk-memory,+mutable-globals" \
  cargo build \
    --target wasm32-unknown-unknown \
    --release \
    2>&1

WASM_SRC="$CRATE/target/wasm32-unknown-unknown/release/wexel_deno_runtime.wasm"

# Copia para assets
mkdir -p "$OUT"
cp "$WASM_SRC" "$OUT/deno-runtime.wasm"

SIZE=$(wc -c < "$OUT/deno-runtime.wasm")
echo "==> deno-runtime.wasm: $SIZE bytes"
echo "==> Copiado para $OUT/deno-runtime.wasm"
