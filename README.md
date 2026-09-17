# Wexel

Wexel 3.0 is a WebAssembly execution runtime and JavaScript/TypeScript SDK for running controlled embedded runtimes inside applications and backend services.

Wexel provides a virtual filesystem, shell execution, WebAssembly modules, language adapters, isolated Node.js sandboxes, controlled networking and native WebAssembly tooling without requiring application code to directly manage the underlying runtime infrastructure.

Highlights

- WebAssembly-first execution
- JavaScript and TypeScript through Deno WASM
- Linux-like virtual filesystem
- Virtual shell with "~" and configurable home directories
- Isolated backend sandboxes through "NodeExecution"
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
- Load-only mode for controlled initialization
- TypeScript API

Installation

For a project that consumes the package directly from Git, use:

npm install git+https://github.com/augustomiguelfarias7-cmd/wexel.git

The repository is structured as a workspace containing the public "wexel" package and the internal "@wexel/core" package.

Quick Start

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

The runtime operates against its virtual filesystem instead of directly exposing the host filesystem.

Runtime Architecture

Wexel 3.0 is organized around several execution layers:

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

For backend applications, "NodeExecution" adds another layer:

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

Each sandbox is created independently and receives its own runtime instance and virtual filesystem.

Deno WebAssembly

Wexel 3.0 adds a Deno-compatible WebAssembly runtime through "DenoWasmRuntime".

The virtual shell exposes the "deno" command and routes JavaScript and TypeScript execution to the Deno WASM runtime.

import { DenoWasmRuntime, Wexel } from "wexel";

const denoRuntime = await DenoWasmRuntime.instantiate(denoWasm);

const runtime = await Wexel.create({
  denoRuntime,
});

runtime.fs.write(
  "/app.ts",
  "console.log('executado pelo Deno');",
);

await runtime.shell.exec("deno run /app.ts");

Supported virtual commands include:

deno run <file.js|file.ts> [args]
deno eval <code>
deno --version

The Deno WASM adapter verifies its ABI before execution. The current runtime expects ABI "30000" and the required Deno WebAssembly exports.

HTML execution remains part of the V9 environment rather than the Deno runtime.

Virtual Filesystem

Wexel provides a Linux-like virtual filesystem.

A runtime starts with directories such as:

/bin
/home
/tmp
/usr
/var
/site-packages

The default home directory is:

/home/wexel

The "~" shell alias resolves to the active runtime home.

const runtime = await Wexel.create({
  coreBytes,
});

await runtime.shell.exec("pwd");
await runtime.shell.exec("touch ~/app.ts");
await runtime.shell.exec("cd ~");

The filesystem is virtual. Operations against these paths do not automatically access the host filesystem.

Storage quotas

Wexel supports logical storage quotas for runtime filesystems.

The quota controls the amount of virtual filesystem storage available to a runtime or sandbox. It should not be interpreted as a reservation of physical RAM or disk on the host.

NodeExecution

"NodeExecution" is the backend orchestration layer introduced in Wexel 3.0.

It is designed for Node.js applications such as:

- Express applications
- Fastify applications
- HTTP APIs
- backend services
- custom Node.js servers

Import it through:

import { NodeExecution } from "wexel/node-execution";

Create an execution manager:

const execution = await NodeExecution.create({
  coreBytes,
  denoRuntime,
});

Create an isolated sandbox:

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

A sandbox contains its own:

- Wexel runtime
- virtual filesystem
- home directory
- permissions
- storage quota
- WebAssembly instance
- optional WebPink client

Creating a sandbox only initializes its execution environment. User code is not automatically executed.

Sandbox lifecycle

const sandbox = await execution.createSandbox();

execution.getSandbox(sandbox.id);

execution.listSandboxes();

execution.destroySandbox(sandbox.id);

await execution.dispose();

By default, a sandbox receives a home directory based on its identifier:

/home/<sandbox-id>

WebPink

WebPink is Wexel's controlled network gateway.

Instead of giving a sandbox unrestricted access to the host network, WebPink provides a controlled network layer with policies such as:

- allowed hosts
- request timeout
- response-size limits
- sandbox-specific network policies
- internal sandbox messaging

Example:

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

WebPink can also provide communication between sandboxes:

const api = await execution.createSandbox({
  permissions: {
    network: true,
  },
});

const worker = await execution.createSandbox({
  webPink: {
    allowInternal: true,
  },
});

api.webPink?.send(worker.id, {
  type: "process-job",
  id: "42",
});

const messages = worker.webPink?.receive();

This makes WebPink suitable for controlled micro-network patterns between isolated execution environments.

CPython and WASI

Wexel includes a CPython WASI integration for Node environments.

The Node adapter can execute CPython WebAssembly through Wasmtime while connecting the Python runtime to Wexel's virtual filesystem.

Example:

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

The Wexel 3.0 changes also improve temporary-directory cleanup and process shutdown handling in the Node CPython adapter.

Python Packages

Wexel provides Python package installation through the virtual filesystem.

The package layer can:

1. Query package metadata.
2. Select compatible universal or WebAssembly wheels.
3. Verify SHA-256 hashes.
4. Extract package files.
5. Install them into the virtual filesystem.

Packages are installed into:

/site-packages

The installer does not execute arbitrary "setup.py" installation logic.

BusyBox

Wexel supports the real Emscripten-built BusyBox WebAssembly runtime.

BusyBox can provide shell functionality inside the Wexel execution environment.

The runner accepts either a URL or a WebAssembly byte source:

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

The byte-based form is useful for Node environments where loading a local "file:" URL through "fetch()" is undesirable.

Native C and C++

Wexel includes native source compilation helpers for C and C++.

Compilation is performed through Emscripten:

C   -> emcc
C++ -> em++

Example:

import { compileNativeSource } from "wexel";

await compileNativeSource({
  source: "/tmp/example.cpp",
  output: "/tmp/example.wasm",
  flags: [
    "-Wl,--export=wexel_add",
  ],
});

The compiler helper detects C and C++ source extensions and produces WebAssembly output suitable for subsequent execution.

Emscripten must be available in the environment when native compilation is requested.

RustV

RustV provides a small adapter for precompiled Rust WebAssembly modules.

It verifies the module ABI and exposes the exported RustV functions.

import { RustV } from "wexel";

const rust = await RustV.load({
  source: rustWasm,
});

console.log(rust.version());
console.log(rust.add(2, 40));

RustV is an execution adapter for compiled Rust WebAssembly modules. It is not a Rust compiler.

Native WebAssembly Extensions

Wexel can load native WebAssembly extensions through extension manifests and binary sources.

Backend sandboxes can receive configured extensions through "NodeExecution":

const execution = await NodeExecution.create({
  coreBytes,
  nativeExtensions: [
    {
      manifest,
      source: extensionWasm,
    },
  ],
});

This allows applications to package specialized WebAssembly capabilities alongside their sandbox configuration.

V9

V9 is Wexel's HTML/CSS execution environment.

It is responsible for rendering web documents inside the Wexel environment while JavaScript and TypeScript execution can be delegated to the Deno WASM runtime.

The separation is intentional:

HTML/CSS
   │
   ▼
  V9

JavaScript/TypeScript
   │
   ▼
Deno WASM

Load-only Mode

Wexel supports a load-only runtime mode.

In this mode, the WebAssembly core and configured components can be loaded without immediately enabling normal execution.

This can be useful for services that want to:

- initialize runtime state first
- keep execution disabled until explicitly requested
- control when permissions are enabled
- create managed runtime pools

Examples

The repository currently contains the following examples:

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

These examples cover runtime loading, WebAssembly modules, Python, BusyBox, native compilation and RustV.

API Surface

The main package exports the core runtime and execution features:

import {
  Wexel,
  DenoWasmRuntime,
  createBusyBoxRunner,
  compileNativeSource,
  RustV,
} from "wexel";

Backend execution is available through the dedicated export:

import { NodeExecution } from "wexel/node-execution";

BusyBox can also be imported through:

import { createBusyBoxRunner } from "wexel/busybox";

Node CPython support is exposed through:

import { createWasiPythonRunner } from "wexel/node";

Development

Wexel is a pnpm workspace.

Install the repository dependencies with:

pnpm install

Root scripts

The root "package.json" defines these scripts:

pnpm build
pnpm test
pnpm typecheck
pnpm clean
pnpm build:busybox

Their actual definitions are:

{
  "build": "pnpm --filter @wexel/core build && node scripts/build-core.mjs && pnpm --filter wexel build && mkdir -p packages/wexel/assets && cp packages/wexel-core/dist/core.wasm packages/wexel/assets/core.wasm && node scripts/check-browser-budget.mjs",
  "test": "pnpm --filter wexel test",
  "typecheck": "pnpm --filter wexel typecheck",
  "clean": "rm -rf packages/*/dist",
  "build:busybox": "bash scripts/build-busybox.sh"
}

Wexel package scripts

Inside "packages/wexel", the package defines:

pnpm --filter wexel build
pnpm --filter wexel test
pnpm --filter wexel typecheck

The actual package scripts are:

{
  "build": "tsc -p tsconfig.json",
  "test": "vitest run",
  "typecheck": "tsc -p tsconfig.json --noEmit"
}

Build

Build the complete project with:

pnpm build

This builds the core package, generates the Wexel core WebAssembly artifact, builds the main package, copies the generated core into the package assets and runs the browser budget check.

Tests

Run the Wexel test suite with:

pnpm test

Or directly:

pnpm --filter wexel test

The Wexel 3.0 PR used the package test suite to cover core runtime creation, shell behavior, VFS home handling, Deno routing, NodeExecution lifecycle and WebPink behavior.

Type checking

pnpm typecheck

Clean

pnpm clean

BusyBox build

pnpm build:busybox

Project Structure

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

Important runtime components include:

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

Security Model

Wexel provides controlled execution primitives, but it should not be treated as a complete kernel-level security boundary.

Some adapters interact with host tooling such as Wasmtime or Emscripten. Applications executing untrusted code should therefore add an appropriate host-level isolation layer around Wexel.

Wexel's permissions, filesystem quotas, virtual filesystem and WebPink policies are execution controls inside the Wexel architecture. They do not automatically replace operating-system isolation.

Version

Current package version:

3.0.0

Wexel 3.0 introduced the Deno WASM runtime, NodeExecution sandbox manager, WebPink networking layer, Linux-like VFS improvements and the associated package/export updates.

License

See the repository license for the terms applicable to Wexel.
