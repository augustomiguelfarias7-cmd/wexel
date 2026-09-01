# Wexel 2.0 — Referência completa da API

O **Wexel 2.0** é um runtime modular baseado no Wexel Assembly, uma camada própria sobre WebAssembly. Ele fornece filesystem virtual, memória WASM, permissões, terminal Linux-like, carregamento de módulos, extensões nativas e adapters para runtimes de linguagem.

Este guia documenta a API pública atual e seus exemplos práticos.

## Instalação

Instale a versão 2.0 diretamente do repositório GitHub:

```bash
npm install git+https://github.com/augustomiguelfarias7-cmd/wexel.git#2.0
```

Durante desenvolvimento, é possível usar a branch principal:

```bash
npm install git+https://github.com/augustomiguelfarias7-cmd/wexel.git#main
```

A tag `2.0` é recomendada para builds reproduzíveis.

## Criar o runtime

A forma principal de inicializar o runtime é `Wexel.create(options)`:

```js
import { readFile } from "node:fs/promises";
import { Wexel } from "wexel";

const coreBytes = await readFile("./node_modules/wexel/assets/core.wasm");

const runtime = await Wexel.create({
  coreBytes,
  mode: "run",
  storageQuotaBytes: 5 * 1024 * 1024 * 1024,
  permissions: {
    storage: true,
    files: true,
    modules: true,
    network: false
  }
});
```

### Opções de `Wexel.create`

| Opção | Tipo | Função |
|---|---|---|
| `coreBytes` | `BufferSource` | Core WebAssembly fornecido explicitamente. |
| `mode` | `"run" \| "load-only"` | Decide se o runtime pode executar código ou apenas carregar componentes. |
| `storageQuotaBytes` | `number` | Quota lógica da VFS. O padrão é 5 GiB. |
| `initialMemoryPages` | `number` | Configuração inicial de páginas de memória WASM. |
| `maxMemoryPages` | `number` | Limite máximo configurável de memória linear. |
| `permissions` | `WexelPermissions` | Permissões de rede, armazenamento, arquivos e módulos. |
| `pythonRunner` | função | Adapter para CPython/WASM real. |
| `denoRunner` | função | Adapter para JavaScript, TypeScript ou HTML. |
| `pypiIndexUrl` | `string` | Índice JSON compatível com PyPI. |
| `gitCloneRunner` | função | Implementação de `git clone` conectada ao ambiente. |
| `nativeCliBytes` | `BufferSource` | Módulo WASM da CLI nativa padrão. |
| `nativeExtensions` | lista | Extensões WASM carregadas na inicialização. |

## Modo `load-only`

Use `Wexel.loadOnly(options)` quando o serviço precisa apenas carregar o motor, sem executar scripts e sem criar arquivos de projeto:

```js
const runtime = await Wexel.loadOnly({ coreBytes });

console.log(runtime.mode); // "load-only"
console.log(runtime.fs.list()); // []
```

Nesse modo, chamadas de execução não executam o código recebido. O serviço pode carregar o runtime e decidir posteriormente quando habilitar operações de execução.

## Resultado de execução

As APIs de execução retornam um objeto `ExecResult`:

```js
{
  stdout: "texto produzido pelo programa",
  stderr: "mensagens de erro ou diagnóstico",
  exitCode: 0
}
```

Um `exitCode` igual a `0` indica sucesso. Outros valores indicam erro ou uso inválido do comando.

## Executar código e arquivos

A função `runtime.exec(request)` aceita `python`, `javascript`, `typescript`, `html` e linguagens encaminhadas por adapters:

```js
const result = await runtime.exec({
  language: "python",
  code: "print('Olá do CPython')",
  args: ["--modo", "teste"]
});

console.log(result.stdout);
console.error(result.stderr);
console.log(result.exitCode);
```

Para executar um arquivo armazenado na VFS:

```js
runtime.fs.write("/workspace/hello.py", "print('arquivo executado')");

const result = await runtime.exec({
  language: "python",
  file: "/workspace/hello.py",
  args: []
});
```

Para JavaScript e TypeScript, registre um `denoRunner` real na criação do runtime. Sem esse adapter, o Wexel retorna um erro explícito em vez de simular a execução.

## `loadScript()`

`loadScript(source)` carrega um script a partir de uma URL ou devolve um buffer já fornecido:

```js
const source = await runtime.loadScript("https://example.com/script.py");
console.log(source.byteLength);
```

Com bytes locais:

```js
const source = await runtime.loadScript(
  new TextEncoder().encode("print('carregado')")
);
```

## `runScript()`

`runScript(source, request)` carrega o conteúdo e encaminha sua execução para `runtime.exec()`:

```js
const result = await runtime.runScript(
  new TextEncoder().encode("print('executando script')"),
  { language: "python", args: [] }
);

console.log(result.stdout);
```

No modo `load-only`, o conteúdo é apenas registrado como carregado e não é executado.

## Filesystem virtual

O objeto `runtime.fs` é uma instância de `WexelFileSystem`.

### `pwd()`

Retorna o diretório de trabalho atual:

```js
console.log(runtime.fs.pwd());
```

### `cd(path)`

Altera o diretório de trabalho:

```js
runtime.fs.mkdir("/workspace");
runtime.fs.cd("/workspace");
console.log(runtime.fs.pwd());
```

### `mkdir(path)`

Cria um diretório virtual:

```js
runtime.fs.mkdir("/workspace/src");
```

### `touch(path)`

Cria um arquivo vazio se ele ainda não existir:

```js
runtime.fs.touch("/workspace/src/main.c");
```

### `write(path, data)`

Grava texto ou bytes:

```js
runtime.fs.write("/workspace/message.txt", "Olá, Wexel");
runtime.fs.write("/workspace/data.bin", new Uint8Array([1, 2, 3]));
```

A quota é verificada em cada gravação.

### `read(path)` e `readText(path)`

`read()` retorna bytes. `readText()` decodifica o conteúdo como texto:

```js
const bytes = runtime.fs.read("/workspace/data.bin");
const text = runtime.fs.readText("/workspace/message.txt");
console.log(bytes, text);
```

### `list()`

Lista os itens do diretório de trabalho:

```js
console.log(runtime.fs.list());
```

### `exists(path)`

Verifica se um arquivo ou diretório existe:

```js
if (runtime.fs.exists("/workspace/message.txt")) {
  console.log("arquivo encontrado");
}
```

### `remove(path)`

Remove um arquivo ou uma árvore de diretórios:

```js
runtime.fs.remove("/workspace/data.bin");
```

### `quota`

Consulta o uso atual e o limite:

```js
console.log(runtime.fs.quota);
// { usedBytes: 0, limitBytes: 5368709120 }
```

### `snapshot()`

Cria uma cópia dos arquivos armazenados, útil para persistência ou inspeção:

```js
const files = runtime.fs.snapshot();
for (const file of files) {
  console.log(file.path, file.data.byteLength);
}
```

## Terminal Linux-like

Use `runtime.shell.exec(command)` para executar comandos dentro da VFS e do Wexel Assembly:

```js
const result = await runtime.shell.exec("pwd");
console.log(result.stdout);
```

Comandos disponíveis na versão 2.0:

```text
pwd ls cd mkdir touch rm cat head tail echo curl git pip native-cli whoami uname help
```

Exemplo de sequência:

```js
await runtime.shell.exec("mkdir /workspace");
await runtime.shell.exec("touch /workspace/readme.txt");
await runtime.shell.exec("echo Wexel 2.0 > /workspace/readme.txt");

const result = await runtime.shell.exec("cat /workspace/readme.txt");
console.log(result.stdout);
```

O terminal é Linux-like, mas não é um kernel Linux. Os comandos funcionam dentro do runtime virtual e respeitam as permissões do Wexel.

## Permissões

As permissões ficam disponíveis em `runtime.permissions`:

```js
runtime.permissions.network = true;
runtime.permissions.files = true;
runtime.permissions.modules = true;
runtime.permissions.storage = true;
```

A rede começa bloqueada por padrão. Operações como `curl`, `pip install` e `git clone` devem receber autorização de rede.

## `curl`

Com a permissão de rede habilitada:

```js
runtime.permissions.network = true;
const result = await runtime.shell.exec("curl https://example.com");
console.log(result.stdout);
```

No navegador, a solicitação ainda está sujeita às políticas de Fetch e CORS.

## `git clone`

O terminal reconhece o comando:

```js
const result = await runtime.shell.exec(
  "git clone https://github.com/exemplo/projeto.git projeto"
);
```

Para funcionar, registre um `gitCloneRunner` que implemente o clone através de um módulo Git ou BusyBox WASM compatível. Sem esse adapter, o Wexel retorna uma mensagem explícita.

## Pip WASM-native

O comando `pip install` consulta um índice PyPI, baixa o wheel, verifica o SHA-256 e extrai os arquivos diretamente em `/site-packages`:

```js
runtime.permissions.network = true;
const result = await runtime.shell.exec("pip install six");
console.log(result.stdout);
```

O instalador aceita wheels `none-any`, `wasm32-wasi` e `wasm32-wasip1`. Wheels nativos precisam ser publicados para uma ABI WebAssembly compatível; um wheel Linux com `.so` não pode ser carregado diretamente pelo CPython WASI.

## CPython WASI

Registre um runner CPython real:

```js
import { createWasiPythonRunner } from "wexel/node";

const pythonRunner = createWasiPythonRunner({
  pythonWasm: "./assets/cpython-3.14.7/python.wasm",
  pythonRoot: "./assets/cpython-3.14.7",
  wasmtime: "wasmtime"
});

const runtime = await Wexel.create({ coreBytes, pythonRunner });
const result = await runtime.exec({
  language: "python",
  code: "print('CPython 3.14.7')"
});
```

## V9: HTML e CSS

O V9 cria documentos HTML/CSS. O método `createWebDocument(document)` retorna o HTML pronto:

```js
const html = runtime.createWebDocument({
  title: "Minha interface",
  body: "<main><h1>Wexel</h1><p>Interface V9.</p></main>",
  css: "body { font-family: sans-serif; padding: 2rem; }"
});

const frame = document.createElement("iframe");
frame.srcdoc = html;
document.body.append(frame);
```

O V9 usa o motor nativo do navegador para a renderização. JavaScript e TypeScript não são executados pelo V9; devem ser encaminhados ao Deno por meio de `denoRunner`.

## Carregar módulos WASM

`loadModule(source)` instancia um módulo WASM e emite o evento `module:loaded`:

```js
const module = await runtime.loadModule("./module.wasm");
const run = module.exports.run;

if (typeof run === "function") {
  console.log(run());
}
```

Para bytes locais:

```js
const module = await runtime.loadModule(moduleBytes);
```

## Extensões nativas

`loadNativeExtension(manifest, source)` valida e registra uma extensão WASM:

```js
const extension = await runtime.loadNativeExtension({
  name: "math-extension",
  version: "2.0.0",
  abi: "wexel-2",
  entry: "math.wasm",
  commands: ["add"],
  dependencies: []
}, mathWasm);
```

O manifesto pode incluir um SHA-256:

```js
{
  name: "math-extension",
  version: "2.0.0",
  abi: "wexel-2",
  entry: "math.wasm",
  sha256: "hash-hexadecimal",
  commands: ["add"]
}
```

### `runtime.extensions.get(name)`

Retorna uma extensão carregada:

```js
const extension = runtime.extensions.get("math-extension");
```

### `runtime.extensions.list()`

Lista os manifestos registrados:

```js
console.log(runtime.extensions.list());
```

### `runtime.extensions.invoke(name, exportName, args)`

Invoca um export autorizado pelo manifesto:

```js
const value = runtime.extensions.invoke(
  "math-extension",
  "add",
  [20, 22]
);
console.log(value);
```

## CLI C++ WASM

A CLI nativa pode ser registrada na criação do runtime:

```js
const runtime = await Wexel.create({
  coreBytes,
  nativeCliBytes
});

const result = await runtime.shell.exec("native-cli add 20 22");
console.log(result.stdout); // 42
```

A CLI é um módulo WASM; ela não cria subprocessos de sistema.

## RustV

O RustV é o motor Rust compilado para WASM:

```js
import { RustV } from "wexel";

const rustv = await RustV.load({
  source: rustvBytes,
  expectedAbi: 20001
});

console.log(rustv.version());
console.log(rustv.add(20, 22));
console.log(rustv.exitCode());
```

A saída esperada é:

```text
20001
42
0
```

## Compilar C e C++

A API `compileNativeSource()` usa `emcc` para C e `em++` para C++ no ambiente de compilação:

```js
import { compileNativeSource } from "wexel";

await compileNativeSource({
  source: "./math.cpp",
  output: "./math.wasm",
  flags: ["-Wl,--export=add"]
});
```

Exemplo C++:

```cpp
extern "C" int add(int left, int right) {
  return left + right;
}
```

Exemplo C:

```c
int multiply(int left, int right) {
  return left * right;
}
```

Depois da compilação:

```js
const module = await runtime.loadModule(
  await readFile("./math.wasm")
);

console.log(module.exports.add(20, 22));
```

A compilação exige uma toolchain Emscripten no ambiente. O módulo WASM gerado pode ser carregado no navegador ou no Node.js pelo Wexel Assembly.

## Eventos do Buzz Box

O runtime possui `runtime.buzz`, usado para eventos de ciclo de vida:

```js
runtime.buzz.on("runtime:ready", (payload) => {
  console.log("runtime pronto", payload);
});

runtime.buzz.on("module:loaded", (payload) => {
  console.log("módulo carregado", payload);
});
```

Os eventos principais incluem `runtime:ready`, `script:loaded`, `module:loaded` e `extension:loaded`.

## Build e testes

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

Build do BusyBox:

```bash
./scripts/build-busybox.sh
```

Build do RustV:

```bash
./scripts/build-rustv.sh
```

Build da CLI C++:

```bash
./scripts/build-native-cli.sh
```

## Resumo da API

| API | Função |
|---|---|
| `Wexel.create()` | Cria um runtime em modo de execução. |
| `Wexel.loadOnly()` | Carrega o motor sem executar scripts. |
| `runtime.exec()` | Executa código ou arquivo por linguagem. |
| `runtime.loadScript()` | Carrega uma URL ou buffer. |
| `runtime.runScript()` | Carrega e executa um script. |
| `runtime.loadModule()` | Instancia um módulo WebAssembly. |
| `runtime.loadNativeExtension()` | Valida e registra uma extensão WASM. |
| `runtime.createWebDocument()` | Monta um documento HTML/CSS para o V9. |
| `runtime.shell.exec()` | Executa comandos no terminal virtual. |
| `runtime.fs.*` | Manipula a filesystem virtual. |
| `runtime.extensions.*` | Lista, consulta e invoca extensões nativas. |
| `runtime.packages.pip()` | Instala wheels compatíveis diretamente na VFS. |
| `RustV.load()` | Carrega o motor Rust WASM. |
| `compileNativeSource()` | Compila C/C++ para WASM via Emscripten. |

## Limites de execução

O Wexel Assembly não é um kernel Linux e não é Docker. O terminal é um ambiente Linux-like dentro do runtime. A execução de C, C++, Rust e extensões Python nativas depende de módulos WebAssembly compatíveis. A rede depende das permissões e, no navegador, das políticas de Fetch/CORS. A compilação de C/C++ dentro do navegador ainda exige uma toolchain de compilação portada para WebAssembly; a API atual compila no ambiente que fornece Emscripten.
