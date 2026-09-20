# Deno no Wexel

O Wexel usa o adaptador backend `packages/wexel/src/deno-host.ts` para executar o Deno nativo do host. A versão fixada para investigação é o Deno **2.9.6**, commit `e518fbd66dda5debcbdefc0beb0b3756b37b64fa`.

## Estado do binário WASM

O release oficial do Deno 2.9.6 publica executáveis para Linux, macOS e Windows, além de `denort`, `libdenort` e o arquivo de fontes. Ele **não publica um `deno.wasm`**. No código-fonte, os comandos relacionados a `wasm32-unknown-unknown` verificam crates auxiliares como `deno_resolver`, `deno_npm_installer` e `deno_config`; isso não compila o CLI/runtime completo em WebAssembly.

Por esse motivo, este diretório não contém um `.wasm` que se passe por Deno. O loader do Wexel só deve receber um módulo WASM quando houver um runtime real, com ABI e imports documentados, validado por `WebAssembly.validate` e hash SHA-256.

## Verificação reproduzível

Execute:

```bash
node scripts/prepare-deno-wasm.mjs
```

O script baixa temporariamente a tag oficial, registra o commit e consulta os artefatos do release. Com Deno 2.9.6, ele termina com código **2** e a mensagem de que não há artefato WASM oficial. Esse resultado é intencional: evita adicionar um binário inválido ou um executável nativo renomeado para `.wasm`.

Quando houver uma implementação WASM real, ela deve ser adicionada com sua origem, versão, ABI, imports permitidos e SHA-256 no manifest antes de ser conectada ao `WasmBinaryLoader`.
