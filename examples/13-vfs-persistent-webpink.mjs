import { readFile } from "node:fs/promises";
import { WexelPersistentFS } from "../packages/wexel/dist/persistent-fs.js";
import { NodeExecution } from "../packages/wexel/dist/node-execution.js";

const coreBytes = await readFile(new URL("../packages/wexel/assets/core.wasm", import.meta.url));
const fs = await WexelPersistentFS.open("./.wexel-demo-vfs", {
  homeDirectory: "/home/webpink-demo",
  autoSaveMs: 0,
});

const executor = await NodeExecution.create({
  coreBytes,
  webPink: {
    allowHosts: ["raw.githubusercontent.com"],
    requestTimeoutMs: 10_000,
    maxResponseBytes: 256 * 1024,
  },
});

const sandbox = await executor.createSandbox({
  id: "persistent-webpink-demo",
  fs,
  permissions: { network: true, storage: true, files: true, modules: true },
});

const result = await sandbox.runtime.exec({
  language: "javascript",
  code: `
    const response = await fetch(
      "https://raw.githubusercontent.com/augustomiguelfarias7-cmd/wexel/main/examples/webping-demo/site/data.json"
    );
    await Deno.writeTextFile("/home/webpink-demo/fetched.json", await response.text());
    console.log("HTTP:", response.status);
    console.log("Arquivos:", Deno.readDir("/home/webpink-demo"));
  `,
});

console.log(result.stdout);
if (result.stderr) console.error(result.stderr);

await fs.flush();
console.log("Persistido:", (await fs.diskUsage()).diskBytes, "bytes");
await fs.close();
await executor.dispose();
