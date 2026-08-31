import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { ExecResult } from "./index.js";

export interface WasiPythonOptions {
  pythonWasm: string;
  /** Diretório contendo Lib/ e demais arquivos do CPython WASI, montado como /. */
  pythonRoot?: string;
  wasmtime?: string;
  cwd?: string;
  env?: Record<string, string>;
}

/** Executa o CPython 3.14.7 WASI real no backend Node.js via Wasmtime. */
export function createWasiPythonRunner(options: WasiPythonOptions) {
  const wasmtime = options.wasmtime ?? "wasmtime";
  return async (code: string, args: string[] = []): Promise<ExecResult> => {
    const dir = await mkdtemp(join(tmpdir(), "wexel-python-"));
    const script = join(dir, "main.py");
    await writeFile(script, code, "utf8");
    const pythonRoot = options.pythonRoot ?? join(options.pythonWasm, "..");
    return await new Promise((resolve, reject) => {
      const child = spawn(wasmtime, ["run", "--wasm", "max-wasm-stack=16777216", "--dir", `${dir}::/work`, "--dir", `${pythonRoot}::/`, "--env", "PYTHONPATH=/Lib", options.pythonWasm, "/work/main.py", ...args], {
        cwd: options.cwd ?? dir,
        env: { ...process.env, ...options.env },
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
      child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
      child.on("error", reject);
      child.on("close", (exitCode) => {
        void rm(dir, { recursive: true, force: true });
        resolve({ stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString(), exitCode: exitCode ?? 1 });
      });
    });
  };
}
