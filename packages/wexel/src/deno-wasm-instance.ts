/**
 * Per-instance runner for an already compiled Deno WASM module.
 *
 * Compilation is shared by the pool; execution state and imports are not.
 */
import type { ExecResult, WexelFileSystem } from "./index.js";
import type { NetworkFetcher } from "./deno-net-bridge.js";

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

const ABI = 30001;

function importsFor(
  fs: WexelFileSystem,
  fetcher: NetworkFetcher,
  networkAllowed: boolean,
  output: { stdout: string[]; stderr: string[]; exitCode: number },
) {
  return {
    __wexel_syscalls: {
      fs_read: (path: string) => fs.read(path),
      fs_write: (path: string, data: Uint8Array) => fs.write(path, data),
      fs_exists: (path: string) => fs.exists(path),
      fs_mkdir: (path: string) => fs.mkdir(path),
      fs_remove: (path: string) => fs.remove(path),
      fs_list: (path: string) => JSON.stringify(fs.list(path)),
      fs_cwd: () => fs.pwd(),
      fs_cd: (path: string) => fs.cd(path),
      env_get: (key: string) => ({
        HOME: fs.home,
        PATH: "/bin:/usr/bin",
        DENO_DIR: `${fs.home}/.deno`,
        WEXEL_DENO_ABI: String(ABI),
      } as Record<string, string>)[key] ?? "",
      stdout_write: (value: string) => output.stdout.push(value),
      stderr_write: (value: string) => output.stderr.push(value),
      proc_exit: (code: number) => { output.exitCode = Number(code); },
      net_fetch: async (url: string, init?: RequestInit) => {
        if (!networkAllowed) throw new Error("Deno: rede não permitida pela sandbox.");
        const response = await fetcher(url, init);
        return {
          status: response.status,
          headers: [...response.headers.entries()],
          body: new Uint8Array(await response.arrayBuffer()),
        };
      },
    },
  };
}

export async function runDenoWasmInstance(
  options: DenoWasmInstanceOptions,
  code: string,
  language: "javascript" | "typescript",
  args: string[] = [],
): Promise<ExecResult> {
  const output = { stdout: [] as string[], stderr: [] as string[], exitCode: 0 };
  const result = await WebAssembly.instantiate(
    options.module,
    importsFor(options.fs, options.fetcher ?? fetch, options.networkAllowed ?? false, output),
  );
  const instance = result instanceof WebAssembly.Instance ? result : result.instance;
  const exp = instance.exports as Exports;

  const version = exp.wexel_deno_abi_version?.();
  if (version !== undefined && Number(version) < ABI) {
    throw new Error(`Deno WASM ABI incompatível: ${version}, esperado >= ${ABI}.`);
  }
  if (!exp.wexel_run || !exp.wexel_alloc) {
    throw new Error("O runtime Deno WASM não expõe a ABI de execução Wexel.");
  }

  exp.wexel_runtime_init?.();

  const memory = exp.memory;
  if (!memory) throw new Error("O runtime Deno WASM não exporta memory.");

  const payload = new TextEncoder().encode(JSON.stringify({ code, language, args }));
  const ptr = exp.wexel_alloc(payload.byteLength + 1);
  new Uint8Array(memory.buffer, ptr, payload.byteLength).set(payload);
  new Uint8Array(memory.buffer)[ptr + payload.byteLength] = 0;

  try {
    const returned = exp.wexel_run(ptr, payload.byteLength, language === "typescript" ? 1 : 0, 0, 0);
    if (Number.isFinite(returned)) output.exitCode = Number(returned);
  } finally {
    exp.wexel_free?.(ptr, payload.byteLength + 1);
  }

  return {
    stdout: output.stdout.join(""),
    stderr: output.stderr.join(""),
    exitCode: output.exitCode,
  };
}
