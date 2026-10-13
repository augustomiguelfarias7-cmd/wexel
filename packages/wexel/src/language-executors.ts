import type { ExecResult, WexelFileSystem } from "./index.js";

export type CompiledLanguage = "go" | "zig";

export interface LanguageExecutorOptions {
  /** Compiled WebAssembly executor/compiler artifact implementing the Wexel Language Executor ABI v1. */
  artifact: BufferSource;
  language: CompiledLanguage;
  fs: WexelFileSystem;
  /** Explicit imports required by the executor artifact (for example, a WASI host). */
  imports?: WebAssembly.Imports;
}

type ExecutorExports = WebAssembly.Exports & {
  memory?: WebAssembly.Memory;
  wexel_executor_abi_version?: () => number;
  wexel_executor_alloc?: (length: number) => number;
  wexel_executor_run?: (sourcePtr: number, sourceLength: number, filePathPtr: number, filePathLength: number, argsPtr: number, argsLength: number) => void;
  wexel_executor_stdout_ptr?: () => number;
  wexel_executor_stdout_len?: () => number;
  wexel_executor_stderr_ptr?: () => number;
  wexel_executor_stderr_len?: () => number;
  wexel_executor_exit_code?: () => number;
};

/**
 * Bridges source files stored in the Wexel VFS to a language executor artifact.
 *
 * ABI v1 expects the artifact to compile/interpret the supplied source and run it.
 * This host adapter deliberately does not spawn a host Go/Zig compiler.
 */
export class WexelLanguageExecutor {
  private constructor(
    readonly language: CompiledLanguage,
    private readonly instance: WebAssembly.Instance,
    private readonly fs: WexelFileSystem,
  ) {}

  static async load(options: LanguageExecutorOptions): Promise<WexelLanguageExecutor> {
    const { instance } = await WebAssembly.instantiate(options.artifact, options.imports ?? {});
    const exports = instance.exports as ExecutorExports;
    if (!(exports.memory instanceof WebAssembly.Memory)) {
      throw new Error(`Executor ${options.language} inválido: exporta memory ausente.`);
    }
    if (typeof exports.wexel_executor_abi_version !== "function") {
      throw new Error(`Executor ${options.language} inválido: wexel_executor_abi_version ausente.`);
    }
    const version = exports.wexel_executor_abi_version();
    if (version !== 1) throw new Error(`ABI do executor ${options.language} incompatível: esperado 1, recebido ${version}.`);
    for (const name of [
      "wexel_executor_alloc", "wexel_executor_run", "wexel_executor_stdout_ptr",
      "wexel_executor_stdout_len", "wexel_executor_stderr_ptr",
      "wexel_executor_stderr_len", "wexel_executor_exit_code",
    ] as const) {
      if (typeof exports[name] !== "function") {
        throw new Error(`Executor ${options.language} inválido: exportação ${name} ausente.`);
      }
    }
    return new WexelLanguageExecutor(options.language, instance, options.fs);
  }

  async runFile(path: string, args: string[] = []): Promise<ExecResult> {
    const extension = this.language === "go" ? ".go" : ".zig";
    if (!path.toLowerCase().endsWith(extension)) {
      return { stdout: "", stderr: `Executor ${this.language} aceita apenas arquivos ${extension}.\n`, exitCode: 2 };
    }

    let source: string;
    try {
      source = this.fs.readText(path);
    } catch (error) {
      return { stdout: "", stderr: `${error instanceof Error ? error.message : String(error)}\n`, exitCode: 1 };
    }

    const exports = this.instance.exports as ExecutorExports;
    const memory = exports.memory!;
    const encoder = new TextEncoder();
    const sourceBytes = encoder.encode(source);
    const pathBytes = encoder.encode(path);
    const argsBytes = encoder.encode(JSON.stringify(args));
    const alloc = exports.wexel_executor_alloc!;
    const sourcePtr = alloc(sourceBytes.length);
    const pathPtr = alloc(pathBytes.length);
    const argsPtr = alloc(argsBytes.length);
    if (sourcePtr < 0 || pathPtr < 0 || argsPtr < 0) {
      return { stdout: "", stderr: "Executor não conseguiu alocar memória para o código-fonte.\n", exitCode: 1 };
    }

    const view = new Uint8Array(memory.buffer);
    const inBounds = (ptr: number, length: number) => ptr >= 0 && length >= 0 && ptr + length <= view.length;
    if (!inBounds(sourcePtr, sourceBytes.length) || !inBounds(pathPtr, pathBytes.length) || !inBounds(argsPtr, argsBytes.length)) {
      return { stdout: "", stderr: "Executor retornou ponteiros de entrada fora da memória linear.\n", exitCode: 1 };
    }
    view.set(sourceBytes, sourcePtr);
    view.set(pathBytes, pathPtr);
    view.set(argsBytes, argsPtr);

    try {
      exports.wexel_executor_run!(sourcePtr, sourceBytes.length, pathPtr, pathBytes.length, argsPtr, argsBytes.length);
      const out = new Uint8Array(memory.buffer);
      const readText = (ptr: number, len: number) => {
        if (ptr < 0 || len < 0 || ptr + len > out.length) throw new Error("Executor retornou uma faixa de saída inválida.");
        return new TextDecoder().decode(out.subarray(ptr, ptr + len));
      };
      return {
        stdout: readText(exports.wexel_executor_stdout_ptr!(), exports.wexel_executor_stdout_len!()),
        stderr: readText(exports.wexel_executor_stderr_ptr!(), exports.wexel_executor_stderr_len!()),
        exitCode: exports.wexel_executor_exit_code!(),
      };
    } catch (error) {
      return {
        stdout: "",
        stderr: `Falha no executor ${this.language}: ${error instanceof Error ? error.message : String(error)}\n`,
        exitCode: 1,
      };
    }
  }
}
