# Wexel

[![Version](https://img.shields.io/badge/version-4.0.0-blue)](https://github.com/augustomiguelfarias7-cmd/wexel)
[![License](https://img.shields.io/badge/license-Apache--2.0-green)](https://github.com/augustomiguelfarias7-cmd/wexel/blob/main/LICENSE.md)
[![GitHub stars](https://img.shields.io/github/stars/augustomiguelfarias7-cmd/wexel?style=flat)](https://github.com/augustomiguelfarias7-cmd/wexel/stargazers)
[![GitHub forks](https://img.shields.io/github/forks/augustomiguelfarias7-cmd/wexel?style=flat)](https://github.com/augustomiguelfarias7-cmd/wexel/network/members)
[![GitHub issues](https://img.shields.io/github/issues/augustomiguelfarias7-cmd/wexel?style=flat)](https://github.com/augustomiguelfarias7-cmd/wexel/issues)
[![GitHub pull requests](https://img.shields.io/github/issues-pr/augustomiguelfarias7-cmd/wexel?style=flat)](https://github.com/augustomiguelfarias7-cmd/wexel/pulls)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue?logo=typescript)](https://www.typescriptlang.org/)
[![WebAssembly](https://img.shields.io/badge/WebAssembly-supported-654FF0?logo=webassembly)](https://webassembly.org/)

**Wexel 4.0** is a WebAssembly execution runtime and JavaScript/TypeScript SDK for running controlled embedded runtimes inside applications and backend services.

Wexel provides a virtual filesystem, shell execution, WebAssembly modules, language adapters, isolated Node.js sandboxes, controlled networking and native WebAssembly tooling without requiring application code to directly manage the underlying runtime infrastructure.

## Highlights

- WebAssembly-first execution
- **New in 4.0:** Wexel.js — Node.js-compatible JS runtime (based on Edge.js + QuickJS-NG), compiled through the real WASIX toolchain, with `npm`/`pnpm` built in
- **Core services:** `@wexel/core` provides Memory64 allocation, the VFS integration point, service management, and runtime lifecycle tracking/recovery. Each Node.js sandbox gets its own WebAssembly Memory64 instance; browser use remains one runtime instance per created environment.
- Optional BusyBox WebAssembly command runner, initialized as part of each sandbox environment
- **New in 4.0:** `pip` (real, unmodified) working through a WebPink-aware network adapter
- **New in 4.0:** Go runs through the Yaegi interpreter compiled to WebAssembly; Zig source is compiled by a Zig compiler also compiled to WebAssembly, then the generated WASI module is stored in the Memory64 VFS and executed. Both toolchains load lazily from bundled assets. See [`docs/go-zig-wasm.md`](docs/go-zig-wasm.md).
- Optional shell service through a configured command runner
- Git built-in: `clone`, `status`, `log`, `diff`, `commit` (GitHub + GitLab)
- curl/wget built-in com rede real (`-X`, `-H`, `-d`, `-o`, `-L`, `--json`)
- npm and pnpm through the real package managers bundled in Wexel.js
- Isolated backend sandboxes through `NodeExecution`
- Per-sandbox permissions and storage quotas
- Controlled networking through WebPink
- **WebPink Netlify:** JSON-based URL allow/deny rules, native local/private-host blocking, HTTP redirect blocking, and request/response limits. See [`docs/webpink-netlify.md`](docs/webpink-netlify.md).
- Internal sandbox-to-sandbox messaging
- CPython WASI integration
- BusyBox WASM integration
- Python package installation through the virtual filesystem
- Native freestanding C/C++ to WebAssembly compilation through Clang/Clang++
- RustV support for precompiled Rust WebAssembly modules
- Native WebAssembly extensions
- V9 HTML/CSS execution environment
- Load-only mode
- TypeScript API

## Installation

For a project that consumes the package directly from Git:

```bash
npm install git+https://github.com/augustomiguelfarias7-cmd/wexel.git
```

The repository is structured as an npm workspace containing the public `wexel` package and `@wexel/core`, which provides the Memory64 core and service lifecycle manager.

## Quick Start

```ts
import { Wexel } from "wexel";

const runtime = await Wexel.create({
  coreBytes,
});

runtime.fs.write(
  "/app.js",
  "console.log('Hello from Wexel');",
);

const source = runtime.fs.readText("/app.js");

console.log(source);
```

The runtime operates against its virtual filesystem instead of directly exposing the host filesystem.

## Runtime Architecture

Wexel 4.0 is organized around several execution layers:

```text
Application
    │
    ▼
Wexel Runtime
    │
    ├── Virtual Shell
    ├── Virtual Filesystem
    │     └── Memory64 core (allocator + VFS)
    ├── WebAssembly artifact manager
    ├── Permissions
    ├── Storage Quota
    │
    ├── Wexel.js (Edge.js + QuickJS-NG, Node-compatible)
    ├── Core service manager
    ├── Runtime lifecycle (starting/running/degraded/recovering/stopped/failed)
    ├── CPython / WASI
    ├── Native WASM Extensions
    └── V9
```

See `packages/wexel/assets/README-4.0.md` for details on the Wexel 4.0 runtime artifacts and their integration points.

Go/Zig execution details and the optional Wexel Language Executor ABI v1 override are documented in `docs/go-zig-wasm.md`. The default Go path interprets source with the third-party Yaegi interpreter; it is not the official Go compiler or an official Go-project interpreter. The default Zig path compiles `.zig` source to `wasm32-wasi` using the bundled Zig v0.11.0 compiler module and stores the generated `.wasm` beside the source in the VFS.

For backend applications, `NodeExecution` adds another layer:

```text
Node.js / Express / Fastify / API
                │
                ▼
          NodeExecution
                │
       ┌────────┼────────┐
       ▼        ▼        ▼
   Sandbox A Sandbox B Sandbox C
       │        │        │
      VFS      VFS      VFS
      WASM     WASM     WASM
      Home     Home     Home
       │        │        │
       └────────┼────────┘
                ▼
             WebPink
```

Each sandbox is created independently and receives its own runtime instance, WebAssembly Memory64 memory, and virtual filesystem. In a browser, a created runtime is one environment with its own memory and VFS.

The runtime exposes `runtime.lifecycle.state` and `runtime.lifecycle.snapshot()` to inspect lifecycle state. `runtime.recoverServices()` attempts to stop and restart registered services; `runtime.shutdown()` stops them and records the terminal state. These APIs recover services while the owning process is alive. A completely exited Node.js process must be detected by the external supervisor, such as the existing WexelOrchester.

### Gestão de artefatos WebAssembly

`runtime.artifacts` centraliza o carregamento, registro, consulta, invocação de exports e descarregamento de módulos WASM. `runtime.loadModule(source, { name, imports })` continua compatível e registra o módulo no gerenciador. O engine WebAssembly do host instancia e executa os módulos; o core Memory64 mantém os arquivos no VFS. O compilador Zig e o interpretador Yaegi são artefatos WASM separados carregados sob demanda, e o `.wasm` produzido por Zig é gravado na VFS.

```ts
runtime.fs.write("/artifacts/ferramenta.wasm", wasmBytes);
const instance = await runtime.loadModuleFromVfs("/artifacts/ferramenta.wasm");
const [artifact] = runtime.artifacts.list();
const version = runtime.artifacts.invoke(artifact.id, "version");
runtime.artifacts.unload(artifact.id); // remove as referências mantidas pelo gerenciador
```

Módulos só podem ser carregados quando `permissions.modules` está habilitada. Imports são explícitos; um módulo WASI ainda precisa de um host WASI compatível fornecido por `imports`.

## Wexel.js

Wexel 4.0 ships Wexel.js — a Node.js-compatible JavaScript/TypeScript runtime
based on Edge.js with QuickJS-NG embedded, compiled through the real WASIX
toolchain (`assets/wexeljs/edgejs.wasm`). It replaces the Deno-based runtime
used in earlier versions. `wexelJsRunner` plugs the engine into a
`WexelRuntime`.

```ts
import { Wexel } from "wexel";

const runtime = await Wexel.create({
  wexelJsRunner: myWexelJsRunner, // executes code via assets/wexeljs/edgejs.wasm
  shellRunner: myShellRunner, // optional command service for runtime.shell
  permissions: { network: true },
});

// JavaScript
await runtime.exec({
  language: "javascript",
  code: `const res = await fetch("https://api.github.com"); console.log(res.status);`,
});

// TypeScript
runtime.fs.write("/app.ts", `
  interface User { login: string; }
  const u: User = { login: "wexel" };
  console.log(u.login);
`);
await runtime.shell.exec("wexeljs run /app.ts");

// Package management (real npm/pnpm bundled in Wexel.js)
await runtime.shell.exec("npm install lodash");
await runtime.shell.exec("pnpm install axios");
```

Supported shell commands:

```text
wexeljs run <file.js|file.ts> [args]
wexeljs eval <code>
wexeljs add <pkg>
wexeljs --version
node <file.js>
npm install <pkg>
pnpm install <pkg>
```

The shell interface (`runtime.shell`) delegates commands to the configured `shellRunner`. In NodeExecution, an optional BusyBox WebAssembly runner can provide this service; it is initialized before the sandbox is made available. No operating-system kernel is required.

HTML remains part of the V9 environment rather than the Wexel.js runtime.

## Virtual Filesystem

The correct acronym used throughout Wexel is **VFS** (Virtual File System).

Wexel provides a Linux-like virtual filesystem.

A runtime starts with directories such as:

```text
/bin
/home
/tmp
/usr
/var
/site-packages
```

The default home directory is:

```text
/home/wexel
```

The `~` shell alias resolves to the active runtime home.

```ts
const runtime = await Wexel.create({
  coreBytes,
});

await runtime.shell.exec("pwd");
await runtime.shell.exec("touch ~/app.ts");
await runtime.shell.exec("cd ~");
```

The filesystem is virtual. Operations against these paths do not automatically access the host filesystem.

### Storage quotas and Memory64

**Memory64** is a WebAssembly feature that allows linear memories to use 64-bit address indexes instead of the 32-bit indexes used by traditional WASM32 memories. This makes address spaces larger than 4 GiB possible in compatible engines and toolchains. The configured 16 GiB maximum is a limit on the module's linear-memory address space: it is not a limit on the host PC's RAM, nor does it reserve 16 GiB of physical RAM. See the [WebAssembly Memory64 proposal](https://github.com/WebAssembly/memory64).

The default Wexel core is the **Memory64 allocator** in `packages/wexel-core/memory64/`. It separates linear-memory allocation from virtual-filesystem metadata:

- **Memory manager:** owns 64-bit allocation, reuses freed blocks, grows memory on demand, and enforces a configured maximum.
- **Virtual filesystem (VFS):** TypeScript manages normalized paths, directory metadata, listings, quota accounting, and snapshots.
- **File payload storage:** file bytes are allocated in the Core's WebAssembly linear memory. Path and directory metadata stay in TypeScript data structures.
- **Logical quota:** the default is **5 GiB**. This is a quota ceiling, not 5 GiB preallocated at startup. Writes consume linear memory on demand, and allocator overhead or runtime limits can prevent reaching the full quota.
- **Directory and file operations:** supports recursive parent creation, listing, reads/writes, file/directory removal, and snapshots. This is a Linux-like hierarchy, not full POSIX compatibility.

The core is built with a maximum of **16 GiB of WebAssembly linear-memory address space** and starts at **16 MiB**. The maximum is not reserved at startup and is not a measurement or cap of the PC's physical RAM. Free-list reuse helps recycle released allocations, but linear memory itself does not shrink after growth.

**Runtime requirement:** Memory64 support varies by engine and version. The core build requires Clang/LLD with the `wasm64` target. Node.js 22 may require `--experimental-wasm-memory64`. The 16 GiB allocator test verifies linear-memory growth; it does not write 16 GiB of file contents. Actual resource use depends on the runtime and host OS. Run `npm run build` and `npm test` from the repository root.
## NodeExecution

`NodeExecution` is the backend orchestration layer introduced in Wexel 3.0.

It is designed for Node.js applications such as:

- Express applications
- Fastify applications
- HTTP APIs
- backend services
- custom Node.js servers

Import it through:

```ts
import { NodeExecution } from "wexel/node-execution";
```

Create an execution manager:

```ts
const execution = await NodeExecution.create({
  coreBytes,
  wexelJsRunner,
  busyBox, // opcional: runner BusyBox WebAssembly para habilitar runtime.shell
});
```

Create an isolated sandbox:

```ts
const sandbox = await execution.createSandbox({
  permissions: {
    network: false,
  },
});

sandbox.runtime.fs.write(
  "/app.ts",
  "console.log('isolated runtime');",
);

const result = await sandbox.runtime.shell.exec(
  "wexeljs run /app.ts",
);

console.log(result);
```

A sandbox contains its own:

- Wexel runtime
- virtual filesystem
- home directory
- permissions
- storage quota
- WebAssembly instance
- optional WebPink client

Creating a sandbox only initializes its execution environment. User code is not automatically executed.

### Sandbox lifecycle

```ts
const sandbox = await execution.createSandbox();

execution.getSandbox(sandbox.id);

execution.listSandboxes();

execution.destroySandbox(sandbox.id);

await execution.dispose();
```

By default, a sandbox receives a home directory based on its identifier:

```text
/home/<sandbox-id>
```

## WebPink

WebPink is Wexel's controlled network gateway.

Instead of giving a sandbox unrestricted access to the host network, WebPink provides a controlled network layer with policies such as:

- allowed hosts
- request timeout
- response-size limits
- sandbox-specific network policies
- internal sandbox messaging

Example:

```ts
const execution = await NodeExecution.create({
  coreBytes,
  webPink: {
    allowHosts: ["api.example.com"],
    requestTimeoutMs: 10_000,
  },
});

const sandbox = await execution.createSandbox({
  permissions: {
    network: true,
  },
});
```

## CPython and WASI

Wexel already includes the CPython 3.14.7 WebAssembly artifact under
`packages/wexel/assets/cpython-3.14.7/`; users do **not** need to create or
compile a second CPython module just to use the bundled integration.

The runtime exposes the `pythonRunner` / `pythonRunnerFactory` hooks. The
repository's current Node.js implementation is
`createWasiPythonRunner` in `packages/wexel/src/node-cpython.ts`, and the
working example is `examples/05-cpython-real-node.mjs`.

The Node.js adapter now instantiates the bundled module through JavaScript's
`WebAssembly` API and the `@bjorn3/browser_wasi_shim` WASI host already listed
as a Wexel dependency. It does not spawn an external process and does not
require a separate Wasmtime installation. The host shim implements a subset of
WASI Preview 1, so compatibility with the bundled CPython build and its system
calls must be verified by running the example and tests. The placeholder
`examples/03-cpython-adapter.mjs` does not run CPython and should not be used
as the real integration example.

## Python Packages

Wexel provides Python package installation through the virtual filesystem.

The package layer can:

1. Query package metadata.
2. Select compatible universal or WebAssembly wheels.
3. Verify SHA-256 hashes.
4. Extract package files.
5. Install them into the virtual filesystem.

Packages are installed into `/site-packages`.

The installer does not execute arbitrary `setup.py` installation logic.

## BusyBox

Wexel supports the Emscripten-built BusyBox WebAssembly runtime.

The runner accepts either a URL or a WebAssembly byte source.

```ts
const busybox = await createBusyBoxRunner(
  BusyBoxModule,
  wasmBytes,
);

const result = await busybox.run({
  args: [
    "busybox",
    "echo",
    "Hello from BusyBox",
  ],
});

console.log(result);
```

## Native C and C++

Wexel can compile freestanding C and C++ directly to WebAssembly with the native Clang/Clang++ toolchain on Node.js:


```text
C   -> clang --target=wasm32
C++ -> clang++ --target=wasm32
```

The generated modules are loaded through Node's WebAssembly API. The current backend is freestanding and does not provide a general-purpose libc/libstdc++ environment by itself.

### MultiC

MultiC lets one `.cpp` source file hold explicit C and C++ sections:

```cpp
// @wexel:c
int main() { return 42; }

// @wexel:cpp
int main() { return 43; }
```

Run it through the Wexel shell with:

```text
multic run program.cpp
```

The sections are compiled concurrently and their results are aggregated deterministically as C first and C++ second. The native runtime artifacts live under `packages/wexel/assets/multic/`.

The C and C++ runtime artifacts are bundled directly in the repository as WebAssembly binaries. They are loaded from `packages/wexel/assets/multic/` and are not generated as part of the normal Wexel build.

## RustV

RustV provides an adapter for precompiled Rust WebAssembly modules.

```ts
import { RustV } from "wexel";

const rust = await RustV.load({
  source: rustWasm,
});

console.log(rust.version());
console.log(rust.add(2, 40));
```

RustV is an execution adapter for compiled Rust WebAssembly modules. It is not a Rust compiler.

## Native WebAssembly Extensions

Wexel can load native WebAssembly extensions through extension manifests and binary sources.

```ts
const execution = await NodeExecution.create({
  coreBytes,
  nativeExtensions: [
    {
      manifest,
      source: extensionWasm,
    },
  ],
});
```

## V9

V9 is Wexel's HTML/CSS execution environment.

HTML/CSS rendering is separated from JavaScript and TypeScript execution:

```text
HTML/CSS
   │
   ▼
  V9

JavaScript/TypeScript
   │
   ▼
Wexel.js (Edge.js + QuickJS-NG)
```

## Load-only Mode

Wexel supports a load-only runtime mode for controlled initialization without immediately enabling normal execution.

## Examples

```text
examples/
├── 01-load-only.mjs
├── 02-wasm-module.mjs
├── 03-cpython-adapter.mjs
├── 04-busybox.mjs
├── 05-cpython-real-node.mjs
├── 06-pip-native-install.mjs
├── 07-loader-only.mjs
├── 08-compile-cpp.mjs
├── 09-rustv.mjs
├── 12-node-execution-webpink.mjs
└── 13-vfs-persistent-webpink.mjs
```

## API Surface

Main package:

```ts
import {
  Wexel,
  WexelGit,
  runCurl,
  checkBrowserSupport,
  createBusyBoxRunner,
  compileNativeSource,
  runNativeSource,
  parseMultiC,
  runMultiCSource,
  RustV,
} from "wexel";
```

Backend execution:

```ts
import { NodeExecution } from "wexel/node-execution";
```

Node CPython support:

```ts
import { createWasiPythonRunner } from "wexel/node";
```

## Development

Wexel is an npm workspace.

```bash
npm install
```

### Root scripts

```bash
npm run build
npm test
npm run typecheck
npm run clean
npm run build:busybox
```

The root `package.json` defines:

```json
{
  "build": "npm run build --workspace=@wexel/core && node scripts/build-core.mjs && npm run build --workspace=wexel && mkdir -p packages/wexel/assets && cp packages/wexel-core/dist/core.wasm packages/wexel/assets/core.wasm && node scripts/check-browser-budget.mjs",
  "test": "npm run test --workspace=wexel",
  "typecheck": "npm run typecheck --workspace=wexel",
  "clean": "rm -rf packages/*/dist",
  "build:busybox": "bash scripts/build-busybox.sh"
}
```

### Wexel package scripts

```bash
npm run build --workspace=wexel
npm run test --workspace=wexel
npm run typecheck --workspace=wexel
```

```json
{
  "build": "tsc -p tsconfig.json",
  "test": "vitest run",
  "typecheck": "tsc -p tsconfig.json --noEmit"
}
```

## Build

```bash
npm run build
```

## Tests

```bash
npm test
```

Or directly:

```bash
npm run test --workspace=wexel
```

## Type Checking

```bash
npm run typecheck
```

## Clean

```bash
npm run clean
```

## BusyBox Build

```bash
npm run build:busybox
```

## MultiC Runtime Artifacts

The C and C++ MultiC runtimes are committed directly as WebAssembly artifacts:

```text
packages/wexel/assets/multic/
├── c-runtime.wasm
├── cpp-runtime.wasm
└── manifest.json
```

These binaries are shipped with the repository and are not regenerated automatically during `npm run build`.

## Project Structure

```text
wexel/
├── packages/
│   ├── wexel/
│   │   ├── src/
│   │   ├── test/
│   │   ├── assets/
│   │   └── package.json
│   │
│   └── wexel-core/
│
├── examples/
├── native/
├── runtimes/
│   ├── c-runtime/
│   └── cpp-runtime/
├── scripts/
├── package.json
└── package.json
```

Important runtime components include:

```text
packages/wexel/src/
├── index.ts
├── node-execution.ts
├── node-cpython.ts
├── busybox.ts
├── web-pink.ts
├── native-compiler.ts
├── native-extensions.ts
├── multic.ts
└── rustv.ts
```

## Security Model

Wexel provides controlled execution primitives, but it should not be treated as a complete kernel-level security boundary.

Some adapters interact with host tooling such as Wasmtime, Clang/Clang++, or Emscripten-based components. Applications executing untrusted code should therefore add an appropriate host-level isolation layer around Wexel.

Wexel's permissions, filesystem quotas, virtual filesystem and WebPink policies are execution controls inside the Wexel architecture. They do not automatically replace operating-system isolation.

## Version

Current package version:

```text
4.0.0
```

Wexel 4.0 adds Wexel.js (a Node.js-compatible JS runtime based on Edge.js and QuickJS-NG), the Core Memory64 service manager, a WebPink-aware adapter for real `pip`, and Go/Zig toolchain support. See `packages/wexel/assets/README-4.0.md` for details on the runtime artifacts.

## License

Wexel is licensed under the Apache License 2.0.

See [`LICENSE.md`](./LICENSE.md) for the complete license text.

wexel 5.0 in 6 months 
