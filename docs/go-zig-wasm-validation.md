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

### Go: Yaegi interpreter WASM — BLOCKED after retries

The public `yaegi-wasm` repository provides wrapper source, not a prebuilt `yaegi.wasm` release asset. Its browser wrapper exposes `window.yaegi.eval(source)` through Go's `syscall/js`; it does not implement Wexel Language Executor ABI v1.

Retried the build with the correct browser target, `GOOS=js GOARCH=wasm`. It could not resolve the Yaegi dependency because the required module checksum/dependency was not cached. Tried the alternate Go module proxy `goproxy.cn`; DNS/network access is unavailable. A separate `GOOS=wasip1` attempt is not compatible with this browser wrapper because `syscall/js` is excluded for WASI. No Yaegi interpreter artifact was produced, so arbitrary Go source interpretation remains untested.

A separate technical approach is to write a small WASI command wrapper around Yaegi that reads source from argv/stdin. That would be a different artifact and would still need the Yaegi module dependencies and a working WASI host adapter.

### Zig interpreter/compiler — BLOCKED

No general-purpose, ready-made Zig-language interpreter WASM artifact was found in the evaluated public sources. Zig's official language overview describes Zig as a compiled language and notes that a third-party interpreter would be a future possibility. The available `zigc-wasm` v0.11.0 release is a **compiler built to run as WebAssembly**, not an interpreter for Zig source and not a Wexel executor.

The release metadata lists a WASM compiler and a separate standard-library archive. An attempt to download the public compiler artifact failed because DNS/network access to `github.com` is unavailable. Zig is not installed in this environment, and no Zig compiler artifact was available locally. Therefore, neither Zig source compilation nor execution was tested.

### WebAssembly's native API is not a Go/Zig interpreter

The WebAssembly JavaScript/Web APIs compile, validate, instantiate, and run `.wasm` modules. They do not parse arbitrary `.go` or `.zig` source files. The runtime can execute a Go interpreter or Zig compiler *if that tool itself has been compiled to WASM*, but it does not provide those language tools automatically.

## ABI status

Wexel already contains a host-side Language Executor ABI v1 bridge in `packages/wexel/src/language-executors.ts`, with VFS-based dispatch in `packages/wexel/src/index.ts`. The ABI is a Wexel-defined contract; it is **not** an ABI that the upstream Yaegi wrapper or Zig compiler automatically exports.

The bridge has not been validated end-to-end with actual Go-interpreter and Zig-compiler artifacts. Do not pass a regular Go program WASM, Go's `wasm_exec.js`, or the upstream Zig compiler directly as `goExecutorBytes` / `zigExecutorBytes`: their interfaces and responsibilities differ.

## Next integration steps

1. Obtain a trusted, version-pinned Yaegi WASM artifact or build it in an environment with dependency access.
2. Add a dedicated Go-WASM host adapter for the wrapper's actual API, or build a compatible executor that implements Wexel ABI v1.
3. For Zig, either use the public Zig compiler built for WASM with its matching standard library and WASI filesystem/process adapter, or find/build a genuine Zig-language interpreter. These are different designs.
4. Add integration tests that run a simple `.go` and `.zig` source file through `runtime.exec` and assert stdout, stderr, and exit status.
5. Only mark source execution as supported after those tests pass.

No GitHub Actions workflow is needed for these steps, and none is proposed here.


## Follow-up attempt and agreed architecture (2026-10-13)

The Yaegi module download was retried against these Go module proxies: `proxy.golang.org`, `goproxy.io`, `proxy.golang.com.cn`, `mirrors.aliyun.com/goproxy`, and `goproxy.cn`. Each attempt failed during DNS resolution in this execution environment, before the module archive could be downloaded. A GitHub source-archive download also failed. The local module cache contains only a lock file for Yaegi v0.16.1, not the source/module archive, so an offline build cannot proceed from the current cache.

The selected design is now explicit:

- **Go:** Yaegi is the first candidate and must interpret source code. A precompiled Go sample does not meet this requirement. The browser wrapper using `syscall/js` cannot simply be relabeled as a WASI artifact; a WASI-specific wrapper and matching Wexel host adapter may be needed.
- **Zig:** use a Zig compiler compiled to WebAssembly, with the matching standard library and a compatible filesystem/process adapter. This is compilation, not source interpretation.
- **Wexel integration:** preserve the VFS-first user flow. Do not claim end-to-end support until actual artifacts have been built and tests pass.
- **Build policy:** no GitHub Actions workflow is required or proposed.

Current blocker: external dependency/artifact downloads are unavailable in this environment. The next practical build attempt requires a connected build environment or a trusted copy of the pinned dependency source; no Yaegi WASM artifact has been produced yet.
