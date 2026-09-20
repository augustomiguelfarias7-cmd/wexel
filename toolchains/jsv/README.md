# JSV

JSV é o runtime JavaScript/TypeScript planejado para o Wexel.

## Base

A primeira implementação usa o `denort` oficial do Deno como base nativa. O
`denort` é o runtime reduzido usado pelo `deno compile`, não o CLI completo.

O bootstrap baixa o `denort` da release oficial, verifica SHA-256 e seleciona
automaticamente o alvo do host:

- Linux x64 / ARM64
- macOS x64 / ARM64
- Windows x64 / ARM64

Fonte oficial: https://github.com/denoland/deno/releases

## Arquitetura

```
JSV
├── denort
├── JSV CLI
├── package manager
├── Wexel VFS
├── permissions
└── WebPink
```

O runtime nativo é separado da CLI. Isso é importante porque `denort` não deve
ser tratado como se já fosse o comando `deno run`.

## Bootstrap

```bash
node scripts/bootstrap-jsv.mjs
```

Os binários baixados ficam em `.cache/jsv/` e o runtime validado fica em
`toolchains/jsv/runtime/`. O binário não deve ser commitado no Git.

## Próximas camadas

1. launcher JSV para JavaScript/TypeScript;
2. `jsv run`, `jsv check`, `jsv test`;
3. `npm install` usando uma camada de pacotes controlada;
4. integração de rede exclusivamente pelo WebPink;
5. integração com a VFS do Wexel;
6. integração com `NodeExecution`.
