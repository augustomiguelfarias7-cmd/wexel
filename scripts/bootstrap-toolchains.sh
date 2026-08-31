#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOLS="$ROOT/toolchains"
mkdir -p "$TOOLS"

WASI_VERSION="34.0"
WASI_ARCHIVE="wasi-sdk-34.0-x86_64-linux.tar.gz"
WASI_SHA256="b761e3a0721dbae9c09a0059e5fdb2bf917d1b4a8a7b430fb3b5aafb0984b2c4"
WASI_URL="https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-34/$WASI_ARCHIVE"

WASMTIME_VERSION="v48.0.1"
WASMTIME_ARCHIVE="wasmtime-v48.0.1-x86_64-linux.tar.xz"
WASMTIME_SHA256="4c2e31b68ad99e0a519f225a261fda099eb15f056d4a24fdb3c2a46517bde1df"
WASMTIME_URL="https://github.com/bytecodealliance/wasmtime/releases/download/$WASMTIME_VERSION/$WASMTIME_ARCHIVE"

fetch_verify() {
  local url="$1" file="$2" expected="$3"
  curl -fL --retry 3 --output "$file" "$url"
  echo "$expected  $file" | sha256sum -c -
}

fetch_verify "$WASI_URL" "$TOOLS/$WASI_ARCHIVE" "$WASI_SHA256"
tar -xzf "$TOOLS/$WASI_ARCHIVE" -C "$TOOLS"

mkdir -p "$TOOLS/wasmtime"
fetch_verify "$WASMTIME_URL" "$TOOLS/wasmtime/$WASMTIME_ARCHIVE" "$WASMTIME_SHA256"
tar -xJf "$TOOLS/wasmtime/$WASMTIME_ARCHIVE" --strip-components=1 -C "$TOOLS/wasmtime"
chmod +x "$TOOLS/wasmtime/wasmtime"

echo "Toolchains disponíveis em $TOOLS"
