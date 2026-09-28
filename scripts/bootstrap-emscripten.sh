#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOLS="$ROOT/toolchains/emscripten"
EMSDK_VERSION="6.0.10"
EMSDK_REPO="https://github.com/emscripten-core/emsdk.git"

mkdir -p "$(dirname "$TOOLS")"
if [ ! -d "$TOOLS/.git" ]; then
  git clone --depth 1 --branch "$EMSDK_VERSION" "$EMSDK_REPO" "$TOOLS"
fi

cd "$TOOLS"
./emsdk install "$EMSDK_VERSION"
./emsdk activate "$EMSDK_VERSION"

echo "Emscripten $EMSDK_VERSION está pronto."
echo "Ative com: source $TOOLS/emsdk_env.sh"
echo "Depois rode: bash $ROOT/scripts/build-multic-runtimes.sh"
