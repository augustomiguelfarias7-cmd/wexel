# Wexel 3.0 — Referência completa da API

O **Wexel 3.0** é um runtime modular baseado no Wexel Assembly. Ele fornece filesystem virtual, shell Linux modernizado, Deno nativo (browser + Node.js), Git, curl, gerenciador de pacotes npm/pnpm, CPython, BusyBox, RustV, extensões nativas e sandboxes Node.js isolados.

## Instalação

```bash
npm install git+https://github.com/augustomiguelfarias7-cmd/wexel.git
```

---

## Criar o runtime

```ts
import { Wexel } from "wexel";

const runtime = await Wexel.create({
  mode: "run",
  storageQuotaBytes: 5 * 1024 * 1024 * 1024,
  permissions: {
    network:  false,
    storage:  true,
    files:    true,
    modules:  true,
  },
});
```

### Opções de `Wexel.create`

| Opção | Tipo | Descrição |
|---|---|---|
| `coreBytes` | `BufferSource` | Core WASM (opcional — carregado automaticamente de assets/). |
| `mode` | `"run" \| "load-only"` | Modo de execução ou apenas carregamento. |
| `storageQuotaBytes` | `number` | Quota da VFS. Padrão: 5 GiB. |
| `permissions` | `WexelPermissions` | Rede, storage, arquivos, módulos. |
| `homeDirectory` | `string` | Diretório home. Padrão: `/home/wexel`. |
| `pythonRunner` | função | Adapter CPython/WASM. |
| `pythonRunnerFactory` | função | Factory que recebe o `fs` e retorna um `pythonRunner`. |
| `deno` | `DenoRuntime` | Runtime Deno unificado (browser + Node). |
| `denoRunner` | função | Adapter Deno legado (compatibilidade). |
| `bashRunner` | função | Adapter para comandos bash externos. |
| `networkFetch` | `typeof fetch` | Fetcher de rede (padrão: `fetch` global). |
| `gitToken` | `string` | Token para repositórios privados no `git clone`. |
| `pypiIndexUrl` | `string` | Índice PyPI alternativo. |
| `nativeCliBytes` | `BufferSource` | CLI C++ WASM. |
| `nativeExtensions` | lista | Extensões WASM carregadas na inicialização. |

---

## DenoRuntime — Deno nativo no browser e no Node

O `DenoRuntime` é o coração do Wexel 3.0. Detecta o ambiente automaticamente e usa o **Deno real** em ambos:

```ts
import { DenoRuntime, Wexel } from "wexel";

const denoRuntime = DenoRuntime.create({
  fs:             runtime.fs,
  networkAllowed: true,
  timeoutMs:      30_000,
});

const runtime = await Wexel.create({ deno: denoRuntime });
```

### Como funciona por ambiente

**No Node.js (NodeExecution / sandbox):**
- Usa o binário nativo `deno.gz` incluído no repositório
- `deno.gz` é descomprimido automaticamente na primeira execução
- O Deno roda como subprocesso isolado num diretório temporário
- O VFS do Wexel é materializado em disco antes da execução

**No browser:**
- Se `crossOriginIsolated` + `SharedArrayBuffer` disponíveis: usa o **Deno real** via `DenoBrowserHost`
  - Service Worker intercepta `/wexel-vfs/*` e serve do VFS via SharedArrayBuffer
  - Node.js sandbox roda o Deno nativo dentro de um `worker_thread`
  - O Deno **acha que está no Linux real**
- Fallback automático para shim JS quando COOP/COEP não estão configurados

### Executar código Deno

```ts
// JavaScript
const result = await runtime.exec({
  language: "javascript",
  code: `
    const data = await Deno.readTextFile("/src/config.json");
    console.log(JSON.parse(data).name);
  `,
});

// TypeScript
const result = await runtime.exec({
  language: "typescript",
  code: `
    interface Config { name: string; version: number; }
    const cfg: Config = JSON.parse(await Deno.readTextFile("/config.json"));
    console.log(cfg.name, cfg.version);
  `,
});

console.log(result.stdout);  // saída do programa
console.log(result.stderr);  // erros
console.log(result.exitCode); // 0 = sucesso
```

### Via shell

```ts
// Rodar arquivo TypeScript
await runtime.shell.exec("deno run /src/app.ts");

// Avaliar expressão
await runtime.shell.exec('deno eval "console.log(Deno.version)"');

// Verificar versão
await runtime.shell.exec("deno --version");
// deno 2.3.5 (stable, release, x86_64-unknown-linux-gnu)
// v8 13.7.152.6-rusty
// typescript 5.8.3
```

### Configurar headers COOP/COEP (browser)

Para usar o Deno real no browser, o servidor precisa retornar:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

```ts
import { getRequiredHeaders, checkBrowserSupport } from "wexel";

// Verificar suporte
const { ok, missing } = checkBrowserSupport();
if (!ok) console.warn("Recursos ausentes:", missing);

// Headers necessários
const headers = getRequiredHeaders();
// { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" }
```

---

## Gerenciador de pacotes

O Wexel 3.0 suporta `npm install`, `pnpm install` e `deno add` nativamente:

```ts
// Via shell
runtime.permissions.network = true;

await runtime.shell.exec("npm install lodash");
await runtime.shell.exec("pnpm install axios");
await runtime.shell.exec("deno add jsr:@std/path");
await runtime.shell.exec("deno add npm:zod");

// Instalar dependências do package.json no VFS
runtime.fs.write("/package.json", JSON.stringify({
  dependencies: { lodash: "latest", axios: "latest" }
}));
await runtime.shell.exec("npm install");

// Instalar dependências do deno.json no VFS
runtime.fs.write("/deno.json", JSON.stringify({
  imports: { "@std/path": "jsr:@std/path" }
}));
await runtime.shell.exec("deno install");
```

---

## Git

Cinco comandos Git completos integrados ao VFS:

```ts
runtime.permissions.network = true;

// git clone — GitHub e GitLab via API REST
const result = await runtime.shell.exec(
  "git clone https://github.com/denoland/deno_std meu-projeto"
);
console.log(result.stdout);
// Cloning into 'meu-projeto'...
// 42 arquivo(s) clonado(s) em /meu-projeto

// git status
await runtime.shell.exec("git status");
// On branch main
// nothing to commit, working tree clean

// git log
await runtime.shell.exec("git log --oneline -5");
// abc1234 clone from https://github.com/...

// git diff
await runtime.shell.exec("git diff src/index.ts");

// git commit
await runtime.shell.exec('git commit -m "feat: nova funcionalidade"');
// [main abc1234] feat: nova funcionalidade
//  3 file(s) changed
```

### Repositórios privados

```ts
const runtime = await Wexel.create({
  gitToken: "ghp_seuTokenAqui",
  permissions: { network: true },
});

await runtime.shell.exec("git clone https://github.com/sua-org/repo-privado");
```

---

## curl e wget

```ts
runtime.permissions.network = true;

// GET simples
const result = await runtime.shell.exec("curl https://api.github.com/users/denoland");
console.log(result.stdout); // JSON da resposta

// POST com JSON
await runtime.shell.exec(`curl -X POST https://api.exemplo.com/dados \
  -H "Content-Type: application/json" \
  -d '{"nome":"Wexel","versao":3}'`);

// Salvar no VFS com -o
await runtime.shell.exec("curl -o /downloads/dados.json https://api.exemplo.com/dados");
const dados = runtime.fs.readText("/downloads/dados.json");

// Silencioso + seguir redirects
await runtime.shell.exec("curl -s -L https://exemplo.com/arquivo.txt -o /tmp/arquivo.txt");

// Incluir headers na resposta
await runtime.shell.exec("curl -i https://httpbin.org/get");

// Atalho --json (POST com Content-Type: application/json automático)
await runtime.shell.exec(`curl --json '{"chave":"valor"}' https://api.exemplo.com`);

// wget (convertido internamente para curl)
await runtime.shell.exec("wget -O /tmp/arquivo.html https://exemplo.com");
```

---

## Shell Linux modernizado

O `runtime.shell.exec()` suporta 40+ comandos Linux:

```ts
// Navegação
await runtime.shell.exec("pwd");
await runtime.shell.exec("cd /workspace");
await runtime.shell.exec("ls -la");
await runtime.shell.exec("find / -name '*.ts'");

// Manipulação de arquivos
await runtime.shell.exec("mkdir -p /projeto/src/utils");
await runtime.shell.exec("touch /projeto/src/index.ts");
await runtime.shell.exec("cp /projeto/src/index.ts /backup/index.ts");
await runtime.shell.exec("mv /tmp/rascunho.ts /projeto/src/final.ts");
await runtime.shell.exec("rm /tmp/lixo.txt");

// Leitura e busca
await runtime.shell.exec("cat /projeto/src/index.ts");
await runtime.shell.exec("head -20 /projeto/src/index.ts");
await runtime.shell.exec("tail -10 /projeto/src/index.ts");
await runtime.shell.exec("grep -i 'function' /projeto/src/index.ts");
await runtime.shell.exec("wc /projeto/src/index.ts");
await runtime.shell.exec("sort /lista.txt");
await runtime.shell.exec("sort -r /lista.txt");
await runtime.shell.exec("uniq /duplicados.txt");

// Escrita
await runtime.shell.exec("echo 'Olá, Wexel 3.0!' > /hello.txt");
await runtime.shell.exec("printf 'linha1\\nlinha2\\n' > /multi.txt");

// Info do sistema
await runtime.shell.exec("whoami");      // wexel
await runtime.shell.exec("uname -a");    // Linux wexel-sandbox 6.1.0-wexel ...
await runtime.shell.exec("hostname");    // wexel-sandbox
await runtime.shell.exec("date");
await runtime.shell.exec("env");

// Disco e quota
await runtime.shell.exec("df");
await runtime.shell.exec("du /projeto");
await runtime.shell.exec("wexel quota");
// Usado: 1.2 MB / 5.0 GB (0%)

// Hash e encoding
await runtime.shell.exec("sha256sum /projeto/src/index.ts");
await runtime.shell.exec("md5sum /arquivo.bin");
await runtime.shell.exec("base64 /imagem.png");

// Processos e utilitários
await runtime.shell.exec("sleep 1");
await runtime.shell.exec("ps");
await runtime.shell.exec("true");
await runtime.shell.exec("false");
await runtime.shell.exec("clear");

// Ajuda
await runtime.shell.exec("help");
```

### Tokenizador com suporte a aspas e escapes

```ts
// Aspas simples
await runtime.shell.exec("echo 'texto com espaços'");

// Aspas duplas
await runtime.shell.exec('echo "texto com $variavel"');

// Escape de caracteres
await runtime.shell.exec("echo linha1\\nlinha2");

// Variáveis de ambiente inline
await runtime.shell.exec("NODE_ENV=production deno run /app.ts");
```

---

## Filesystem virtual

```ts
// Escrever
runtime.fs.write("/src/app.ts", `
  const msg: string = "Olá do Wexel 3.0";
  console.log(msg);
`);

// Ler texto
const code = runtime.fs.readText("/src/app.ts");

// Ler bytes
const bytes = runtime.fs.read("/imagem.png");

// Verificar existência
if (runtime.fs.exists("/config.json")) {
  const cfg = JSON.parse(runtime.fs.readText("/config.json"));
}

// Navegar
runtime.fs.mkdir("/projeto/src/utils");
runtime.fs.cd("/projeto");
console.log(runtime.fs.pwd()); // /projeto
console.log(runtime.fs.list()); // ["src"]

// Home
console.log(runtime.fs.home); // /home/wexel

// Quota
const { usedBytes, limitBytes } = runtime.fs.quota;
console.log(`${usedBytes} / ${limitBytes} bytes`);

// Snapshot (para persistência)
const files = runtime.fs.snapshot();
for (const { path, data } of files) {
  console.log(path, data.byteLength, "bytes");
}

// Remover
runtime.fs.remove("/tmp/lixo");
```

---

## CPython

```ts
// Executar código Python
const result = await runtime.exec({
  language: "python",
  code: `
import json
data = {"wexel": True, "version": 3}
print(json.dumps(data))
  `,
});
console.log(result.stdout); // {"wexel": true, "version": 3}

// Executar arquivo Python do VFS
runtime.fs.write("/scripts/hello.py", "print('Olá do CPython 3.14.7')");
await runtime.shell.exec("python3 /scripts/hello.py");

// pip install
runtime.permissions.network = true;
await runtime.shell.exec("pip install requests");
await runtime.shell.exec("pip3 install numpy");
```

---

## BusyBox

```ts
import { createBusyBoxRunner } from "wexel";

const busybox = await createBusyBoxRunner({
  source: busyboxWasmBytes,
});

const result = await busybox.run("ls -la /");
console.log(result.stdout);
```

---

## RustV

```ts
import { RustV } from "wexel";

const rustv = await RustV.load({
  source:      rustvBytes,
  expectedAbi: 20001,
});

console.log(rustv.version()); // 20001
console.log(rustv.add(20, 22)); // 42
console.log(rustv.exitCode()); // 0
```

---

## Compilar C/C++ para WASM

```ts
import { compileNativeSource } from "wexel";

// C++
await compileNativeSource({
  source: "./math.cpp",
  output: "./math.wasm",
  flags:  ["-Wl,--export=add"],
});

// C
await compileNativeSource({
  source: "./multiply.c",
  output: "./multiply.wasm",
});

// Carregar o módulo gerado
const mod = await runtime.loadModule(await readFile("./math.wasm"));
console.log(mod.exports.add(20, 22)); // 42
```

---

## Extensões nativas WASM

```ts
const extension = await runtime.loadNativeExtension(
  {
    name:         "math-extension",
    version:      "3.0.0",
    abi:          "wexel-3",
    entry:        "math.wasm",
    sha256:       "hash-hex-opcional",
    commands:     ["add", "multiply"],
    dependencies: [],
  },
  mathWasmBytes,
);

// Invocar export
const result = runtime.extensions.invoke("math-extension", "add", [20, 22]);
console.log(result); // 42

// Listar extensões carregadas
console.log(runtime.extensions.list());

// CLI nativa
await runtime.shell.exec("native-cli version");
await runtime.shell.exec("native-cli add 20 22"); // 42
```

---

## V9 — Documentos HTML/CSS

```ts
const html = runtime.createWebDocument({
  title: "Minha interface",
  body:  "<main><h1>Wexel 3.0</h1><p>Rodando no browser.</p></main>",
  css:   "body { font-family: sans-serif; padding: 2rem; background: #0f0f0f; color: #fff; }",
});

const frame = document.createElement("iframe");
frame.srcdoc = html;
document.body.append(frame);
```

---

## WebPink — Rede controlada entre sandboxes

```ts
import { WebPink } from "wexel";

const pink = new WebPink({
  allowHosts:       ["api.exemplo.com"],
  maxResponseBytes: 1 * 1024 * 1024, // 1MB
  timeoutMs:        5_000,
});

// Sandbox com política de rede restrita
const runtime = await Wexel.create({
  permissions: { network: true },
  networkFetch: pink.fetch.bind(pink),
});
```

---

## Sandboxes Node.js isolados

```ts
import { NodeExecution } from "wexel/node";

const executor = new NodeExecution();

// Criar sandbox isolada com Deno
const sandbox = await executor.createSandbox({
  permissions: { network: false },
  storageQuotaBytes: 100 * 1024 * 1024, // 100MB
});

// Rodar Deno na sandbox
const result = await sandbox.runtime.exec({
  language: "typescript",
  code: `console.log("Deno rodando em sandbox isolada");`,
});

console.log(result.stdout);
await sandbox.dispose();
```

---

## Eventos do BuzzBox

```ts
runtime.buzz.on("runtime:ready",    (p) => console.log("pronto", p));
runtime.buzz.on("module:loaded",    (p) => console.log("módulo", p));
runtime.buzz.on("extension:loaded", (p) => console.log("extensão", p));
runtime.buzz.on("script:loaded",    (p) => console.log("script", p));
```

---

## Modo `load-only`

```ts
const runtime = await Wexel.loadOnly({ coreBytes });

console.log(runtime.mode); // "load-only"

// exec() não executa — apenas emite "script:loaded"
await runtime.exec({ language: "python", code: "print('não executa')" });
```

---

## Build e desenvolvimento

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test

# Binário do Deno (baixar para outras plataformas)
node scripts/prepare-deno-wasm.mjs

# Build de componentes individuais
pnpm build:busybox
./scripts/build-rustv.sh
./scripts/build-native-cli.sh
```

---

## Resumo da API 3.0

| API | Descrição |
|---|---|
| `Wexel.create(opts)` | Cria runtime em modo execução. |
| `Wexel.loadOnly(opts)` | Carrega sem executar. |
| `runtime.exec({ language, code, file, args })` | Executa código (python, javascript, typescript). |
| `runtime.shell.exec(command)` | Shell Linux com 40+ comandos. |
| `runtime.deno(args)` | Interface direta ao Deno (run, eval, add, --version). |
| `runtime.gitExec(args)` | Git: clone, status, log, diff, commit. |
| `runtime.curlExec(args)` | curl/wget com rede real. |
| `runtime.denoPackages(argv)` | npm/pnpm/deno add. |
| `runtime.node(args)` | Executa JS via Deno (compat Node). |
| `runtime.bash(args)` | Delega para bashRunner. |
| `runtime.fs.*` | VFS: write, read, mkdir, cd, list, exists, snapshot, quota. |
| `runtime.packages.pip(args)` | pip install via VFS. |
| `runtime.loadModule(source)` | Instancia módulo WASM. |
| `runtime.loadNativeExtension(manifest, bytes)` | Extensão WASM validada. |
| `runtime.createWebDocument(doc)` | HTML/CSS via V9. |
| `runtime.extensions.invoke(name, fn, args)` | Invoca export de extensão. |
| `DenoRuntime.create(opts)` | Runtime Deno unificado (browser + Node). |
| `DenoBrowserHost.create(fs, opts)` | Deno real no browser via SW + SAB. |
| `installDenoServiceWorker()` | Instala SW para VFS no browser. |
| `checkBrowserSupport()` | Verifica SAB + crossOriginIsolated. |
| `RustV.load(opts)` | Motor Rust WASM. |
| `compileNativeSource(opts)` | Compila C/C++ para WASM. |
| `createBusyBoxRunner(opts)` | BusyBox WASM. |
