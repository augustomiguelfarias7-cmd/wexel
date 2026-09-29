/**
 * prepare-deno-wasm-asset.mjs
 *
 * Prepara um artefato Deno WASM comprimido para o runtime Wexel.
 *
 * Entrada padrão:
 *   packages/wexel/assets/deno/deno.wasm.gz
 *
 * Saída:
 *   packages/wexel/assets/deno/deno.wasm
 *
 * Importante: descomprimir não converte um binário nativo em WASM.
 * O arquivo de entrada precisa ser um WebAssembly válido.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import path from "node:path";
import process from "node:process";
import { createHash } from "node:crypto";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const assetDir = path.join(root, "packages/wexel/assets/deno");
const input = process.env.DENO_WASM_GZ
  ? path.resolve(process.env.DENO_WASM_GZ)
  : path.join(assetDir, "deno.wasm.gz");
const output = process.env.DENO_WASM_OUT
  ? path.resolve(process.env.DENO_WASM_OUT)
  : path.join(assetDir, "deno.wasm");

await mkdir(path.dirname(output), { recursive: true });

const compressed = await readFile(input);
const wasm = gunzipSync(compressed);

if (
  wasm.length < 8 ||
  wasm[0] !== 0x00 ||
  wasm[1] !== 0x61 ||
  wasm[2] !== 0x73 ||
  wasm[3] !== 0x6d
) {
  throw new Error(
    `O artefato descomprimido não é WebAssembly: ${input}. ` +
    "Um executável ELF/nativo não pode ser convertido em WASM apenas por descompressão.",
  );
}

await writeFile(output, wasm);

const sha256 = createHash("sha256").update(wasm).digest("hex");
console.log(`Deno WASM preparado: ${output}`);
console.log(`Tamanho: ${wasm.byteLength} bytes`);
console.log(`SHA-256: ${sha256}`);
