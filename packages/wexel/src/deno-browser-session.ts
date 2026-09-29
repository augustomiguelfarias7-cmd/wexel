/**
 * Browser Deno session.
 *
 * Browser Wexel has one sandbox/session. The Deno WASM module is compiled
 * once and instantiated once for that session. Its imports are bound directly
 * to the session VFS and network policy.
 */
import type { ExecResult, WexelFileSystem } from "./index.js";
import type { DenoWasmArtifactSource } from "./deno-portable-wasm.js";
import { DenoWasmPool } from "./deno-wasm-pool.js";
import { runDenoWasm } from "./deno-wasm-adapter.js";
import type { NetworkFetcher } from "./deno-net-bridge.js";

export interface DenoBrowserSessionOptions {
  fs: WexelFileSystem;
  networkAllowed?: boolean;
  fetcher?: NetworkFetcher;
  timeoutMs?: number;
  artifact?: DenoWasmArtifactSource;
}

export class DenoBrowserSession {
  readonly pool: DenoWasmPool;
  private disposed = false;

  constructor(private readonly options: DenoBrowserSessionOptions) {
    this.pool = new DenoWasmPool(options.artifact);
  }

  async run(code: string, language: "javascript" | "typescript", args: string[] = []): Promise<ExecResult> {
    if (this.disposed) throw new Error("Deno browser session já foi encerrada.");
    return runDenoWasm({
      fs: this.options.fs,
      networkAllowed: this.options.networkAllowed ?? false,
      fetcher: this.options.fetcher,
      timeoutMs: this.options.timeoutMs,
      artifact: this.options.artifact,
    }, code, language, args);
  }

  async warmup(): Promise<void> {
    if (this.disposed) throw new Error("Deno browser session já foi encerrada.");
    await this.pool.template();
  }

  dispose(): void {
    this.disposed = true;
    this.pool.clear();
  }
}
