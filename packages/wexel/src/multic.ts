import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

export type MultiCLanguage = "c" | "cpp";
export interface MultiCOptions { cc?: string; cxx?: string; target?: string; flags?: string[]; tempDirectory?: string; }
export interface MultiCSection { language: MultiCLanguage; source: string; line: number; }
export interface MultiCResult { stdout: string; stderr: string; exitCode: number; sections: Array<{ language: MultiCLanguage; stdout: string; stderr: string; exitCode: number }>; }

const C_MARKER = /^\s*\/\/\s*@wexel:c\s*$/i;
const CPP_MARKER = /^\s*\/\/\s*@wexel:cpp\s*$/i;

export function parseMultiC(source: string): MultiCSection[] {
  const sections: MultiCSection[] = []; let language: MultiCLanguage | undefined; let startLine = 1; let buffer: string[] = [];
  const flush = () => { if (!language) return; const body = buffer.join("\n").trim(); if (body) sections.push({ language, source: body + "\n", line: startLine }); buffer = []; };
  source.split(/\r?\n/).forEach((line, index) => {
    const lineNumber = index + 1;
    if (C_MARKER.test(line)) { flush(); language = "c"; startLine = lineNumber + 1; return; }
    if (CPP_MARKER.test(line)) { flush(); language = "cpp"; startLine = lineNumber + 1; return; }
    if (language) buffer.push(line);
  });
  flush();
  if (!sections.length) throw new Error("MultiC: nenhum bloco encontrado. Use // @wexel:c e/ou // @wexel:cpp.");
  if (!sections.some((section) => section.language === "c")) throw new Error("MultiC: falta um bloco C.");
  if (!sections.some((section) => section.language === "cpp")) throw new Error("MultiC: falta um bloco C++.");
  return sections;
}

export async function runMultiCFile(file: string, options: MultiCOptions = {}): Promise<MultiCResult> { return runMultiCSource(file, await readFile(file, "utf8"), options); }

export async function runMultiCSource(fileName: string, source: string, options: MultiCOptions = {}): Promise<MultiCResult> {
  const sections = parseMultiC(source);
  const temp = await mkdtemp(join(options.tempDirectory ?? tmpdir(), "wexel-multic-"));
  try {
    const sectionResults = await Promise.all(sections.map((section, index) => runSection(section, index, temp, fileName, options)));
    const ordered = sections.map((section, index) => ({ section, result: sectionResults[index] }));
    const stdout = ordered.map(({ section, result }) => `===== ${section.language === "c" ? "C" : "C++"} =====\n${result.stdout.trimEnd()}`).join("\n\n") + "\n";
    const stderr = ordered.filter(({ result }) => result.stderr).map(({ section, result }) => `===== ${section.language === "c" ? "C" : "C++"} =====\n${result.stderr.trimEnd()}`).join("\n\n");
    const exitCode = ordered.find(({ result }) => result.exitCode !== 0)?.result.exitCode ?? 0;
    return { stdout, stderr: stderr ? stderr + "\n" : "", exitCode, sections: ordered.map(({ section, result }) => ({ language: section.language, ...result })) };
  } finally { await rm(temp, { recursive: true, force: true }); }
}

export async function runMultiCVfs(fs: { readText(path: string): string }, file: string, options: MultiCOptions = {}): Promise<MultiCResult> { return runMultiCSource(file, fs.readText(file), options); }

async function runSection(section: MultiCSection, index: number, temp: string, fileName: string, options: MultiCOptions): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const extension = section.language === "c" ? ".c" : ".cpp";
  const sourcePath = join(temp, index + "-" + sanitize(fileName) + extension);
  const outputPath = join(temp, index + "-" + section.language + ".wasm");
  await writeFile(sourcePath, section.source, "utf8");
  const compiler = section.language === "c" ? (options.cc ?? "clang") : (options.cxx ?? "clang++");
  const args = [`--target=${options.target ?? "wasm32"}`, "-O2", "-ffreestanding", "-nostdlib", "-Wl,--no-entry", "-Wl,--export=main", "-Wl,--allow-undefined", sourcePath, "-o", outputPath, ...(options.flags ?? [])];
  const compiled = await spawnCapture(compiler, args);
  if (compiled.exitCode !== 0) return compiled;
  const wasm = await readFile(outputPath);
  const printed: string[] = []; let instance: WebAssembly.Instance;
  const imports = { env: {
    wexel_print_i32: (value: number) => printed.push(String(value)),
    wexel_print_bytes: (ptr: number, len: number) => { const memory = instance.exports.memory as WebAssembly.Memory; printed.push(new TextDecoder().decode(new Uint8Array(memory.buffer, ptr, len))); },
  } };
  try {
    ({ instance } = await WebAssembly.instantiate(wasm, imports));
    const main = (instance.exports as Record<string, unknown>).main;
    if (typeof main !== "function") throw new Error("WASM não exportou main().");
    const value = (main as () => unknown)();
    return { stdout: printed.length ? printed.join("") : `${String(value)}\n`, stderr: "", exitCode: 0 };
  } catch (error) { return { stdout: "", stderr: `${error instanceof Error ? error.message : String(error)}\n`, exitCode: 1 }; }
}

function sanitize(name: string): string { return name.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(-80) || "program"; }
function spawnCapture(command: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] }); let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject); child.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
  });
}
