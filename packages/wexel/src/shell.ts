import type { ExecResult } from "./index.js";

/**
 * WexelShell is a command interface backed by a configured runtime service.
 * It does not require or boot an operating-system kernel.
 */
export class WexelShell {
  constructor(private readonly runCommand: (command: string) => Promise<ExecResult> | ExecResult) {}

  async exec(command: string): Promise<ExecResult> {
    const normalized = command.trim();
    if (!normalized) return { stdout: "", stderr: "", exitCode: 0 };
    return await this.runCommand(normalized);
  }
}
