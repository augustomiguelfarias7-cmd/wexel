import { readFile } from "node:fs/promises";
import { Wexel } from "../packages/wexel/dist/index.js";
const coreBytes = await readFile(new URL("../packages/wexel/assets/core.wasm", import.meta.url));
const runtime = await Wexel.create({ coreBytes });
const module = await runtime.loadModule(coreBytes);
console.log("2 + 40 =", module.exports.add(2, 40));
