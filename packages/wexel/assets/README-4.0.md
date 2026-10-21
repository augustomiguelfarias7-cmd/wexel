# Wexel 4.0 assets

- `s-kernel/s1.wasm`: kernel S1, desenvolvido em C++ freestanding e compilado
  para WebAssembly por `npm run build:s1`. O código-fonte fica em
  `kernel/s1/`; a integração de host fica em `src/s1-kernel.ts`.
- `busybox/`: BusyBox WASM usado como shell separado do kernel. O S1 mantém
  o registro de serviços e não implementa um shell próprio.
- `wexeljs/edgejs.wasm`: Wexel.js, runtime JavaScript/Node-compatível.
- `go/wasm_exec.js`: runtime oficial do Go para artefatos `GOOS=js GOARCH=wasm`.
- Os adaptadores Python, WebPinke e os executores de outras linguagens continuam
  sendo componentes separados do kernel.

O artefato S1 é gerado pelo build local. A substituição do artefato Linux antigo
só deve ser considerada concluída depois de compilar e validar o S1 e verificar
o carregamento de BusyBox e as APIs de rede no runtime.
