/**
 * deno-browser-host.ts — Wexel
 *
 * Inicializa o ambiente para rodar Deno no browser:
 *   1. Instala o Service Worker (intercept /wexel-vfs/*)
 *   2. Serve o VFS via SharedArrayBuffer (síncrono)
 *   3. Expõe run() — executa código Deno real no Web Worker
 *
 * O Deno roda num Web Worker dedicado. Ele acha que está num Linux
 * real: tem filesystem (VFS do Wexel via SAB), tem rede (fetch nativo
 * do browser), tem variáveis de ambiente e processo coerentes.
 */

import type { ExecResult, WexelFileSystem } from "./index.js";
import { installDenoServiceWorker, checkBrowserSupport } from "./deno-service-worker.js";
import { runDenoWasmWorker } from "./deno-wasm-worker.js";

export interface DenoBrowserHostOptions {
  networkAllowed?: boolean;
  timeoutMs?:      number;
  autoInstallSW?:  boolean;
}

export class DenoBrowserHost {
  private swReg?: ServiceWorkerRegistration;

  private constructor(
    private readonly fs:   WexelFileSystem,
    private readonly opts: Required<DenoBrowserHostOptions>,
  ) {}

  static async create(fs: WexelFileSystem, options: DenoBrowserHostOptions = {}): Promise<DenoBrowserHost> {
    const opts: Required<DenoBrowserHostOptions> = {
      networkAllowed: true,
      timeoutMs:      30_000,
      autoInstallSW:  true,
      ...options,
    };

    const support = checkBrowserSupport();
    if (!support.ok) {
      console.warn(`[Wexel] DenoBrowserHost: recursos ausentes: ${support.missing.join(", ")}`);
    }

    const host = new DenoBrowserHost(fs, opts);

    if (opts.autoInstallSW && "serviceWorker" in navigator) {
      try {
        host.swReg = await installDenoServiceWorker();
      } catch (err) {
        console.warn("[Wexel] Service Worker não instalado:", err);
      }
    }

    return host;
  }

  /** Executa código JS/TS no Deno dentro do Web Worker com VFS real. */
  async run(code: string, language: "javascript" | "typescript", args: string[] = []): Promise<ExecResult> {
    return runDenoWasmWorker(
      this.fs,
      { networkAllowed: this.opts.networkAllowed, fetcher: fetch, timeoutMs: this.opts.timeoutMs },
      { code, language, args },
    );
  }

  async dispose(): Promise<void> {
    await this.swReg?.unregister();
  }

  get vfsBaseUrl(): string {
    return `${location.origin}/wexel-vfs`;
  }
}
