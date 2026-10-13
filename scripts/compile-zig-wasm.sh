#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 || $# -gt 3 ]]; then
  echo "Usage: $0 <source.zig> <output.wasm> [debug|release-small|release-fast|release-safe]" >&2
  exit 2
fi

SOURCE="$1"
OUTPUT="$2"
MODE="${3:-release-small}"
ZIG_BIN="${ZIG_BIN:-zig}"

if [[ ! -f "$SOURCE" ]]; then
  echo "Zig source file not found: $SOURCE" >&2
  exit 2
fi
if ! command -v "$ZIG_BIN" >/dev/null 2>&1; then
  echo "Zig compiler not found. Install Zig or set ZIG_BIN to its executable." >&2
  exit 1
fi

case "$MODE" in
  debug) OPT="-O" ; OPT_VALUE="Debug" ;;
  release-small) OPT="-O" ; OPT_VALUE="ReleaseSmall" ;;
  release-fast) OPT="-O" ; OPT_VALUE="ReleaseFast" ;;
  release-safe) OPT="-O" ; OPT_VALUE="ReleaseSafe" ;;
  *) echo "Unknown optimization mode: $MODE" >&2; exit 2 ;;
esac

mkdir -p "$(dirname "$OUTPUT")"
"$ZIG_BIN" build-exe "$SOURCE" -target wasm32-wasi "$OPT" "$OPT_VALUE" -femit-bin="$OUTPUT"
if [[ ! -s "$OUTPUT" ]]; then
  echo "Zig compiler returned without producing a non-empty artifact: $OUTPUT" >&2
  exit 1
fi
printf 'Compiled %s -> %s (target=wasm32-wasi, mode=%s)\n' "$SOURCE" "$OUTPUT" "$MODE"
