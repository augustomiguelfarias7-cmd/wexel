import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import process from "node:process";

const exec = promisify(execFile);
const root = path.resolve(new URL("..", import.meta.url).pathname);
const version = process.env.DENO_VERSION ?? "2.9.6";
const tag = `v${version}`;
const workdir = path.join(root, ".cache", `deno-${version}`);
const manifestPath = path.join(root, "toolchains/deno/deno-2.9.6.source.json");

await mkdir(path.dirname(manifestPath), { recursive: true });
await rm(workdir, { recursive: true, force: true });
await mkdir(path.dirname(workdir), { recursive: true });

await exec("git", ["clone", "--depth", "1", "--branch", tag, "https://github.com/denoland/deno.git", workdir], {
  cwd: root,
  maxBuffer: 2 * 1024 * 1024,
});
const { stdout: commit } = await exec("git", ["-C", workdir, "rev-parse", "HEAD"], { maxBuffer: 1024 * 1024 });
const { stdout: wasmChecks } = await exec("rg", ["-n", "cargo (check|build).*wasm32|wasm32-unknown-unknown", ".github", "Cargo.toml", "cli", "runtime"], {
  cwd: workdir,
  maxBuffer: 4 * 1024 * 1024,
}).catch(() => ({ stdout: "" }));

const releaseResponse = await fetch(`https://api.github.com/repos/denoland/deno/releases/tags/${tag}`, {
  headers: { accept: "application/vnd.github+json", "user-agent": "wexel-deno-wasm-check" },
});
if (!releaseResponse.ok) throw new Error(`GitHub release lookup failed: HTTP ${releaseResponse.status}`);
const release = await releaseResponse.json();
const assets = release.assets.map(({ name, browser_download_url: url }) => ({ name, url }));
const wasmAssets = assets.filter(({ name }) => /wasm/i.test(name));

const manifest = {
  runtime: "deno",
  version,
  source: {
    repository: "https://github.com/denoland/deno.git",
    tag,
    commit: commit.trim(),
  },
  release: {
    url: release.html_url,
    assets,
    wasmAssets,
  },
  result: wasmAssets.length === 0 ? "no-official-deno-wasm-artifact" : "wasm-artifact-found",
  sourceWasmReferences: wasmChecks.split("\n").filter(Boolean),
};
await writeFile(path.join(root, "toolchains/deno", `deno-${version}.release.json`), `${JSON.stringify(manifest, null, 2)}\n`);

if (wasmAssets.length === 0) {
  console.error(`Deno ${version} não publica um artefato WASM oficial; nenhum binário foi criado.`);
  console.error("O runtime Deno completo não pode ser convertido em um .wasm apenas renomeando o executável nativo.");
  process.exitCode = 2;
}

const digest = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
console.log(JSON.stringify({ version, commit: commit.trim(), wasmAssets, manifestSha256: digest }, null, 2));

// Mantém a fonte reproduzível durante a execução, mas não incorpora uma cópia vendorizada do Deno.
await rm(workdir, { recursive: true, force: true });
await readFile(manifestPath);
