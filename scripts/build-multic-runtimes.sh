#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/packages/wexel/assets/multic"
mkdir -p "$DEST"

CC="${WEXEL_CLANG:-clang}"
CXX="${WEXEL_CLANGXX:-clang++}"
TARGET="wasm32"

command -v "$CC" >/dev/null 2>&1 || { echo "Clang não encontrado: $CC" >&2; exit 1; }
command -v "$CXX" >/dev/null 2>&1 || { echo "Clang++ não encontrado: $CXX" >&2; exit 1; }

COMMON=("--target=$TARGET" "-O2" "-ffreestanding" "-nostdlib" "-Wl,--no-entry")

"$CC" "$ROOT/runtimes/c-runtime/main.c" "${COMMON[@]}" \
  "-Wl,--export=wexel_c_runtime_abi_version" \
  "-Wl,--export=wexel_c_runtime_language" \
  "-Wl,--export=wexel_c_runtime_add" \
  "-Wl,--export=wexel_c_vfs_checksum" \
  -o "$DEST/c-runtime.wasm"

"$CXX" "$ROOT/runtimes/cpp-runtime/main.cpp" "${COMMON[@]}" \
  "-Wl,--export=wexel_cpp_runtime_abi_version" \
  "-Wl,--export=wexel_cpp_runtime_language" \
  "-Wl,--export=wexel_cpp_runtime_add" \
  "-Wl,--export=wexel_cpp_vfs_checksum" \
  -o "$DEST/cpp-runtime.wasm"

cat > "$DEST/manifest.json" <<MANIFEST
{
  "abiVersion": 2,
  "backend": "clang-wasm32",
  "c": "c-runtime.wasm",
  "cpp": "cpp-runtime.wasm"
}
MANIFEST

echo "MultiC runtimes gerados em $DEST usando Clang/Clang++."
