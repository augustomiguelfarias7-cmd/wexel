/**
 * browser-wasi-python.ts — Wexel
 * Carrega python.wasm via WebAssembly API + WexelWasiShim (sem Wasmtime).
 */

import type { ExecResult, WexelFileSystem } from "./index.js";
import { WexelAssetLoader, type WexelAssetLoaderOptions } from "./asset-loader.js";
import { WexelWasiShim, type WasiShimOptions } from "./wasi-shim.js";

export interface BrowserWasiPythonOptions {
  fs?: WexelFileSystem;
  pythonWasm?: BufferSource | string;
  assetLoader?: WexelAssetLoader;
  assetLoaderOptions?: WexelAssetLoaderOptions;
  wasi?: Omit<WasiShimOptions, "fs">;
  eagerLoad?: boolean;
}

export interface BrowserWasiPythonRunner {
  readonly bytes: ArrayBuffer | null;
  readonly instance: WebAssembly.Instance | null;
  readonly shim: WexelWasiShim | null;
  load(): Promise<void>;
  run(code: string, args?: string[]): Promise<ExecResult>;
}

export function createBrowserWasiPythonRunner(options: BrowserWasiPythonOptions = {}): BrowserWasiPythonRunner {
  const loader = options.assetLoader ?? new WexelAssetLoader(options.assetLoaderOptions ?? {});
  let bytes: ArrayBuffer | null = null;
  let instance: WebAssembly.Instance | null = null;
  let shim: WexelWasiShim | null = null;

  async function load() {
    const loadOpts =
      typeof options.pythonWasm === "string"
        ? { url: options.pythonWasm }
        : options.pythonWasm
          ? { bytes: options.pythonWasm }
          : {};
    const loaded = await loader.loadBinary("python", { ...loadOpts, instantiate: false });
    bytes = loaded.bytes;
  }

  async function run(code: string, args: string[] = []): Promise<ExecResult> {
    if (!bytes) {
      try { await load(); }
      catch (error) {
        return { stdout: "", stderr: `BrowserWasiPython: ${error instanceof Error ? error.message : String(error)}\n`, exitCode: 1 };
      }
    }
    if (!bytes) return { stdout: "", stderr: "BrowserWasiPython: sem bytes\n", exitCode: 1 };
    if (options.fs) {
      try { options.fs.mkdir?.("/tmp"); } catch { /* */ }
      options.fs.write("/tmp/main.py", code);
    }
    shim = new WexelWasiShim({
      args: ["python", "/tmp/main.py", ...args],
      env: { PYTHONHOME: "/", PYTHONPATH: "/Lib:/site-packages:/tmp", PYTHONDONTWRITEBYTECODE: "1", ...(options.wasi?.env ?? {}) },
      fs: options.fs,
      captureStdio: true,
      ...options.wasi,
    });
    try {
      const result = await WebAssembly.instantiate(bytes, shim.getImportObject());
      instance = result.instance;
      shim.setInstance(instance);
      const exitCode = shim.start(instance);
      return { stdout: shim.stdoutText, stderr: shim.stderrText, exitCode };
    } catch (error) {
      return {
        stdout: shim?.stdoutText ?? "",
        stderr: `${shim?.stderrText ?? ""}${error instanceof Error ? error.message : String(error)}\n`,
        exitCode: 1,
      };
    }
  }

  const runner: BrowserWasiPythonRunner = {
    get bytes() { return bytes; },
    get instance() { return instance; },
    get shim() { return shim; },
    load,
    run,
  };
  if (options.eagerLoad) void load().catch(() => {});
  return runner;
}

export function browserWasiPythonRunnerFactory(
  options: Omit<BrowserWasiPythonOptions, "fs"> = {},
): (fs: WexelFileSystem) => (code: string, args: string[]) => Promise<ExecResult> {
  return (fs) => {
    const runner = createBrowserWasiPythonRunner({ ...options, fs });
    return (code, args) => runner.run(code, args);
  };
}
