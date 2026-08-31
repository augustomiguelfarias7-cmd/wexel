import { readFile } from "node:fs/promises";
import { Wexel } from "../packages/wexel/dist/index.js";
const coreBytes = await readFile(new URL("../packages/wexel/assets/core.wasm", import.meta.url));
const engine = await Wexel.loadOnly({ coreBytes });
console.log({ mode: engine.mode, files: engine.fs.list(), quota: engine.fs.quota });
// O serviço consumidor pode guardar `engine` e chamar APIs de integração.
// Nenhum script é executado neste modo.
