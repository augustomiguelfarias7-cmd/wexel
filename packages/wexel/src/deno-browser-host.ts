/**
 * deno-browser-host.ts — Wexel
 *
 * Inicializa o ambiente completo para rodar Deno no browser:
 *
 *   1. Verifica suporte (SAB, crossOriginIsolated, ServiceWorker)
 *   2. Instala o Service Worker do Deno
 *   3. Conecta o VFS do Wexel ao SW via SharedArrayBuffer
 *   4. Expõe DenoBrowserHost.run() — roda código Deno real via Node sandbox
 *
 * O Deno roda dentro de uma sandbox Node.js do Wexel (deno-node-sandbox.ts),
 * que por sua vez usa o binário nativo deno.gz descomprimido.
 * O Service Worker intercepta as requisições de arquivo e rede.
 *
 * Uso:
 *   const host = await DenoBrowserHost.create(wexelRuntime);
 *   const result = await host.run(`console.log("oi do Deno!")`, "javascript");
 */

import type { ExecResult, WexelFileSystem } from "./index.js";
import {
  installDenoServiceWorker,
  checkBrowserSupport,
} from "./deno-service-worker.js";
import { createVfsBridgeChannel, serveVfsBridge } from "./deno-vfs-bridge.js";
import { runDenoNodeSandbox } from "./deno-node-sandbox.js";

export interface DenoBrowserHostOptions {
  /** Permite rede real no Deno. Padrão: true (browser tem fetch nativo). */
  networkAllowed?: boolean;
  /** Timeout por execução em ms. Padrão: 30 000. */
  timeoutMs?: number;
  /** Instala o Service Worker automaticamente. Padrão: true. */
  autoInstallSW?: boolean;
}

export class DenoBrowserHost {
  private readonly stopVfs:  () => void;
  private swReg?:            ServiceWorkerRegistration;

  private constructor(
    private readonly fs:      WexelFileSystem,
    private readonly channel: ReturnType<typeof createVfsBridgeChannel>,
    private readonly opts:    Required<DenoBrowserHostOptions>,
  ) {
    // Serve o VFS para o Service Worker via SAB
    this.stopVfs = serveVfsBridge(channel, fs);
  }

  /** Cria e inicializa o DenoBrowserHost. */
  static async create(
    fs:      WexelFileSystem,
    options: DenoBrowserHostOptions = {},
  ): Promise<DenoBrowserHost> {
    const opts: Required<DenoBrowserHostOptions> = {
      networkAllowed: true,
      timeoutMs:      30_000,
      autoInstallSW:  true,
      ...options,
    };

    // Verifica suporte do browser
    const support = checkBrowserSupport();
    if (!support.ok) {
      console.warn(
        `[Wexel] DenoBrowserHost: recursos ausentes: ${support.missing.join(", ")}.\n` +
        `Adicione os headers COOP/COEP ao servidor e garanta crossOriginIsolated.`,
      );
    }

    const channel = createVfsBridgeChannel();
    const host    = new DenoBrowserHost(fs, channel, opts);

    // Instala o Service Worker
    if (opts.autoInstallSW && "serviceWorker" in navigator) {
      try {
        host.swReg = await installDenoServiceWorker();
        // Envia o SAB para o SW para ele poder servir o VFS
        host.swReg.active?.postMessage({
          type: "wexel-vfs-init",
          ctrl: channel.ctrl,
          data: channel.data,
        });
      } catch (err) {
        console.warn("[Wexel] Service Worker não instalado:", err);
      }
    }

    return host;
  }

  /**
   * Executa código JavaScript ou TypeScript no Deno real.
   *
   * O código roda via deno-node-sandbox (Node.js worker_thread),
   * que por sua vez usa o binário nativo do Deno.
   * O VFS do Wexel está disponível como filesystem real.
   * A rede usa fetch nativo do browser (via Service Worker).
   */
  async run(
    code:     string,
    language: "javascript" | "typescript",
    args:     string[] = [],
  ): Promise<ExecResult> {
    return runDenoNodeSandbox(
      this.fs,
      {
        networkAllowed: this.opts.networkAllowed,
        fetcher:        fetch, // fetch nativo do browser
        timeoutMs:      this.opts.timeoutMs,
      },
      { code, language, args },
    );
  }

  /** Libera recursos (para o serviço VFS e desregistra o SW). */
  async dispose(): Promise<void> {
    this.stopVfs();
    await this.swReg?.unregister();
  }

  /**
   * URL base do VFS no Service Worker.
   * Use para referenciar arquivos do VFS em imports do Deno:
   *   import { foo } from "${host.vfsBaseUrl}/src/foo.ts";
   */
  get vfsBaseUrl(): string {
    return `${location.origin}/wexel-vfs`;
  }
}
