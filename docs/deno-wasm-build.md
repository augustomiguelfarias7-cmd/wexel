# Tentativa de compilação do Deno 2.9.6 para WebAssembly

## Comando executado

O código-fonte oficial do Deno foi clonado sem alterações no commit `e518fbd66dda5debcbdefc0beb0b3756b37b64fa`. A compilação foi executada usando a toolchain fixada pelo próprio repositório (`rust-toolchain.toml`, Rust `1.95.0`) e o target `wasm32-unknown-unknown`:

```bash
cargo build --release --target wasm32-unknown-unknown -p deno
```

## Resultado

A compilação passou pelas dependências iniciais, mas falhou no crate `mio` com 47 erros. O código de rede do runtime espera APIs nativas de sockets, incluindo `TcpStream`, `UdpSocket`, `register`, `reregister` e `deregister`. Essas APIs não existem no target `wasm32-unknown-unknown` usado pelo build.

Exemplos dos erros observados:

```text
expected `TcpStream`, found `()`
no method named `register` found for struct `IoSource<std::net::UdpSocket>`
expected `UdpSocket`, found `()`
```

Não foi gerado `target/wasm32-unknown-unknown/release/deno.wasm`.

## Decisão de empacotamento

Nenhum executável nativo foi renomeado para `.wasm`, e nenhum módulo parcial foi adicionado ao Wexel. Um artefato nessas condições não seria carregável pelo `WasmBinaryLoader` nem representaria o runtime Deno.

A compilação reproduzível e a consulta dos releases permanecem disponíveis em `scripts/prepare-deno-wasm.mjs`. O adaptador funcional atual continua sendo o backend nativo `packages/wexel/src/deno-host.ts`.
