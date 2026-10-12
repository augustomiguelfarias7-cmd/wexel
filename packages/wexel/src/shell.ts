import type { ExecResult } from "./index.js";
import { createKernelBusyBoxConnector, type BootedKernel } from "./kernel-busybox-connector.js";

/**
 * WexelShell: substitui o antigo shell de ~40 comandos reimplementados a mao
 * por este conector, que manda os comandos de verdade pro BusyBox rodando
 * dentro do kernel Linux-WASM ja inicializado (ver kernel-busybox-connector.ts).
 *
 * Quem cria esta instancia precisa ja ter um kernel inicializado (chamando
 * linux(...) de linux-node.js ou linux-browser equivalente) e uma funcao
 * captureOutput ligada ao console_write usado nesse boot - essa parte (o
 * boot do kernel em si) ainda precisa ser conectada em algum ponto do
 * NodeExecution; este arquivo so recebe o kernel ja pronto.
 */
export class WexelShell {
  private readonly connector: ReturnType<typeof createKernelBusyBoxConnector>;

  constructor(kernel: BootedKernel, captureOutput: (listener: (chunk: string) => void) => () => void) {
    this.connector = createKernelBusyBoxConnector(kernel, captureOutput);
  }

  async exec(command: string): Promise<ExecResult> {
    const tokens = command.trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) return { stdout: "", stderr: "", exitCode: 0 };
    return this.connector.run({ args: tokens });
  }
}
