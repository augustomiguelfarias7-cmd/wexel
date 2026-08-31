import fs from "node:fs";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const budget = 115 * 1024 * 1024;
const files = ["packages/wexel/assets/core.wasm"];
const total = files.reduce((sum, file) => sum + fs.statSync(path.join(root, file)).size, 0);
if (total > budget) {
  throw new Error(`Browser bundle exceeds 115 MB: ${total} bytes`);
}
console.log(`Browser runtime budget: ${total} / ${budget} bytes`);
