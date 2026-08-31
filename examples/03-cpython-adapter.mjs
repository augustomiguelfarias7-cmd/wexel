import { readFile } from "node:fs/promises";
import { Wexel } from "../packages/wexel/dist/index.js";
const coreBytes = await readFile(new URL("../packages/wexel/assets/core.wasm", import.meta.url));
// Substitua este adapter pelo runner do CPython 3.14.7 compilado para WASM.
const runtime = await Wexel.create({
  coreBytes,
  pythonRunner: async (code, args) => {
    throw new Error(`CPython WASM não configurado; script solicitado: ${code.length} bytes, args=${args.length}`);
  },
});
console.log(await runtime.exec({ language: "python", code: "print('Olá do CPython')" }));
