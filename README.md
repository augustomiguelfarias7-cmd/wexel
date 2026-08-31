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

Esta entrega contém um SDK compilável e testado, carregamento real de módulos WebAssembly, shell virtual, permissões, filesystem organizado com quota lógica configurável, modo `load-only`, execução de scripts selecionados e adapters explícitos para CPython e Deno. A quota padrão é de aproximadamente 3 GB de armazenamento lógico e não aloca 3 GB de RAM. O tamanho total do pacote é controlado por artefatos e não deve ser confundido com memória disponível: um bundle de 115 GB não é apropriado para navegador e deverá ser distribuído em módulos sob demanda.

A integração de um binário CPython específico depende do artefato WASM escolhido, da ABI do runtime e dos arquivos da biblioteca padrão. O núcleo do Wexel permanece independente dessa escolha e não utiliza micropip/Pyodide como mecanismo principal. Da mesma forma, Deno deve ser fornecido como runtime WASM compatível ou como adapter de host; o SDK não simula a execução quando o adapter não está instalado. Git, Curl avançado, persistência IndexedDB e execução de processos reais exigem backends adicionais, que permanecem como extensões controladas.

## BusyBox real

O repositório inclui os artefatos reais `packages/wexel/assets/busybox/busybox.js` e `busybox.wasm`, gerados a partir do projeto `mayflower/busybox-wasm` com BusyBox 1.37.0. O build pode ser repetido com:

```bash
pnpm build:busybox
```

O runner é exposto por `createBusyBoxRunner()`. Ele foi desenhado para receber a factory Emscripten ES module, o endereço do `.wasm`, argumentos e streams. O build de referência recomenda Emscripten 4.x; a imagem de desenvolvimento usada nesta execução forneceu Emscripten 3.1.6, portanto o artefato foi produzido, mas deve ser revalidado com Emscripten 4.x antes de uma release de produção.

## Exemplos

Os quatro exemplos estão em `examples/`: `01-load-only.mjs` apenas carrega o runtime; `02-wasm-module.mjs` carrega e executa um módulo WebAssembly; `03-cpython-adapter.mjs` mostra a integração do CPython real; e `04-busybox.mjs` mostra a integração do BusyBox WASM. Execute os dois primeiros com `node examples/01-load-only.mjs` e `node examples/02-wasm-module.mjs`. Os exemplos de CPython e BusyBox exigem seus respectivos artefatos e ABI de runtime.
