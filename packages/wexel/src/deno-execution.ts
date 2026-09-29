/**
 * Deno execution topology used by Wexel.
 *
 * Browser:
 *   one DenoBrowserSession -> one VFS -> one Deno instance
 *
 * Node Execution:
 *   one DenoNodePool -> one compiled Deno template
 *   many sandbox sessions -> one isolated Deno instance per sandbox
 */
import type { ExecResult, WexelFileSystem } from "./index.js";
import { DenoBrowserSession, type DenoBrowserSessionOptions } from "./deno-browser-session.js";
import { DenoNodePool, type DenoNodePoolOptions, type DenoNodeSandboxSession } from "./deno-node-pool.js";

export class DenoExecutionTopology {
  private readonly browser?: DenoBrowserSession;
  private readonly node?: DenoNodePool;

  private constructor(
    mode: "browser" | "node",
    options: DenoBrowserSessionOptions | DenoNodePoolOptions,
  ) {
    if (mode === "browser") {
      this.browser = new DenoBrowserSession(options as DenoBrowserSessionOptions);
    } else {
      this.node = new DenoNodePool(options as DenoNodePoolOptions);
    }
  }

  static browser(options: DenoBrowserSessionOptions): DenoExecutionTopology {
    return new DenoExecutionTopology("browser", options);
  }

  static node(options: DenoNodePoolOptions = {}): DenoExecutionTopology {
    return new DenoExecutionTopology("node", options);
  }

  async warmup(): Promise<void> {
    if (this.browser) return this.browser.warmup();
    await this.node!.warmup();
  }

  async runBrowser(code: string, language: "javascript" | "typescript", args: string[] = []): Promise<ExecResult> {
    if (!this.browser) throw new Error("Esta topologia não é browser.");
    return this.browser.run(code, language, args);
  }

  createNodeSandbox(options: {
    id: string;
    fs: WexelFileSystem;
    networkAllowed?: boolean;
    fetcher?: Parameters<DenoNodePool["createSandboxSession"]>[0]["fetcher"];
    timeoutMs?: number;
  }): DenoNodeSandboxSession {
    if (!this.node) throw new Error("Esta topologia não é Node Execution.");
    return this.node.createSandboxSession(options);
  }

  destroyNodeSandbox(id: string): boolean {
    if (!this.node) throw new Error("Esta topologia não é Node Execution.");
    return this.node.destroySandboxSession(id);
  }

  dispose(): void {
    this.browser?.dispose();
    this.node?.dispose();
  }
}
