import type { ExecResult } from "./index.js";
import { createKernelBusyBoxConnector, type BootedKernel } from "./kernel-busybox-connector.js";

type ShellRunner = (command: string) => Promise<ExecResult>;

/** BusyBox continua sendo o shell do Wexel. Pode ser ligado a uma sessão
 * interativa herdada ou executado pelo runner WASM de cada comando. */
export class WexelShell {
  private readonly connector?: ReturnType<typeof createKernelBusyBoxConnector>;
  private readonly runner?: ShellRunner;

  constructor(kernelOrRunner: BootedKernel | ShellRunner, captureOutput?: (listener: (chunk: string) => void) => () => void) {
    if (typeof kernelOrRunner === "function") {
      this.runner = kernelOrRunner;
    } else {
      if (!captureOutput) throw new Error("WexelShell requer captura de saída para uma sessão de kernel.");
      this.connector = createKernelBusyBoxConnector(kernelOrRunner, captureOutput);
    }
  }

  async exec(command: string): Promise<ExecResult> {
    if (this.runner) return this.runner(command);
    const tokens = command.trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) return { stdout: "", stderr: "", exitCode: 0 };
    return this.connector!.run({ args: tokens });
  }
}
