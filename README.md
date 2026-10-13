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
- **New in 4.0:** real Linux kernel compiled to WebAssembly (NOMMU), running a genuine BusyBox shell inside `NodeExecution` via `worker_threads`
- **New in 4.0:** shell now runs on the real BusyBox inside that kernel instead of a 40-command reimplementation
- **New in 4.0:** `pip` (real, unmodified) working through a WebPink-aware network adapter
- **Go and Zig source execution:** the runtime exposes `runtime.exec({ language: "go" | "zig", file: "/home/main.go" })` and a versioned Wexel Language Executor ABI that reads source files from the VFS. The host-side bridge is implemented; actual Go/Zig ABI-v1 executor artifacts still need to be bundled. See [`docs/go-zig-wasm.md`](docs/go-zig-wasm.md).
- Virtual shell with `~` and configurable home directories
- Git built-in: `clone`, `status`, `log`, `diff`, `commit` (GitHub + GitLab)
- curl/wget built-in com rede real (`-X`, `-H`, `-d`, `-o`, `-L`, `--json`)
- npm and pnpm through the real package managers bundled in Wexel.js
- Isolated backend sandboxes through `NodeExecution`
- Per-sandbox permissions and storage quotas
- Controlled networking through WebPink
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

The repository is structured as an npm workspace containing the public `wexel` package and the internal `@wexel/core` package.

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

Wexel 4.0 is organized around several execution layers:

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
    ├── Wexel.js (Edge.js + QuickJS-NG, Node-compatible)
    ├── Linux kernel (WebAssembly, NOMMU) + BusyBox
    ├── CPython / WASI
    ├── Native WASM Extensions
    └── V9
```

See `packages/wexel/assets/README-4.0.md` for details on the new 4.0 artifacts
(the compiled kernel, Wexel.js, and their integration points).

Go/Zig VFS-first execution and the Wexel Language Executor ABI v1 are documented in `docs/go-zig-wasm.md`. The older standalone build/run helpers are low-level smoke-test utilities, not the runtime API. Full source execution requires bundled executor artifacts implementing ABI v1; the ordinary Go and Zig program artifacts do not compile arbitrary source files.

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

The shell itself (`runtime.shell`) runs on the real BusyBox binary inside the
Linux kernel compiled to WebAssembly (`assets/linux-kernel/`), wired up via
`kernel-boot.ts` — see `packages/wexel/assets/README-4.0.md` for details.

HTML remains part of the V9 environment rather than the Wexel.js runtime.

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

### Storage quotas and Memory64

**Memory64** is a WebAssembly feature that allows linear memories to use 64-bit address indexes instead of the 32-bit indexes used by traditional WASM32 memories. This makes address spaces larger than 4 GiB possible in compatible engines and toolchains. It does not mean that a runtime automatically has that much physical RAM available. See the [WebAssembly Memory64 proposal](https://github.com/WebAssembly/memory64).

In Wexel, `packages/wexel-core/memory64/` contains an **experimental core target** that separates linear-memory allocation from virtual-filesystem behavior:

- **Memory manager:** controls allocation, memory growth, and the configured maximum.
- **Virtual filesystem (VFS):** requests memory from that manager for file contents and path metadata; it does not grow WebAssembly memory directly.
- **Directory and file operations:** supports normalized absolute paths, directory creation, immediate-child listing, file reads/writes/removal, and removal of empty directories. This is a Linux-like hierarchy, not full POSIX filesystem compatibility.

The experimental target has a configured maximum of **16 GiB of linear memory** and starts at **16 MiB**. The maximum is not reserved at startup. Real growth depends on Memory64 support in the host runtime and available resources. A logical VFS quota limits live file contents, while metadata and allocator overhead also consume linear memory.

**Integration status:** this target has its own build and test under `packages/wexel-core/memory64/`. The normal package still uses the existing WASM32 core until a Memory64-capable runtime path and host ABI integration are completed. The current arena allocator does not reclaim physical linear-memory space after overwrites or removals, so the 16 GiB maximum is not a promise that 16 GiB of file payload can be stored.

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
  linuxKernel, // ver kernel-boot.ts
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

Wexel 4.0 adds Wexel.js (a Node.js-compatible JS runtime based on Edge.js and
QuickJS-NG, compiled through the real WASIX toolchain), a real Linux kernel
compiled to WebAssembly running an actual BusyBox shell inside
`NodeExecution`, a WebPink-aware adapter for the real `pip`, and Go/Zig
toolchain support. See `packages/wexel/assets/README-4.0.md` for details on
the new artifacts and `CHANGELOG.md`-style notes above for prior versions.

Wexel 3.0 introduced the Deno runtime integration, NodeExecution sandbox manager, WebPink networking layer, Linux-like VFS improvements and associated package/export updates.

## License

Wexel is licensed under the Apache License 2.0.

See [`LICENSE.md`](./LICENSE.md) for the complete license text.

4.0.0 shortly 