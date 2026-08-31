import fs from "node:fs";
import path from "node:path";
import wabtInit from "wabt";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const wabt = await wabtInit();
const watPath = path.join(root, "packages/wexel-core/src/core.wat");
const outPath = path.join(root, "packages/wexel-core/dist/core.wasm");
fs.mkdirSync(path.dirname(outPath), { recursive: true });
const parsed = wabt.parseWat(watPath, fs.readFileSync(watPath, "utf8"));
fs.writeFileSync(outPath, Buffer.from(parsed.toBinary({}).buffer));
parsed.destroy();
console.log(`Wrote ${outPath}`);
