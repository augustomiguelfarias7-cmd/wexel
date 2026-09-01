#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EMSDK_ROOT="${EMSDK_ROOT:-}"
if [[ -n "$EMSDK_ROOT" && -f "$EMSDK_ROOT/emsdk_env.sh" ]]; then
  # shellcheck disable=SC1090
  source "$EMSDK_ROOT/emsdk_env.sh"
fi
command -v em++ >/dev/null 2>&1 || { echo "em++ não encontrado; instale Emscripten para compilar a CLI." >&2; exit 1; }

DEST="$ROOT/packages/wexel/assets/native"
mkdir -p "$DEST"
em++ "$ROOT/native/wexel-cli/main.cpp" \
  -O3 -std=c++20 \
  -s STANDALONE_WASM=1 \
  -s ERROR_ON_UNDEFINED_SYMBOLS=0 \
  --no-entry \
  -Wl,--export=wexel_cli_abi_version \
  -Wl,--export=wexel_cli_add \
  -Wl,--export=wexel_cli_exit_code \
  -o "$DEST/wexel-cli.wasm"

echo "CLI C++ WASM criada em $DEST/wexel-cli.wasm"
