import { createWasiPythonRunner } from "../packages/wexel/dist/node-cpython.js";
const run = createWasiPythonRunner({
  pythonWasm: new URL("../packages/wexel/assets/cpython-3.14.7/python.wasm", import.meta.url).pathname,
  pythonRoot: new URL("../packages/wexel/assets/cpython-3.14.7", import.meta.url).pathname,
  wasmtime: process.env.WASMTIME ?? "/home/ubuntu/wexel/toolchains/wasmtime/wasmtime",
});
console.log(await run("print(2 + 40)"));
