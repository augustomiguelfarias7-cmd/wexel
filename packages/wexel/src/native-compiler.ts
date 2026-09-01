import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { basename, extname } from "node:path";

export interface CompileOptions {
  source: string;
  output: string;
  emcc?: string;
  emxx?: string;
  flags?: string[];
}

export interface CompileResult {
  output: string;
  language: "c" | "cpp";
  stdout: string;
  stderr: string;
}

/** Compila C/C++ para WASM no ambiente Node que fornece Emscripten. */
export async function compileNativeSource(options: CompileOptions): Promise<CompileResult> {
  const extension = extname(options.source).toLowerCase();
  const language = extension === ".cpp" || extension === ".cc" || extension === ".cxx" ? "cpp" : extension === ".c" ? "c" : undefined;
  if (!language) throw new Error(`Fonte não suportada: ${basename(options.source)}. Use .c ou .cpp.`);
  await access(options.source);
  const compiler = language === "cpp" ? (options.emxx ?? "em++") : (options.emcc ?? "emcc");
  const args = [options.source, "-O2", "-s", "STANDALONE_WASM=1", "-s", "ERROR_ON_UNDEFINED_SYMBOLS=0", "--no-entry", "-o", options.output, ...(options.flags ?? [])];
  const result = await run(compiler, args);
  if (result.code !== 0) throw new Error(`${compiler} falhou (${result.code}):\n${result.stderr}`);
  return { output: options.output, language, stdout: result.stdout, stderr: result.stderr };
}

function run(command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}
