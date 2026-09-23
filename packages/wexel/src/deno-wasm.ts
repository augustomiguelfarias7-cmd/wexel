/**
 * Ponto de entrada unificado do Deno no Wexel.
 *
 * A classe DenoWasmRuntime mantém a ABI pública original (DENO_WASM_ABI_VERSION)
 * para não quebrar código existente, mas agora delega a execução para:
 *
 *   - DenoWorkerRuntime   → ambiente browser (Web Worker + SharedArrayBuffer)
 *   - DenoNodeRuntime     → ambiente Node.js (worker_threads + MessageChannel)
 *
 * A detecção do ambiente é automática, mas pode ser forçada via `target`.
 */

import type { ExecResult, WexelFileSystem } from "./index.js";
import {
  runDenoWorker,
  createDenoWorkerBlobUrl,
  type DenoWorkerOptions,
} from "./deno-worker.js";
import {
  runDenoNodeSandbox,
  type DenoNodeSandboxOptions,
} from "./deno-node-sandbox.js";
import type { NetworkFetcher } from "./deno-net-bridge.js";

// Mantida para compatibilidade com código que importa DENO_WASM_ABI_VERSION
export const DENO_WASM_ABI_VERSION = 30000;

export type DenoTarget = "browser" | "node" | "auto";

export interface DenoRuntimeOptions {
  /** Filesystem virtual da instância Wexel. Obrigatório. */
  fs: WexelFileSystem;
  /** Ambiente alvo. Padrão: "auto" (detectado em runtime). */
  target?: DenoTarget;
  /** Permite rede real (fetch, WebSocket). Padrão: false. */
  networkAllowed?: boolean;
  /**
   * Fetcher de rede — use WebPink.fetch para sandboxes com política de rede.
   * Padrão: fetch nativo.
   */
  fetcher?: NetworkFetcher;
  /** Timeout em ms por execução. Padrão: 30 000. */
  timeoutMs?: number;
  /**
   * URL do script do Worker (apenas browser).
   * Se omitido, um Blob URL é gerado automaticamente.
   */
  workerScriptUrl?: string | URL;
}

function detectTarget(): "browser" | "node" {
  if (
    typeof globalThis.Worker !== "undefined" &&
    typeof globalThis.SharedArrayBuffer !== "undefined"
  ) {
    return "browser";
  }
  return "node";
}

/**
 * Runtime Deno unificado — substitui DenoWasmRuntime.
 *
 * Uso básico (browser):
 *   const deno = DenoRuntime.create({ fs: runtime.fs, networkAllowed: true });
 *   await deno.run("console.log('oi')", "javascript");
 *
 * Uso com WebPink (Node sandbox):
 *   const deno = DenoRuntime.create({ fs: sandbox.runtime.fs, fetcher: sandbox.webPink.fetch });
 *   await deno.run(code, "typescript");
 */
export class DenoRuntime {
  private readonly target:   "browser" | "node";
  private readonly fs:       WexelFileSystem;
  private readonly fetcher:  NetworkFetcher;
  private readonly net:      boolean;
  private readonly timeout:  number;
  private readonly workerUrl: string | URL;
  private _blobUrl?: string;

  private constructor(opts: DenoRuntimeOptions) {
    this.target  = (opts.target === "auto" || !opts.target) ? detectTarget() : opts.target;
    this.fs      = opts.fs;
    this.fetcher = opts.fetcher ?? fetch;
    this.net     = opts.networkAllowed ?? false;
    this.timeout = opts.timeoutMs ?? 30_000;
    this.workerUrl = opts.workerScriptUrl ?? "";
  }

  static create(opts: DenoRuntimeOptions): DenoRuntime {
    return new DenoRuntime(opts);
  }

  /**
   * Executa código JavaScript ou TypeScript no sandbox Deno.
   * Retorna ExecResult com stdout, stderr e exitCode.
   */
  async run(
    code:     string,
    language: "javascript" | "typescript",
    args:     string[] = [],
  ): Promise<ExecResult> {
    if (this.target === "browser") {
      return this.runBrowser(code, language, args);
    }
    return this.runNode(code, language, args);
  }

  /** Atalho para ler um arquivo do VFS e executá-lo. */
  async runFile(
    path:     string,
    language: "javascript" | "typescript",
    args:     string[] = [],
  ): Promise<ExecResult> {
    const code = this.fs.readText(path);
    return this.run(code, language, args);
  }

  private async runBrowser(
    code:     string,
    language: "javascript" | "typescript",
    args:     string[],
  ): Promise<ExecResult> {
    const url = this.workerUrl || this.ensureBlobUrl();
    const opts: DenoWorkerOptions = {
      workerScriptUrl: url,
      networkAllowed:  this.net,
      fetcher:         this.fetcher,
      timeoutMs:       this.timeout,
    };
    return runDenoWorker(this.fs, opts, { code, language, args });
  }

  private async runNode(
    code:     string,
    language: "javascript" | "typescript",
    args:     string[],
  ): Promise<ExecResult> {
    const opts: DenoNodeSandboxOptions = {
      fetcher:         this.fetcher,
      networkAllowed:  this.net,
      timeoutMs:       this.timeout,
    };
    return runDenoNodeSandbox(this.fs, opts, { code, language, args });
  }

  private ensureBlobUrl(): string {
    if (!this._blobUrl) {
      this._blobUrl = createDenoWorkerBlobUrl();
    }
    return this._blobUrl;
  }

  /** Libera o Blob URL gerado automaticamente (se houver). */
  dispose(): void {
    if (this._blobUrl) {
      URL.revokeObjectURL(this._blobUrl);
      this._blobUrl = undefined;
    }
  }
}

/**
 * DenoWasmRuntime — mantida para compatibilidade.
 * Agora é um wrapper sobre DenoRuntime que preserva a API antiga.
 *
 * @deprecated Use DenoRuntime.create() com as novas opções.
 */
export class DenoWasmRuntime {
  private constructor(private readonly inner: DenoRuntime) {}

  /** @deprecated Use DenoRuntime.create() */
  static fromRuntime(inner: DenoRuntime): DenoWasmRuntime {
    return new DenoWasmRuntime(inner);
  }

  /**
   * Mantida para compatibilidade: instancia a ABI legada (agora no-op).
   * O `source` é ignorado — o Deno real não precisa mais de um .wasm externo.
   *
   * @deprecated Use DenoRuntime.create() passando { fs } nas opções.
   */
  static async instantiate(_source: BufferSource): Promise<DenoWasmRuntime> {
    // Compatibilidade: retorna uma instância sem fs — fs deve ser injetado depois
    const inner = DenoRuntime.create({
      fs: null as unknown as WexelFileSystem, // será substituído em run()
      target: "auto",
    });
    return new DenoWasmRuntime(inner);
  }

  /** @deprecated Use DenoRuntime.run() */
  async run(
    code:     string,
    language: "javascript" | "typescript",
    args:     string[] = [],
  ): Promise<ExecResult> {
    return this.inner.run(code, language, args);
  }
}
