#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import fs from "node:fs";
import { webcrypto } from "node:crypto";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";

const wasmPath = process.argv[2];
if (!wasmPath) {
  console.error("Usage: node scripts/run-go-wasm.mjs <program.wasm> [program args...]");
  process.exit(2);
}

globalThis.require ??= createRequire(import.meta.url);
globalThis.fs ??= fs;
globalThis.crypto ??= webcrypto;
globalThis.performance ??= performance;
globalThis.TextEncoder ??= TextEncoder;
globalThis.TextDecoder ??= TextDecoder;

const runtimePath = resolve("packages/wexel/assets/go/wasm_exec.js");
await import(runtimePath);
if (typeof globalThis.Go !== "function") {
  throw new Error("Official Go wasm_exec.js did not expose globalThis.Go");
}

const go = new globalThis.Go();
go.argv = [resolve(wasmPath), ...process.argv.slice(3)];
go.env = {};
const bytes = await readFile(wasmPath);
const { instance } = await WebAssembly.instantiate(bytes, go.importObject);
await go.run(instance);
