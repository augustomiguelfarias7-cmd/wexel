import { randomUUID } from "node:crypto";
import { createBusyBoxRunner, type BusyBoxFactory } from "./busybox.js";
import { createWasiPythonRunner, type WasiPythonOptions } from "./node-cpython.js";
import { nodeWasiPythonRunnerFactory, type NodeWasiPythonOptions } from "./node-wasi-python.js";
import { DenoWasmRuntime } from "./deno-wasm.js";
import { createDenoNativeRunner, type DenoNativeOptions } from "./deno-native-adapter.js";
import { runDenoNodeWorker } from "./deno-node-worker.js";
import { Wexel, type WexelPermissions, type WexelRuntime } from "./index.js";
import type { NativeExtensionManifest } from "./native-extensions.js";
import { WebPink, type WebPinkClient, type WebPinkOptions, type WebPinkSandboxPolicy } from "./web-pink.js";

export interface NodeExecutionBusyBoxOptions {
  factory: BusyBoxFactory;
  wasmSource?: string | BufferSource;
  wasmUrl?: string;
}

export interface NodeExecutionOptions {
  coreBytes: BufferSource;
  denoRuntime?: DenoWasmRuntime;
  /**
   * Backend padrão: Deno nativo é lançado como processo interno da sandbox
   * Wexel, com VFS materializada, permissões e rede controladas.
   */
  denoNative?: Omit<DenoNativeOptions, "env"> | false;
  /**
   * Worker/shim legado. Desligado por padrão. Mantido apenas para compatibilidade
   * com projetos antigos que ainda dependem dessa implementação.
   */
  denoNodeWorker?: boolean;
  python?: Omit<WasiPythonOptions, "fs">;
  pythonWasi?: Omit<NodeWasiPythonOptions, "fs"> | false;
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
  fs?: WexelRuntime["fs"];
  webPink?: WebPinkSandboxPolicy;
}

export interface BackendSandbox {
  id: string;
  runtime: WexelRuntime;
  createdAt: number;
  webPink?: WebPinkClient;
}

export class NodeExecution {
  private readonly sandboxes = new Map<string, BackendSandbox>();
  private readonly busyBox?: Awaited<ReturnType<typeof createBusyBoxRunner>>;
  readonly webPink?: WebPink;

  private constructor(
    private readonly options: NodeExecutionOptions,
    busyBox?: Awaited<ReturnType<typeof createBusyBoxRunner>>,
    webPink?: WebPink,
  ) {
    this.busyBox = busyBox;
    this.webPink = webPink;
  }

  static async create(options: NodeExecutionOptions): Promise<NodeExecution> {
    const busyBoxOptions = options.busyBox;
    if (busyBoxOptions && !busyBoxOptions.wasmSource && !busyBoxOptions.wasmUrl) {
      throw new Error("Node Execution requer busyBox.wasmSource ou busyBox.wasmUrl.");
    }
    const busyBox = busyBoxOptions
      ? await createBusyBoxRunner(
          busyBoxOptions.factory,
          busyBoxOptions.wasmSource ?? busyBoxOptions.wasmUrl!,
        )
      : undefined;
    return new NodeExecution(
      options,
      busyBox,
      options.webPink ? new WebPink(options.webPink) : undefined,
    );
  }

  async createSandbox(options: SandboxOptions = {}): Promise<BackendSandbox> {
    const id = options.id ?? randomUUID();
    if (this.sandboxes.has(id)) throw new Error(`Sandbox já existe: ${id}`);

    const webPink = this.webPink?.createClient(id, options.webPink);
    const sandboxFetcher = webPink?.fetch.bind(webPink) as typeof fetch | undefined;

    const nativeDeno = this.options.denoNative === false
      ? undefined
      : {
          ...(this.options.denoNative ?? {}),
          networkAllowed: !!options.permissions?.network,
          timeoutMs: this.options.denoNative?.timeoutMs ?? 30_000,
        };

    const useLegacyWorker = this.options.denoNodeWorker === true && !nativeDeno && !this.options.denoRuntime;

    const runtime = await Wexel.create({
      coreBytes: this.options.coreBytes,
      permissions: options.permissions,
      storageQuotaBytes: options.storageQuotaBytes,
      homeDirectory: options.homeDirectory ?? `/home/${id}`,
      fs: options.fs,
      denoRuntime: this.options.denoRuntime,
      denoRunner: nativeDeno
        ? createDenoNativeRunnerPlaceholder(nativeDeno, sandboxFetcher)
        : useLegacyWorker
          ? (code, language, args) => runDenoNodeWorker(
              runtime.fs,
              {
                networkAllowed: !!options.permissions?.network,
                fetcher: sandboxFetcher ?? fetch,
                timeoutMs: 30_000,
                preferNative: false,
              },
              { code, language: language as "javascript" | "typescript", args },
            )
          : undefined,
      pythonRunnerFactory: this.options.python
        ? (fs) => createWasiPythonRunner({ ...this.options.python!, fs })
        : this.options.pythonWasi === false
          ? undefined
          : nodeWasiPythonRunnerFactory(this.options.pythonWasi ?? {}),
      bashRunner: this.busyBox
        ? async (args) => this.busyBox!.run({ args: ["busybox", "sh", ...args] })
        : undefined,
      networkFetch: sandboxFetcher,
      nativeCliBytes: this.options.nativeCliBytes,
      nativeExtensions: this.options.nativeExtensions,
    });

    const sandbox = { id, runtime, createdAt: Date.now(), webPink };
    this.sandboxes.set(id, sandbox);
    return sandbox;
  }

  getSandbox(id: string): BackendSandbox | undefined {
    return this.sandboxes.get(id);
  }

  listSandboxes(): BackendSandbox[] {
    return [...this.sandboxes.values()];
  }

  destroySandbox(id: string): boolean {
    this.webPink?.removeClient(id);
    return this.sandboxes.delete(id);
  }

  async dispose(): Promise<void> {
    for (const id of this.sandboxes.keys()) this.webPink?.removeClient(id);
    this.sandboxes.clear();
  }
}

/**
 * Cria o runner depois que WexelRuntime existe. A função devolvida captura
 * o runtime somente no momento da execução, evitando depender de uma VFS
 * inexistente durante a construção do objeto Wexel.
 */
function createDenoNativeRunnerPlaceholder(
  options: DenoNativeOptions,
  fetcher?: typeof fetch,
) {
  return async function run(code: string, language: "javascript" | "typescript", args: string[]): Promise<import("./index.js").ExecResult> {
    throw new Error(
      "Deno native runner precisa ser conectado à VFS da sandbox antes da execução. Use DenoRuntime.create({ fs }) ou configure o runner explicitamente.",
    );
  };
}
