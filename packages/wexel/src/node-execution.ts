import { randomUUID } from "node:crypto";
import { createBusyBoxRunner, type BusyBoxFactory } from "./busybox.js";
import { createWasiPythonRunner, type WasiPythonOptions } from "./node-cpython.js";
import { DenoWasmRuntime } from "./deno-wasm.js";
import { runDenoNodeWorker } from "./deno-node-worker.js";
import { Wexel, type WexelPermissions, type WexelRuntime } from "./index.js";
import type { NativeExtensionManifest } from "./native-extensions.js";
import { WebPink, type WebPinkClient, type WebPinkOptions, type WebPinkSandboxPolicy } from "./web-pink.js";

export interface NodeExecutionBusyBoxOptions {
  factory: BusyBoxFactory;
  /** Bytes do artefato evitam `fetch(file:)` no Node. */
  wasmSource?: string | BufferSource;
  /** @deprecated Use wasmSource. Mantido para compatibilidade. */
  wasmUrl?: string;
}

export interface NodeExecutionOptions {
  coreBytes: BufferSource;
  denoRuntime?: DenoWasmRuntime;
  /**
   * Usa worker_threads + WebAssembly.Memory shared para rodar o Deno
   * dentro das sandboxes — equivalente ao Web Worker no browser.
   * A rede passa automaticamente pelo WebPink da sandbox.
   * Padrão: true quando denoRuntime não está definido.
   */
  denoNodeWorker?: boolean;
  python?: Omit<WasiPythonOptions, "fs">;
  busyBox?: NodeExecutionBusyBoxOptions;
  nativeCliBytes?: BufferSource;
  nativeExtensions?: Array<{ manifest: NativeExtensionManifest; source: BufferSource }>;
  webPink?: WebPinkOptions;
}

export interface SandboxOptions {
  id?: string;
  permissions?: WexelPermissions;
  storageQuotaBytes?: number;
  homeDirectory?: string;
  webPink?: WebPinkSandboxPolicy;
}

export interface BackendSandbox {
  id: string;
  runtime: WexelRuntime;
  createdAt: number;
  webPink?: WebPinkClient;
}

/**
 * Gerencia runtimes isolados para aplicações Node, Express, Fastify ou APIs
 * próprias. Cada sandbox recebe uma VFS, permissões e instância WASM próprias.
 * A criação somente carrega componentes; nenhum script é executado até `exec`.
 */
export class NodeExecution {
  private readonly sandboxes = new Map<string, BackendSandbox>();
  private readonly busyBox?: Awaited<ReturnType<typeof createBusyBoxRunner>>;
  readonly webPink?: WebPink;
  private constructor(private readonly options: NodeExecutionOptions, busyBox?: Awaited<ReturnType<typeof createBusyBoxRunner>>, webPink?: WebPink) {
    this.busyBox = busyBox;
    this.webPink = webPink;
  }

  static async create(options: NodeExecutionOptions): Promise<NodeExecution> {
    const busyBoxOptions = options.busyBox;
    if (busyBoxOptions && !busyBoxOptions.wasmSource && !busyBoxOptions.wasmUrl) throw new Error("Node Execution requer busyBox.wasmSource ou busyBox.wasmUrl.");
    const busyBox = busyBoxOptions ? await createBusyBoxRunner(busyBoxOptions.factory, busyBoxOptions.wasmSource ?? busyBoxOptions.wasmUrl!) : undefined;
    return new NodeExecution(options, busyBox, options.webPink ? new WebPink(options.webPink) : undefined);
  }

  async createSandbox(options: SandboxOptions = {}): Promise<BackendSandbox> {
    const id = options.id ?? randomUUID();
    if (this.sandboxes.has(id)) throw new Error(`Sandbox já existe: ${id}`);
    const webPink = this.webPink?.createClient(id, options.webPink);
    // Decide o runner Deno para esta sandbox
    const useNodeWorker = this.options.denoNodeWorker !== false && !this.options.denoRuntime;
    const sandboxFetcher = webPink?.fetch.bind(webPink) as typeof fetch | undefined;

    const runtime = await Wexel.create({
      coreBytes: this.options.coreBytes,
      permissions: options.permissions,
      storageQuotaBytes: options.storageQuotaBytes,
      homeDirectory: options.homeDirectory ?? `/home/${id}`,
      denoRuntime: this.options.denoRuntime,
      // Worker_thread + memória WASM compartilhada + WebPink como rede
      denoRunner: useNodeWorker
        ? (code, language, args) => runDenoNodeWorker(
            runtime.fs,
            {
              networkAllowed:  !!options.permissions?.network,
              fetcher:         sandboxFetcher ?? fetch,
              timeoutMs:       30_000,
            },
            { code, language: language as "javascript" | "typescript", args },
          )
        : undefined,
      pythonRunnerFactory: this.options.python ? (fs) => createWasiPythonRunner({ ...this.options.python!, fs }) : undefined,
      bashRunner: this.busyBox ? async (args) => this.busyBox!.run({ args: ["busybox", "sh", ...args] }) : undefined,
      networkFetch: sandboxFetcher,
      nativeCliBytes: this.options.nativeCliBytes,
      nativeExtensions: this.options.nativeExtensions,
    });
    const sandbox = { id, runtime, createdAt: Date.now(), webPink };
    this.sandboxes.set(id, sandbox);
    return sandbox;
  }

  getSandbox(id: string): BackendSandbox | undefined { return this.sandboxes.get(id); }
  listSandboxes(): BackendSandbox[] { return [...this.sandboxes.values()]; }
  destroySandbox(id: string): boolean { this.webPink?.removeClient(id); return this.sandboxes.delete(id); }
  async dispose(): Promise<void> { for (const id of this.sandboxes.keys()) this.webPink?.removeClient(id); this.sandboxes.clear(); }
}
