#!/usr/bin/env node
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createWriteStream } from "node:fs";
import path from "node:path";
import process from "node:process";
import os from "node:os";

const exec = promisify(execFile);
const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const VERSION = process.env.JSV_DENO_VERSION ?? "2.9.7";
const BASE = path.join(ROOT, ".cache", "jsv", VERSION);
const ARCHIVE = path.join(BASE, "denort.zip");
const RUNTIME_DIR = path.join(ROOT, "toolchains", "jsv", "runtime");
const manifestPath = path.join(ROOT, "toolchains", "jsv", "runtime-manifest.json");

const targets = {
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "darwin-x64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
  "win32-x64": "x86_64-pc-windows-msvc",
  "win32-arm64": "aarch64-pc-windows-msvc",
};

const platformKey = process.platform + "-" + (process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : process.arch);
const target = targets[platformKey];
if (!target) throw new Error("JSV: plataforma não suportada: " + platformKey);

const asset = "denort-" + target + ".zip";
const url = "https://github.com/denoland/deno/releases/download/v" + VERSION + "/" + asset;
const checksumUrl = url + ".sha256sum";

await mkdir(BASE, { recursive: true });
await mkdir(RUNTIME_DIR, { recursive: true });

async function download(url, destination) {
  const response = await fetch(url, { headers: { "user-agent": "wexel-jsv-bootstrap" } });
  if (!response.ok) throw new Error("JSV: download falhou HTTP " + response.status + ": " + url);
  const file = createWriteStream(destination);
  await new Promise(async (resolve, reject) => {
    try {
      if (!response.body) throw new Error("Resposta sem corpo.");
      for await (const chunk of response.body) file.write(chunk);
      file.end(resolve);
    } catch (error) {
      file.destroy();
      reject(error);
    }
  });
}

await download(url, ARCHIVE);
const checksumTextPath = path.join(BASE, "denort.sha256sum");
await download(checksumUrl, checksumTextPath);

const expected = (await readFile(checksumTextPath, "utf8")).trim().split(/\s+/)[0];
const actual = createHash("sha256").update(await readFile(ARCHIVE)).digest("hex");
if (expected !== actual) {
  throw new Error("JSV: SHA-256 inválido para " + asset + ". Esperado " + expected + ", recebido " + actual);
}

if (process.platform === "win32") {
  const archive = ARCHIVE.replace(/'/g, "''");
  const destination = RUNTIME_DIR.replace(/'/g, "''");
  await exec("powershell.exe", ["-NoProfile", "-Command", "Expand-Archive -LiteralPath '" + archive + "' -DestinationPath '" + destination + "' -Force"]);
} else {
  await exec("unzip", ["-o", ARCHIVE, "-d", RUNTIME_DIR]);
}

const runtimeName = process.platform === "win32" ? "denort.exe" : "denort";
const runtimePath = path.join(RUNTIME_DIR, runtimeName);
if (process.platform !== "win32") await chmod(runtimePath, 0o755);

const manifest = {
  runtime: "jsv",
  basedOn: "denort",
  denoVersion: VERSION,
  target,
  asset,
  source: url,
  checksum: actual,
  runtimePath,
  note: "denort é um runtime reduzido para executáveis compilados; ele não é o Deno CLI completo.",
  host: { platform: os.platform(), arch: os.arch() },
};
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify(manifest, null, 2));
