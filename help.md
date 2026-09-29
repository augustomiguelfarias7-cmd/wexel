# Wexel 3.0 — Referência completa da API

O **Wexel 3.0** é um runtime modular baseado no Wexel Assembly. Ele fornece filesystem virtual, shell Linux modernizado, Deno nativo no Node.js e uma arquitetura Deno WASM dedicada para browser/Node, Git, curl, gerenciadores de pacotes, CPython, BusyBox, RustV, extensões WASM e sandboxes Node.js isoladas.

## Instalação

```bash
npm install git+https://github.com/augustomiguelfarias7-cmd/wexel.git
```

---

## DenoRuntime — Deno nativo no Node e Deno WASM no browser

O `DenoRuntime` separa explicitamente os dois caminhos. No Node.js, o Wexel pode usar o binário Deno nativo. No browser, o caminho suportado é um módulo Deno WASM real dentro de um DedicatedWorker, conectado ao VFS/rede pelo Linux Adapter.

```ts
import { DenoRuntime, Wexel } from "wexel";

const denoRuntime = DenoRuntime.create({
  fs: runtime.fs,
  networkAllowed: true,
  timeoutMs: 30_000,
  // browser: aponte para um artefato Deno WASM real
  denoWasmUrl: "/assets/deno.wasm",
});

const runtime = await Wexel.create({ deno: denoRuntime });
```

### Node.js / NodeExecution

- Usa o binário nativo do Deno preparado por `scripts/prepare-deno-native.mjs`.
- O executável é mantido separado do artefato WASM.
- O VFS é materializado no diretório temporário da sandbox.
- As permissões de leitura, escrita e rede são controladas pelo Wexel.

### Browser

```text
Browser
  └── DedicatedWorker
       └── Wexel WASM Host
            └── Deno WASM real
                 └── Linux/Wexel Adapter
                      ├── VFS → SharedArrayBuffer
                      ├── Network → WebPink/Fetch
                      ├── stdout/stderr → Wexel I/O
                      ├── env → Wexel environment
                      └── process/cwd → Wexel process layer
```

O `DenoLinuxAdapter` é uma ponte de host. Ele não cria um objeto global `Deno`, não executa `new Function()` e não transforma um executável nativo em WebAssembly.

O `DenoWasmHost` valida o magic header WASM, instancia o módulo e fornece a fronteira de imports. Para executar código JavaScript/TypeScript, o artefato Deno precisa expor um entrypoint compatível com a ABI Wexel. Instanciar um módulo WASM arbitrário não é, por si só, um runtime Deno.

### Preparar Deno nativo

```bash
node scripts/prepare-deno-native.mjs
```

Esse comando prepara somente o executável nativo. Ele **não** produz `.wasm`.

### Preparar um artefato Deno WASM

O repositório possui `scripts/prepare-deno-wasm-asset.mjs` para validar/descompactar um artefato WASM já fornecido:

```bash
DENO_WASM_GZ=/caminho/deno.wasm.gz npm run prepare:deno-wasm
```

Se o arquivo descompactado não começar com o magic header `00 61 73 6d`, o processo falha. Um ELF/PE/Mach-O nativo não é convertido para WASM por gzip.

---

## Linux Adapter e WASM Host

As APIs estão expostas diretamente:

```ts
import {
  DenoLinuxAdapter,
  instantiateDenoWasm,
  loadDenoWasm,
} from "wexel";

const adapter = new DenoLinuxAdapter({
  fs: runtime.fs,
  networkAllowed: true,
});

const host = await loadDenoWasm("/assets/deno.wasm", { adapter });
console.log(host.adapterAbi);

// liberar canais VFS/rede
adapter.dispose();
```

A lista de host calls é explícita: filesystem, ambiente, stdout/stderr, processo e rede. O módulo WASM precisa ser compilado para essa ABI ou para uma ABI adaptadora compatível.

---

## Executar código Deno

A execução efetiva depende do backend escolhido. No Node, o Deno nativo é executável. No browser, o Wexel não usa fallback para shim JavaScript ou Deno nativo do Node.

```ts
const result = await runtime.exec({
  language: "typescript",
  code: `console.log(Deno.version);`,
});

console.log(result.stdout);
console.log(result.stderr);
console.log(result.exitCode);
```

---

## Build e desenvolvimento

```bash
npm install
npm run build
npm run typecheck
npm test

# Preparar o Deno nativo para NodeExecution
node scripts/prepare-deno-native.mjs

# Validar/descompactar um Deno WASM já fornecido
npm run prepare:deno-wasm

# Build de componentes individuais
npm run build:busybox
./scripts/build-rustv.sh
./scripts/build-native-cli.sh
```

> O README não é atualizado por estas mudanças de arquitetura. Esta referência concentra a documentação detalhada.

---

## Outras APIs

O restante das APIs do Wexel 3.0 continua disponível, incluindo VFS, shell, CPython, BusyBox, RustV, C/C++ para WASM, Git, curl, WebPink, extensões WASM e NodeExecution.
