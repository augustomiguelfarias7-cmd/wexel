/**
 * Node Execution Deno pool.
 *
 * One compiled Deno WASM template can serve many isolated sandboxes.
 * Instances are never shared between sandboxes, so VFS, cwd, env and
 * runtime state remain isolated.
 */
import type { ExecResult, WexelFileSystem } from "./index.js";
import type { DenoWasmArtifactSource } from "./deno-portable-wasm.js";
import { DenoWasmPool } from "./deno-wasm-pool.js";
import { runDenoWasm } from "./deno-wasm-adapter.js";
import type { NetworkFetcher } from "./deno-net-bridge.js";

export interface DenoNodePoolOptions {
  artifact?: DenoWasmArtifactSource;
}

export interface DenoNodeSandboxSession {
  readonly id: string;
  run(code: string, language: "javascript" | "typescript", args?: string[]): Promise<ExecResult>;
  dispose(): void;
}

export class DenoNodePool {
  readonly pool: DenoWasmPool;
  private readonly sessions = new Map<string, DenoNodeSandboxSession>();

  constructor(options: DenoNodePoolOptions = {}) {
    this.pool = new DenoWasmPool(options.artifact);
  }

  async warmup(): Promise<void> {
    await this.pool.template();
  }

  createSandboxSession(options: {
    id: string;
    fs: WexelFileSystem;
    networkAllowed?: boolean;
    fetcher?: NetworkFetcher;
    timeoutMs?: number;
  }): DenoNodeSandboxSession {
    if (this.sessions.has(options.id)) throw new Error(`Sandbox Deno já existe: ${options.id}`);

    const session: DenoNodeSandboxSession = {
      id: options.id,
      run: (code, language, args = []) => runDenoWasm({
        fs: options.fs,
        networkAllowed: options.networkAllowed ?? false,
        fetcher: options.fetcher,
        timeoutMs: options.timeoutMs,
      }, code, language, args),
      dispose: () => { this.sessions.delete(options.id); },
    };

    this.sessions.set(options.id, session);
    return session;
  }

  getSandboxSession(id: string): DenoNodeSandboxSession | undefined {
    return this.sessions.get(id);
  }

  destroySandboxSession(id: string): boolean {
    return this.sessions.delete(id);
  }

  dispose(): void {
    this.sessions.clear();
    this.pool.clear();
  }
}
