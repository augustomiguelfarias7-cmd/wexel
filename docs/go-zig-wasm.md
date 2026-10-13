# Go and Zig source execution inside Wexel

Go and Zig are routed through Wexel's language-executor layer. The preferred path is the Wexel Language Executor ABI v1. A legacy adapter path also accepts the classic Yaegi (js/wasm) artifact and the public zigc-wasm compiler.

## Runtime API

```ts
import { Wexel } from "wexel";

const runtime = await Wexel.create({
  goExecutorBytes,   // ABI v1 or legacy Yaegi
  zigExecutorBytes,  // ABI v1 or legacy zigc-wasm
});

runtime.fs.write("/home/main.go", `package main
import "fmt"
func main() { fmt.Println("Hello from Go inside Wexel") }`);

const goResult = await runtime.exec({ language: "go", file: "/home/main.go" });
console.log(goResult.stdout, goResult.stderr, goResult.exitCode);
```

## Wexel Language Executor ABI v1 (preferred)

The artifact must export `memory`, `wexel_executor_abi_version` (returns 1), `wexel_executor_alloc`, `wexel_executor_run`, and the stdout/stderr/exit_code helpers. See the previous version of this document for the full contract.

## Legacy adapters

### Go – Yaegi (self-bootstrapping)

Pass the Yaegi `js/wasm` artifact as `goExecutorBytes`.

The adapter tries, in order:

1. Reuse `globalThis.yaegiEval` if it already exists.
2. If you also supply the text of the official `wasm_exec.js` (via a future options extension or by making it available), the adapter evaluates it, creates a `Go` instance, instantiates the WASM and wires `yaegiEval` automatically.
3. If neither is possible it returns a clear error telling you what is missing.

**Goal:** the end-user of Wexel should only need to pass the bytes. The host library does the rest.

### Zig – zigc-wasm

The public `zig_small_strip.wasm` (+ `std.zip`) is accepted. Full compilation still requires a WASI host with preopens. The adapter registers the artifact and returns a diagnostic until the WASI shim is finished.

## Boundary

ABI v1 remains the clean long-term contract. The legacy path exists so the already-built Yaegi and zigc-wasm binaries can be used with minimal friction while true ABI-v1 executors are prepared.
