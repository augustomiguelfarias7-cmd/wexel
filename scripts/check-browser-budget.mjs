import fs from "node:fs";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const assetRoot = path.join(root, "packages/wexel/assets");
const budget = 115 * 1024 * 1024;
function filesIn(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? filesIn(full) : [full];
  });
}
const files = filesIn(assetRoot);
const total = files.reduce((sum, file) => sum + fs.statSync(file).size, 0);
if (total > budget) throw new Error(`Browser bundle exceeds 115 MB: ${total} bytes`);
console.log(`Browser runtime budget: ${total} / ${budget} bytes (${files.length} files)`);
