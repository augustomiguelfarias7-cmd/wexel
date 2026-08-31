# Wexel

**Wexel** é um framework JavaScript/TypeScript para incorporar o Wexel Assembly em aplicações modernas. O Wexel Assembly é um runtime próprio baseado em WebAssembly; não é um sistema operacional e não pretende ser uma versão oficial do WebAssembly.

## Arquitetura

A implementação está organizada em dois pacotes. `@wexel/core` compila `core.wat` para `core.wasm` e fornece o Execution Core, memória linear, alocador e funções ABI básicas. `wexel` fornece a API de alto nível, carregador de módulos, shell virtual, sistema de arquivos em memória e políticas de permissões.

| Camada | Implementação |
|---|---|
| SDK | `Wexel.create()`, `runtime.exec()`, `runtime.loadModule()` e `runtime.shell.exec()` |
| Runtime | Permissões, filesystem virtual, rede controlada e roteamento de linguagens |
| Execution Core | Módulo WebAssembly com `memory`, `alloc`, `add` e `write_byte` |
| Extensões | Adapters para CPython/WASM, Git, Curl e futuros runtimes |

## Desenvolvimento

```bash
pnpm install --ignore-scripts
pnpm build
pnpm test
```

O pacote compilado pode ser encontrado em `packages/wexel/dist`. Para usar o SDK durante o desenvolvimento:

```ts
import { Wexel } from "wexel";

const runtime = await Wexel.create();
console.log((await runtime.shell.exec("pwd")).stdout);
const wasm = await runtime.loadModule("./program.wasm");
```

## Python via CPython/WebAssembly

O SDK não falsifica a execução Python. Para respeitar a especificação, o executor Python deve ser um adapter conectado a um build real do CPython compilado para WebAssembly:

```ts
const runtime = await Wexel.create({
  pythonRunner: async (code, args) => {
    // Encaminhar para o módulo CPython/WASM incorporado.
    return { stdout: "", stderr: "", exitCode: 0 };
  }
});
```

A integração de um binário CPython específico depende do artefato WASM escolhido, da ABI do runtime e dos arquivos da biblioteca padrão. O núcleo do Wexel permanece independente dessa escolha e não utiliza micropip/Pyodide como mecanismo principal.

## Segurança e limitações

Todas as operações de rede, armazenamento, arquivos e carregamento de módulos devem ser explicitamente autorizadas pelas permissões do runtime. A rede é negada por padrão. O shell atual é virtual e não executa comandos arbitrários do sistema operacional. Git e Curl são pontos de extensão controlados; Curl somente funciona quando a aplicação concede rede e quando o navegador permite a requisição, inclusive sob CORS.

O armazenamento virtual e a memória WASM são conceitos distintos. O limite de memória do core é configurável no módulo WebAssembly, enquanto o armazenamento deve ser conectado posteriormente a uma implementação persistente, como IndexedDB, sem pressupor consumo equivalente de RAM.

## Estado atual

Esta entrega contém uma base funcional compilável e testada do SDK e do Execution Core, com carregamento real de módulos WebAssembly, shell virtual, permissões e adapter explícito para CPython. A implementação completa de CPython dentro de WASM, Git, Curl avançado, persistência IndexedDB e encadeamento completo de processos exige artefatos e backends adicionais, que foram deixados como extensões bem definidas em vez de serem simulados.
