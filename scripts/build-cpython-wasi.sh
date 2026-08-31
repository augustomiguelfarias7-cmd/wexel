#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CPYTHON_DIR="$ROOT/vendor/cpython"
WASI_SDK_PATH="${WASI_SDK_PATH:-$ROOT/toolchains/wasi-sdk-34.0-x86_64-linux}"
WASMTIME_DIR="${WASMTIME_DIR:-$ROOT/toolchains/wasmtime}"

if [[ ! -d "$CPYTHON_DIR/.git" ]]; then
  mkdir -p "$ROOT/vendor"
  git clone --depth=1 --branch v3.14.7 https://github.com/python/cpython.git "$CPYTHON_DIR"
fi

export WASI_SDK_PATH
export PATH="$WASMTIME_DIR:$PATH"
export WASMTIME="${WASMTIME:-$WASMTIME_DIR/wasmtime}"

cd "$CPYTHON_DIR"
python3 Tools/wasm/wasi build --quiet -- --config-cache

DEST="$ROOT/packages/wexel/assets/cpython-3.14.7"
mkdir -p "$DEST"
cp cross-build/wasm32-wasip1/python.wasm "$DEST/python.wasm"
cp cross-build/wasm32-wasip1/python.sh "$DEST/python.sh"
rm -rf "$DEST/Lib"
cp -a Lib "$DEST/Lib"
find "$DEST/Lib" -type d -name __pycache__ -prune -exec rm -rf {} +
mkdir -p "$DEST/Lib/site-packages"
unzip -q -o "$DEST/Lib/ensurepip/_bundled/"*.whl -d "$DEST/Lib/site-packages"

echo "CPython 3.14.7 WASI integrado em $DEST"
