# Wexel 2.0 — Help

O Wexel é um runtime modular baseado no Wexel Assembly, uma camada de execução WebAssembly. Ele pode carregar o motor sem executar scripts, executar módulos WASM, inicializar o filesystem virtual, usar o terminal Linux-like e integrar runtimes de linguagem por adapters explícitos.

## Instalação por Git

Para instalar a versão 2.0 diretamente do repositório GitHub, use uma tag ou commit fixo:

```bash
npm install git+https://github.com/augustomiguelfarias7-cmd/wexel.git#2.0
```

Também é possível instalar a branch principal durante o desenvolvimento:

```bash
npm install git+https://github.com/augustomiguelfarias7-cmd/wexel.git#main
```

A tag `2.0` é preferível em ambientes reproduzíveis, pois não muda com novos commits.

## 1. Carregar somente o motor

Use `loadOnly()` quando a aplicação precisa apenas inicializar o Wexel para integração, sem executar código e sem criar arquivos de projeto:

```js
import { readFile } from "node:fs/promises";
import { Wexel } from "wexel";

const coreBytes = await readFile("./node_modules/wexel/assets/core.wasm");
const runtime = await Wexel.loadOnly({ coreBytes });

console.log(runtime.mode); // load-only
console.log(runtime.fs.list("/")); // []
```

O modo loader-only não baixa pacotes, não executa scripts e começa com o filesystem virtual vazio.

## 2. Criar e consultar arquivos na VFS

```js
import { readFile } from "node:fs/promises";
import { Wexel } from "wexel";

const coreBytes = await readFile("./node_modules/wexel/assets/core.wasm");
const runtime = await Wexel.create({ coreBytes });

runtime.permissions.files = true;
runtime.fs.mkdir("/workspace");
runtime.fs.writeText("/workspace/message.txt", "Olá do Wexel 2.0");

console.log(runtime.fs.readText("/workspace/message.txt"));
console.log(runtime.fs.list("/workspace"));
```

A quota padrão da VFS é de 5 GiB. Ela representa armazenamento lógico e não reserva 5 GiB de RAM na inicialização.

## 3. Executar comandos do terminal

```js
const result = await runtime.shell.exec("mkdir /tmp");
console.log(result.exitCode);

await runtime.shell.exec("touch /tmp/example.txt");
await runtime.shell.exec("echo Wexel > /tmp/example.txt");

const output = await runtime.shell.exec("cat /tmp/example.txt");
console.log(output.stdout);
```

Comandos disponíveis incluem `pwd`, `ls`, `cd`, `mkdir`, `touch`, `rm`, `cat`, `head`, `tail`, `echo`, `curl`, `git`, `pip`, `native-cli`, `whoami`, `uname` e `help`.

## 4. Executar Python pelo adapter CPython WASI

O adapter CPython usa o CPython real compilado para WebAssembly. Ele não utiliza Pyodide como runtime principal:

```js
import { readFile } from "node:fs/promises";
import { Wexel, createWasiPythonRunner } from "wexel";

const coreBytes = await readFile("./node_modules/wexel/assets/core.wasm");
const runtime = await Wexel.create({ coreBytes });

const python = createWasiPythonRunner({
  pythonWasm: "./node_modules/wexel/assets/cpython-3.14.7/python.wasm",
  pythonRoot: "./node_modules/wexel/assets/cpython-3.14.7",
  wasmtime: "wasmtime"
});

runtime.setPythonRunner(python);
const result = await runtime.exec({
  language: "python",
  code: "print('Python executando no Wexel')"
});

console.log(result.stdout);
```

## 5. Instalar um pacote Python puro

O instalador consulta o PyPI, baixa o wheel, verifica o SHA-256, extrai os arquivos diretamente na VFS e sincroniza `/site-packages` com o CPython WASI:

```js
const result = await runtime.shell.exec("pip install six");
console.log(result.stdout);
```

Pacotes Python puros devem publicar wheels `none-any`. Extensões nativas precisam publicar wheels `wasm32-wasi` ou `wasm32-wasip1` compatíveis com a ABI do Wexel.

## 6. Usar o V9 para HTML e CSS

O V9 monta HTML e CSS e usa o mecanismo nativo do navegador para exibir a interface. Ele não é um interpretador JavaScript:

```js
const html = runtime.createWebDocument({
  title: "Página Wexel",
  body: "<main><h1>Olá</h1><p>Interface criada com V9.</p></main>",
  css: "body { font-family: sans-serif; padding: 2rem; }"
});

const frame = document.createElement("iframe");
frame.sandbox.add("allow-scripts");
frame.srcdoc = html;
document.body.append(frame);
```

JavaScript e TypeScript devem ser encaminhados ao runtime Deno quando o adapter Deno estiver registrado.

## 7. Carregar um módulo WASM

```js
import { readFile } from "node:fs/promises";

const moduleBytes = await readFile("./module.wasm");
const instance = await runtime.loadModule(moduleBytes);

const exportedFunction = instance.exports.run;
if (typeof exportedFunction !== "function") {
  throw new Error("O módulo não exporta a função run");
}

console.log(exportedFunction());
```

## 8. Compilar C ou C++ para WASM

A compilação de arquivos `.c` e `.cpp` usa Emscripten no ambiente que fornece a toolchain:

```js
import { compileNativeSource } from "wexel";

await compileNativeSource({
  source: "./math.cpp",
  output: "./math.wasm",
  flags: ["-Wl,--export=add"]
});
```

Exemplo de `math.cpp`:

```cpp
extern "C" int add(int left, int right) {
  return left + right;
}
```

Depois de compilado, o módulo pode ser carregado pelo Wexel:

```js
const module = await runtime.loadModule(await readFile("./math.wasm"));
console.log(module.exports.add(20, 22)); // 42
```

Para C, use a mesma API com um arquivo `.c`:

```c
int multiply(int left, int right) {
  return left * right;
}
```

## 9. Executar a CLI C++ WASM

A CLI nativa incluída nos assets pode ser registrada e executada sem subprocesso do sistema:

```js
import { readFile } from "node:fs/promises";

const nativeCli = await readFile("./node_modules/wexel/assets/native/wexel-cli.wasm");
const result = await Wexel.create({
  coreBytes,
  nativeCliBytes: nativeCli
});

console.log(await result.shell.exec("native-cli add 20 22"));
```

Saída esperada:

```text
{ stdout: "42\n", stderr: "", exitCode: 0 }
```

## 10. Executar Rust pelo RustV

O RustV é o motor Rust compilado para WebAssembly:

```js
import { readFile } from "node:fs/promises";
import { RustV } from "wexel";

const rustv = await RustV.load({
  source: await readFile("./node_modules/wexel/assets/native/rustv.wasm"),
  expectedAbi: 20001
});

console.log(rustv.version());
console.log(rustv.add(20, 22)); // 42
console.log(rustv.exitCode()); // 0
```

## 11. Extensões nativas com manifesto

Extensões WASM devem declarar sua ABI e seus exports autorizados:

```js
const extension = await runtime.loadNativeExtension({
  name: "math-extension",
  version: "2.0.0",
  abi: "wexel-2",
  entry: "math.wasm",
  commands: ["add"],
  dependencies: []
}, mathWasm);

console.log(runtime.extensions.list());
console.log(runtime.extensions.invoke("math-extension", "add", [20, 22]));
```

O registro valida a ABI e, quando fornecido, o hash SHA-256 antes de instanciar o módulo.

## 12. Build e testes do projeto

No checkout do repositório:

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

Para gerar a CLI C++ WASM:

```bash
./scripts/build-native-cli.sh
```

Para gerar o RustV:

```bash
./scripts/build-rustv.sh
```

Para compilar um exemplo C++:

```bash
node examples/08-compile-cpp.mjs
```

Para executar o exemplo RustV:

```bash
node examples/09-rustv.mjs
```

## Limites importantes

O Wexel Assembly executa WebAssembly e oferece filesystem, memória, permissões e módulos cooperativos. Ele não é um kernel Linux nem um processo Docker. O terminal Linux-like fornece comandos dentro do runtime, e não acesso irrestrito ao sistema operacional.

A instalação de pacotes Python com dependências nativas exige wheels WebAssembly compatíveis. Um wheel Linux com `.so` não pode ser carregado diretamente pelo CPython WASI. A compilação C/C++ dentro do navegador também exige uma toolchain Clang/Emscripten compilada para WebAssembly; a API atual compila no ambiente Node.js que fornece `emcc` ou `em++` e executa o resultado no Wexel Assembly.
