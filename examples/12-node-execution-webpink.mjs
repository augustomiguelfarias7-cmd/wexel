import { readFile } from "node:fs/promises";
import { NodeExecution } from "../packages/wexel/dist/node-execution.js";

const coreBytes = await readFile(new URL("../packages/wexel/assets/core.wasm", import.meta.url));

const executor = await NodeExecution.create({
  coreBytes,
  webPink: {
    allowHosts: ["raw.githubusercontent.com"],
    requestTimeoutMs: 10_000,
    maxResponseBytes: 256 * 1024,
  },
  denoNodeWorker: true,
});

const sandbox = await executor.createSandbox({
  id: "webpink-demo",
  permissions: { network: true, storage: true, files: true, modules: true },
});

sandbox.runtime.fs.mkdir("/site");
sandbox.runtime.fs.write("/site/index.html", await readFile(new URL("./webping-demo/site/index.html", import.meta.url)));
sandbox.runtime.fs.write("/site/app.js", await readFile(new URL("./webping-demo/site/app.js", import.meta.url)));
sandbox.runtime.fs.write("/site/data.json", await readFile(new URL("./webping-demo/site/data.json", import.meta.url)));

const result = await sandbox.runtime.exec({
  language: "javascript",
  code: `
    const url = "https://raw.githubusercontent.com/augustomiguelfarias7-cmd/wexel/main/examples/webping-demo/site/data.json";
    const response = await fetch(url);
    const text = await response.text();

    await Deno.writeTextFile("/site/fetched-data.json", text);

    const local = await Deno.readTextFile("/site/data.json");
    console.log("WebPink HTTP status:", response.status);
    console.log("VFS local bytes:", new TextEncoder().encode(local).byteLength);
    console.log("VFS fetched bytes:", new TextEncoder().encode(text).byteLength);
  `,
});

console.log(result.stdout);
if (result.stderr) console.error(result.stderr);
console.log("VFS:", sandbox.runtime.fs.snapshot().map(({ path }) => path));
console.log("Quota:", sandbox.runtime.fs.quota);

await executor.dispose();
