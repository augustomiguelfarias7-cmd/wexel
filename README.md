# Wexel

[![Version](https://img.shields.io/badge/version-3.0.0-blue)](https://github.com/augustomiguelfarias7-cmd/wexel)
[![License](https://img.shields.io/badge/license-Apache--2.0-green)](https://github.com/augustomiguelfarias7-cmd/wexel/blob/main/LICENSE.md)
[![GitHub stars](https://img.shields.io/github/stars/augustomiguelfarias7-cmd/wexel?style=flat)](https://github.com/augustomiguelfarias7-cmd/wexel/stargazers)
[![GitHub forks](https://img.shields.io/github/forks/augustomiguelfarias7-cmd/wexel?style=flat)](https://github.com/augustomiguelfarias7-cmd/wexel/network/members)
[![GitHub issues](https://img.shields.io/github/issues/augustomiguelfarias7-cmd/wexel?style=flat)](https://github.com/augustomiguelfarias7-cmd/wexel/issues)
[![GitHub pull requests](https://img.shields.io/github/issues-pr/augustomiguelfarias7-cmd/wexel?style=flat)](https://github.com/augustomiguelfarias7-cmd/wexel/pulls)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue?logo=typescript)](https://www.typescriptlang.org/)
[![WebAssembly](https://img.shields.io/badge/WebAssembly-supported-654FF0?logo=webassembly)](https://webassembly.org/)

**Wexel 3.0** is a WebAssembly execution runtime and JavaScript/TypeScript SDK for running controlled embedded runtimes inside applications and backend services.

Wexel provides a virtual filesystem, shell execution, WebAssembly modules, language adapters, isolated Node.js sandboxes, controlled networking and native WebAssembly tooling without requiring application code to directly manage the underlying runtime infrastructure.

## Highlights

- WebAssembly-first execution
- JavaScript and TypeScript through Deno WASM
- Linux-like virtual filesystem
- Virtual shell with `~` and configurable home directories
- Isolated backend sandboxes through `NodeExecution`
- Per-sandbox permissions and storage quotas
- Controlled networking through WebPink
- Internal sandbox-to-sandbox messaging
- CPython WASI integration
- BusyBox WASM integration
- Python package installation through the virtual filesystem
- Native C/C++ to WebAssembly compilation through Emscripten
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

The repository is structured as a pnpm workspace containing the public `wexel` package and the internal `@wexel/core` package.

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

const result = await runtime.shell.exec("cat /app.js");

console.log(result);
```

The runtime operates against its virtual filesystem instead of directly exposing the host filesystem.

## Runtime Architecture

Wexel 3.0 is organized around several execution layers:

```text
Application
    │
    ▼
Wexel Runtime
    │
    ├── Virtual Shell
    ├── Virtual Filesystem
    ├── Permissions
    ├── Storage Quota
    │
    ├── Deno WASM
    ├── CPython / WASI
    ├── BusyBox
    ├── Native WASM Extensions
    └── V9
```

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

Each sandbox is created independently and receives its own runtime instance and virtual filesystem.

## Deno WebAssembly

Wexel 3.0 adds a Deno-compatible WebAssembly runtime through `DenoWasmRuntime`.

The virtual shell exposes the `deno` command and routes JavaScript and TypeScript execution to the Deno WASM runtime.

```ts
import { DenoWasmRuntime, Wexel } from "wexel";

const denoRuntime = await DenoWasmRuntime.instantiate(denoWasm);

const runtime = await Wexel.create({
  coreBytes,
  denoRuntime,
});

runtime.fs.write(
  "/app.ts",
  "console.log('executado pelo Deno');",
);

await runtime.shell.exec("deno run /app.ts");
```

Supported virtual commands include:

```text
deno run <file.js|file.ts> [args]
deno eval <code>
deno --version
```

The Deno WASM adapter verifies its ABI before execution. The current runtime expects ABI `30000` and the required Deno WebAssembly exports.

HTML remains part of the V9 environment rather than the Deno runtime.

## Virtual Filesystem

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

### Storage quotas

Wexel supports logical storage quotas for runtime filesystems.

The quota controls the amount of virtual filesystem storage available to a runtime or sandbox. It should not be interpreted as a reservation of physical RAM or disk on the host.

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
  denoRuntime,
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
  "deno run /app.ts",
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

WebPink can also provide communication between sandboxes.

## CPython and WASI

Wexel includes a CPython WASI integration for Node environments.

The Node adapter can execute CPython WebAssembly through Wasmtime while connecting the Python runtime to Wexel's virtual filesystem.

```ts
import { createWasiPythonRunner } from "wexel/node";

const runPython = createWasiPythonRunner({
  pythonWasm: "/path/to/python.wasm",
  pythonRoot: "/path/to/python-root",
  wasmtime: "wasmtime",
  fs: runtime.fs,
});

console.log(
  await runPython("print(2 + 40)"),
);
```

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

The runner accepts either a URL or a WebAssembly byte source:

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

Wexel includes native source compilation helpers for C and C++ through Emscripten:

```text
C   -> emcc
C++ -> em++
```

Example:

```ts
import { compileNativeSource } from "wexel";

await compileNativeSource({
  source: "/tmp/example.cpp",
  output: "/tmp/example.wasm",
  flags: [
    "-Wl,--export=wexel_add",
  ],
});
```

Emscripten must be available in the environment when native compilation is requested.

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
Deno WASM
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
└── 09-rustv.mjs
```

## API Surface

Main package:

```ts
import {
  Wexel,
  DenoWasmRuntime,
  createBusyBoxRunner,
  compileNativeSource,
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

Wexel is a pnpm workspace.

```bash
pnpm install
```

### Root scripts

```bash
pnpm build
pnpm test
pnpm typecheck
pnpm clean
pnpm build:busybox
```

The root `package.json` defines:

```json
{
  "build": "pnpm --filter @wexel/core build && node scripts/build-core.mjs && pnpm --filter wexel build && mkdir -p packages/wexel/assets && cp packages/wexel-core/dist/core.wasm packages/wexel/assets/core.wasm && node scripts/check-browser-budget.mjs",
  "test": "pnpm --filter wexel test",
  "typecheck": "pnpm --filter wexel typecheck",
  "clean": "rm -rf packages/*/dist",
  "build:busybox": "bash scripts/build-busybox.sh"
}
```

### Wexel package scripts

```bash
pnpm --filter wexel build
pnpm --filter wexel test
pnpm --filter wexel typecheck
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
pnpm build
```

## Tests

```bash
pnpm test
```

Or directly:

```bash
pnpm --filter wexel test
```

## Type Checking

```bash
pnpm typecheck
```

## Clean

```bash
pnpm clean
```

## BusyBox Build

```bash
pnpm build:busybox
```

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
├── scripts/
├── package.json
└── pnpm-workspace.yaml
```

Important runtime components include:

```text
packages/wexel/src/
├── index.ts
├── deno-wasm.ts
├── node-execution.ts
├── node-cpython.ts
├── busybox.ts
├── web-pink.ts
├── native-compiler.ts
├── native-extensions.ts
└── rustv.ts
```

## Security Model

Wexel provides controlled execution primitives, but it should not be treated as a complete kernel-level security boundary.

Some adapters interact with host tooling such as Wasmtime or Emscripten. Applications executing untrusted code should therefore add an appropriate host-level isolation layer around Wexel.

Wexel's permissions, filesystem quotas, virtual filesystem and WebPink policies are execution controls inside the Wexel architecture. They do not automatically replace operating-system isolation.

## Version

Current package version:

```text
3.0.0
```

Wexel 3.0 introduced the Deno WASM runtime, NodeExecution sandbox manager, WebPink networking layer, Linux-like VFS improvements and associated package/export updates.

## License

Wexel is licensed under the Apache License 2.0.

See [`LICENSE.md`](./LICENSE.md) for the complete license text.
