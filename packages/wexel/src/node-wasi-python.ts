/**
 * node-wasi-python.ts — Wexel
 *
 * CPython 3.14.7 WASI REAL via node:wasi + assets/cpython-3.14.7/python.wasm.
 * Não usa Wasmtime. Não é simulação.
 */

import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { ExecResult, WexelFileSystem } from "./index.js";

export interface NodeWasiPythonOptions {
  pythonWasm?: string | BufferSource;
  pythonRoot?: string;
  args?: string[];
  env?: Record<string, string>;
  workDir?: string;
  fs?: WexelFileSystem;
}

function defaultPythonRoot(): string {
  return fileURLToPath(new URL("../assets/cpython-3.14.7/", import.meta.url));
}

async function loadWasmBytes(
  options: NodeWasiPythonOptions,
  pythonRoot: string,
): Promise<BufferSource> {
  if (options.pythonWasm && typeof options.pythonWasm !== "string") {
    return options.pythonWasm;
  }
  const path =
    typeof options.pythonWasm === "string"
      ? options.pythonWasm
      : join(pythonRoot, "python.wasm");
  return readFile(path);
}

export async function runNodeWasiPython(
  code: string,
  options: NodeWasiPythonOptions = {},
): Promise<ExecResult> {
  const { WASI } = await import("node:wasi");
  const pythonRoot = options.pythonRoot ?? defaultPythonRoot();
  const wasmBytes = await loadWasmBytes(options, pythonRoot);

  const work =
    options.workDir ??
    join(tmpdir(), `wexel-wasi-${process.pid}-${Date.now()}`);
  await mkdir(work, { recursive: true });

  if (options.fs) {
    try {
      for (const file of options.fs.snapshot()) {
        if (!file.path.startsWith("/site-packages/")) continue;
        const rel = file.path.replace(/^\/site-packages\//, "");
        const target = join(work, "site-packages", rel);
        await mkdir(join(target, ".."), { recursive: true });
        await writeFile(target, file.data);
      }
    } catch {
      /* optional */
    }
  }

  const wrapped = `
import sys
_out_path = "/work/__wexel_stdout__.txt"
_err_path = "/work/__wexel_stderr__.txt"
class _Cap:
    def __init__(self, path):
        self._path = path
        self._buf = []
    def write(self, s):
        if s:
            self._buf.append(s)
    def flush(self):
        pass
    def dump(self):
        with open(self._path, "w", encoding="utf-8") as f:
            f.write("".join(self._buf))
_stdout, _stderr = _Cap(_out_path), _Cap(_err_path)
sys.stdout, sys.stderr = _stdout, _stderr
_exit = 0
try:
${code.split("\n").map((line) => "    " + line).join("\n")}
except SystemExit as e:
    _exit = int(e.code) if isinstance(e.code, int) else 1
except Exception as e:
    _stderr.write(type(e).__name__ + ": " + str(e) + "\\n")
    _exit = 1
finally:
    _stdout.dump()
    _stderr.dump()
    raise SystemExit(_exit)
`;
  await writeFile(join(work, "main.py"), wrapped, "utf8");

  const wasi = new WASI({
    version: "preview1",
    args: options.args ?? ["python", "/work/main.py"],
    env: {
      PYTHONHOME: "/",
      PYTHONPATH: "/Lib:/work:/work/site-packages",
      PYTHONDONTWRITEBYTECODE: "1",
      ...options.env,
    },
    preopens: {
      "/": pythonRoot,
      "/work": work,
    },
    returnOnExit: true,
  });

  let exitCode = 1;
  try {
    const ab =
      wasmBytes instanceof ArrayBuffer
        ? wasmBytes
        : (wasmBytes.buffer.slice(
            (wasmBytes as ArrayBufferView).byteOffset,
            (wasmBytes as ArrayBufferView).byteOffset + (wasmBytes as ArrayBufferView).byteLength,
          ) as ArrayBuffer);
    const compiled = await WebAssembly.compile(ab);
    const instance = await WebAssembly.instantiate(
      compiled,
      wasi.getImportObject() as WebAssembly.Imports,
    );
    const ret = wasi.start(
      instance as WebAssembly.Instance & { exports: { memory: WebAssembly.Memory } },
    );
    exitCode = typeof ret === "number" ? ret : 0;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (!/exit|Exit|proc_exit/i.test(msg)) {
      await rm(work, { recursive: true, force: true }).catch(() => {});
      return { stdout: "", stderr: `node:wasi/python.wasm: ${msg}\n`, exitCode: 1 };
    }
  }

  let stdout = "";
  let stderr = "";
  try {
    stdout = await readFile(join(work, "__wexel_stdout__.txt"), "utf8");
  } catch {
    /* empty */
  }
  try {
    stderr = await readFile(join(work, "__wexel_stderr__.txt"), "utf8");
  } catch {
    /* empty */
  }

  if (!options.workDir) {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }

  return { stdout, stderr, exitCode };
}

export function createNodeWasiPythonRunner(options: Omit<NodeWasiPythonOptions, "fs"> = {}) {
  return (code: string, _args: string[] = []) => runNodeWasiPython(code, options);
}

export function nodeWasiPythonRunnerFactory(
  options: Omit<NodeWasiPythonOptions, "fs"> = {},
): (fs: WexelFileSystem) => (code: string, args: string[]) => Promise<ExecResult> {
  return (fs) => (code, args) => runNodeWasiPython(code, { ...options, fs });
}
