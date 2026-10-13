#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ $# -lt 2 ]]; then
  echo "Usage: $0 <go|zig> <source-file> [program args...]" >&2
  exit 2
fi
LANGUAGE="$1"
SOURCE="$2"
shift 2
if [[ ! -f "$SOURCE" ]]; then
  echo "Source file not found: $SOURCE" >&2
  exit 2
fi
SOURCE="$(cd "$(dirname "$SOURCE")" && pwd)/$(basename "$SOURCE")"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

case "$LANGUAGE" in
  go)
    command -v go >/dev/null 2>&1 || { echo "Go toolchain is required to compile .go source." >&2; exit 1; }
    GOOS=js GOARCH=wasm go build -trimpath -o "$TMP/program.wasm" "$SOURCE"
    node "$ROOT/scripts/run-go-wasm.mjs" "$TMP/program.wasm" "$@"
    ;;
  zig)
    command -v zig >/dev/null 2>&1 || { echo "Zig toolchain is required to compile .zig source." >&2; exit 1; }
    zig build-exe "$SOURCE" -target wasm32-wasi -O ReleaseSmall -femit-bin="$TMP/program.wasm"
    node "$ROOT/scripts/run-wasi-wasm.mjs" "$TMP/program.wasm" "$@"
    ;;
  *)
    echo "Unsupported language: $LANGUAGE (expected go or zig)" >&2
    exit 2
    ;;
esac
