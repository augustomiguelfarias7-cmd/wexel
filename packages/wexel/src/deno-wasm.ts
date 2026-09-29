/**
 * Ponto de entrada unificado do Deno no Wexel.
 *
 * O caminho browser deve usar um artefato Deno WASM real dentro de um
 * DedicatedWorker. O caminho Node pode usar o binário nativo explicitamente.
 * Nenhum caminho usa um shim JavaScript para fingir que é o Deno.
 */

import type { ExecResult, WexelFileSystem } from "./index.js";
import {
  runDenoNative,
  resolvedenoBin,
  type DenoNativeOptions,
} from "./deno-native-adapter.js";
import type { NetworkFetcher } from "./deno-net-bridge.js";
import { runDenoBrowser, disposeDenoBrowser } from "./deno-browser-bridge.js";

export const DENO_WASM_ABI_VERSION = 30000;
export type DenoTarget = "browser" | "node" | "auto";

export interface DenoRuntimeOptions {
  fs: WexelFileSystem;
  target?: DenoTarget;
  networkAllowed?: boolean;
  fetcher?: NetworkFetcher;
  timeoutMs?: number;
  denoBin?: string;
  denoWasmUrl?: string | URL;
}

function detectTarget(): "browser" | "node" {
  return typeof globalThis.Worker !== "undefined" &&
    typeof globalThis.SharedArrayBuffer !== "undefined"
    ? "browser"
    : "node";
}

export class DenoRuntime {
  private readonly target: "browser" | "node";
  private readonly fs: WexelFileSystem;
  private readonly fetcher: NetworkFetcher;
  private readonly net: boolean;
  private readonly timeout: number;
  private readonly denoBin?: string;
  private readonly denoWasmUrl?: string | URL;

  private constructor(opts: DenoRuntimeOptions) {
    this.target = !opts.target || opts.target === "auto" ? detectTarget() : opts.target;
    this.fs = opts.fs;
    this.fetcher = opts.fetcher ?? fetch;
    this.net = opts.networkAllowed ?? false;
    this.timeout = opts.timeoutMs ?? 30_000;
    this.denoBin = opts.denoBin;
    this.denoWasmUrl = opts.denoWasmUrl;
  }

  static create(opts: DenoRuntimeOptions): DenoRuntime {
    return new DenoRuntime(opts);
  }

  async run(
    code: string,
    language: "javascript" | "typescript",
    args: string[] = [],
  ): Promise<ExecResult> {
    if (this.target === "browser") {
      if (!this.denoWasmUrl) {
        throw new Error(
          "Deno WASM não configurado no browser. Forneça denoWasmUrl apontando para um módulo WebAssembly Deno real; o Wexel não usa mais shim JavaScript ou Deno nativo do Node no browser.",
        );
      }

      return runDenoBrowser(this.fs, code, language, args, {
        denoWasmUrl: this.denoWasmUrl,
        networkAllowed: this.net,
        fetcher: this.fetcher,
        timeoutMs: this.timeout,
      });
    }

    const bin = await resolvedenoBin(this.denoBin);
    const nativeOpts: DenoNativeOptions = {
      denoBin: bin,
      networkAllowed: this.net,
      timeoutMs: this.timeout,
      env: { WEXEL_DENO_TARGET: "node" },
    };
    return runDenoNative(this.fs, nativeOpts, { code, language, args });
  }

  async runFile(
    path: string,
    language: "javascript" | "typescript",
    args: string[] = [],
  ): Promise<ExecResult> {
    return this.run(this.fs.readText(path), language, args);
  }

  dispose(): void {
    if (this.target === "browser") void disposeDenoBrowser(this.fs);
  }
}

/** Compatibilidade com a API histórica. */
export class DenoWasmRuntime {
  private constructor(private readonly inner: DenoRuntime) {}

  static fromRuntime(inner: DenoRuntime): DenoWasmRuntime {
    return new DenoWasmRuntime(inner);
  }

  static async instantiate(_source: BufferSource): Promise<DenoWasmRuntime> {
    throw new Error(
      "DenoWasmRuntime.instantiate() não aceita mais artefatos genéricos sem ABI de execução. Use DenoRuntime.create({ fs, denoWasmUrl }) com um Deno WASM real.",
    );
  }

  async run(
    code: string,
    language: "javascript" | "typescript",
    args: string[] = [],
  ): Promise<ExecResult> {
    return this.inner.run(code, language, args);
  }
}
