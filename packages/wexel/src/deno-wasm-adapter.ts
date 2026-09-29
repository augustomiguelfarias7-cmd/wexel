/**
 * deno-wasm-adapter.ts
 *
 * Host adapter for a real Deno runtime compiled for WebAssembly.
 *
 * Wexel owns the sandbox boundary:
 *   Deno runtime (guest WASM) -> __wexel_syscalls -> Wexel VFS/network
 *
 * There is intentionally no JavaScript Deno shim in this path. The guest
 * runtime must provide the execution ABI below.
 */

import type { ExecResult, WexelFileSystem } from "./index.js";
import { loadDenoWasmArtifact, type DenoWasmArtifactSource } from "./deno-portable-wasm.js";
import type { NetworkFetcher } from "./deno-net-bridge.js";

export interface DenoWasmAdapterOptions {
  fs: WexelFileSystem;
  networkAllowed?: boolean;
  fetcher?: NetworkFetcher;
  timeoutMs?: number;
  artifact?: DenoWasmArtifactSource;
}

type GuestExports = WebAssembly.Exports & {
  memory?: WebAssembly.Memory;
  wexel_runtime_init?: () => void;
  wexel_run?: (codePtr: number, codeLen: number, language: number, argsPtr: number, argsLen: number) => number;
  wexel_alloc?: (size: number) => number;
  wexel_free?: (ptr: number, size: number) => void;
};

const ABI = 30001;

function getMemory(exports: GuestExports): WebAssembly.Memory {
  if (!exports.memory) throw new Error("Deno WASM: export 'memory' ausente.");
  return exports.memory;
}

function allocUtf8(exports: GuestExports, text: string): { ptr: number; len: number } {
  if (!exports.wexel_alloc) throw new Error("Deno WASM: export 'wexel_alloc' ausente.");
  const bytes = new TextEncoder().encode(text);
  const ptr = exports.wexel_alloc(bytes.length + 1);
  new Uint8Array(getMemory(exports).buffer, ptr, bytes.length).set(bytes);
  new Uint8Array(getMemory(exports).buffer)[ptr + bytes.length] = 0;
  return { ptr, len: bytes.length };
}

function readCString(exports: GuestExports, ptr: number): string {
  const memory = new Uint8Array(getMemory(exports).buffer);
  let end = ptr;
  while (end < memory.length && memory[end] !== 0) end++;
  return new TextDecoder().decode(memory.subarray(ptr, end));
}

/**
 * Creates the host imports consumed by the guest Deno runtime.
 *
 * The guest never receives the host filesystem. Every operation is routed
 * through WexelFileSystem and the configured network policy.
 */
function createSyscalls(
  fs: WexelFileSystem,
  fetcher: NetworkFetcher,
  networkAllowed: boolean,
  emit: (kind: "stdout" | "stderr" | "exit", value: string | number) => void,
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
      stdout_write: (text: string) => emit("stdout", text),
      stderr_write: (text: string) => emit("stderr", text),
      proc_exit: (code: number) => emit("exit", code),
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

export async function runDenoWasm(
  options: DenoWasmAdapterOptions,
  code: string,
  language: "javascript" | "typescript",
  args: string[] = [],
): Promise<ExecResult> {
  const artifact = await loadDenoWasmArtifact(options.artifact);
  const stdout: string[] = [];
  const stderr: string[] = [];
  let exitCode = 0;

  const imports = createSyscalls(
    options.fs,
    options.fetcher ?? fetch,
    options.networkAllowed ?? false,
    (kind, value) => {
      if (kind === "stdout") stdout.push(String(value));
      else if (kind === "stderr") stderr.push(String(value));
      else exitCode = Number(value);
    },
  );

  const instance = await WebAssembly.instantiate(artifact.module, imports);
  const exports = instance.exports as GuestExports;

  if (typeof exports.wexel_deno_abi_version === "function") {
    const version = Number((exports.wexel_deno_abi_version as () => number)());
    if (version < 30001) {
      throw new Error(`Deno WASM: ABI incompatível (${version}, esperado >= 30001).`);
    }
  }

  exports.wexel_runtime_init?.();

  if (!exports.wexel_run) {
    throw new Error(
      "Deno WASM: runtime carregado, mas o export 'wexel_run' não existe. " +
      "O asset precisa ser o runtime Deno real adaptado à ABI Wexel.",
    );
  }

  const payload = JSON.stringify({ code, language, args });
  const { ptr, len } = allocUtf8(exports, payload);
  try {
    const result = exports.wexel_run(ptr, len, language === "typescript" ? 1 : 0, 0, 0);
    if (Number.isFinite(result)) exitCode = Number(result);
  } finally {
    exports.wexel_free?.(ptr, len + 1);
  }

  return { stdout: stdout.join(""), stderr: stderr.join(""), exitCode };
}
