# Go and Zig WebAssembly execution

Wexel keeps the Go and Zig examples as separate WebAssembly artifacts. The source code is compiled to WASM first, and Wexel's execution path runs the resulting artifact. End users do not need to clone the Go or Zig source repositories.

## Build-time requirements

The compiler is required only when compiling source code:

- Go 1.23.x for the Go `js/wasm` target.
- Zig 0.14.1 for the Zig `wasm32-wasi` target.
- Node.js 22 to run the smoke-test artifacts in this repository.

These are compiler toolchains, not the upstream Go or Zig source repositories. The resulting artifacts are independent `.wasm` files.

## Build both artifacts

From the repository root:

```sh
./scripts/build-go-zig-wasm.sh
```

Outputs:

- `dist/languages/go/hello.wasm`: Go compiled for `GOOS=js GOARCH=wasm`.
- `dist/languages/go/wasm_exec.js`: the official Go JavaScript runtime copied from the installed Go distribution.
- `dist/languages/zig/hello.wasm`: Zig compiled for `wasm32-wasi`.

## Execute the artifacts

```sh
node scripts/run-go-wasm.mjs dist/languages/go/hello.wasm
node scripts/run-wasi-wasm.mjs dist/languages/zig/hello.wasm
```

The Go artifact uses Go's official `wasm_exec.js` runtime. The Zig artifact uses Node.js's WASI Preview 1 host. The two artifacts are separate because their ABI and runtime requirements differ.

The GitHub Actions workflow `.github/workflows/go-zig-wasm-artifacts.yml` builds and executes both artifacts, then uploads them as the `wexel-go-zig-wasm` workflow artifact.

## Using the Wexel VFS for source files

Applications can keep source files such as `/home/user/main.go` and `/home/user/main.zig` in Wexel's VFS, including the experimental Memory64 VFS target. File creation/storage and compilation are separate concerns:

1. Write source bytes to the VFS.
2. Provide those bytes to a configured Go or Zig compiler during the build/compile stage.
3. Produce a WASM artifact.
4. Execute the artifact using the matching Go or WASI runtime adapter.

**Important integration boundary:** the files in this change prove that Go and Zig programs can be compiled to separate WASM artifacts and those artifacts can be executed. They do not embed the complete Go or Zig compiler inside WebAssembly, and they do not yet add a `runtime.exec({ language: "go" | "zig", code })` API that compiles arbitrary source stored in the VFS automatically. That requires an explicit compiler provisioning strategy and a VFS-to-compiler bridge. The Node.js WASI runner is for NodeExecution; a browser WASI host needs its own compatible WASI implementation.
