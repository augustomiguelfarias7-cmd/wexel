import { spawn } from "node:child_process";
import { access } from "node:fs/promises";

export interface JSVNetworkGateway {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface JSVAdapterOptions {
  runtimePath: string;
  cwd: string;
  network?: JSVNetworkGateway;
  env?: Record<string, string>;
}

/**
 * Host-side adapter for JSV.
 *
 * denort is the stripped runtime used by Deno compile. It is not the full
 * Deno CLI, so this adapter deliberately does not pretend that
 * "denort <file.ts>" is equivalent to "deno run <file.ts>".
 */
export class JSVAdapter {
  constructor(private readonly options: JSVAdapterOptions) {}

  async verifyRuntime(): Promise<void> {
    await access(this.options.runtimePath);
  }

  get runtimePath(): string {
    return this.options.runtimePath;
  }

  async execute(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    if (!args.length) throw new Error("JSV: nenhum argumento fornecido.");
    return new Promise((resolve, reject) => {
      const child = spawn(this.options.runtimePath, args, {
        cwd: this.options.cwd,
        env: { ...process.env, ...this.options.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", chunk => { stdout += chunk; });
      child.stderr.on("data", chunk => { stderr += chunk; });
      child.once("error", reject);
      child.once("close", code => resolve({ stdout, stderr, exitCode: code ?? 1 }));
    });
  }

  get networkGateway(): JSVNetworkGateway | undefined {
    return this.options.network;
  }
}
