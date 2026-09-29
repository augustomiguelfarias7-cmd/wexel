/** Host browser para um Deno WASM real dentro de DedicatedWorker. */

import type { ExecResult, WexelFileSystem } from "./index.js";
import { DenoLinuxAdapter } from "./deno-linux-adapter.js";
import { createDenoBrowserWorkerSource, DENO_BROWSER_ENTRYPOINT } from "./deno-browser-worker.js";

export interface DenoBrowserHostOptions {
  networkAllowed?: boolean;
  timeoutMs?: number;
  denoWasmUrl: string | URL;
  fetcher?: typeof fetch;
}

export class DenoBrowserHost {
  private readonly adapter: DenoLinuxAdapter;
  private readonly worker: Worker;
  private readonly timeoutMs: number;

  private constructor(private readonly fs: WexelFileSystem, options: DenoBrowserHostOptions) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.adapter = new DenoLinuxAdapter({
      fs,
      networkAllowed: options.networkAllowed ?? false,
      fetcher: options.fetcher ?? fetch,
    });
    const blob = new Blob([createDenoBrowserWorkerSource()], { type: "text/javascript" });
    this.worker = new Worker(URL.createObjectURL(blob), { type: "classic" });
  }

  static async create(fs: WexelFileSystem, options: DenoBrowserHostOptions): Promise<DenoBrowserHost> {
    if (typeof Worker === "undefined") throw new Error("Deno WASM no browser requer Web Worker.");
    if (typeof SharedArrayBuffer === "undefined" || !crossOriginIsolated) {
      throw new Error("Deno WASM no browser requer SharedArrayBuffer e crossOriginIsolated.");
    }
    const host = new DenoBrowserHost(fs, options);
    try {
      const response = await fetch(options.denoWasmUrl);
      if (!response.ok) throw new Error(`Falha ao carregar Deno WASM: HTTP ${response.status}`);
      await host.initialize(await response.arrayBuffer());
      return host;
    } catch (error) {
      host.dispose();
      throw error;
    }
  }

  private initialize(bytes: ArrayBuffer): Promise<void> {
    const resources = this.adapter.workerInit();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error(`Deno WASM não inicializou em ${this.timeoutMs} ms`)); }, this.timeoutMs);
      const onMessage = (event: MessageEvent) => {
        const msg = event.data as { type: string; data?: string };
        if (msg.type === "ready") { cleanup(); resolve(); }
        else if (msg.type === "error") { cleanup(); reject(new Error(msg.data ?? "Falha ao inicializar Deno WASM")); }
      };
      const cleanup = () => { clearTimeout(timer); this.worker.removeEventListener("message", onMessage); };
      this.worker.addEventListener("message", onMessage);
      this.worker.postMessage({ type: "init", wasmBytes: bytes, fsSab: resources.fsSab, netPort: resources.netPort }, [bytes, resources.netPort]);
    });
  }

  run(code: string, language: "javascript" | "typescript", args: string[] = []): Promise<ExecResult> {
    return new Promise((resolve) => {
      let stdout = "", stderr = "";
      const timer = setTimeout(() => { cleanup(); resolve({ stdout, stderr: stderr + `Deno WASM timeout após ${this.timeoutMs} ms\n`, exitCode: 124 }); }, this.timeoutMs);
      const onMessage = (event: MessageEvent) => {
        const msg = event.data as { type: string; data?: string; exitCode?: number };
        if (msg.type === "stdout") stdout += msg.data ?? "";
        else if (msg.type === "stderr") stderr += msg.data ?? "";
        else if (msg.type === "result" || msg.type === "exit") { cleanup(); resolve({ stdout, stderr, exitCode: msg.exitCode ?? 0 }); }
        else if (msg.type === "error") { cleanup(); resolve({ stdout, stderr: stderr + (msg.data ?? "Erro Deno WASM") + "\n", exitCode: 1 }); }
      };
      const cleanup = () => { clearTimeout(timer); this.worker.removeEventListener("message", onMessage); };
      this.worker.addEventListener("message", onMessage);
      this.worker.postMessage({ type: "run", code, language, args });
    });
  }

  dispose(): void {
    this.worker.terminate();
    this.adapter.dispose();
  }

  get entrypoint(): string { return DENO_BROWSER_ENTRYPOINT; }
}
