# Go and Zig source execution inside Wexel

Go and Zig are routed through Wexel's language-executor ABI, rather than being exposed as unrelated host-side compile scripts.

## Runtime API

Create the source file in the Wexel VFS, then execute that file through its language executor:

```ts
import { Wexel } from "wexel";

const runtime = await Wexel.create({
  goExecutorBytes,  // Go executor/compiler artifact, ABI v1
  zigExecutorBytes, // Zig executor/compiler artifact, ABI v1
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

## Wexel Language Executor ABI v1

Each language executor is a WebAssembly artifact configured with `goExecutorBytes` or `zigExecutorBytes`. It must export:

- `memory`: WebAssembly memory shared by the ABI calls.
- `wexel_executor_abi_version() -> i32`: returns `1`.
- `wexel_executor_alloc(length: i32) -> i32`: allocates a byte range and returns its pointer.
- `wexel_executor_run(sourcePtr, sourceLength, filePathPtr, filePathLength, argsPtr, argsLength) -> void`: compiles/interprets and runs the source. Arguments are UTF-8; `argsPtr` points to a JSON array of strings.
- `wexel_executor_stdout_ptr() -> i32` and `wexel_executor_stdout_len() -> i32`.
- `wexel_executor_stderr_ptr() -> i32` and `wexel_executor_stderr_len() -> i32`.
- `wexel_executor_exit_code() -> i32`.

The stdout/stderr pointers refer to UTF-8 output buffers in the exported memory. The executor must preserve those buffers until the host has read them after `wexel_executor_run` returns.

## Important implementation boundary

The host-side ABI bridge and VFS routing are implemented in `packages/wexel/src/language-executors.ts`. However, a real Go or Zig executor/compiler artifact implementing this ABI must be supplied through the options above. The ordinary Go `js/wasm` program artifact, Go's `wasm_exec.js`, and a normal Zig WASI program are **not** themselves ABI-v1 source compilers. They cannot accept arbitrary `.go` or `.zig` source files as input.

This distinction matters: the runtime now has the organized entry point and the contract for the language executor, but full out-of-the-box source execution is not complete until the actual Go and Zig executor artifacts are built and bundled. No GitHub Actions Workflow is involved.
