# Go and Zig execution in Wexel 4.0

Wexel bundles WebAssembly toolchains for both languages. They are loaded lazily on first use; no native Go or Zig compiler is needed by the application at runtime.

## Go: Yaegi interpreter compiled to WebAssembly

The bundled Go artifact is the [Yaegi](https://github.com/traefik/yaegi) interpreter (v0.16.1) compiled for `GOOS=js GOARCH=wasm`. A small Wexel wrapper exposes an isolated `run(source)` API. Wexel reads the Go source from its VFS, Yaegi interprets it, and the result includes captured stdout/stderr and an exit status.

```ts
runtime.fs.write("/home/main.go", `package main
import "fmt"
func main() { fmt.Println("Hello from interpreted Go") }
`);
const result = await runtime.exec({ language: "go", file: "/home/main.go" });
console.log(result.stdout, result.stderr, result.exitCode);
```

**Compatibility note:** Yaegi is a third-party Go interpreter, not the official Go compiler and not an interpreter maintained by the Go project. It interprets supported Go constructs; it does not compile arbitrary Go source into a native Go WebAssembly executable. Programs that require unsupported language/runtime features may not work.

## Zig: Zig compiler compiled to WebAssembly

The bundled compiler is `zig-wasm/zigc-wasm` v0.11.0 with its matching `std.zip`. Wexel runs the compiler module under a WASI host, compiles `.zig` source to **`wasm32-wasi`**, writes the generated `.wasm` next to the source in the Memory64-backed VFS, then executes the generated module through WASI.

```ts
runtime.fs.write("/home/main.zig", `
const std = @import("std");
pub fn main() !void {
    std.debug.print("Hello from Zig\\n", .{});
}
`);

// Compile only; the generated path is /home/main.wasm by default.
const artifactPath = await runtime.compileZig("/home/main.zig");

// The regular execution path compiles and runs the file in one call.
const result = await runtime.exec({ language: "zig", file: "/home/main.zig" });
console.log(artifactPath, result.stdout, result.stderr, result.exitCode);
```

The produced WASI program receives command-line arguments and can write to stdout/stderr. The current execution host does not preopen the guest program's filesystem. The compiler's own short-lived input/stdlib files are hosted in the WASI shim; the user source and generated `.wasm` remain in the Wexel VFS.

## Core and artifact boundary

The Memory64 core continues to own the Wexel VFS: file names, directory records, source files and generated Zig modules are stored in its linear memory. The 16 GiB value is a configured **linear-memory address-space ceiling**, not reserved physical PC RAM. Yaegi and the Zig compiler are separate WASM modules, loaded on demand; neither is part of the core itself.

A custom executor can still override the bundled path by supplying `goExecutorBytes` or `zigExecutorBytes` to `Wexel.create()`. Artifacts implementing the Wexel Language Executor ABI v1 remain supported. The default bundled tools use Yaegi and Zig's WASI compiler rather than requiring that custom ABI.

## Rebuilding bundled assets

```sh
./toolchains/go-yaegi/build.sh
./toolchains/build-zig-wasm.sh
npm run build
```

The Go wrapper and module lock are in `toolchains/go-yaegi/`. The Zig rebuild script pins the v0.11.0 release and checks the compiler and standard-library SHA-256 hashes. Third-party notices/licenses accompany the assets and wrapper sources.
