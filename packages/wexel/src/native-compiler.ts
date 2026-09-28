import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

export interface CompileOptions {
  source: string;
  output: string;
  cc?: string;
  cxx?: string;
  target?: string;
  flags?: string[];
}

export interface CompileResult {
  output: string;
  language: "c" | "cpp";
  stdout: string;
  stderr: string;
}

export interface RunOptions extends Omit<CompileOptions, "output"> {
  outputDirectory?: string;
}

export interface RunResult extends CompileResult {
  exitCode: number;
}

/** Compila C/C++ diretamente para standalone WebAssembly usando Clang/Clang++. */
export async function compileNativeSource(options: CompileOptions): Promise<CompileResult> {
  const language = detectLanguage(options.source);
  await access(options.source);
  const compiler = language === "cpp" ? (options.cxx ?? "clang++") : (options.cc ?? "clang");
  const target = options.target ?? "wasm32";
  const args = [
    `--target=${target}`, "-O2", "-ffreestanding", "-nostdlib",
    "-Wl,--no-entry", "-Wl,--export=main", "-Wl,--allow-undefined",
    options.source, "-o", options.output, ...(options.flags ?? []),
  ];
  const result = await run(compiler, args);
  if (result.code !== 0) throw new Error(`${compiler} falhou (${result.code}):\n${result.stderr}`);
  return { output: options.output, language, stdout: result.stdout, stderr: result.stderr };
}

export async function runNativeSource(options: RunOptions): Promise<RunResult> {
  const dir = await mkdtemp(join(options.outputDirectory ?? tmpdir(), "wexel-native-"));
  const output = join(dir, "program.wasm");
  try {
    const compiled = await compileNativeSource({ ...options, output });
    const wasm = await readFile(output);
    const printed: string[] = [];
    let instance: WebAssembly.Instance;
    const imports = {
      env: {
        wexel_print_i32: (value: number) => printed.push(String(value)),
        wexel_print_bytes: (ptr: number, len: number) => {
          const memory = instance.exports.memory as WebAssembly.Memory;
          const bytes = new Uint8Array(memory.buffer, ptr, len);
          printed.push(new TextDecoder().decode(bytes));
        },
      },
    };
    ({ instance } = await WebAssembly.instantiate(wasm, imports));
    const main = (instance.exports as Record<string, unknown>).main;
    if (typeof main !== "function") throw new Error("WASM não exportou main().");
    const value = (main as () => unknown)();
    const stdout = printed.length ? printed.join("") : `${String(value)}\n`;
    return { ...compiled, stdout, stderr: "", exitCode: 0 };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function detectLanguage(source: string): "c" | "cpp" {
  const extension = extname(source).toLowerCase();
  if (extension === ".cpp" || extension === ".cc" || extension === ".cxx") return "cpp";
  if (extension === ".c") return "c";
  throw new Error(`Fonte não suportada: ${basename(source)}. Use .c ou .cpp.`);
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
