import { instantiateCore, type WexelCoreInstance } from "@wexel/core";
import { BuzzBox } from "./buzz-box.js";
import { PythonPackageManager } from "./python-packages.js";
import { V9Executor, type V9Document } from "./v9.js";
import { NativeExtensionRegistry, type NativeExtensionManifest, type NativeExtension } from "./native-extensions.js";

import { WexelGit } from "./git.js";
import { runCurl } from "./curl.js";

import { runNativeSource } from "./native-compiler.js";
import { runMultiCVfs } from "./multic.js";
import { WexelShell } from "./shell.js";

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
  /** VFS externo/persistente. Quando fornecido, o runtime não cria outro Map. */
  fs?: WexelFileSystem;
  mode?: "load-only" | "run";
  initialMemoryPages?: number;
  maxMemoryPages?: number;
  coreBytes?: BufferSource;
  pythonRunner?: (code: string, args: string[]) => Promise<ExecResult> | ExecResult;
  pythonRunnerFactory?: (fs: WexelFileSystem) => NonNullable<WexelOptions["pythonRunner"]>;
  /** Executa JS/TS via Wexel.js (Edge.js + QuickJS-NG, ver assets/wexeljs/edgejs.wasm). */
  wexelJsRunner?: (code: string, language: "javascript" | "typescript", args: string[]) => Promise<ExecResult> | ExecResult;
  bashRunner?: (args: string[]) => Promise<ExecResult> | ExecResult;
  networkFetch?: typeof fetch;
  pypiIndexUrl?: string;
  v9?: V9Document;
  /** @deprecated Use WexelGit integrado. */
  gitCloneRunner?: (url: string, destination: string) => Promise<ExecResult> | ExecResult;
  /** Token para repositórios privados no git clone. */
  gitToken?: string;
  nativeCliBytes?: BufferSource;
  nativeExtensions?: Array<{ manifest: NativeExtensionManifest; source: BufferSource }>;
  /**
   * Kernel Linux-WASM ja inicializado (retorno de linux(...) em
   * linux-node.js/linux-browser.js) e a funcao de captura de saida ligada ao
   * console_write usado nesse boot. Sem os dois, this.shell fica undefined —
   * o boot do kernel em si ainda precisa ser feito por quem monta o
   * NodeExecution, antes de passar pra ca.
   */
  kernel?: import("./kernel-busybox-connector.js").BootedKernel;
  kernelOutput?: (listener: (chunk: string) => void) => () => void;
}

// ── WexelFileSystem ──────────────────────────────────────────────────────────

export class WexelFileSystem {
  private files = new Map<string, Uint8Array>();
  private cwd: string;
  private used = 0;
  readonly home: string;

  constructor(private readonly quotaBytes = 5 * 1024 * 1024 * 1024, homeDirectory = "/home/wexel") {
    this.home = normalizeHome(homeDirectory);
    this.cwd  = this.home;
    for (const directory of ["/bin", "/home", this.home, "/tmp", "/usr", "/var", "/site-packages"]) {
      this.files.set(`${directory}/.dir`, new Uint8Array());
    }
  }

  pwd(): string { return this.cwd; }
  cd(path: string): void {
    const next = this.resolve(path);
    if (next !== "/" && !this.files.has(`${next}/.dir`)) throw new Error(`Diretório inexistente: ${path}`);
    this.cwd = next;
  }
  mkdir(path: string): void { if (path) this.files.set(`${this.resolve(path)}/.dir`, new Uint8Array()); }
  touch(path: string): void { if (!this.exists(path)) this.write(path, new Uint8Array()); }
  remove(path: string): void {
    const target = this.resolve(path);
    for (const key of [...this.files.keys()]) {
      if (key === target || key.startsWith(`${target}/`)) { this.used -= this.files.get(key)?.byteLength ?? 0; this.files.delete(key); }
    }
  }
  readText(path: string): string { return new TextDecoder().decode(this.read(path)); }
  write(path: string, data: string | Uint8Array): void {
    const value   = typeof data === "string" ? new TextEncoder().encode(data) : data;
    const target  = this.resolve(path);
    const previous = this.files.get(target)?.byteLength ?? 0;
    if (this.used - previous + value.byteLength > this.quotaBytes) throw new Error(`Quota do filesystem excedida (${this.quotaBytes} bytes)`);
    this.files.set(target, value);
    this.used = this.used - previous + value.byteLength;
  }
  read(path: string): Uint8Array {
    const value = this.files.get(this.resolve(path));
    if (!value) throw new Error(`Arquivo inexistente: ${path}`);
    return value;
  }
  list(path?: string): string[] {
    const base = path === undefined ? this.cwd : this.resolve(path);
    const prefix = base === "/" ? "/" : `${base}/`;
    return [...this.files.keys()].filter((x) => x.startsWith(prefix)).map((x) => x.slice(prefix.length)).filter((x) => x && x !== ".dir");
  }
  get quota(): { usedBytes: number; limitBytes: number } { return { usedBytes: this.used, limitBytes: this.quotaBytes }; }
  exists(path: string): boolean { return this.files.has(this.resolve(path)) || this.files.has(`${this.resolve(path)}/.dir`); }
  snapshot(): Array<{ path: string; data: Uint8Array }> {
    return [...this.files.entries()].filter(([path]) => !path.endsWith("/.dir")).map(([path, data]) => ({ path, data: data.slice() }));
  }
  private resolve(path: string): string {
    const expanded = path === "~" || path.startsWith("~/") ? `${this.home}${path.slice(1)}` : path;
    const raw = expanded.startsWith("/") ? expanded : `${this.cwd}/${expanded}`;
    const parts: string[] = [];
    for (const part of raw.split("/")) { if (!part || part === ".") continue; if (part === "..") parts.pop(); else parts.push(part); }
    return `/${parts.join("/")}`.replace(/\/$/, "") || "/";
  }
}

// ── WexelRuntime ──────────────────────────────────────────────────────────────

export class WexelRuntime {
  /** undefined ate que options.kernel + options.kernelOutput sejam fornecidos (kernel ja precisa estar de pe). */
  readonly shell?:      WexelShell;
  readonly permissions: Required<WexelPermissions>;
  readonly fs:          WexelFileSystem;
  readonly mode:        "load-only" | "run";
  readonly buzz       = new BuzzBox();
  readonly packages:    PythonPackageManager;
  readonly v9         = new V9Executor();
  readonly extensions = new NativeExtensionRegistry();
  readonly networkFetch: typeof fetch;

  private readonly pythonRunner?: (code: string, args: string[]) => Promise<ExecResult> | ExecResult;
  private readonly _wexelJsRunner?: WexelOptions["wexelJsRunner"];
  private readonly bashRunner?:   WexelOptions["bashRunner"];
  private readonly gitCloneRunner?: WexelOptions["gitCloneRunner"];
  private readonly gitToken?:     string;
  private readonly nativeCliBytes?: BufferSource;
  private _git?:          WexelGit;


  private constructor(readonly core: WexelCoreInstance, options: WexelOptions) {
    this.mode         = options.mode ?? "run";
    this.fs           = options.fs ?? new WexelFileSystem(options.storageQuotaBytes, options.homeDirectory);
    this.pythonRunner = options.pythonRunner ?? options.pythonRunnerFactory?.(this.fs);
    this._wexelJsRunner = options.wexelJsRunner;
    this.bashRunner   = options.bashRunner;
    this.networkFetch = options.networkFetch ?? fetch;
    this.gitCloneRunner = options.gitCloneRunner;
    this.gitToken     = options.gitToken;
    this.nativeCliBytes = options.nativeCliBytes;
    this.packages     = new PythonPackageManager({ fs: this.fs, indexUrl: options.pypiIndexUrl, fetcher: this.networkFetch });
    this.permissions  = { network: false, storage: true, files: false, modules: true, ...options.permissions };
    if (options.kernel && options.kernelOutput) {
      this.shell = new WexelShell(options.kernel, options.kernelOutput);
    }
    // sem kernel+kernelOutput, this.shell fica undefined (ver WexelOptions.kernel)
  }

  static async create(options: WexelOptions = {}): Promise<WexelRuntime> {
    const bytes   = options.coreBytes ?? await defaultCoreBytes();
    const runtime = new WexelRuntime(await instantiateCore(bytes), options);
    for (const ext of options.nativeExtensions ?? []) await runtime.loadNativeExtension(ext.manifest, ext.source);
    runtime.buzz.emit("runtime:ready", { mode: runtime.mode });
    return runtime;
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

    if (request.language === "python") {
      const code = request.code ?? (request.file ? this.fs.readText(request.file) : "");
      if (!this.pythonRunner) throw new Error("CPython/WebAssembly não foi registrado. Configure pythonRunner ao criar o runtime.");
      return await this.pythonRunner(code, request.args ?? []);
    }

    return { stdout: request.code ?? "", stderr: "", exitCode: 0 };
  }

  // ── wexeljs shell (Node.js-compatível, via Wexel.js) ────────────────────────

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
    // instalação de pacotes agora é feita pelo npm/pnpm reais embutidos no
    // proprio Wexel.js (ver assets/wexeljs/pnpm.cjs), não por um gerenciador
    // separado — delega pro shell (BusyBox+kernel) rodando o binario real.
    if (command === "add" || command === "install") {
      if (!this.shell) return { stdout: "", stderr: "Shell (BusyBox/kernel) não foi registrado.\n", exitCode: 2 };
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
  async loadModule(source: string | BufferSource): Promise<WebAssembly.Instance> {
    if (!this.permissions.modules) throw new Error("Permissão de módulos negada");
    const bytes    = typeof source === "string" ? await fetch(source).then((r) => r.arrayBuffer()) : source;
    const instance = (await WebAssembly.instantiate(bytes, {})).instance;
    this.buzz.emit("module:loaded", { source: typeof source === "string" ? source : "buffer" });
    return instance;
  }
  createWebDocument(document: V9Document): string { return this.v9.createDocument(document); }
  async loadNativeExtension(manifest: NativeExtensionManifest, source: BufferSource): Promise<NativeExtension> {
    if (!this.permissions.modules) throw new Error("Permissão de módulos negada");
    const extension = await this.extensions.load(manifest, source);
    this.buzz.emit("extension:loaded", { name: manifest.name, version: manifest.version });
    return extension;
  }
  async nativeLanguage(language: "c" | "cpp", args: string[]): Promise<ExecResult> {
    const command = args[0];
    if (command === "list") {
      const extensions = language === "c" ? [".c"] : [".cpp", ".cc", ".cxx"];
      const files = this.fs.snapshot().map((entry) => entry.path).filter((path) => extensions.some((ext) => path.toLowerCase().endsWith(ext)));
      return { stdout: files.join("\\n") + (files.length ? "\\n" : ""), stderr: "", exitCode: 0 };
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
    if (args[0] !== "run" || !args[1]) return { stdout: "", stderr: "Uso: multic run <arquivo.cpp>\\n", exitCode: 2 };
    const file = args[1];
    if (!/\\.(cpp|cc|cxx)$/i.test(file)) return { stdout: "", stderr: "MultiC usa um arquivo-contêiner .cpp/.cc/.cxx.\\n", exitCode: 2 };
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

function normalizeHome(path: string): string {
  if (!path.startsWith("/")) throw new Error("O diretório home deve ser um caminho absoluto.");
  const normalized = path.replace(/\/+$/, "");
  if (normalized === "/" || normalized.includes("/../") || normalized.endsWith("/..")) throw new Error("Diretório home inválido.");
  return normalized;
}

// ── re-exports ────────────────────────────────────────────────────────────────

export { BuzzBox }          from "./buzz-box.js";
export { createBusyBoxRunner, type BusyBoxFactory, type BusyBoxRunOptions, type BusyBoxRunResult } from "./busybox.js";
export { PythonPackageManager, type PackageInstallResult, type PackageManagerOptions } from "./python-packages.js";
export { V9Executor, type V9Document, type V9RenderResult } from "./v9.js";
export { NativeExtensionRegistry, type NativeExtensionManifest, type NativeExtension } from "./native-extensions.js";
export { compileNativeSource, runNativeSource, type CompileOptions, type CompileResult, type RunOptions, type RunResult } from "./native-compiler.js";
export { parseMultiC, runMultiCFile, runMultiCSource, runMultiCVfs, type MultiCOptions, type MultiCResult, type MultiCSection, type MultiCLanguage } from "./multic.js";
export { RustV, type RustVOptions } from "./rustv.js";
export { WexelPersistentFS, WexelIDBFS, type PersistentFSOptions } from "./persistent-fs.js";
export { X64_WASM_TRANSLATOR_ABI, translateX64ToWasm, x64RegisterName, x64RegisterIndex, type X64Register, type X64Instruction, type X64TranslationDiagnostic, type X64TranslationResult, type X64WasmTranslatorOptions } from "./x86-64-wasm-translator.js";
export { WexelGit, type GitOptions } from "./git.js";
export { runCurl, type CurlOptions, type CurlResult } from "./curl.js";
export { WebPink, WebPinkClient, type WebPinkMessage, type WebPinkOptions, type WebPinkSandboxPolicy } from "./web-pink.js";
export type { WexelCoreInstance } from "@wexel/core";
