import { instantiateCore, WexelLifecycleManager, WexelServiceManager, type WexelCoreInstance } from "@wexel/core";
import { WexelArtifactManager, type LoadArtifactOptions } from "./artifact-manager.js";
import { BuzzBox } from "./buzz-box.js";
import { PythonPackageManager } from "./python-packages.js";
import { V9Executor, type V9Document } from "./v9.js";
import { NativeExtensionRegistry, type NativeExtensionManifest, type NativeExtension } from "./native-extensions.js";

import { WexelGit } from "./git.js";
import { runCurl } from "./curl.js";

import { runNativeSource } from "./native-compiler.js";
import { WexelLanguageExecutor, type CompiledLanguage } from "./language-executors.js";
import { readPackagedAsset, readPackagedGzip } from "./toolchain-assets.js";
import { WexelZigWasiToolchain } from "./zig-wasi-toolchain.js";
import { runMultiCVfs } from "./multic.js";
import { WexelShell } from "./shell.js";
import { WexelMemory64FileSystem, type WexelFileSystemLike } from "@wexel/core";
export { WexelFileSystem, WexelMemory64FileSystem, normalizeHome } from "@wexel/core";
export type { WexelFileSystemLike, WexelQuota } from "@wexel/core";

export type Language = "python" | "wasm" | "javascript" | "typescript" | string;

export interface ExecRequest {
  language: Language;
  code?: string;
  file?: string;
  args?: string[];
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface WexelPermissions {
  network?: boolean;
  storage?: boolean;
  files?: boolean;
  modules?: boolean;
}

export interface WexelOptions {
  permissions?: WexelPermissions;
  storageQuotaBytes?: number;
  homeDirectory?: string;
  /** VFS externo/persistente. Quando ausente, usa o VFS do core Memory64. */
  fs?: WexelFileSystemLike;
  mode?: "load-only" | "run";
  initialMemoryPages?: number;
  maxMemoryPages?: number;
  coreBytes?: BufferSource;
  pythonRunner?: (code: string, args: string[]) => Promise<ExecResult> | ExecResult;
  pythonRunnerFactory?: (fs: WexelFileSystemLike) => NonNullable<WexelOptions["pythonRunner"]>;
  /** Executa JS/TS via Wexel.js (Edge.js + QuickJS-NG, ver assets/wexeljs/edgejs.wasm). */
  wexelJsRunner?: (code: string, language: "javascript" | "typescript", args: string[]) => Promise<ExecResult> | ExecResult;
  bashRunner?: (args: string[]) => Promise<ExecResult> | ExecResult;
  /** Executa comandos por um serviço de shell inicializado para o runtime. */
  shellRunner?: (command: string) => Promise<ExecResult> | ExecResult;
  networkFetch?: typeof fetch;
  pypiIndexUrl?: string;
  v9?: V9Document;
  /** @deprecated Use WexelGit integrado. */
  gitCloneRunner?: (url: string, destination: string) => Promise<ExecResult> | ExecResult;
  /** Token para repositórios privados no git clone. */
  gitToken?: string;
  nativeCliBytes?: BufferSource;
  /** Go interpreter/executor artifact (ABI v1 or supported legacy Yaegi js/wasm). */
  goExecutorBytes?: BufferSource;
  /** Zig executor/compiler artifact (ABI v1 or supported legacy zigc-wasm). */
  zigExecutorBytes?: BufferSource;
  /** Official Go wasm_exec.js source, required when bootstrapping a legacy Yaegi js/wasm artifact. */
  goWasmExecJs?: string;
  /** Explicit imports required by language artifacts (for example, WASI imports). */
  goExecutorImports?: WebAssembly.Imports;
  zigExecutorImports?: WebAssembly.Imports;
  /** Optional Zig standard-library archive for the legacy zigc-wasm compiler adapter. */
  zigStdZip?: BufferSource | string;
  nativeExtensions?: Array<{ manifest: NativeExtensionManifest; source: BufferSource }>;
}

// ── WexelRuntime ──────────────────────────────────────────────────────────────

export class WexelRuntime {
  /** Interface de comandos disponível quando um shellRunner é configurado. */
  readonly shell?: WexelShell;
  /** Acompanha o estado do runtime e coordena recuperação de serviços. */
  readonly lifecycle = new WexelLifecycleManager();
  /** Gerencia serviços e sinaliza falhas ao monitor de ciclo de vida. */
  readonly services = new WexelServiceManager((service) => {
    this.lifecycle.degraded(`Serviço ${service.name} falhou: ${service.error ?? "erro desconhecido"}`);
  });
  readonly permissions: Required<WexelPermissions>;
  readonly fs:          WexelFileSystemLike;
  readonly artifacts:   WexelArtifactManager;
  readonly mode:        "load-only" | "run";
  readonly buzz       = new BuzzBox();
  readonly packages:    PythonPackageManager;
  readonly v9         = new V9Executor();
  readonly extensions = new NativeExtensionRegistry();
  readonly networkFetch: typeof fetch;

  private pythonRunner?: (code: string, args: string[]) => Promise<ExecResult> | ExecResult;
  private readonly pythonRunnerFactory?: (fs: WexelFileSystemLike) => NonNullable<WexelOptions["pythonRunner"]>;
  private readonly _wexelJsRunner?: WexelOptions["wexelJsRunner"];
  private readonly bashRunner?:   WexelOptions["bashRunner"];
  private readonly gitCloneRunner?: WexelOptions["gitCloneRunner"];
  private readonly gitToken?:     string;
  private readonly nativeCliBytes?: BufferSource;
  private readonly languageExecutors = new Map<CompiledLanguage, WexelLanguageExecutor>();
  private readonly zigWasiToolchain = new WexelZigWasiToolchain();
  private bundledGoExecutor?: Promise<WexelLanguageExecutor>;
  private _git?:          WexelGit;


  private constructor(readonly core: WexelCoreInstance, options: WexelOptions) {
    this.mode         = options.mode ?? "run";
    this.fs           = options.fs ?? new WexelMemory64FileSystem(core, options.storageQuotaBytes, options.homeDirectory);
    this.pythonRunnerFactory = options.pythonRunnerFactory;
    // Factories run under lifecycle supervision during startup and recovery.
    this.pythonRunner = options.pythonRunner;
    this._wexelJsRunner = options.wexelJsRunner;
    this.bashRunner   = options.bashRunner;
    this.networkFetch = options.networkFetch ?? fetch;
    this.gitCloneRunner = options.gitCloneRunner;
    this.gitToken     = options.gitToken;
    this.nativeCliBytes = options.nativeCliBytes;
    this.packages     = new PythonPackageManager({ fs: this.fs, indexUrl: options.pypiIndexUrl, fetcher: this.networkFetch });
    this.permissions  = { network: false, storage: true, files: false, modules: true, ...options.permissions };
    this.artifacts    = new WexelArtifactManager(() => this.permissions.modules);
    if (options.shellRunner) this.shell = new WexelShell(options.shellRunner);
  }

  static async create(options: WexelOptions = {}): Promise<WexelRuntime> {
    const bytes   = options.coreBytes ?? await defaultCoreBytes();
    const runtime = new WexelRuntime(await instantiateCore(bytes), options);
    runtime.lifecycle.starting();
    try {
      // Every integration that performs initialization is registered with the
      // same generic lifecycle supervisor, so recovery isn't CPython-specific.
      if (options.pythonRunnerFactory) {
        runtime.lifecycle.registerComponent("executor:python", async () => {
          runtime.pythonRunner = options.pythonRunnerFactory!(runtime.fs);
        });
      } else if (runtime.pythonRunner) {
        runtime.lifecycle.registerComponent("executor:python", async () => {
          if (!runtime.pythonRunner) throw new Error("Executor Python não está disponível.");
        });
      }
      if (runtime._wexelJsRunner) {
        runtime.lifecycle.registerComponent("executor:wexeljs", async () => {
          if (!runtime._wexelJsRunner) throw new Error("Executor Wexel.js não está disponível.");
        });
      }
      if (runtime.bashRunner) {
        runtime.lifecycle.registerComponent("integration:bash", async () => {
          if (!runtime.bashRunner) throw new Error("Integração Bash não está disponível.");
        });
      }
      if (options.shellRunner) {
        runtime.lifecycle.registerComponent("integration:shell", async () => {
          if (!runtime.shell) throw new Error("Integração de shell não está disponível.");
        });
      }
      if (options.goExecutorBytes) {
        runtime.lifecycle.registerComponent("executor:go", async () => {
          runtime.languageExecutors.set("go", await WexelLanguageExecutor.load({
            language: "go", artifact: options.goExecutorBytes!, fs: runtime.fs,
            imports: options.goExecutorImports, wasmExecJs: options.goWasmExecJs,
          }));
        });
      }
      if (options.zigExecutorBytes) {
        runtime.lifecycle.registerComponent("executor:zig", async () => {
          runtime.languageExecutors.set("zig", await WexelLanguageExecutor.load({
            language: "zig", artifact: options.zigExecutorBytes!, fs: runtime.fs,
            imports: options.zigExecutorImports, zigStdZip: options.zigStdZip,
          }));
        });
      }
      for (const ext of options.nativeExtensions ?? []) {
        runtime.lifecycle.registerComponent(`extension:${ext.manifest.name}`, async () => {
          await runtime.loadNativeExtension(ext.manifest, ext.source);
        });
      }
      await runtime.lifecycle.initializeComponents();
      runtime.services.register("runtime", { start: () => runtime.buzz.emit("runtime:ready", { mode: runtime.mode }) });
      await runtime.services.startAll();
      runtime.lifecycle.running();
      return runtime;
    } catch (error) {
      runtime.lifecycle.failed(error instanceof Error ? error.message : String(error));
      try { await runtime.services.stopAll(); } catch { /* preserve the initialization error */ }
      throw error;
    }
  }

  /**
   * Reinitializes registered services after an incomplete startup or service failure.
   * Process death itself must be detected by the external Node.js supervisor.
   */
  async recoverServices(): Promise<void> {
    await this.lifecycle.recover(async () => {
      await this.services.stopAll();
      await this.services.startAll();
    });
  }

  /** Marks a failed integration as degraded so the lifecycle manager can recover it. */
  reportComponentFailure(name: string, error: unknown): void {
    this.lifecycle.reportComponentFailure(name, error);
  }

  /** Reinitializes one registered integration using its original initializer. */
  async recoverComponent(name: string): Promise<void> {
    await this.lifecycle.recoverComponent(name);
  }

  /** Reinitializes all required integrations that are not currently ready. */
  async recoverComponents(): Promise<void> {
    await this.lifecycle.recoverComponents();
  }

  /** Stops runtime-owned services and records the terminal lifecycle state. */
  async shutdown(): Promise<void> {
    this.lifecycle.stopping();
    try {
      await this.services.stopAll();
      this.lifecycle.stopped();
    } catch (error) {
      this.lifecycle.failed(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  // ── exec principal ─────────────────────────────────────────────────────────

  /** Conecta um runner Wexel.js à VFS desta sandbox após a criação do runtime. */
  attachWexelJsRunner(runner: NonNullable<WexelOptions["wexelJsRunner"]>): void {
    (this as unknown as { _wexelJsRunnerMutable?: NonNullable<WexelOptions["wexelJsRunner"]> })._wexelJsRunnerMutable = runner;
  }

  async exec(request: ExecRequest): Promise<ExecResult> {
    if (this.mode === "load-only") { this.buzz.emit("script:loaded", { language: request.language }); return { stdout: "", stderr: "", exitCode: 0 }; }
    if (request.language === "wasm") throw new Error("Use loadModule() para módulos WASM");

    if (request.language === "javascript" || request.language === "typescript") {
      const code = request.code ?? (request.file ? this.fs.readText(request.file) : "");
      const runner = this._wexelJsRunner ?? (this as unknown as { _wexelJsRunnerMutable?: WexelOptions["wexelJsRunner"] })._wexelJsRunnerMutable;
      if (runner) return await runner(code, request.language, request.args ?? []);
      throw new Error("Runtime Wexel.js não foi registrado. Forneça wexelJsRunner nas opções.");
    }

    if (request.language === "go" || request.language === "zig") {
      if (!request.file) throw new Error(`Executor ${request.language} exige um arquivo na VFS; use /home/main.${request.language}.`);
      const executor = this.languageExecutors.get(request.language);
      if (executor) return executor.runFile(request.file, request.args ?? []);
      if (request.language === "zig") return this.zigWasiToolchain.runFile(this.fs, request.file, request.args ?? []);
      try {
        return await (await this.getBundledGoExecutor()).runFile(request.file, request.args ?? []);
      } catch (error) {
        return { stdout: "", stderr: `Falha ao iniciar o interpretador Go embutido: ${error instanceof Error ? error.message : String(error)}\n`, exitCode: 1 };
      }
    }

    if (request.language === "python") {
      const code = request.code ?? (request.file ? this.fs.readText(request.file) : "");
      if (!this.pythonRunner) throw new Error("CPython/WebAssembly não foi registrado. Configure pythonRunner ao criar o runtime.");
      return await this.pythonRunner(code, request.args ?? []);
    }

    return { stdout: request.code ?? "", stderr: "", exitCode: 0 };
  }

  // ── wexeljs shell (Node.js-compatível, via Wexel.js) ────────────────────────

  /** Compila Zig para WASI e grava o artefato .wasm na VFS Memory64. */
  async compileZig(sourcePath: string, outputPath?: string): Promise<string> {
    return (await this.zigWasiToolchain.compileFile(this.fs, sourcePath, outputPath)).outputPath;
  }

  private getBundledGoExecutor(): Promise<WexelLanguageExecutor> {
    if (!this.bundledGoExecutor) {
      this.bundledGoExecutor = Promise.all([
        readPackagedGzip("../assets/toolchains/go/yaegi.wasm.gz"),
        readPackagedAsset("../assets/toolchains/go/wasm_exec.js"),
      ]).then(([artifact, wasmExecJs]) => {
        const moduleBytes = new Uint8Array(artifact);
        return WexelLanguageExecutor.load({
          language: "go",
          artifact: moduleBytes.buffer,
          fs: this.fs,
          wasmExecJs: new TextDecoder().decode(wasmExecJs),
        });
      });
    }
    return this.bundledGoExecutor;
  }

  async wexeljs(args: string[]): Promise<ExecResult> {
    const [command, target, ...scriptArgs] = args;
    if (command === "--version" || command === "version") {
      return { stdout: "wexel.js v24.13.2-pre (edge.js + quickjs-ng)\n", stderr: "", exitCode: 0 };
    }
    if (command === "eval" && target !== undefined) return this.exec({ language: "javascript", code: target, args: scriptArgs });
    if (command === "run" && target) {
      const language = scriptLanguage(target);
      if (!language) return { stdout: "", stderr: `wexeljs: extensão não suportada: ${target}\n`, exitCode: 2 };
      return this.exec({ language, file: target, args: scriptArgs });
    }
    // A instalação delega para o serviço de shell configurado pelo ambiente.
    if (command === "add" || command === "install") {
      if (!this.shell) return { stdout: "", stderr: "Shell não foi registrado. Configure shellRunner ao criar o runtime.\n", exitCode: 2 };
      return this.shell.exec(`pnpm install ${target ?? ""} ${scriptArgs.join(" ")}`.trim());
    }
    return { stdout: "", stderr: "Uso: wexeljs run <arquivo.js|.ts> | wexeljs eval <código> | wexeljs add <pkg> | wexeljs --version\n", exitCode: 2 };
  }

  // ── node (via wexelJsRunner se disponível) ──────────────────────────────────

  async node(args: string[]): Promise<ExecResult> {
    if (!args[0]) return { stdout: "", stderr: "Uso: node <arquivo.js>\n", exitCode: 2 };
    return this.exec({ language: "javascript", file: args[0], args: args.slice(1) });
  }

  // ── bash ──────────────────────────────────────────────────────────────────

  async bash(args: string[]): Promise<ExecResult> {
    if (!this.bashRunner) return { stdout: "", stderr: "Bash/BusyBox não foi registrado.\n", exitCode: 2 };
    return await this.bashRunner(args);
  }

  // ── git ───────────────────────────────────────────────────────────────────

  async gitExec(args: string[]): Promise<ExecResult> {
    if (!this._git) {
      this._git = new WexelGit({
        fs:             this.fs,
        networkAllowed: this.permissions.network,
        fetcher:        this.networkFetch,
        gitToken:       this.gitToken,
      });
    }
    // compatibilidade com gitCloneRunner legado para git clone
    if (args[0] === "clone" && args[1] && this.gitCloneRunner && !this.gitToken) {
      const dest = args[2] ?? args[1].split("/").pop()?.replace(/\.git$/, "") ?? "repo";
      return this.gitCloneRunner(args[1], dest);
    }
    return this._git.exec(args);
  }

  // ── curl (exposto para o shell) ───────────────────────────────────────────

  async curlExec(args: string[]): Promise<ExecResult> {
    return runCurl(args, { fs: this.fs, fetcher: this.networkFetch });
  }

  // ── módulos / extensões ───────────────────────────────────────────────────

  async loadScript(source: string | BufferSource): Promise<BufferSource> {
    if (typeof source === "string") return await fetch(source).then((r) => r.arrayBuffer());
    return source;
  }
  async runScript(source: string | BufferSource, request: Omit<ExecRequest, "code" | "file">): Promise<ExecResult> {
    const bytes = await this.loadScript(source);
    const code  = new TextDecoder().decode(bytes instanceof ArrayBuffer ? bytes : (bytes as ArrayBufferView).buffer);
    return this.exec({ ...request, code });
  }
  async loadModule(source: string | BufferSource, options: LoadArtifactOptions = {}): Promise<WebAssembly.Instance> {
    if (!this.permissions.modules) throw new Error("Permissão de módulos negada");
    const artifact = await this.artifacts.load(source, options);
    this.buzz.emit("module:loaded", { source: artifact.source, id: artifact.id, name: artifact.name });
    return artifact.instance;
  }
  async loadModuleFromVfs(path: string, options: LoadArtifactOptions = {}): Promise<WebAssembly.Instance> {
    if (!this.permissions.modules) throw new Error("Permissão de módulos negada");
    const bytes = new Uint8Array(this.fs.read(path));
    return this.loadModule(bytes, { ...options, name: options.name ?? path, sourceLabel: path });
  }
  createWebDocument(document: V9Document): string { return this.v9.createDocument(document); }
  async loadNativeExtension(manifest: NativeExtensionManifest, source: BufferSource): Promise<NativeExtension> {
    if (!this.permissions.modules) throw new Error("Permissão de módulos negada");
    const extension = await this.extensions.load(manifest, source);
    this.buzz.emit("extension:loaded", { name: manifest.name, version: manifest.version });
    return extension;
  }
  /** Executa arquivos .go guardados na VFS através do executor Go registrado. */
  async go(args: string[]): Promise<ExecResult> {
    return this.runLanguageCommand("go", args);
  }

  /** Executa arquivos .zig guardados na VFS através do executor Zig registrado. */
  async zig(args: string[]): Promise<ExecResult> {
    return this.runLanguageCommand("zig", args);
  }

  private async runLanguageCommand(language: CompiledLanguage, args: string[]): Promise<ExecResult> {
    if (args[0] !== "run" || !args[1]) {
      return { stdout: "", stderr: `Uso: ${language} run <arquivo.${language}> [argumentos...]\n`, exitCode: 2 };
    }
    const file = args[1];
    const executor = this.languageExecutors.get(language);
    if (!executor) {
      return { stdout: "", stderr: `Executor ${language} não registrado. Configure ${language === "go" ? "goExecutorBytes" : "zigExecutorBytes"} com um artefato Wexel Language Executor ABI v1.\n`, exitCode: 1 };
    }
    return executor.runFile(file, args.slice(2));
  }

  async nativeLanguage(language: "c" | "cpp", args: string[]): Promise<ExecResult> {
    const command = args[0];
    if (command === "list") {
      const extensions = language === "c" ? [".c"] : [".cpp", ".cc", ".cxx"];
      const files = this.fs.snapshot().map((entry) => entry.path).filter((path) => extensions.some((ext) => path.toLowerCase().endsWith(ext)));
      return { stdout: files.join("\n") + (files.length ? "\n" : ""), stderr: "", exitCode: 0 };
    }
    if (command !== "run" || !args[1]) return { stdout: "", stderr: `Uso: ${language} list | ${language} run <arquivo>
`, exitCode: 2 };
    const file = args[1];
    const ext = file.toLowerCase().split(".").pop();
    const expected = language === "c" ? ["c"] : ["cpp", "cc", "cxx"];
    if (!ext || !expected.includes(ext)) return { stdout: "", stderr: `O comando ${language} só aceita arquivos ${language === "c" ? ".c" : ".cpp/.cc/.cxx"}.
`, exitCode: 2 };
    const source = this.fs.readText(file);
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "wexel-source-"));
    const hostFile = join(dir, "program." + ext);
    try {
      await writeFile(hostFile, source, "utf8");
      const result = await runNativeSource({ source: hostFile });
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async multic(args: string[]): Promise<ExecResult> {
    if (args[0] !== "run" || !args[1]) return { stdout: "", stderr: "Uso: multic run <arquivo.cpp>\n", exitCode: 2 };
    const file = args[1];
    if (!/\\.(cpp|cc|cxx)$/i.test(file)) return { stdout: "", stderr: "MultiC usa um arquivo-contêiner .cpp/.cc/.cxx.\n", exitCode: 2 };
    return runMultiCVfs(this.fs, file);
  }

  async nativeCli(args: string[]): Promise<ExecResult> {
    const registered = this.extensions.get("wexel-cli");
    if (registered) {
      if (args[0] === "version") return { stdout: `${this.extensions.invoke("wexel-cli", "wexel_cli_abi_version")}\n`, stderr: "", exitCode: 0 };
      if (args[0] === "add" && args[1] && args[2]) return { stdout: `${this.extensions.invoke("wexel-cli", "wexel_cli_add", [Number(args[1]), Number(args[2])])}\n`, stderr: "", exitCode: 0 };
    }
    if (!this.nativeCliBytes) return { stdout: "", stderr: "CLI C++ WASM não foi registrada.\n", exitCode: 2 };
    const instance = (await WebAssembly.instantiate(this.nativeCliBytes, {})).instance;
    const exports  = instance.exports as unknown as { wexel_cli_abi_version?: () => number; wexel_cli_add?: (a: number, b: number) => number };
    if (args[0] === "version") return { stdout: `${exports.wexel_cli_abi_version?.() ?? 0}\n`, stderr: "", exitCode: 0 };
    if (args[0] === "add" && args[1] && args[2]) return { stdout: `${exports.wexel_cli_add?.(Number(args[1]), Number(args[2])) ?? 0}\n`, stderr: "", exitCode: 0 };
    return { stdout: "", stderr: "Uso: native-cli version | native-cli add <a> <b>\n", exitCode: 2 };
  }

  /** @deprecated use gitExec */
  async git(args: string[]): Promise<ExecResult> { return this.gitExec(args); }
  /** @deprecated use curlExec */
  async curl(url: string): Promise<ExecResult>   { return runCurl([url], { fs: this.fs, fetcher: this.networkFetch }); }
}

// ── Wexel (entry point) ───────────────────────────────────────────────────────

export const Wexel = {
  create:   WexelRuntime.create.bind(WexelRuntime),
  loadOnly: (options: WexelOptions = {}) => WexelRuntime.create({ ...options, mode: "load-only" as const }),
};

// ── utilitários internos ──────────────────────────────────────────────────────

async function defaultCoreBytes(): Promise<ArrayBuffer> {
  const url = new URL("../assets/core.wasm", import.meta.url);
  try { return await fetch(url).then((r) => r.arrayBuffer()); }
  catch { throw new Error("Wexel Assembly core não encontrado. Execute o build ou forneça coreBytes."); }
}

function scriptLanguage(path: string): "javascript" | "typescript" | undefined {
  const ext = path.split("?")[0].split(".").pop()?.toLowerCase();
  if (ext === "js" || ext === "mjs" || ext === "cjs") return "javascript";
  if (ext === "ts" || ext === "mts" || ext === "cts" || ext === "tsx") return "typescript";
  return undefined;
}

// ── re-exports ────────────────────────────────────────────────────────────────

export { BuzzBox }          from "./buzz-box.js";
export { createBusyBoxRunner, type BusyBoxFactory, type BusyBoxRunOptions, type BusyBoxRunResult } from "./busybox.js";
export { PythonPackageManager, type PackageInstallResult, type PackageManagerOptions } from "./python-packages.js";
export { V9Executor, type V9Document, type V9RenderResult } from "./v9.js";
export { NativeExtensionRegistry, type NativeExtensionManifest, type NativeExtension } from "./native-extensions.js";
export { compileNativeSource, runNativeSource, type CompileOptions, type CompileResult, type RunOptions, type RunResult } from "./native-compiler.js";
export { WexelLanguageExecutor, type LanguageExecutorOptions, type CompiledLanguage } from "./language-executors.js";
export { WexelArtifactManager, type LoadArtifactOptions, type WexelLoadedArtifact, type WexelArtifactSummary } from "./artifact-manager.js";
export { parseMultiC, runMultiCFile, runMultiCSource, runMultiCVfs, type MultiCOptions, type MultiCResult, type MultiCSection, type MultiCLanguage } from "./multic.js";
export { RustV, type RustVOptions } from "./rustv.js";
export { WexelPersistentFS, WexelIDBFS, type PersistentFSOptions } from "./persistent-fs.js";
export { X64_WASM_TRANSLATOR_ABI, translateX64ToWasm, x64RegisterName, x64RegisterIndex, type X64Register, type X64Instruction, type X64TranslationDiagnostic, type X64TranslationResult, type X64WasmTranslatorOptions } from "./x86-64-wasm-translator.js";
export { WexelGit, type GitOptions } from "./git.js";
export { runCurl, type CurlOptions, type CurlResult } from "./curl.js";
export { WebPink, WebPinkClient, type WebPinkMessage, type WebPinkOptions, type WebPinkSandboxPolicy } from "./web-pink.js";
export { WexelLifecycleManager } from "@wexel/core";
export type { WexelComponentSnapshot, WexelComponentState, WexelLifecycleSnapshot, WexelLifecycleState } from "@wexel/core";
export type { WexelCoreInstance } from "@wexel/core";

