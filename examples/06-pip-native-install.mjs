import { readFile } from "node:fs/promises";
import { Wexel } from "../packages/wexel/dist/index.js";
import { createWasiPythonRunner as createNodePython } from "../packages/wexel/dist/node-cpython.js";
const coreBytes = await readFile(new URL("../packages/wexel/assets/core.wasm", import.meta.url));
const runtime = await Wexel.create({ coreBytes, permissions: { network: true } });
console.log(await runtime.shell.exec("pip install six"));
const runPython = createNodePython({
  pythonWasm: new URL("../packages/wexel/assets/cpython-3.14.7/python.wasm", import.meta.url).pathname,
  pythonRoot: new URL("../packages/wexel/assets/cpython-3.14.7", import.meta.url).pathname,
  wasmtime: process.env.WASMTIME ?? "/home/ubuntu/wexel/toolchains/wasmtime/wasmtime",
  fs: runtime.fs,
});
console.log(await runPython("import six; print(six.__version__)"));
console.log("Arquivos instalados:", runtime.fs.list().length, "quota:", runtime.fs.quota);
