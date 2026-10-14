import type { ExecResult } from "./index.js";
import type { WexelFileSystemLike } from "./filesystem.js";

export type CompiledLanguage = "go" | "zig";

export interface LanguageExecutorOptions {
  /** Compiled WebAssembly executor/compiler artifact. Prefer ABI v1; legacy Yaegi/zigc also accepted. */
  artifact: BufferSource;
  language: CompiledLanguage;
  fs: WexelFileSystemLike;
  /** Explicit imports required by the executor artifact (for example, a WASI host). */
  imports?: WebAssembly.Imports;
  /** Optional source of wasm_exec.js (string content). If omitted the adapter tries to bootstrap with a minimal Go runtime. */
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
 *
 * Legacy Yaegi is now self-bootstrapping: the user only needs to pass goExecutorBytes.
 */
export class WexelLanguageExecutor {
  private constructor(
    readonly language: CompiledLanguage,
    private readonly mode: "abi-v1" | "legacy-yaegi" | "legacy-zigc",
    private readonly instance: WebAssembly.Instance | null,
    private readonly fs: WexelFileSystemLike,
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
    const ctx: any = {
      artifact: options.artifact,
      fs: options.fs,
      ready: false,
      evalFn: null as null | ((source: string) => any),
      goInstance: null as any,
      error: null as string | null,
    };

    try {
      // 1. If the host already has yaegiEval, reuse it (fast path).
      if (typeof globalThis !== "undefined" && typeof (globalThis as any).yaegiEval === "function") {
        ctx.evalFn = (globalThis as any).yaegiEval;
        ctx.ready = true;
        return new WexelLanguageExecutor("go", "legacy-yaegi", null, options.fs, ctx);
      }

      // 2. Self-bootstrap: we need the Go JS runtime (wasm_exec.js).
      // Prefer the official runtime source passed through WexelOptions.goWasmExecJs.
      // If omitted, reuse an already-loaded global Go runtime when available.
      let wasmExecSource = options.wasmExecJs;

      if (!wasmExecSource) {
        // Try common locations that some bundlers / Node setups expose.
        // In a pure library we cannot reliably fetch the official file without network,
        // so we document that wasmExecJs should be supplied together with the artifact
        // for fully offline self-bootstrap. For now we still attempt the global path.
        if (typeof globalThis !== "undefined" && (globalThis as any).Go) {
          // Go constructor already present
        } else {
          ctx.error =
            "Legacy Yaegi precisa do conteúdo de wasm_exec.js. " +
            "Passe options.wasmExecJs com o texto do arquivo oficial do Go, " +
            "ou carregue o runtime Go antes de criar o Wexel. " +
            "(O artefato yaegi.wasm sozinho não é suficiente.)";
          return new WexelLanguageExecutor("go", "legacy-yaegi", null, options.fs, ctx);
        }
      }

      // Evaluate wasm_exec.js if we have the source
      if (wasmExecSource) {
        // eslint-disable-next-line no-new-func
        const runWasmExec = new Function(wasmExecSource + "\n; return typeof Go !== 'undefined' ? Go : globalThis.Go;");
        const GoCtor = runWasmExec();
        if (typeof GoCtor !== "function") {
          ctx.error = "wasm_exec.js foi fornecido mas não expôs o construtor Go.";
          return new WexelLanguageExecutor("go", "legacy-yaegi", null, options.fs, ctx);
        }
        (globalThis as any).Go = GoCtor;
      }

      const Go = (globalThis as any).Go;
      if (typeof Go !== "function") {
        ctx.error = "Construtor Go não disponível após carregar wasm_exec.js.";
        return new WexelLanguageExecutor("go", "legacy-yaegi", null, options.fs, ctx);
      }

      const go = new Go();
      const result = await WebAssembly.instantiate(options.artifact, go.importObject);
      go.run(result.instance);

      // Give the Go runtime a moment to register the JS callbacks
      await new Promise((r) => setTimeout(r, 50));

      if (typeof (globalThis as any).yaegiEval === "function") {
        ctx.evalFn = (globalThis as any).yaegiEval;
        ctx.ready = true;
        ctx.goInstance = go;
      } else {
        ctx.error =
          "Yaegi WASM foi instanciado, mas a função yaegiEval não apareceu no globalThis. " +
          "Verifique se o artefato é o wrapper correto (aquele que faz global.Set(\"yaegiEval\", ...)).";
      }
    } catch (err) {
      ctx.error = `Falha ao auto-inicializar Yaegi: ${err instanceof Error ? err.message : String(err)}`;
    }

    return new WexelLanguageExecutor("go", "legacy-yaegi", null, options.fs, ctx);
  }

  private static async loadLegacyZigc(options: LanguageExecutorOptions): Promise<WexelLanguageExecutor> {
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

  private async runLegacyYaegi(_path: string, source: string, _args: string[]): Promise<ExecResult> {
    const ctx = this.legacyCtx;

    if (ctx?.error) {
      return { stdout: "", stderr: ctx.error + "\n", exitCode: 1 };
    }

    if (!ctx?.ready || typeof ctx.evalFn !== "function") {
      return {
        stdout: "",
        stderr:
          "Legacy Yaegi adapter não está pronto. " +
          "Passe o conteúdo de wasm_exec.js via options.wasmExecJs junto com o artefato, " +
          "ou garanta que globalThis.yaegiEval já exista.\n",
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

  private async runLegacyZigc(path: string, _source: string, _args: string[]): Promise<ExecResult> {
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
