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


### Additional public Yaegi WASM artifact discovered (not yet integrated)

A second public project, `Aryan-Bagale/go-browser-interpreter`, commits a `main.wasm` binary (39,813,704 bytes) alongside its wrapper source and Go runtime glue. This is a real lead beyond a source-only recipe, but it is not a ready Wexel artifact: its documented interface is the browser-specific Go runtime plus `wasm_exec.js` and `syscall/js`, and its wrapper exposes a JavaScript `yaegi` object. It does not export Wexel Language Executor ABI v1. The repository has no GitHub Releases, and binary retrieval through this environment was not successful, so the binary has not been downloaded, inspected, checksum-verified, or run here. Do not bundle or trust it as a Wexel executor until the source, license, build provenance, and runtime adapter have been reviewed.

## Memory64 and artifact storage boundary

The configured 16 GiB belongs to the experimental Memory64 core's linear memory, used by its allocator and VFS for file contents and metadata. It is not where the Go interpreter or Zig compiler artifact must be stored. Language artifacts should be retained/loaded separately by the host runtime and instantiated as their own WebAssembly modules. When code runs, the VFS source can be passed as input to the relevant module; a copy into that module's own memory is not the same as storing the artifact in Memory64 linear memory.

The new architecture note is `docs/go-zig-artifact-memory.md`. This does not change the Memory64 integration status: the experimental Memory64 target is not yet the default package core.


## Deep retry record (2026-10-13, follow-up)

### Go / Yaegi

- Repeated direct downloads of `github.com/traefik/yaegi@v0.16.1` from `proxy.golang.org`, `goproxy.io`, `proxy.golang.com.cn`, `mirrors.aliyun.com/goproxy`, and `goproxy.cn` all failed with DNS resolution errors in the build environment.
- Retried the GitHub source archive URL; DNS resolution failed there too.
- An offline `GOOS=js GOARCH=wasm go build` attempt fails because the Yaegi module is not present in the local module cache and there are no `go.sum` entries.
- Found a public repository, `Aryan-Bagale/go-browser-interpreter`, that commits a 39,813,704-byte `main.wasm` using Yaegi. However, binary retrieval through the available GitHub connector failed because its binary blob cannot be decoded as UTF-8. It uses the browser-specific Go WASM host glue and does not implement Wexel Language Executor ABI v1. It has not been checksum-verified, executed, or approved for bundling.
- Successfully reran the existing small, precompiled Go sample with Node.js. Output: `Hello from Go compiled to WebAssembly inside Wexel` and `2 + 40 = 42`. This proves only that the existing precompiled sample runs; it does not prove arbitrary Go source interpretation.

### Zig compiler

- Confirmed the local environment has no `zig` executable and no Zig compiler WASM artifact in the local artifact kit.
- Public leads such as `zigc-wasm` describe a Zig compiler compiled to WebAssembly, but the GitHub endpoint redirects and the available transfer/build environment could not retrieve a usable compiler artifact.
- No Zig source was compiled in this retry. No Zig artifact is being published as if it were validated.

### Publication decision

No new executable language artifact is published in this retry, because neither the Yaegi binary nor the Zig compiler artifact could be downloaded, verified, and tested end-to-end. This avoids committing an unverified third-party binary or falsely marking the feature as complete. No GitHub Actions workflow was added. The Memory64 artifact-storage boundary remains documented separately in `docs/go-zig-artifact-memory.md`.
