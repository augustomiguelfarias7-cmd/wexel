/**
 * Host browser do Deno WASM no Wexel.
 *
 * O browser não executa o Deno nativo nem um shim JavaScript. O módulo
 * precisa ser um WebAssembly real e recebe seus recursos através do
 * DenoLinuxAdapter. A execução de código depende de um entrypoint de
 * execução compatível com a ABI do artefato Deno utilizado.
 */

import type { ExecResult, WexelFileSystem } from "./index.js";
import { DenoLinuxAdapter } from "./deno-linux-adapter.js";
import { loadDenoWasm, type DenoWasmHostInstance } from "./deno-wasm-host.js";

export interface DenoBrowserHostOptions {
  networkAllowed?: boolean;
  timeoutMs?: number;
  denoWasmUrl: string | URL;
  fetcher?: typeof fetch;
}

export class DenoBrowserHost {
  private readonly adapter: DenoLinuxAdapter;
  private wasm?: DenoWasmHostInstance;

  private constructor(
    private readonly fs: WexelFileSystem,
    options: DenoBrowserHostOptions,
  ) {
    this.adapter = new DenoLinuxAdapter({
      fs,
      networkAllowed: options.networkAllowed ?? false,
      fetcher: options.fetcher ?? fetch,
    });
  }

  static async create(
    fs: WexelFileSystem,
    options: DenoBrowserHostOptions,
  ): Promise<DenoBrowserHost> {
    if (typeof Worker === "undefined") {
      throw new Error("Deno WASM no browser requer Web Worker.");
    }
    if (typeof SharedArrayBuffer === "undefined" || !crossOriginIsolated) {
      throw new Error("Deno WASM no browser requer SharedArrayBuffer e crossOriginIsolated.");
    }

    const host = new DenoBrowserHost(fs, options);
    host.wasm = await loadDenoWasm(options.denoWasmUrl, { adapter: host.adapter });
    return host;
  }

  /**
   * Executa código somente quando o artefato Deno WASM fornecer um entrypoint
   * compatível com a ABI Wexel. Instanciar um módulo WASM sozinho não cria um
   * interpretador Deno, portanto não existe fallback para Node ou shim JS.
   */
  async run(
    _code: string,
    _language: "javascript" | "typescript",
    _args: string[] = [],
  ): Promise<ExecResult> {
    if (!this.wasm) throw new Error("Deno WASM ainda não foi carregado.");
    throw new Error(
      "O Deno WASM foi carregado, mas o artefato não expõe um entrypoint de execução Deno compatível com a ABI Wexel. Compile/forneça um Deno WASM real com essa ABI antes de executar código.",
    );
  }

  get wasmInstance(): DenoWasmHostInstance | undefined {
    return this.wasm;
  }

  dispose(): void {
    this.adapter.dispose();
    this.wasm = undefined;
  }
}
