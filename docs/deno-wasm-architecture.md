# Arquitetura do Deno no Wexel

## Objetivo

O Wexel mantém o Deno como um runtime separado e organiza sua execução atrás de uma fronteira WASM. A finalidade desta camada é manter a integração modular: o Deno não recebe diretamente o filesystem ou a rede do sistema hospedeiro.

A arquitetura prevista é:

```
Wexel
├── Node Execution
│   └── WASM Host
│       └── Deno WASM
│           └── Deno Linux/Wexel Adapter
│               ├── VFS
│               ├── Network Bridge
│               ├── stdout/stderr
│               ├── env
│               └── process
│
└── Browser
    └── Dedicated Worker
        └── WASM Host
            └── Deno WASM
                └── Deno Linux/Wexel Adapter
```

## Linux/Wexel Adapter

`DenoLinuxAdapter` é uma camada de integração do host. Ele conecta o runtime a recursos virtuais do Wexel através dos canais já existentes de VFS e rede.

O adapter não cria um objeto JavaScript que imita a API `Deno`. O objetivo é fornecer uma ABI explícita para um build WASM real do Deno.

## WASM Host

`DenoWasmHost` é a camada responsável por instanciar o módulo WebAssembly.

Responsabilidades:

- validar que o artefato possui o cabeçalho WASM;
- compilar e instanciar o módulo;
- fornecer imports explicitamente autorizados;
- manter a fronteira entre o módulo WASM e os recursos do host;
- disponibilizar os recursos transferíveis do Linux Adapter para o Worker.

O host não usa `new Function()` para executar código Deno e não cria uma implementação falsa de `Deno`.

## Artefato comprimido

O script `scripts/prepare-deno-wasm-asset.mjs` prepara um artefato:

```
deno.wasm.gz
      ↓
gunzip
      ↓
deno.wasm
      ↓
Wexel WASM Host
```

A descompressão não converte um executável nativo em WebAssembly. O arquivo de entrada precisa já conter um módulo WASM válido. Se o conteúdo descompactado não começar com o magic number WASM, o script interrompe o processo.

O binário nativo existente em `packages/wexel/assets/deno/` continua sendo tratado separadamente. Ele não é considerado um Deno WASM.

## Browser

No browser, o Worker é a fronteira de execução. A intenção é que o Deno WASM permaneça dentro do runtime WASM do Worker e converse com o Wexel através dos canais do adapter.

O browser não recebe acesso direto ao filesystem da máquina. O filesystem apresentado ao Deno é o VFS do Wexel. A rede também passa pela camada de rede controlada do Wexel.

## Node Execution

No Node Execution, a mesma separação de responsabilidades pode ser reutilizada:

```
Node.js
  ↓
Wexel Node Execution
  ↓
WASM Host
  ↓
Deno WASM
  ↓
Linux/Wexel Adapter
  ↓
VFS / Network
```

Isso permite manter o Deno nativo como caminho separado enquanto o caminho WASM é desenvolvido e validado.

## Estado da integração

As camadas de organização estão presentes no código:

- `DenoLinuxAdapter`;
- `DenoWasmHost`;
- preparação e validação de `deno.wasm.gz`;
- exportação das novas APIs pelo pacote Wexel.

A presença dessas camadas não significa que o binário nativo `deno.gz` tenha sido convertido em WASM. Para executar o Deno propriamente como WebAssembly, o Wexel precisa receber ou produzir um artefato Deno WASM compatível com a ABI de host utilizada.

Essa distinção é intencional para evitar que um binário Linux nativo seja confundido com um módulo WebAssembly.
