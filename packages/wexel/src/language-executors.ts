import type { ExecResult, WexelFileSystem } from "./index.js";

export type CompiledLanguage = "go" | "zig";

export interface LanguageExecutorOptions {
  /** Compiled WebAssembly executor/compiler artifact. Prefer ABI v1; legacy Yaegi/zigc also accepted. */
  artifact: BufferSource;
  language: CompiledLanguage;
  fs: WexelFileSystem;
  /** Explicit imports required by the executor artifact (for example, a WASI host). */
  imports?: WebAssembly.Imports;
  /** Optional path to wasm_exec.js (only used by the legacy Yaegi adapter). */
  wasmExecJs?: string;
  /** Optional path or bytes for Zig std library zip (legacy zigc adapter). */
  zigStdZip?: BufferSource | string;
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
 * Supports two modes:
 * 1. Wexel Language Executor ABI v1 (preferred)
 * 2. Legacy adapters for the classic Yaegi js/wasm artifact and zigc-wasm compiler
 */
export class WexelLanguageExecutor {
  private constructor(
    readonly language: CompiledLanguage,
    private readonly mode: "abi-v1" | "legacy-yaegi" | "legacy-zigc",
    private readonly instance: WebAssembly.Instance | null,
    private readonly fs: WexelFileSystem,
    private readonly legacyCtx: any = null,
  ) {}

  static async load(options: LanguageExecutorOptions): Promise<WexelLanguageExecutor> {
    // First try pure ABI v1
    try {
      const { instance } = await WebAssembly.instantiate(options.artifact, options.imports ?? {});
      const exports = instance.exports as ExecutorExports;

      if (
        exports.memory instanceof WebAssembly.Memory &&
        typeof exports.wexel_executor_abi_version === "function" &&
        exports.wexel_executor_abi_version() === 1 &&
        typeof exports.wexel_executor_alloc === "function" &&
        typeof exports.wexel_executor_run === "function" &&
        typeof exports.wexel_executor_stdout_ptr === "function" &&
        typeof exports.wexel_executor_stdout_len === "function" &&
        typeof exports.wexel_executor_stderr_ptr === "function" &&
        typeof exports.wexel_executor_stderr_len === "function" &&
        typeof exports.wexel_executor_exit_code === "function"
      ) {
        return new WexelLanguageExecutor(options.language, "abi-v1", instance, options.fs);
      }
    } catch {
      // not a pure ABI v1 module, fall through to legacy detection
    }

    // Legacy path
    if (options.language === "go") {
      return WexelLanguageExecutor.loadLegacyYaegi(options);
    }
    if (options.language === "zig") {
      return WexelLanguageExecutor.loadLegacyZigc(options);
    }

    throw new Error(`Executor ${options.language} inválido: nem ABI v1 nem adapter legado reconhecido.`);
  }

  private static async loadLegacyYaegi(options: LanguageExecutorOptions): Promise<WexelLanguageExecutor> {
    // Legacy Yaegi (GOOS=js GOARCH=wasm) needs the Go JS runtime (wasm_exec.js).
    // We keep a minimal host-side adapter that can be completed by the caller
    // providing a Go runtime context, or we throw a clear error.
    const ctx = {
      artifact: options.artifact,
      fs: options.fs,
      wasmExecJs: options.wasmExecJs,
      ready: false,
      evalFn: null as null | ((source: string) => any),
    };

    // In environments that already have a global Go + yaegiEval (browser or
    // pre-loaded Node glue) we can reuse it. Otherwise the adapter stays in
    // "pending" state and runFile will return a helpful error.
    if (typeof globalThis !== "undefined" && (globalThis as any).yaegiEval) {
      ctx.evalFn = (globalThis as any).yaegiEval;
      ctx.ready = true;
    }

    return new WexelLanguageExecutor("go", "legacy-yaegi", null, options.fs, ctx);
  }

  private static async loadLegacyZigc(options: LanguageExecutorOptions): Promise<WexelLanguageExecutor> {
    // Legacy zigc-wasm is a WASI compiler. Full execution needs a WASI host
    // with preopened directories for the source + std library.
    // We register the artifact and leave a clear path for a future WASI shim.
    const ctx = {
      artifact: options.artifact,
      fs: options.fs,
      zigStdZip: options.zigStdZip,
      ready: false,
    };
    return new WexelLanguageExecutor("zig", "legacy-zigc", null, options.fs, ctx);
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

    if (this.mode === "abi-v1") {
      return this.runAbiV1(path, source, args);
    }

    if (this.mode === "legacy-yaegi") {
      return this.runLegacyYaegi(path, source, args);
    }

    if (this.mode === "legacy-zigc") {
      return this.runLegacyZigc(path, source, args);
    }

    return { stdout: "", stderr: "Modo de executor desconhecido.\n", exitCode: 1 };
  }

  private async runAbiV1(path: string, source: string, args: string[]): Promise<ExecResult> {
    const exports = this.instance!.exports as ExecutorExports;
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

  private async runLegacyYaegi(path: string, source: string, _args: string[]): Promise<ExecResult> {
    const ctx = this.legacyCtx;
    if (!ctx?.ready || typeof ctx.evalFn !== "function") {
      return {
        stdout: "",
        stderr:
          "Legacy Yaegi adapter carregado, mas o runtime Go (wasm_exec.js + yaegiEval) ainda não foi inicializado.\n" +
          "Carregue o artefato yaegi.wasm com o Go JS runtime antes de chamar runtime.exec({ language: \"go\", ... }).\n" +
          "Veja docs/go-zig-wasm.md e o exemplo de adapter legado.\n",
        exitCode: 1,
      };
    }

    try {
      const result = ctx.evalFn(source);
      if (result && typeof result === "object") {
        return {
          stdout: String(result.stdout ?? ""),
          stderr: String(result.stderr ?? result.error ?? ""),
          exitCode: result.error ? 1 : 0,
        };
      }
      return { stdout: String(result ?? ""), stderr: "", exitCode: 0 };
    } catch (error) {
      return {
        stdout: "",
        stderr: `Legacy Yaegi: ${error instanceof Error ? error.message : String(error)}\n`,
        exitCode: 1,
      };
    }
  }

  private async runLegacyZigc(path: string, source: string, args: string[]): Promise<ExecResult> {
    // Placeholder for a full WASI-based zigc adapter.
    // A complete implementation needs:
    // - WASI snapshot preview1 imports
    // - preopen of a virtual FS containing the source + std library from std.zip
    // - capture of compiler stdout/stderr and the produced .wasm
    // - optional second step to execute the produced module
    return {
      stdout: "",
      stderr:
        "Legacy zigc-wasm adapter registrado, mas a execução completa ainda requer um host WASI com preopens (source + std.zip).\n" +
        "O artefato foi aceito; a integração completa do compilador está documentada em docs/go-zig-wasm.md.\n" +
        `Arquivo solicitado: ${path}\n`,
      exitCode: 1,
    };
  }
}
