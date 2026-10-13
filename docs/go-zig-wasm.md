# Go and Zig source execution inside Wexel

Go and Zig are routed through Wexel's language-executor layer. The preferred path is the Wexel Language Executor ABI v1. A legacy adapter path also accepts the classic Yaegi (js/wasm) artifact and the public zigc-wasm compiler.

## Runtime API

Create the source file in the Wexel VFS, then execute that file through its language executor:

```ts
import { Wexel } from "wexel";

const runtime = await Wexel.create({
  goExecutorBytes,  // ABI v1 preferred, or legacy Yaegi js/wasm artifact
  zigExecutorBytes, // ABI v1 preferred, or legacy zigc-wasm compiler
});

runtime.fs.write("/home/main.go", `package main
import "fmt"
func main() { fmt.Println("Hello from Go inside Wexel") }`);

runtime.fs.write("/home/main.zig", `const std = @import("std");
pub fn main() void { std.debug.print("Hello from Zig inside Wexel\\n", .{}); }`);

const goResult = await runtime.exec({ language: "go", file: "/home/main.go" });
const zigResult = await runtime.exec({ language: "zig", file: "/home/main.zig" });

console.log(goResult.stdout, goResult.stderr, goResult.exitCode);
console.log(zigResult.stdout, zigResult.stderr, zigResult.exitCode);
```

The source is read from the runtime VFS. The selected executor receives the source bytes, virtual path, and JSON-encoded arguments, and returns standard output, standard error, and an exit code. The API does not copy source files to the host filesystem or spawn a host compiler.

## Wexel Language Executor ABI v1 (preferred)

Each language executor is a WebAssembly artifact configured with `goExecutorBytes` or `zigExecutorBytes`. It must export:

- `memory`: WebAssembly memory shared by the ABI calls.
- `wexel_executor_abi_version() -> i32`: returns `1`.
- `wexel_executor_alloc(length: i32) -> i32`: allocates a byte range and returns its pointer.
- `wexel_executor_run(sourcePtr, sourceLength, filePathPtr, filePathLength, argsPtr, argsLength) -> void`: compiles/interprets and runs the source. Arguments are UTF-8; `argsPtr` points to a JSON array of strings.
- `wexel_executor_stdout_ptr() -> i32` and `wexel_executor_stdout_len() -> i32`.
- `wexel_executor_stderr_ptr() -> i32` and `wexel_executor_stderr_len() -> i32`.
- `wexel_executor_exit_code() -> i32`.

The stdout/stderr pointers refer to UTF-8 output buffers in the exported memory. The executor must preserve those buffers until the host has read them after `wexel_executor_run` returns.

## Legacy adapters (current practical path)

`language-executors.ts` now accepts two well-known legacy artifacts without requiring a full ABI-v1 recompile:

### Go – Yaegi (js/wasm)

- Artifact: Yaegi compiled with `GOOS=js GOARCH=wasm` (classic wrapper that exposes `yaegiEval`).
- The loader detects the absence of ABI v1 exports and switches to the **legacy-yaegi** mode.
- For the adapter to become ready, the host must still load the Go JS runtime (`wasm_exec.js`) and make `globalThis.yaegiEval` available before calling `runtime.exec`.
- Once ready, source files from the VFS are passed to the interpreter.

### Zig – zigc-wasm

- Artifact: public `zig_small_strip.wasm` (or larger variants) from zig-wasm/zigc-wasm + matching `std.zip`.
- The loader switches to **legacy-zigc** mode.
- Full compilation still needs a WASI host with preopened directories for the source file and the standard library. The current adapter registers the artifact and returns a clear diagnostic until the WASI shim is completed.

## Important implementation boundary

The host-side bridge lives in `packages/wexel/src/language-executors.ts`. ABI v1 remains the clean long-term contract. The legacy adapters exist so the already-built Yaegi and zigc-wasm binaries can be used immediately while true ABI-v1 executors are prepared.

No GitHub Actions Workflow is required.
