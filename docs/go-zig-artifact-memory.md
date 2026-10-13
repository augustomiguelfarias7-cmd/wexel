# Go/Zig artifacts and Memory64 separation

## Ownership boundary

Wexel's experimental Memory64 core owns its own linear memory. Memory64 is WebAssembly's 64-bit memory-index feature. Wexel's experimental Memory64 core has a configured 16 GiB maximum linear memory; that memory is for the core's allocator and VFS, not a storage container for every WebAssembly artifact used by the runtime.

Keep these resources separate:

- **Memory64 Memory64 core:** stores VFS file contents and filesystem metadata through its allocator, subject to the actual runtime's Memory64 support and host resource limits.
- **Go interpreter artifact:** a separately loaded WebAssembly module, responsible for interpreting Go source. The selected first candidate is Yaegi.
- **Zig compiler artifact:** a separately loaded WebAssembly module, responsible for compiling Zig source. Zig is a compiler integration, not a source interpreter.
- **Host adapter:** connects the VFS to the appropriate artifact and returns stdout, stderr, and the exit status.

The .wasm artifact bytes must not be written into the Memory64 core's VFS or copied into Memory64's linear memory as a way to store the tool. The host/runtime may keep the artifact bytes in host-managed storage and instantiate the module separately.

## What happens when source runs

1. The user writes /home/main.go or /home/main.zig into the Wexel VFS.
2. Wexel reads the source from the VFS.
3. The host adapter passes the source to the separately instantiated language tool. Any copy into the tool's own memory is input for that invocation, not storage of the artifact inside Memory64.
4. Yaegi interprets Go source, while the Zig compiler compiles Zig source.
5. The adapter returns output and exit status to Wexel.

The exact data-transfer mechanism depends on each artifact's actual ABI. A browser-oriented Go WASM artifact using wasm_exec.js and syscall/js cannot be passed directly to the current Wexel Language Executor ABI v1 bridge unless a matching host adapter is implemented.

## Current implementation status

The Wexel Language Executor ABI v1 bridge exists, but real Go-interpreter and Zig-compiler artifacts have not yet been validated with it. The experimental Memory64 target is also documented as separate from the package's current default WASM32 core. Do not claim the 16 GiB Memory64 core or Go/Zig source execution is generally available in the default package until the respective integration and tests are complete.

See the validation report at docs/go-zig-wasm-validation.md for artifact research and build blockers.
