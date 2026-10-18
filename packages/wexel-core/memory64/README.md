# Wexel Core Memory64 allocator

The Memory64 Core provides the WebAssembly linear-memory allocator used by the TypeScript VFS.

## Architecture

- `src/wasm64_memory.cpp` owns the 64-bit linear-memory limit, growth, and a 16-byte-aligned free-list allocator with block splitting/coalescing.
- `tools/build-memory64.sh` compiles only the allocator into the `.wasm` artifact. VFS path normalization, directory metadata, listings, and quota accounting are handled by `packages/wexel/src/filesystem.ts` in TypeScript.
- `WexelMemory64FileSystem` stores file payload bytes in the Core's linear memory; its path and directory metadata live in TypeScript data structures. The logical quota is a cap, not memory reserved at startup.

## Build and test

From this directory:

```sh
CLANGXX=clang++ WASM_LD=wasm-ld bash tools/build-memory64.sh
node --experimental-wasm-memory64 tools/test-memory64.mjs
```

Requirements: Clang/LLVM and LLD with `wasm64-unknown-unknown`/Memory64 support, Python 3 for the compatibility post-processing helper, and a runtime with Memory64 support. Node.js 22 may require `--experimental-wasm-memory64`.

## Memory behavior

- Compiled maximum: 16 GiB of WebAssembly linear-memory address space; initial memory is 16 MiB. The maximum is not pre-reserved and is not a measurement or cap of physical host RAM.
- Default logical VFS file-payload quota: **5 GiB**. This quota does not allocate 5 GiB up front. Actual payload writes consume Core linear memory on demand, plus allocator overhead, and can fail before the logical quota is reached if the runtime cannot grow/allocate more memory.
- Replaced and removed payload allocations can be reused. WebAssembly linear memory does not shrink after growth.
- The test validates 64-bit pointers, allocator reuse, and growth to 16 GiB. It does not write 16 GiB of file contents.

This is a Linux-like virtual filesystem interface, not full POSIX compatibility.