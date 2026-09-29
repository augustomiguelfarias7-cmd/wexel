import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WexelFileSystem, createDenoNativeRunner, resolvedenoBin } from "../dist/index.js";

const results = [];
async function run(name, fn) {
  try {
    await fn();
    results.push({ name, status: "PASS" });
    console.log("PASS  " + name);
  } catch (error) {
    results.push({ name, status: "FAIL", error: String(error) });
    console.error("FAIL  " + name);
    throw error;
  }
}

const denoBin = await resolvedenoBin();
assert.ok(existsSync(denoBin), "Deno binary not found: " + denoBin);
console.log("DENO_BIN=" + denoBin);

const fs = new WexelFileSystem();
fs.write("/home/wexel/input.txt", new TextEncoder().encode("from-wexel-vfs"));

const runner = createDenoNativeRunner(fs, { networkAllowed: true, timeoutMs: 60_000 });

await run("JavaScript executes in real Deno", async () => {
  const result = await runner("console.log((42 + 1) / 1)", "javascript", []);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout.trim(), /^43$/);
});

await run("TypeScript executes in real Deno", async () => {
  const result = await runner(
    "const value: number = (42 + 1) / 1; console.log(value)",
    "typescript",
    [],
  );
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout.trim(), /^43$/);
});

await run("Deno can read a file materialized from Wexel VFS", async () => {
  const result = await runner(
    "console.log(await Deno.readTextFile('/home/wexel/input.txt'))",
    "javascript",
    [],
  );
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout.trim(), /^from-wexel-vfs$/);
});

await run("npm-compatible package import works inside the Deno sandbox", async () => {
  const result = await runner(
    'import lodash from "npm:lodash@4.17.21"; console.log(lodash.add(40, 2))',
    "javascript",
    [],
  );
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout.trim(), /^42$/);
});

await run("VFS remains intact after Deno execution", async () => {
  const data = await fs.read("/home/wexel/input.txt");
  assert.equal(new TextDecoder().decode(data), "from-wexel-vfs");
});

await run("Deno cannot read outside its sandbox permission root", async () => {
  const result = await runner(
    "try { await Deno.readTextFile('/etc/hostname'); console.log('LEAK') } catch { console.log('DENIED') }",
    "javascript",
    [],
  );
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout.trim(), /^DENIED$/);
});

await run("Deno cannot write outside its sandbox permission root", async () => {
  const marker = join(tmpdir(), "wexel-host-marker-" + process.pid);
  await rm(marker, { force: true });
  const source = "try { await Deno.writeTextFile(" + JSON.stringify(marker) + ", 'LEAK'); console.log('LEAK') } catch { console.log('DENIED') }";
  const result = await runner(source, "javascript", []);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout.trim(), /^DENIED$/);
  assert.equal(existsSync(marker), false);
});

console.log("\n=== Wexel Deno sandbox result ===");
for (const item of results) console.log(item.status.padEnd(4) + " " + item.name);
console.log("All native Deno sandbox checks passed.");
