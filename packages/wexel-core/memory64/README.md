# Wexel Core Memory64 VFS

This is the default WebAssembly core used by the Wexel runtime. It deliberately separates linear-memory ownership from the TypeScript filesystem adapter.

## Modules

- `src/wasm64_memory.cpp` owns the 64-bit linear-memory limit, growth, and a 16-byte-aligned free-list allocator with block splitting/coalescing.
- `src/vfs-memory64.cpp` owns a dynamic hierarchical VFS table; path and file buffers are stored in the core's linear memory and released/reused on overwrite or removal.
- `tools/build-memory64.sh` compiles both modules and links one Memory64 `.wasm` artifact.
- `tools/test-memory64.mjs` exercises the 64-bit ABI, block reuse, 700 directories (beyond the old 512-entry ceiling), quota/read/write/removal, and growth to the configured maximum.
- `../../wexel/src/filesystem.ts` contains `WexelMemory64FileSystem`, the TypeScript adapter used by default by `Wexel.create()`.

## Build and test

From the repository root:

```sh
npm run build
npm test
```

For a direct core build from this directory:

```sh
CLANGXX=clang++-19 WASM_LD=wasm-ld-19 bash tools/build-memory64.sh
node --experimental-wasm-memory64 tools/test-memory64.mjs
```

Requirements: Clang/LLVM and LLD with `wasm64-unknown-unknown`/Memory64 support, Python 3 for the binary post-processing helper, and a runtime with Memory64 support. In the validated Node.js 22.13 environment, the feature is experimental and requires `--experimental-wasm-memory64`.

## Memory and filesystem behavior

- Compiled maximum: 16 GiB of WebAssembly linear-memory address space; initial memory is 16 MiB and the maximum is not pre-reserved. This is not a cap on the host PC's RAM and does not reserve 16 GiB of physical RAM.
- Default logical file-payload quota: follows the core artifact's configured linear-memory limit (16 GiB by default); callers may configure a smaller quota up to that limit. Metadata and allocator overhead also consume linear memory, so the VFS may run out of allocatable memory before reaching the logical payload quota.
- Removed/overwritten allocations are reusable. The underlying WebAssembly memory does not shrink after it grows.
- Root (`/`) exists implicitly. The host adapter creates missing parent directories. The low-level VFS exports immediate-child names; the high-level `list()` returns descendants relative to the requested directory.
- Paths are UTF-8 absolute normalized paths; this is a Linux-like hierarchy, not full POSIX/Linux filesystem compatibility.
- The 16 GiB test verifies that the engine grows the linear memory to its configured ceiling and that small VFS data survives. It does not write 16 GiB of file content. Physical resource use depends on pages touched and the runtime/OS; the configured ceiling is neither a RAM reservation nor a PC-RAM limit.

## ABI boundary

The core manages its own VFS and memory. The host JavaScript WebAssembly engine instantiates and executes other WebAssembly modules. Compiler tools such as Go/Zig therefore need separate compiler adapters; they are not automatically Wexel Language Executor ABI v1 modules.
