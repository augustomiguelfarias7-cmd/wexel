import type { BusyBoxRunOptions, BusyBoxRunResult } from "./busybox.js";

/** Uma sessao de kernel ja inicializada (ver linux-node.js: o retorno de linux(...)). */
export interface BootedKernel {
  key_input: (text: string) => void;
}

/**
 * Conector: mesma interface do createBusyBoxRunner (busybox.ts), mas os
 * comandos sao executados de verdade DENTRO do kernel Linux-WASM ja
 * inicializado, em vez de um BusyBox standalone isolado. Isso reaproveita o
 * VFS, os processos e o shell reais do kernel, em vez de simular tudo nesta
 * camada.
 */
/**
 * IMPORTANTE pra quem implementa captureOutput: se a funcao que notifica os
 * listeners (tipicamente o console_write passado pro linux-node.js) itera um
 * array de listeners, faca uma copia antes de iterar (ex.: `for (const l of
 * [...listeners])`). O stop() devolvido aqui remove o listener da lista
 * DURANTE a notificacao (assim que a marca de termino e encontrada), e
 * iterar+remover o mesmo array ao mesmo tempo corrompe a ordem/perde
 * notificacoes pros proximos comandos.
 */
export function createKernelBusyBoxConnector(kernel: BootedKernel, captureOutput: (listener: (chunk: string) => void) => () => void) {
  let seq = 0;

  return {
    async run(options: BusyBoxRunOptions): Promise<BusyBoxRunResult> {
      const marker = `__WEXEL_CMD_DONE_${Date.now()}_${seq++}__`;
      const cmd = [...options.args.map(shellQuote)].join(" ");
      const linha = options.cwd
        ? `cd ${shellQuote(options.cwd)} && ${cmd}; echo "${marker}:$?"\n`
        : `${cmd}; echo "${marker}:$?"\n`;

      let buffer = "";
      const result = await new Promise<BusyBoxRunResult>((resolve) => {
        const stop = captureOutput((chunk) => {
          buffer += chunk;
          const semCR = buffer.replace(/\r/g, "");
          // A marca aparece DUAS vezes no fluxo: a 1a e so o terminal ecoando de
          // volta o que foi digitado (o comando ainda nem rodou); a 2a e o
          // resultado real, impresso depois que o comando termina de executar.
          // So considerar concluido quando existem as duas ocorrencias.
          const primeiraIdx = semCR.indexOf(marker);
          const ultimaIdx = semCR.lastIndexOf(marker);
          if (primeiraIdx === -1 || primeiraIdx === ultimaIdx) return; // so o eco ainda, nao terminou
          const antesDaMarca = semCR.slice(0, ultimaIdx);
          const depoisDaMarca = semCR.slice(ultimaIdx + marker.length);
          const exitCode = parseInt(depoisDaMarca.split("\n")[0]?.replace(":", "").trim() || "0", 10);
          // A saida real fica entre o fim da linha ecoada (1a ocorrencia) e o
          // inicio do resultado (2a ocorrencia, ja cortada em antesDaMarca acima).
          const fimDoEco = semCR.indexOf("\n", primeiraIdx);
          const stdout = antesDaMarca.slice(fimDoEco + 1).replace(/^~ # /gm, "").trim();
          stop();
          resolve({ stdout, stderr: "", exitCode: isNaN(exitCode) ? 0 : exitCode });
        });
        kernel.key_input(options.stdin ? `${linha}` : linha);
      });

      return result;
    },
  };
}

function shellQuote(s: string): string {
  return /^[A-Za-z0-9_\-./]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}
