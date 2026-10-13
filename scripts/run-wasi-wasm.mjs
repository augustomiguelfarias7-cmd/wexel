#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { WASI } from "node:wasi";
import { resolve } from "node:path";

const wasmPath = process.argv[2];
if (!wasmPath) {
  console.error("Usage: node scripts/run-wasi-wasm.mjs <program.wasm> [program args...]");
  process.exit(2);
}

const wasi = new WASI({
  version: "preview1",
  args: [resolve(wasmPath), ...process.argv.slice(3)],
  env: {},
  preopens: {},
});
const bytes = await readFile(wasmPath);
const module = await WebAssembly.compile(bytes);
const instance = await WebAssembly.instantiate(module, {
  wasi_snapshot_preview1: wasi.wasiImport,
});
wasi.start(instance);
