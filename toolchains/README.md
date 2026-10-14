# Wexel toolchains

Esta pasta contém os metadados e scripts para reproduzir os artefatos do Wexel. Os binários grandes do WASI SDK e do Wasmtime não são versionados no Git: o GitHub impõe limite de 100 MB por arquivo e não é adequado usar o repositório como distribuidor de toolchains inteiras.

## Versões fixadas

| Ferramenta | Versão | Plataforma | Pin/verificação |
|---|---:|---|---|
| CPython | 3.14.7 | fonte oficial | tag `v3.14.7` |
| WASI SDK | 34.0 | x86_64 Linux | `b761e3a0721dbae9c09a0059e5fdb2bf917d1b4a8a7b430fb3b5aafb0984b2c4` |
| Wasmtime | 48.0.1 | x86_64 Linux | `4c2e31b68ad99e0a519f225a261fda099eb15f056d4a24fdb3c2a46517bde1df` |
| Yaegi | 0.16.1 | Go interpreter `js/wasm` | versão e hashes do módulo fixados em `toolchains/go-yaegi/go.sum` |
| zigc-wasm | 0.11.0 | compilador Zig `wasm32-wasi` em WASM | SHA-256 do compilador e `std.zip` validados pelo script |

Use `scripts/bootstrap-toolchains.sh` para baixar e validar os binários, e `scripts/build-cpython-wasi.sh` para reproduzir o `python.wasm`. O artefato gerado do CPython é copiado para `packages/wexel/assets/cpython-3.14.7/` pelo script de integração.

Para reconstruir os toolchains Go/Zig incluídos em Wexel 4.0, execute `./toolchains/go-yaegi/build.sh` e `./toolchains/build-zig-wasm.sh`. Os assets e respectivos avisos de licença ficam em `packages/wexel/assets/toolchains/`.
