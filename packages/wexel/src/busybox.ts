export interface BusyBoxRunOptions {
  args: string[];
  cwd?: string;
  stdin?: string;
  files?: Array<{ path: string; content: string | Uint8Array }>;
}

export interface BusyBoxRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type BusyBoxFactory = (options: Record<string, unknown>) => Promise<any>;

/** Integra o busybox.js/busybox.wasm Emscripten real, sem executar binários nativos do host. */
export async function createBusyBoxRunner(factory: BusyBoxFactory, wasmSource: string | BufferSource) {
  let module: any;
  let initializationError: string | undefined;
  try {
    const wasmBinary = typeof wasmSource === "string" ? undefined : new Uint8Array(wasmSource instanceof ArrayBuffer ? wasmSource : wasmSource.buffer.slice(wasmSource.byteOffset, wasmSource.byteOffset + wasmSource.byteLength));
    module = await factory({ noInitialRun: true, noExitRuntime: true, locateFile: () => typeof wasmSource === "string" ? wasmSource : "busybox.wasm", ...(wasmBinary ? { wasmBinary } : {}) });
    if (typeof module.callMain !== "function") initializationError = "BusyBox WASM inválido: o módulo não exporta callMain().";
  } catch (error) {
    initializationError = `Falha ao inicializar BusyBox WASM: ${error instanceof Error ? error.message : String(error)}`;
  }
  return {
    async run(options: BusyBoxRunOptions): Promise<BusyBoxRunResult> {
      if (initializationError) return { stdout: "", stderr: `${initializationError}\n`, exitCode: 1 };
      const stdout: string[] = [];
      const stderr: string[] = [];
      let exitCode = 0;
      module.print = (text: string) => stdout.push(text);
      module.printErr = (text: string) => stderr.push(text);
      const originalQuit = module.quit;
      module.quit = (status: number, error?: unknown) => {
        exitCode = status;
        if (error) throw error;
        throw new Error("ExitStatus");
      };
      try { module.callMain(options.args); }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message !== "ExitStatus") throw error;
      }
      finally { module.quit = originalQuit; }
      return { stdout: stdout.join("\n"), stderr: stderr.join("\n"), exitCode };
    },
  };
}
