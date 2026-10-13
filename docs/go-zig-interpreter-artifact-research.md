# Go and Zig interpreter/compiler artifact research

This note records upstream artifact candidates evaluated for Wexel. It does not claim that either binary has been bundled or that end-to-end source execution is already working.

## Go: Yaegi

- Upstream interpreter: https://github.com/traefik/yaegi
- Browser/WASM wrapper source: https://github.com/Muhammad-Ayman/yaegi-wasm
- License of the wrapper project: Apache-2.0; Yaegi is also Apache-2.0.
- The wrapper repository contains Go source and build instructions, but its repository tree does not contain a prebuilt `yaegi.wasm` release asset. Its documented build requires downloading the Yaegi Go module and compiling the wrapper with `GOOS=js GOARCH=wasm`.
- I attempted that build in the available environment. It failed before compilation because the environment could not resolve `proxy.golang.org`; no Go interpreter WASM artifact was produced.

Important integration boundary: the published wrapper exposes a JavaScript API through Go's `syscall/js` and `wasm_exec.js`. It does not implement Wexel Language Executor ABI v1. It must be integrated through a dedicated Go-WASM host adapter or rebuilt as an executor that implements Wexel's ABI; passing it directly as `goExecutorBytes` would be incorrect.

Yaegi is an interpreter and may have compatibility limitations; it is not equivalent to the official Go compiler.

## Zig: compiler compiled to WebAssembly

- Upstream project: https://github.com/zig-wasm/zigc-wasm
- Release: https://github.com/zig-wasm/zigc-wasm/releases/tag/v0.11.0
- The release publishes `zig_small_strip.wasm` (5,018,805 bytes) and `std.zip` (2,871,033 bytes). It also publishes larger variants.
- The companion `wasi-zigc` project documents the WASI shim needed to run this compiler: https://github.com/zig-wasm/wasi-zigc
- This is a Zig compiler built for WASM, not a Zig-language interpreter. The documented compiler targets an older Zig toolchain (0.11-era flags) and expects the matching standard library archive and a WASI filesystem shim.

Important integration boundary: `zig_small_strip.wasm` is a compiler executable with WASI imports, not a Wexel Language Executor ABI v1 module. It cannot be passed directly as `zigExecutorBytes`. Wexel needs a dedicated compiler adapter that maps VFS source files into the WASI filesystem, runs compilation, collects the resulting program artifact, then executes that program with a compatible WASI host.

## Decision

Do not label either candidate as an already-working Wexel executor. The next implementation step is to add dedicated adapters for the actual upstream interfaces and pin artifact versions and checksums. No GitHub Actions Workflow is required or proposed here.
