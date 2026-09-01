import { readFile } from "node:fs/promises";
import { RustV } from "../packages/wexel/dist/index.js";

const rustv = await RustV.load({
  source: await readFile(new URL("../packages/wexel/assets/native/rustv.wasm", import.meta.url)),
  expectedAbi: 20001
});

console.log(`RustV ABI: ${rustv.version()}`);
console.log(`RustV add: ${rustv.add(20, 22)}`);
console.log(`RustV exit: ${rustv.exitCode()}`);
