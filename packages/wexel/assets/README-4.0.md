# Novidades do Wexel 4.0

- `linux-kernel/vmlinux.wasm` + `initramfs.cpio.gz`: kernel Linux real compilado
  para WebAssembly (base: joelseverin/linux-wasm, NOMMU), com identidade
  renomeada para Wexel. Orquestrado por `src/linux-kernel-host.js` +
  `src/linux-kernel-worker.js` (porte de linux.js/linux-worker.js pra
  `worker_threads` do Node). Inicializado via `src/kernel-boot.ts`.
- `wexeljs/edgejs.wasm`: Wexel.js — runtime JS/Node-compatível, baseado no
  Edge.js (Wasmer) com QuickJS-NG embutido, compilado via toolchain WASIX real
  (wasixcc + LLVM 21 + wasix-libc). `pnpm.cjs` staged junto. Licença MIT
  original da Wasmer preservada (ver LICENSE.md do pacote); modificações
  próprias sob Apache 2.0.
- `go/wasm_exec.js`: runtime oficial do Go para executar artefatos `.wasm` compilados com `GOOS=js GOARCH=wasm`.
- Go/Zig source execution uses the Wexel Language Executor ABI v1 bridge documented in `docs/go-zig-wasm.md`. The runtime reads source files from its VFS and dispatches them to configured executor artifacts. Standalone Go/Zig WASM smoke-test files are examples only, not the source-execution API. No GitHub Actions Workflow is required.
- `src/webpink_pip_adapter.py`: adaptador que liga o `pip` real (não
  reimplementado) à política de rede do WebPink, interceptando em
  `socket.create_connection`.
- `src/shell.ts` + `src/kernel-busybox-connector.ts`: substituem o shell de
  ~40 comandos da 3.0 pelo BusyBox real rodando dentro do kernel acima.

Builds de teste, toolchains baixados (LLVM, sysroot, wasmer-cli) e o
código-fonte do kernel/QuickJS-NG/Edge.js em si NÃO fazem parte deste
repositório — só os artefatos finais e o código de integração.
