# Novidades do Wexel 4.0

- `wexeljs/edgejs.wasm`: Wexel.js, runtime JavaScript/Node-compatível baseado no Edge.js com QuickJS-NG embutido, compilado via toolchain WASIX (wasixcc + LLVM 21 + wasix-libc). O pacote `pnpm.cjs` acompanha o runtime. A licença MIT original da Wasmer é preservada; modificações próprias estão sob Apache 2.0.
- `go/wasm_exec.js`: runtime oficial do Go para executar artefatos `.wasm` compilados com `GOOS=js GOARCH=wasm`.
- Go/Zig source execution uses the Wexel Language Executor ABI v1 bridge documented in `docs/go-zig-wasm.md`. The runtime reads source files from its VFS and dispatches them to configured executor artifacts. Standalone Go/Zig WASM smoke-test files are examples only, not the source-execution API. No GitHub Actions Workflow is required.
- `src/webpink_pip_adapter.py`: adaptador que liga o `pip` real à política de rede do WebPink, interceptando `socket.create_connection`.
- `@wexel/core`: fornece o núcleo WebAssembly Memory64 e o `WexelServiceManager`, que registra serviços e controla seus ciclos de vida.
- `NodeExecution`: cria o runtime e aguarda a inicialização do sandbox antes de disponibilizá-lo. O shell é um serviço opcional fornecido por um `shellRunner`, que pode ser conectado ao BusyBox WebAssembly.

Os artefatos e o código de integração são independentes de um kernel de sistema operacional. Toolchains baixados e builds temporários não fazem parte deste repositório.
