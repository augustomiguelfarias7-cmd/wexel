/**
 * deno-linux-adapter.ts — Wexel
 *
 * Camada de compatibilidade Linux para o Deno WASM no browser.
 *
 * O adapter NÃO implementa um Deno falso. Ele fornece a ponte que um
 * Deno WASM real usa para enxergar os recursos do Wexel:
 *
 *   Deno WASM
 *       ↓
 *   Linux ABI / host calls
 *       ↓
 *   ┌───────────────┬────────────────┐
 *   │ Wexel VFS     │ Browser network│
 *   └───────────────┴────────────────┘
 *
 * A execução deve acontecer dentro de um DedicatedWorker. O worker recebe
 * somente os canais necessários e o módulo Deno WASM real.
 */

import type { WexelFileSystem } from "./index.js";
import type { NetworkFetcher } from "./deno-net-bridge.js";
import { createWasmFsChannel, serveWasmFs, type WasmFsChannel } from "./deno-wasm-fs.js";
import { NetBridgeHost } from "./deno-net-bridge.js";

export const DENO_LINUX_ADAPTER_ABI = 1;

export interface DenoLinuxAdapterOptions {
  fs: WexelFileSystem;
  networkAllowed?: boolean;
  fetcher?: NetworkFetcher;
}

/**
 * Host-side Linux adapter.
 *
 * The adapter owns the two host bridges. The Deno WASM module never gets
 * direct access to the browser's filesystem or network APIs.
 */
export class DenoLinuxAdapter {
  readonly fsChannel: WasmFsChannel;
  readonly networkAllowed: boolean;
  readonly fetcher: NetworkFetcher;

  private readonly stopFs: () => void;
  private readonly netHost: NetBridgeHost;

  constructor(options: DenoLinuxAdapterOptions) {
    this.fsChannel = createWasmFsChannel();
    this.networkAllowed = options.networkAllowed ?? false;
    this.fetcher = options.fetcher ?? fetch;

    this.stopFs = serveWasmFs(this.fsChannel, options.fs);

    const { port1, port2 } = new MessageChannel();
    this.netHost = new NetBridgeHost(
      port1,
      this.fetcher,
      this.networkAllowed,
    );

    this.netPort = port2;
  }

  private readonly netPort: MessagePort;

  /**
   * Transferable host resources for the dedicated Deno worker.
   */
  workerInit(): {
    fsSab: SharedArrayBuffer;
    netPort: MessagePort;
    abiVersion: number;
  } {
    return {
      fsSab: this.fsChannel.sab,
      netPort: this.netPort,
      abiVersion: DENO_LINUX_ADAPTER_ABI,
    };
  }

  dispose(): void {
    this.stopFs();
    this.netHost.dispose();
    this.netPort.close();
  }
}

/**
 * Host-call names used by the Linux adapter ABI.
 *
 * These are intentionally explicit instead of pretending that a JS object
 * called "Deno" is the runtime. A real Deno WASM build must bind its WASI /
 * host imports to these operations.
 */
export const DENO_LINUX_HOST_CALLS = Object.freeze([
  "fs_read",
  "fs_write",
  "fs_exists",
  "fs_mkdir",
  "fs_remove",
  "fs_list",
  "fs_cwd",
  "fs_cd",
  "env_get",
  "stdout_write",
  "stderr_write",
  "proc_exit",
  "net_fetch",
  "net_ws_open",
  "net_ws_send",
  "net_ws_close",
] as const);

export type DenoLinuxHostCall = (typeof DENO_LINUX_HOST_CALLS)[number];
