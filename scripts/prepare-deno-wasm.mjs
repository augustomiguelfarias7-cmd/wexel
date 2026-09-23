/**
 * prepare-deno-wasm.mjs — Wexel
 *
 * Baixa o binário nativo do Deno para o ambiente correto (Linux x64, macOS arm64,
 * Windows x64) e o coloca em packages/wexel/assets/deno/.
 *
 * No browser o Deno NÃO roda como binário nativo — ele é emulado pelo
 * deno-worker.ts via Web Worker + shim. Este script serve o binário para o
 * ambiente Node.js (NodeExecution + deno-node-sandbox.ts).
 *
 * Uso:
 *   node scripts/prepare-deno-wasm.mjs            # versão padrão
 *   DENO_VERSION=2.9.6 node scripts/prepare-deno-wasm.mjs
 */

import { mkdir, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = path.resolve(new URL("..", import.meta.url).pathname);
const version = process.env.DENO_VERSION ?? "2.9.6";
const tag = `v${version}`;
const assetDir = path.join(root, "packages/wexel/assets/deno");

// ── Detecta a plataforma ──────────────────────────────────────────────────────

function getPlatformAsset() {
  const os   = process.platform;
  const arch = process.arch;
  if (os === "linux"  && arch === "x64")  return `deno-x86_64-unknown-linux-gnu.zip`;
  if (os === "darwin" && arch === "arm64")return `deno-aarch64-apple-darwin.zip`;
  if (os === "darwin" && arch === "x64")  return `deno-x86_64-apple-darwin.zip`;
  if (os === "win32"  && arch === "x64")  return `deno-x86_64-pc-windows-msvc.zip`;
  throw new Error(`Plataforma não suportada: ${os}/${arch}`);
}

const assetName = getPlatformAsset();
const downloadUrl = `https://github.com/denoland/deno/releases/download/${tag}/${assetName}`;
const zipPath    = path.join(assetDir, assetName);
const manifestPath = path.join(assetDir, "manifest.json");

await mkdir(assetDir, { recursive: true });

// ── Verifica release no GitHub ────────────────────────────────────────────────

console.log(`Verificando release ${tag} no GitHub...`);
const releaseRes = await fetch(
  `https://api.github.com/repos/denoland/deno/releases/tags/${tag}`,
  { headers: { accept: "application/vnd.github+json", "user-agent": "wexel-prepare-deno" } },
);
if (!releaseRes.ok) throw new Error(`GitHub API falhou: HTTP ${releaseRes.status}`);
const release = await releaseRes.json();
const asset   = release.assets.find((a) => a.name === assetName);
if (!asset) throw new Error(`Asset ${assetName} não encontrado na release ${tag}`);

// ── Download ──────────────────────────────────────────────────────────────────

console.log(`Baixando ${downloadUrl}...`);
const dlRes = await fetch(downloadUrl);
if (!dlRes.ok) throw new Error(`Download falhou: HTTP ${dlRes.status}`);

await pipeline(
  Readable.fromWeb(dlRes.body),
  createWriteStream(zipPath),
);
console.log(`Zip salvo em ${zipPath}`);

// ── Extrai o binário do zip ───────────────────────────────────────────────────

// Usa o unzip do sistema ou o Node 22+ (que tem suporte nativo)
try {
  await exec("unzip", ["-o", zipPath, "deno*", "-d", assetDir]);
} catch {
  // fallback: usa o módulo nativo do Node 22+
  const { decompress } = await import("node:zlib");
  const { promisify: p } = await import("node:util");
  const decomp = p(decompress);
  const zipped = await import("node:fs/promises").then((m) => m.readFile(zipPath));
  const out    = await decomp(zipped);
  const exe    = process.platform === "win32" ? "deno.exe" : "deno";
  await writeFile(path.join(assetDir, exe), out, { mode: 0o755 });
}

// ── Hash SHA-256 do binário ───────────────────────────────────────────────────

const binName  = process.platform === "win32" ? "deno.exe" : "deno";
const binPath  = path.join(assetDir, binName);
const binBytes = await import("node:fs/promises").then((m) => m.readFile(binPath));
const sha256   = createHash("sha256").update(binBytes).digest("hex");

// ── Confirma que o binário funciona ──────────────────────────────────────────

let denoVersion = "(não verificado)";
try {
  const { stdout } = await exec(binPath, ["--version"]);
  denoVersion = stdout.trim().split("\n")[0];
  console.log(`Deno funcional: ${denoVersion}`);
} catch (err) {
  console.warn(`Aviso: não foi possível executar ${binPath}: ${err.message}`);
}

// ── Manifesto ─────────────────────────────────────────────────────────────────

const manifest = {
  runtime: "deno",
  version,
  tag,
  asset:   assetName,
  binary:  binName,
  sha256,
  denoVersion,
  downloadUrl,
  preparedAt: new Date().toISOString(),
};
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
console.log(`Manifesto escrito em ${manifestPath}`);

// ── Limpa o zip ───────────────────────────────────────────────────────────────
await rm(zipPath, { force: true });

console.log(`\nDeno ${version} pronto em ${assetDir}/${binName}`);
