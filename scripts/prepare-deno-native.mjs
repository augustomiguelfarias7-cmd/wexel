/**
 * Prepara o binário NATIVO do Deno para Node Execution.
 *
 * Este script não produz WASM. O artefato gerado aqui é ELF/PE/Mach-O,
 * dependendo da plataforma. O caminho browser exige um Deno WASM real
 * separado e nunca converte este executável por descompressão.
 */

import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
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

function getPlatformAsset() {
  const os = process.platform;
  const arch = process.arch;
  if (os === "linux" && arch === "x64") return "deno-x86_64-unknown-linux-gnu.zip";
  if (os === "darwin" && arch === "arm64") return "deno-aarch64-apple-darwin.zip";
  if (os === "darwin" && arch === "x64") return "deno-x86_64-apple-darwin.zip";
  if (os === "win32" && arch === "x64") return "deno-x86_64-pc-windows-msvc.zip";
  throw new Error(`Plataforma não suportada: ${os}/${arch}`);
}

const assetName = getPlatformAsset();
const downloadUrl = `https://github.com/denoland/deno/releases/download/${tag}/${assetName}`;
const zipPath = path.join(assetDir, assetName);
const manifestPath = path.join(assetDir, "manifest.json");
const binName = process.platform === "win32" ? "deno.exe" : "deno";
const binPath = path.join(assetDir, binName);

await mkdir(assetDir, { recursive: true });
const releaseRes = await fetch(`https://api.github.com/repos/denoland/deno/releases/tags/${tag}`, {
  headers: { accept: "application/vnd.github+json", "user-agent": "wexel-prepare-deno-native" },
});
if (!releaseRes.ok) throw new Error(`GitHub API falhou: HTTP ${releaseRes.status}`);
const release = await releaseRes.json();
if (!release.assets.some((a) => a.name === assetName)) throw new Error(`Asset ${assetName} não encontrado na release ${tag}`);

const dlRes = await fetch(downloadUrl);
if (!dlRes.ok) throw new Error(`Download falhou: HTTP ${dlRes.status}`);
await pipeline(Readable.fromWeb(dlRes.body), createWriteStream(zipPath));

await exec("unzip", ["-o", zipPath, "deno*", "-d", assetDir]);
const binBytes = await readFile(binPath);
const sha256 = createHash("sha256").update(binBytes).digest("hex");

let denoVersion = "(não verificado)";
try {
  denoVersion = (await exec(binPath, ["--version"])).stdout.trim().split("\\n")[0];
} catch (err) {
  console.warn(`Aviso: não foi possível executar ${binPath}: ${err.message}`);
}

await writeFile(manifestPath, JSON.stringify({
  runtime: "deno-native", version, tag, asset: assetName, binary: binName,
  sha256, denoVersion, downloadUrl, preparedAt: new Date().toISOString(),
}, null, 2) + "\\n");
await rm(zipPath, { force: true });
console.log(`Deno nativo ${version} preparado em ${binPath}`);
