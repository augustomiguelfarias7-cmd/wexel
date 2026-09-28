#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/packages/wexel/assets/multic"
mkdir -p "$DEST"

command -v emcc >/dev/null 2>&1 || { echo "Emscripten (emcc) não encontrado. Rode scripts/bootstrap-emscripten.sh primeiro." >&2; exit 1; }
command -v em++ >/dev/null 2>&1 || { echo "Emscripten (em++) não encontrado. Rode scripts/bootstrap-emscripten.sh primeiro." >&2; exit 1; }

COMMON=("-O2" "-s" "STANDALONE_WASM=1" "-s" "ERROR_ON_UNDEFINED_SYMBOLS=0" "--no-entry")
emcc "$ROOT/runtimes/c-runtime/main.c" "${COMMON[@]}" "-s" "EXPORTED_FUNCTIONS=['_wexel_c_runtime_abi_version','_wexel_c_runtime_language']" -o "$DEST/c-runtime.wasm"
em++ "$ROOT/runtimes/cpp-runtime/main.cpp" "${COMMON[@]}" "-s" "EXPORTED_FUNCTIONS=['_wexel_cpp_runtime_abi_version','_wexel_cpp_runtime_language']" -o "$DEST/cpp-runtime.wasm"

cat > "$DEST/manifest.json" <<MANIFEST
{
  "abiVersion": 1,
  "c": "c-runtime.wasm",
  "cpp": "cpp-runtime.wasm"
}
MANIFEST

echo "MultiC runtimes gerados em $DEST"
