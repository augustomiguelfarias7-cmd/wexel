# Go/Zig WebAssembly validation report

Date: 2026-10-13

## Results

### Go: precompiled program runner — PASS

A precompiled Go program targeting `GOOS=js GOARCH=wasm` was executed with the Go `wasm_exec.js` runtime in Node.js. It printed:

```text
Hello from Go compiled to WebAssembly inside Wexel
2 + 40 = 42
```

This verifies that the sample Go program WASM module can run under the Go JavaScript/WASM host. It does **not** verify arbitrary Go source execution inside Wexel: the WASM file already contains the compiled program, and the runner requires the Go host runtime.

### Go: Yaegi interpreter WASM — BLOCKED

The public `yaegi-wasm` repository provides wrapper source, not a prebuilt `yaegi.wasm` release asset. Its wrapper exposes `window.yaegi.eval(source)` through Go's `syscall/js`; it does not implement Wexel Language Executor ABI v1.

An attempt to resolve the Yaegi module with `go mod tidy` failed because DNS/network access to `proxy.golang.org` is unavailable in this environment. No interpreter WASM artifact was produced, so source interpretation could not be tested.

### Zig WASM compiler — BLOCKED

The public `zigc-wasm` v0.11.0 release metadata lists a WASM compiler and a separate standard-library archive. The compiler is not a Zig interpreter and does not implement Wexel Language Executor ABI v1 directly.

An attempt to download the public compiler artifact failed because DNS/network access to `github.com` is unavailable. Zig is not installed in this environment, and no Zig artifact was available locally. Therefore, neither Zig source compilation nor execution was tested.

## ABI status

Wexel already contains a host-side Language Executor ABI v1 bridge in `packages/wexel/src/language-executors.ts`, with VFS-based dispatch in `packages/wexel/src/index.ts`. The ABI is a Wexel-defined contract; it is **not** an ABI that the upstream Yaegi wrapper or Zig compiler automatically exports.

The bridge has not been validated end-to-end with actual Go-interpreter and Zig-compiler artifacts. Do not pass a regular Go program WASM, Go's `wasm_exec.js`, or the upstream Zig compiler directly as `goExecutorBytes` / `zigExecutorBytes`: their interfaces and responsibilities differ.

## Next integration steps

1. Obtain a trusted, version-pinned Yaegi WASM artifact or build it in an environment with dependency access.
2. Add a dedicated Go-WASM host adapter for the wrapper's JavaScript API, or build a compatible executor that implements Wexel ABI v1.
3. Obtain `zig_small.wasm` and the matching `std.zip`; implement the required WASI filesystem/process adapter to compile VFS source and execute the generated module.
4. Add integration tests that run a simple `.go` and `.zig` source file through `runtime.exec` and assert stdout, stderr, and exit status.
5. Only mark source execution as supported after those tests pass.

No GitHub Actions workflow is needed for these steps, and none is proposed here.
