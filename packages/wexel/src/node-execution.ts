import { randomUUID } from "node:crypto";
import { createBusyBoxRunner, type BusyBoxFactory } from "./busybox.js";
import { createWasiPythonRunner, type WasiPythonOptions } from "./node-cpython.js";
import { nodeWasiPythonRunnerFactory, type NodeWasiPythonOptions } from "./node-wasi-python.js";
import { Wexel, type WexelPermissions, type WexelRuntime, type ExecResult } from "./index.js";
import type { NativeExtensionManifest } from "./native-extensions.js";
import { WebPink, type WebPinkClient, type WebPinkOptions, type WebPinkSandboxPolicy } from "./web-pink.js";
import { bootKernel } from "./kernel-boot.js";

export interface NodeExecutionBusyBoxOptions {
  factory: BusyBoxFactory;
  wasmSource?: string | BufferSource;
  wasmUrl?: string;
}

export interface NodeExecutionOptions {
  coreBytes: BufferSource;
  /** Executa JS/TS via Wexel.js (Edge.js + QuickJS-NG). Ver assets/wexeljs/edgejs.wasm. */
  wexelJsRunner?: (code: string, language: "javascript" | "typescript", args: string[]) => Promise<ExecResult> | ExecResult;
  /** Kernel Linux-WASM (ver kernel-boot.ts). Sem isso, sandbox.shell fica undefined. */
  linuxKernel?: Parameters<typeof bootKernel>[0];
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
  /** Cada sandbox recebe seu próprio boot/kernel Linux-WASM. */
  private readonly kernelBoots = new Map<string, Awaited<ReturnType<typeof bootKernel>>>();

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

    // Não reutilizar a instância do kernel: cada sandbox precisa de estado isolado.
    const kernelBoot = this.options.linuxKernel
      ? await bootKernel(this.options.linuxKernel)
      : undefined;

    const runtime = await Wexel.create({
      coreBytes: this.options.coreBytes,
      kernel: kernelBoot?.kernel,
      kernelOutput: kernelBoot?.kernelOutput,
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
      bashRunner: this.busyBox
        ? async (args) => this.busyBox!.run({ args: ["busybox", "sh", ...args] })
        : undefined,
      networkFetch: sandboxFetcher,
      nativeCliBytes: this.options.nativeCliBytes,
      nativeExtensions: this.options.nativeExtensions,
    });

    const sandbox = { id, runtime, createdAt: Date.now(), webPink };
    if (kernelBoot) this.kernelBoots.set(id, kernelBoot);
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
    this.kernelBoots.delete(id);
    return this.sandboxes.delete(id);
  }

  async dispose(): Promise<void> {
    for (const id of this.sandboxes.keys()) this.webPink?.removeClient(id);
    this.sandboxes.clear();
    this.kernelBoots.clear();
  }
}

