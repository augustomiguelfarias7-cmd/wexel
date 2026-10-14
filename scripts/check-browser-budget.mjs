import fs from "node:fs";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const assetRoot = path.join(root, "packages/wexel/assets");
// The shipped CPython/WASI and kernel assets currently total about 182 MiB.
const budget = 200 * 1024 * 1024;
function filesIn(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? filesIn(full) : [full];
  });
}
const files = filesIn(assetRoot);
const total = files.reduce((sum, file) => sum + fs.statSync(file).size, 0);
if (total > budget) throw new Error(`Browser bundle exceeds ${Math.round(budget / 1024 / 1024)} MiB: ${total} bytes`);
console.log(`Browser runtime budget: ${total} / ${budget} bytes (${files.length} files)`);
