# Wexel Core Memory64 VFS

This is an experimental Memory64 core target for Wexel. It deliberately separates WebAssembly memory management from filesystem behavior.

## Modules

- `src/wasm64_memory.cpp` owns the linear-memory limit, growth, and arena allocation.
- `src/wasm64_vfs.cpp` owns the hierarchical VFS and requests memory through the manager's exported allocator.
- `tools/build-memory64.sh` builds both modules and links them into one WebAssembly artifact.
- `tools/test-memory64.mjs` instantiates that artifact in a Memory64-capable Node.js runtime and exercises directories, file I/O, and growth.

## Build and test

Run these commands from this directory:

```sh
./tools/build-memory64.sh
node --experimental-wasm-memory64 tools/test-memory64.mjs
```

Requirements: Clang/LLVM with `wasm64-unknown-unknown`, `wasm-ld` with Memory64 support, Python 3, and a Node.js build/runtime that supports the experimental Memory64 feature.

## Memory and filesystem behavior

- Compiled maximum: 16 GiB of WebAssembly linear memory.
- Initial memory: 16 MiB. The maximum is not reserved or filled at startup.
- The VFS logical quota may be configured up to 16 GiB, but metadata and allocator overhead also use linear memory.
- Root (`/`) exists implicitly. New directories require an existing parent. Listing returns immediate child names. Only empty directories can be removed.
- Paths are absolute and normalized; this is a Linux-like hierarchy, not full POSIX/Linux filesystem compatibility.
- The arena allocator does not reclaim physical linear-memory space when files are overwritten or removed. Logical quota accounting is updated, but repeated writes may consume more physical linear memory than the live file contents.
- The test grows linear memory to 16 GiB and verifies a small file survives that growth. It does not fill 16 GiB with file data and does not prove the host has 16 GiB of free physical RAM.

## Integration status

This target is separate from the existing WASM32 `src/core.wat` artifact. The default Wexel package/runtime does not switch to this target automatically yet. Integration requires a Memory64-capable runtime path and host ABI wiring for both Wexel Browser and Wexel NodeExecution.
