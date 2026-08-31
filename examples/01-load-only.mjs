import { readFile } from "node:fs/promises";
import { Wexel } from "../packages/wexel/dist/index.js";
const coreBytes = await readFile(new URL("../packages/wexel/assets/core.wasm", import.meta.url));
const runtime = await Wexel.create({ mode: "load-only", coreBytes });
console.log("Wexel carregado sem executar scripts:", runtime.mode);
