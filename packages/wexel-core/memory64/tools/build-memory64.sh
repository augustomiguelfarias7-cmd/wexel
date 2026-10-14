#!/usr/bin/env bash
set -euo pipefail

CLANGXX="${CLANGXX:-clang++}"
WASM_LD="${WASM_LD:-wasm-ld}"
OUT_DIR="${OUT_DIR:-build-memory64}"
mkdir -p "$OUT_DIR"

COMMON=(--target=wasm64-unknown-unknown -O2 -nostdlib -fno-exceptions -fno-rtti -fno-threadsafe-statics)
"$CLANGXX" "${COMMON[@]}" -c src/wasm64_memory.cpp -o "$OUT_DIR/wasm64_memory.o"
"$CLANGXX" "${COMMON[@]}" -c src/vfs-memory64.cpp -o "$OUT_DIR/vfs-memory64.o"

"$WASM_LD" -mwasm64 --no-entry --export-memory \
  --export=wexel_memory64_pointer_bits \
  --export=wexel_memory64_set_limit \
  --export=wexel_memory64_limit_bytes \
  --export=wexel_memory64_size_bytes \
  --export=wexel_memory64_grow \
  --export=wexel_memory64_alloc \
  --export=wexel_memory64_free \
  --export=wexel_vfs_init \
  --export=wexel_vfs_mkdir \
  --export=wexel_vfs_rmdir \
  --export=wexel_vfs_path_exists \
  --export=wexel_vfs_is_directory \
  --export=wexel_vfs_file_size \
  --export=wexel_vfs_write \
  --export=wexel_vfs_read \
  --export=wexel_vfs_remove \
  --export=wexel_vfs_remove_tree \
  --export=wexel_vfs_list_size \
  --export=wexel_vfs_list \
  --export=wexel_vfs_bytes_used \
  --export=wexel_vfs_quota_bytes \
  --export=wexel_vfs_file_count \
  --export=wexel_vfs_directory_count \
  --export=wexel_memory_bytes \
  --initial-memory=16777216 \
  --max-memory=17179869184 \
  --features=memory64,mutable-globals,reference-types,multivalue,sign-ext \
  "$OUT_DIR/wasm64_memory.o" "$OUT_DIR/vfs-memory64.o" -o "$OUT_DIR/wexel-core-memory64.wasm"

python3 tools/strip-unused-table.py "$OUT_DIR/wexel-core-memory64.wasm" "$OUT_DIR/wexel-core-memory64.wasm.compat.tmp"
mv "$OUT_DIR/wexel-core-memory64.wasm.compat.tmp" "$OUT_DIR/wexel-core-memory64.wasm"
echo "Created $OUT_DIR/wexel-core-memory64.wasm"
echo "Run a real Memory64 test with: node --experimental-wasm-memory64 tools/test-memory64.mjs"
