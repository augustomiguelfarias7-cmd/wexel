#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ASSET_DIR="$ROOT/packages/wexel/assets/toolchains/zig"
RELEASE="https://github.com/zig-wasm/zigc-wasm/releases/download/v0.11.0"
LICENSE_URL="https://raw.githubusercontent.com/zig-wasm/zigc-wasm/main/LICENSE"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$ASSET_DIR"

curl -fL "$RELEASE/zig_small_strip.wasm" -o "$TMP/zigc.wasm"
curl -fL "$RELEASE/std.zip" -o "$ASSET_DIR/std.zip"
curl -fL "$LICENSE_URL" -o "$ASSET_DIR/UNLICENSE"
echo "cbfc172100b07beee2710c837b7ed0fe2e456fb10c00aa7ff5e618db949adf61  $TMP/zigc.wasm" | sha256sum -c -
echo "9b5b9243d511efe1adc4f1081c2fbcc7b0df6caa4d3f6d4099d7c392d2f5b59d  $ASSET_DIR/std.zip" | sha256sum -c -
gzip -9 -n -c "$TMP/zigc.wasm" > "$ASSET_DIR/zigc.wasm.gz"
echo "Installed zigc-wasm v0.11.0 and matching stdlib -> $ASSET_DIR"
