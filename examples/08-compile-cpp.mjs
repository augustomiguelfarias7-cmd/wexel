import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { compileNativeSource, Wexel } from "../packages/wexel/dist/index.js";

const source = "/tmp/wexel-example.cpp";
const output = "/tmp/wexel-example.wasm";
if (spawnSync(process.env.EMXX ?? "em++", ["--version"], { stdio: "ignore" }).status !== 0) {
  console.warn("Exemplo ignorado: em++ (Emscripten) não está disponível. Defina EMXX ou instale Emscripten.");
  process.exit(0);
}
await writeFile(source, 'extern "C" int wexel_add(int a, int b) { return a + b; }\n');
await compileNativeSource({ source, output, flags: ["-Wl,--export=wexel_add"] });
const wasm = await WebAssembly.instantiate(await readFile(output), {});
console.log(wasm.instance.exports.wexel_add(20, 22));

const coreBytes = await readFile(new URL("../packages/wexel/assets/core.wasm", import.meta.url));
const runtime = await Wexel.create({ coreBytes });
const loaded = await runtime.loadModule(await readFile(output));
console.log(Number(loaded.exports.wexel_add(1, 2)));
