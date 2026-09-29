/**
 * Smoke: carrega binários WASM do asset (sem Wasmtime).
 * node examples/10-asset-loader.mjs
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const assets = join(root, "packages/wexel/assets");
const catalog = {
  core: join(assets, "core.wasm"),
  busybox: join(assets, "busybox/busybox.wasm"),
  python: join(assets, "cpython-3.14.7/python.wasm"),
};

console.log("Wexel asset loader — smoke (sem Wasmtime)\n");
for (const [id, path] of Object.entries(catalog)) {
  try {
    const bytes = await readFile(path);
    let note = "ok";
    if (id === "core") {
      const { instance } = await WebAssembly.instantiate(bytes, {});
      note = `instantiate ok exports=${Object.keys(instance.exports).join(",")}`;
    }
    console.log(`✓ ${id.padEnd(14)} ${String(bytes.byteLength).padStart(10)} bytes  ${note}`);
  } catch (err) {
    console.log(`✗ ${id.padEnd(14)} ${err instanceof Error ? err.message : err}`);
  }
}
