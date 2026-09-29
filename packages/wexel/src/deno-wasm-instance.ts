/**
 * Per-instance runner for an already compiled Deno WASM module.
 *
 * Compilation is shared by the pool; execution state and imports are not.
 * The Deno guest is presented with a Linux-like OS boundary backed by Wexel.
 */
import type { ExecResult, WexelFileSystem } from "./index.js";
import type { NetworkFetcher } from "./deno-net-bridge.js";
import { createDenoLinuxHost } from "./deno-linux-host.js";

export interface DenoWasmInstanceOptions {
  module: WebAssembly.Module;
  fs: WexelFileSystem;
  networkAllowed?: boolean;
  fetcher?: NetworkFetcher;
}

type Exports = WebAssembly.Exports & {
  memory?: WebAssembly.Memory;
  wexel_deno_abi_version?: () => number;
  wexel_runtime_init?: () => void;
  wexel_run?: (ptr: number, len: number, language: number, argsPtr: number, argsLen: number) => number;
  wexel_alloc?: (size: number) => number;
  wexel_free?: (ptr: number, size: number) => void;
};

const ABI = 30002;

export interface DenoWasmSession {
  run(code: string, language: "javascript" | "typescript", args?: string[]): Promise<ExecResult>;
  dispose(): void;
}

/** Creates one persistent Deno WASM instance. The compiled Module is shared,
 * while memory, file descriptors and runtime state belong to this session. */
export async function createDenoWasmSession(options: DenoWasmInstanceOptions): Promise<DenoWasmSession> {
  const output = { stdout: [] as string[], stderr: [] as string[], exitCode: 0 };
  const linuxHost = createDenoLinuxHost({
    fs: options.fs,
    networkAllowed: options.networkAllowed ?? false,
    fetcher: options.fetcher ?? fetch,
    output,
  });
  const result = await WebAssembly.instantiate(options.module, {
    ...linuxHost.imports,
    __wexel_syscalls: {
      fs_read: (path: string) => options.fs.read(path),
      fs_write: (path: string, data: Uint8Array) => options.fs.write(path, data),
      fs_exists: (path: string) => options.fs.exists(path),
      fs_mkdir: (path: string) => options.fs.mkdir(path),
      fs_remove: (path: string) => options.fs.remove(path),
      fs_list: (path: string) => JSON.stringify(options.fs.list(path)),
      fs_cwd: () => options.fs.pwd(),
      fs_cd: (path: string) => options.fs.cd(path),
      env_get: (key: string) => ({ HOME: options.fs.home, PATH: "/bin:/usr/bin", DENO_DIR: options.fs.home + "/.deno", WEXEL_DENO_ABI: String(ABI) } as Record<string, string>)[key] ?? "",
      stdout_write: (value: string) => output.stdout.push(value),
      stderr_write: (value: string) => output.stderr.push(value),
      proc_exit: (code: number) => { output.exitCode = Number(code); },
    },
  });
  const instance = result instanceof WebAssembly.Instance ? result : result.instance;
  const exp = instance.exports as Exports;
  if (!exp.memory) throw new Error("O runtime Deno WASM não exporta memory.");
  linuxHost.bindMemory(exp.memory);
  const version = exp.wexel_deno_abi_version?.();
  if (version !== undefined && Number(version) < ABI) throw new Error(`Deno Linux ABI incompatível: ${version}, esperado >= ${ABI}.`);
  if (!exp.wexel_run || !exp.wexel_alloc) throw new Error("O runtime Deno WASM não expõe a ABI de execução Wexel.");
  exp.wexel_runtime_init?.();
  let disposed = false;
  return {
    async run(code, language, args = []) {
      if (disposed) throw new Error("Deno WASM session já foi encerrada.");
      output.stdout.length = 0; output.stderr.length = 0; output.exitCode = 0;
      const payload = new TextEncoder().encode(JSON.stringify({ code, language, args }));
      const ptr = exp.wexel_alloc(payload.byteLength + 1);
      new Uint8Array(exp.memory!.buffer, ptr, payload.byteLength).set(payload);
      new Uint8Array(exp.memory!.buffer)[ptr + payload.byteLength] = 0;
      try {
        const returned = exp.wexel_run!(ptr, payload.byteLength, language === "typescript" ? 1 : 0, 0, 0);
        if (Number.isFinite(returned)) output.exitCode = Number(returned);
      } catch (error) {
        if (!(error instanceof Error && error.message === "WEXEL_DENO_PROCESS_EXIT")) throw error;
      } finally { exp.wexel_free?.(ptr, payload.byteLength + 1); }
      return { stdout: output.stdout.join(""), stderr: output.stderr.join(""), exitCode: output.exitCode };
    },
    dispose() { disposed = true; },
  };
}

export async function runDenoWasmInstance(
  options: DenoWasmInstanceOptions,
  code: string,
  language: "javascript" | "typescript",
  args: string[] = [],
): Promise<ExecResult> {
  const output = { stdout: [] as string[], stderr: [] as string[], exitCode: 0 };
  const linuxHost = createDenoLinuxHost({
    fs: options.fs,
    networkAllowed: options.networkAllowed ?? false,
    fetcher: options.fetcher ?? fetch,
    output,
  });

  const result = await WebAssembly.instantiate(options.module, {
    ...linuxHost.imports,
    __wexel_syscalls: {
      fs_read: (path: string) => options.fs.read(path),
      fs_write: (path: string, data: Uint8Array) => options.fs.write(path, data),
      fs_exists: (path: string) => options.fs.exists(path),
      fs_mkdir: (path: string) => options.fs.mkdir(path),
      fs_remove: (path: string) => options.fs.remove(path),
      fs_list: (path: string) => JSON.stringify(options.fs.list(path)),
      fs_cwd: () => options.fs.pwd(),
      fs_cd: (path: string) => options.fs.cd(path),
      env_get: (key: string) => ({
        HOME: options.fs.home,
        PATH: "/bin:/usr/bin",
        DENO_DIR: options.fs.home + "/.deno",
        WEXEL_DENO_ABI: String(ABI),
      } as Record<string, string>)[key] ?? "",
      stdout_write: (value: string) => output.stdout.push(value),
      stderr_write: (value: string) => output.stderr.push(value),
      proc_exit: (code: number) => { output.exitCode = Number(code); },
    },
  });

  const instance = result instanceof WebAssembly.Instance ? result : result.instance;
  const exp = instance.exports as Exports;

  if (!exp.memory) throw new Error("O runtime Deno WASM não exporta memory.");
  linuxHost.bindMemory(exp.memory);

  const version = exp.wexel_deno_abi_version?.();
  if (version !== undefined && Number(version) < ABI) {
    throw new Error(`Deno Linux ABI incompatível: ${version}, esperado >= ${ABI}.`);
  }
  if (!exp.wexel_run || !exp.wexel_alloc) {
    throw new Error("O runtime Deno WASM não expõe a ABI de execução Wexel.");
  }

  exp.wexel_runtime_init?.();

  const payload = new TextEncoder().encode(JSON.stringify({ code, language, args }));
  const ptr = exp.wexel_alloc(payload.byteLength + 1);
  new Uint8Array(exp.memory.buffer, ptr, payload.byteLength).set(payload);
  new Uint8Array(exp.memory.buffer)[ptr + payload.byteLength] = 0;

  try {
    const returned = exp.wexel_run(ptr, payload.byteLength, language === "typescript" ? 1 : 0, 0, 0);
    if (Number.isFinite(returned)) output.exitCode = Number(returned);
  } catch (error) {
    if (!(error instanceof Error && error.message === "WEXEL_DENO_PROCESS_EXIT")) throw error;
  } finally {
    exp.wexel_free?.(ptr, payload.byteLength + 1);
  }

  return {
    stdout: output.stdout.join(""),
    stderr: output.stderr.join(""),
    exitCode: output.exitCode,
  };
}
