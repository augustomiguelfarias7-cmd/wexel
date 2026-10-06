# Deno Runtime WASM experimental

This directory is the reproducible build path for the experimental Wexel Deno runtime.

## Architecture

The integration is intentionally split into layers:

1. Deno runtime / denort layer: build the Deno runtime components for wasm32-unknown-unknown.
2. Deno CLI layer: keep the CLI as a host-side command layer that talks to the runtime artifact instead of forcing the CLI itself into WASM.
3. Package-manager layer: npm/pnpm/npx remain JavaScript tooling and are executed by the Deno runtime once the runtime ABI is working.
4. Wexel host layer: Node.js owns the WebAssembly API in Node Execution; browser execution can later use the same WASM artifact from a Worker.
5. Wexel VFS/network adapters: filesystem, network, process, environment and stdio cross the WASM boundary only through explicit imports.

## Important status

This branch does not pretend that a native denort executable is a WASM module.

The GitHub Actions workflow first probes the real Deno source tree with cargo check for denort and deno_runtime on wasm32-unknown-unknown. Only if the runtime can be built for the target does the workflow attempt to emit a denort.wasm artifact.

The current upstream Deno workspace already performs WASM checks for some supporting crates, while its normal release build produces native denort binaries. The experimental Wexel path therefore treats a successful WASM build as a new target, not as an official Deno release artifact.

## Node.js validation

The resulting module is validated from Node.js because Node Execution is the first Wexel host targeted by this experiment.

The validation checks the WASM magic header, WebAssembly compilation, imports, exports, ABI metadata, and a minimal host instantiation when the produced module is self-contained enough to instantiate.

No JavaScript Deno shim is accepted as a substitute for the runtime artifact.

## Package managers

npm/pnpm/npx are not independently compiled to WASM. They are JavaScript programs. After the runtime artifact is functional, they can be loaded and executed inside the Deno runtime and their filesystem/network operations are routed through Wexel's adapters.

## Source

The upstream source is pinned by the workflow through DENO_REF. The resulting binary is an experimental Wexel artifact and is not represented as an official Deno release.
