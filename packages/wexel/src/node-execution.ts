import { randomUUID } from "node:crypto";
import { createBusyBoxRunner, type BusyBoxFactory } from "./busybox.js";
import { createWasiPythonRunner, type WasiPythonOptions } from "./node-cpython.js";
import { nodeWasiPythonRunnerFactory, type NodeWasiPythonOptions } from "./node-wasi-python.js";
import { Wexel, type WexelPermissions, type WexelRuntime, type ExecResult } from "./index.js";
import type { NativeExtensionManifest } from "./native-extensions.js";
import { WebPink, type WebPinkClient, type WebPinkOptions, type WebPinkSandboxPolicy } from "./web-pink.js";
import { S1Kernel, type S1KernelOptions } from "./s1-kernel.js";
export { S1Kernel } from "./s1-kernel.js";
export type { S1KernelOptions, S1SocketHost } from "./s1-kernel.js";
import type { WexelOrchester, WexelOrchesterOptions } from "./wexel-orchester.js";

export interface NodeExecutionBusyBoxOptions {
  factory: BusyBoxFactory;
  wasmSource?: string | BufferSource;
  wasmUrl?: string;
}

export interface NodeExecutionOptions {
  coreBytes: BufferSource;
  /** Executa JS/TS via Wexel.js (Edge.js + QuickJS-NG). Ver assets/wexeljs/edgejs.wasm. */
  wexelJsRunner?: (code: string, language: "javascript" | "typescript", args: string[]) => Promise<ExecResult> | ExecResult;
  /** Kernel S1 compilado para WebAssembly; cada sandbox recebe estado isolado. */
  sKernel?: S1KernelOptions;
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
  sKernel?: S1Kernel;
}

export class NodeExecution {
  private readonly sandboxes = new Map<string, BackendSandbox>();
  readonly webPink?: WebPink;
  /** Estado de kernel isolado por sandbox. */
  private readonly sKernels = new Map<string, S1Kernel>();

  private constructor(private readonly options: NodeExecutionOptions, webPink?: WebPink) {
    this.webPink = webPink;
  }

  static async create(options: NodeExecutionOptions): Promise<NodeExecution> {
    const busyBoxOptions = options.busyBox;
    if (busyBoxOptions && !busyBoxOptions.wasmSource && !busyBoxOptions.wasmUrl) {
      throw new Error("Node Execution requer busyBox.wasmSource ou busyBox.wasmUrl.");
    }
    return new NodeExecution(
      options,
      options.webPink ? new WebPink(options.webPink) : undefined,
    );
  }


  /** Cria o gerenciador multiprocesso para sandboxes isoladas em processos Node.js separados. */
  static async createOrchester(options: Pick<NodeExecutionOptions, "coreBytes"> & {
    permissions?: WexelPermissions;
    storageQuotaBytes?: number;
    startupTimeoutMs?: number;
    shutdownTimeoutMs?: number;
    onEvent?: (event: import("./wexel-orchester.js").WexelOrchesterEvent) => void;
    workerPath?: string;
    webPink?: Omit<WebPinkOptions, "fetcher">;
  }): Promise<import("./wexel-orchester.js").WexelOrchester> {
    const { WexelOrchester } = await import("./wexel-orchester.js");
    return WexelOrchester.create(options);
  }

  /**
   * Cria um orquestrador multiprocesso usando o Core desta instância.
   * Encaminha a configuração serializável do WebPink e as permissões de rede.
   * Runners JS/Python, kernel, BusyBox e adaptadores FS ainda não são encaminhados.
   */
  async createOrchester(options: Omit<WexelOrchesterOptions, "coreBytes"> = {}): Promise<WexelOrchester> {
    const { WexelOrchester } = await import("./wexel-orchester.js");
    const webPink = this.options.webPink ? {
      allowHosts: this.options.webPink.allowHosts,
      requestTimeoutMs: this.options.webPink.requestTimeoutMs,
      maxResponseBytes: this.options.webPink.maxResponseBytes,
      policyJson: this.options.webPink.policyJson,
    } : undefined;
    return WexelOrchester.create({ ...options, coreBytes: this.options.coreBytes, webPink: options.webPink ?? webPink });
  }

  async createSandbox(options: SandboxOptions = {}): Promise<BackendSandbox> {
    const id = options.id ?? randomUUID();
    if (this.sandboxes.has(id)) throw new Error(`Sandbox já existe: ${id}`);

    const webPink = this.webPink?.createClient(id, options.webPink);
    // Toda chamada de rede do runtime passa por este wrapper, mesmo quando
    // WebPink não foi configurado. Sem isso, o fallback global fetch ignoraria
    // permissions.network e permitiria rede por caminhos como curl/PyPI.
    const sandboxFetcher: typeof fetch = (async (input, init) => {
      if (options.permissions?.network !== true) {
        throw new Error("Permissão de rede negada para esta sandbox.");
      }
      if (webPink) return webPink.fetch(input, init);
      return fetch(input, init);
    }) as typeof fetch;

    // Cada sandbox recebe uma instância isolada do kernel S1.
    const sKernelOptions = this.options.sKernel ?? {};
    const sKernel = await S1Kernel.boot({
      ...sKernelOptions,
      allowNetwork: options.permissions?.network === true && sKernelOptions.allowNetwork === true,
    });

    const sandboxBusyBox = this.options.busyBox
      ? await createBusyBoxRunner(
          this.options.busyBox.factory,
          this.options.busyBox.wasmSource ?? this.options.busyBox.wasmUrl!,
        )
      : undefined;

    if (this.options.busyBox) {
      const registered = sKernel.registerService("busybox", 1);
      if (registered < 0 && registered !== -17) throw new Error(`S1 não conseguiu registrar BusyBox: ${registered}`);
      const started = sKernel.startService("busybox");
      if (started < 0 && started !== -17) throw new Error(`S1 não conseguiu iniciar BusyBox: ${started}`);
    }

    const runtime = await Wexel.create({
      coreBytes: this.options.coreBytes,
      shellRunner: sandboxBusyBox
        ? async (command) => sandboxBusyBox.run({ args: ["busybox", "sh", "-c", command] })
        : undefined,
      permissions: options.permissions,
      storageQuotaBytes: options.storageQuotaBytes,
      homeDirectory: options.homeDirectory ?? `/home/${id}`,
      fs: options.fs,
      wexelJsRunner: this.options.wexelJsRunner,
      pythonRunnerFactory: this.options.python
        ? (fs) => createWasiPythonRunner({ ...this.options.python!, fs })
        : this.options.pythonWasi === false
          ? undefined
          : nodeWasiPythonRunnerFactory(this.options.pythonWasi ?? {}),
      bashRunner: sandboxBusyBox
        ? async (args) => sandboxBusyBox.run({ args: ["busybox", "sh", ...args] })
        : undefined,
      networkFetch: sandboxFetcher,
      nativeCliBytes: this.options.nativeCliBytes,
      nativeExtensions: this.options.nativeExtensions,
    });

    const sandbox = { id, runtime, createdAt: Date.now(), webPink, sKernel };
    this.sKernels.set(id, sKernel);
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
    this.sKernels.delete(id);
    return this.sandboxes.delete(id);
  }

  async dispose(): Promise<void> {
    for (const id of this.sandboxes.keys()) this.webPink?.removeClient(id);
    this.sandboxes.clear();
    this.sKernels.clear();
  }
}

