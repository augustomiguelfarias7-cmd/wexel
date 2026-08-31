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
export async function createBusyBoxRunner(factory: BusyBoxFactory, wasmUrl: string) {
  const module = await factory({ noInitialRun: true, noExitRuntime: true, locateFile: () => wasmUrl });
  return {
    async run(options: BusyBoxRunOptions): Promise<BusyBoxRunResult> {
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
