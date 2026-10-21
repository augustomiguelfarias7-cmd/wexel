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

O artefato `s-kernel/s1.wasm` é gerado pelo build local com Clang/LLD. Antes
de publicar uma distribuição, execute o build e os testes do pacote para validar
o ABI S1, o carregamento do BusyBox e a política de rede do host.
