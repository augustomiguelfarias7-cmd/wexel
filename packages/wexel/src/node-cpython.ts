import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { WASI, File, OpenFile, ConsoleStdout, PreopenDirectory, Directory, type Inode } from "@bjorn3/browser_wasi_shim";
import type { ExecResult } from "./index.js";
import type { WexelFileSystemLike } from "./filesystem.js";

export interface WasiPythonOptions {
  /** Caminho do artefato CPython WASI já empacotado com o Wexel. */
  pythonWasm: string;
  /** Diretório contendo Lib/ e os demais arquivos da distribuição CPython. */
  pythonRoot?: string;
  cwd?: string;
  env?: Record<string, string>;
  fs?: WexelFileSystemLike;
}

type TreeEntry = Map<string, Inode>;

async function loadDirectory(path: string): Promise<Directory> {
  const contents: TreeEntry = new Map();
  for (const name of await readdir(path)) {
    const fullPath = join(path, name);
    const info = await stat(fullPath);
    if (info.isDirectory()) contents.set(name, await loadDirectory(fullPath));
    else if (info.isFile()) contents.set(name, new File(await readFile(fullPath)));
  }
  return new Directory(contents);
}

function addFile(root: Directory, path: string, bytes: Uint8Array): void {
  const parts = path.split("/").filter(Boolean);
  let current = root;
  for (const part of parts.slice(0, -1)) {
    let next = current.contents.get(part);
    if (!(next instanceof Directory)) {
      next = new Directory(new Map());
      current.contents.set(part, next);
    }
    current = next;
  }
  current.contents.set(parts[parts.length - 1], new File(bytes));
}

/**
 * Executa o artefato CPython WASI diretamente com WebAssembly + o host WASI
 * JavaScript já incluído no Wexel. Não inicia processos externos nem requer
 * Wasmtime instalado no sistema.
 */
export function createWasiPythonRunner(options: WasiPythonOptions) {
  return async (code: string, args: string[] = []): Promise<ExecResult> => {
    const pythonRoot = options.pythonRoot ?? join(options.pythonWasm, "..");
    const root = await loadDirectory(pythonRoot);
    const work = new Directory(new Map());
    addFile(work, "main.py", new TextEncoder().encode(code));
    root.contents.set("work", work);

    const sitePackages = new Directory(new Map());
    if (options.fs) {
      for (const file of options.fs.snapshot()) {
        const path = file.path.replace(/^\/?site-packages\//, "").replace(/^\//, "");
        if (path) addFile(sitePackages, path, new Uint8Array(file.data));
      }
    }
    root.contents.set("site-packages", sitePackages);

    let stdout = "";
    let stderr = "";
    const stdoutFd = ConsoleStdout.lineBuffered((line) => { stdout += line + "\n"; });
    const stderrFd = ConsoleStdout.lineBuffered((line) => { stderr += line + "\n"; });
    const wasi = new WASI(
      ["python.wasm", "/work/main.py", ...args],
      Object.entries({ ...process.env, ...options.env, PYTHONPATH: "/Lib:/site-packages" })
        .filter((entry): entry is [string, string] => entry[1] !== undefined)
        .map(([key, value]) => `${key}=${value}`),
      [new OpenFile(new File([])), stdoutFd, stderrFd, new PreopenDirectory("/", root.contents)],
    );

    try {
      const bytes = await readFile(options.pythonWasm);
      const module = await WebAssembly.compile(bytes);
      const instance = await WebAssembly.instantiate(module, {
        wasi_snapshot_preview1: wasi.wasiImport,
      });
      const exitCode = wasi.start(instance);
      return { stdout, stderr, exitCode };
    } catch (error) {
      return {
        stdout,
        stderr: stderr + (error instanceof Error ? error.message : String(error)) + "\n",
        exitCode: 1,
      };
    }
  };
}
