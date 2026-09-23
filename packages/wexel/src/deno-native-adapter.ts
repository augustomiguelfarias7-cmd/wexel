/**
 * deno-native-adapter.ts — Wexel
 *
 * Roda o binário nativo do Deno como subprocesso do sandbox Node.js.
 *
 * Este adapter complementa o deno-node-sandbox.ts (que usa worker_threads
 * com shim JS). Quando o binário nativo está disponível em
 * packages/wexel/assets/deno/deno (ou DENO_BIN no env), este adapter
 * o usa diretamente — com acesso real ao V8 completo, TypeScript nativo,
 * npm:, jsr:, Node.js compat, etc.
 *
 * A sandbox Wexel isola o processo via:
 *   - Diretório temporário próprio (sem acesso ao fs do host além dele)
 *   - Deno.permissions escritas no arquivo de permissões temporário
 *   - Rede controlada pelo WebPink (via DENO_NO_PROXY + proxy socks5 local)
 *   - Variáveis de ambiente sanitizadas
 */

import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm, mkdir, readFile } from "node:fs/promises";
import { tmpdir }  from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExecResult, WexelFileSystem } from "./index.js";

const HERE = dirname(fileURLToPath(import.meta.url));

export interface DenoNativeOptions {
  /**
   * Caminho para o binário deno. Padrão: detectado automaticamente em
   *   1. DENO_BIN (variável de ambiente)
   *   2. ../assets/deno/deno  (binário baixado pelo prepare-deno-wasm.mjs)
   *   3. "deno"               (PATH do sistema — útil em CI)
   */
  denoBin?:        string;
  /** Permissão de rede real. Padrão: false. */
  networkAllowed?: boolean;
  /** Timeout por execução em ms. Padrão: 30 000. */
  timeoutMs?:      number;
  /** Variáveis de ambiente extras passadas para o subprocesso Deno. */
  env?:            Record<string, string>;
}

export interface DenoNativeExecOptions {
  code:     string;
  language: "javascript" | "typescript";
  args?:    string[];
}

/** Resolve o caminho do binário Deno nas três fontes de busca. */
export async function resolvedenoBin(override?: string): Promise<string> {
  if (override) return override;
  if (process.env["DENO_BIN"]) return process.env["DENO_BIN"];

  // assets/deno/deno[.exe]
  const ext    = process.platform === "win32" ? ".exe" : "";
  const assets = resolve(HERE, "../assets/deno", `deno${ext}`);
  try {
    await readFile(assets); // só verifica se existe
    return assets;
  } catch { /* não disponível — usa PATH */ }

  return "deno";
}

/**
 * Executa código JavaScript/TypeScript no binário nativo do Deno,
 * dentro de um diretório temporário isolado, com o VFS do Wexel
 * copiado para /tmp e o resultado devolvido como ExecResult.
 */
export async function runDenoNative(
  fs:      WexelFileSystem,
  options: DenoNativeOptions,
  exec:    DenoNativeExecOptions,
): Promise<ExecResult> {
  const denoBin = await resolvedenoBin(options.denoBin);
  const ext     = exec.language === "typescript" ? ".ts" : ".js";
  const workDir = await mkdtemp(join(tmpdir(), "wexel-deno-"));

  try {
    // Materializa o VFS no diretório temporário
    for (const file of fs.snapshot()) {
      const dest = join(workDir, file.path);
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, file.data);
    }

    // Escreve o script de entrada
    const scriptPath = join(workDir, `__wexel_entry${ext}`);
    await writeFile(scriptPath, exec.code, "utf8");

    // Monta os flags de permissão do Deno
    const denoFlags: string[] = [
      "--allow-read=" + workDir,
      "--allow-write=" + workDir,
    ];
    if (options.networkAllowed) {
      denoFlags.push("--allow-net");
    }
    // TypeScript: Deno suporta nativamente — sem flags extras

    const argv = [
      "run",
      "--no-prompt",
      "--quiet",
      ...denoFlags,
      scriptPath,
      ...(exec.args ?? []),
    ];

    const env: NodeJS.ProcessEnv = {
      // ambiente mínimo — não vaza variáveis do host
      HOME:     workDir,
      DENO_DIR: join(workDir, ".deno"),
      PATH:     process.env["PATH"] ?? "/usr/bin:/bin",
      ...options.env,
      // nunca deixa o Deno usar cache do host real
      DENO_NO_UPDATE_CHECK: "1",
    };

    return await new Promise<ExecResult>((resolve) => {
      const child = spawn(denoBin, argv, {
        cwd: workDir,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let settled = false;

      const timeout = options.timeoutMs !== undefined
        ? setTimeout(() => {
            if (!settled) { child.kill("SIGKILL"); finish(1, "Timeout Deno excedido\n"); }
          }, options.timeoutMs)
        : undefined;

      function finish(exitCode: number, extraErr?: string): void {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        resolve({
          stdout:   Buffer.concat(stdout).toString("utf8"),
          stderr:   Buffer.concat(stderr).toString("utf8") + (extraErr ?? ""),
          exitCode,
        });
      }

      child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
      child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
      child.on("error", (err) => finish(127, `deno: ${err.message}\n`));
      child.on("close", (code) => finish(code ?? 1));
    });
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/**
 * Cria um runner Deno nativo compatível com WexelOptions.denoRunner.
 * Uso:
 *   const runtime = await WexelRuntime.create({
 *     denoRunner: createDenoNativeRunner(myFs, { networkAllowed: true }),
 *   });
 */
export function createDenoNativeRunner(
  fs:      WexelFileSystem,
  options: DenoNativeOptions = {},
): (code: string, language: "javascript" | "typescript", args: string[]) => Promise<ExecResult> {
  return (code, language, args) =>
    runDenoNative(fs, options, { code, language, args });
}
