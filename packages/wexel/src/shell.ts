import type { ExecResult } from "./index.js";

/** Shell do Wexel: executa comandos pelo BusyBox WASM, sem embutir shell no kernel S1. */
export class WexelShell {
  constructor(private readonly runner: (command: string) => Promise<ExecResult>) {}

  async exec(command: string): Promise<ExecResult> {
    if (!command.trim()) return { stdout: "", stderr: "", exitCode: 0 };
    return this.runner(command);
  }
}
