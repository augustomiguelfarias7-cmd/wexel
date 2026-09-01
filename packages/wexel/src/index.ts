import { instantiateCore, type WexelCoreInstance } from "@wexel/core";
import { BuzzBox } from "./buzz-box.js";
import { PythonPackageManager } from "./python-packages.js";
import { V9Executor, type V9Document } from "./v9.js";

export type Language = "python" | "wasm" | "javascript" | string;

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
  /** Quota lógica do filesystem; não reserva essa quantidade de RAM. */
  storageQuotaBytes?: number;
  /** Perfil de ciclo de vida: carregar componentes sem executar ou executar scripts solicitados. */
  mode?: "load-only" | "run";
  initialMemoryPages?: number;
  maxMemoryPages?: number;
  coreBytes?: BufferSource;
  /** Adapter para um build real do CPython compilado para WebAssembly. */
  pythonRunner?: (code: string, args: string[]) => Promise<ExecResult> | ExecResult;
  denoRunner?: (code: string, language: "javascript" | "typescript" | "html", args: string[]) => Promise<ExecResult> | ExecResult;
  pypiIndexUrl?: string;
  v9?: V9Document;
  gitCloneRunner?: (url: string, destination: string) => Promise<ExecResult> | ExecResult;
}

export class WexelFileSystem {
  private files = new Map<string, Uint8Array>();
  private cwd = "/";
  private used = 0;
  constructor(private readonly quotaBytes = 5 * 1024 * 1024 * 1024) {}

  pwd(): string { return this.cwd; }
  cd(path: string): void {
    const next = this.resolve(path);
    if (next !== "/" && !this.files.has(`${next}/.dir`)) throw new Error(`Diretório inexistente: ${path}`);
    this.cwd = next;
  }
  mkdir(path: string): void { this.files.set(`${this.resolve(path)}/.dir`, new Uint8Array()); }
  touch(path: string): void { if (!this.exists(path)) this.write(path, new Uint8Array()); }
  remove(path: string): void {
    const target = this.resolve(path);
    for (const key of [...this.files.keys()]) {
      if (key === target || key.startsWith(`${target}/`)) { this.used -= this.files.get(key)?.byteLength ?? 0; this.files.delete(key); }
    }
  }
  readText(path: string): string { return new TextDecoder().decode(this.read(path)); }
  write(path: string, data: string | Uint8Array): void {
    const value = typeof data === "string" ? new TextEncoder().encode(data) : data;
    const target = this.resolve(path);
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
  list(): string[] {
    const prefix = this.cwd === "/" ? "/" : `${this.cwd}/`;
    return [...this.files.keys()].filter((x) => x.startsWith(prefix)).map((x) => x.slice(prefix.length)).filter((x) => x && x !== ".dir");
  }
  get quota(): { usedBytes: number; limitBytes: number } { return { usedBytes: this.used, limitBytes: this.quotaBytes }; }
  exists(path: string): boolean { return this.files.has(this.resolve(path)) || this.files.has(`${this.resolve(path)}/.dir`); }
  snapshot(): Array<{ path: string; data: Uint8Array }> { return [...this.files.entries()].filter(([path]) => !path.endsWith("/.dir")).map(([path, data]) => ({ path, data: data.slice() })); }
  private resolve(path: string): string {
    const raw = path.startsWith("/") ? path : `${this.cwd}/${path}`;
    const parts: string[] = [];
    for (const part of raw.split("/")) { if (!part || part === ".") continue; if (part === "..") parts.pop(); else parts.push(part); }
    return `/${parts.join("/")}`.replace(/\/$/, "") || "/";
  }
}

export class WexelShell {
  constructor(private readonly runtime: WexelRuntime) {}
  async exec(command: string): Promise<ExecResult> {
    const tokens = command.match(/(?:[^\s\"']+|\"[^\"]*\"|'[^']*')+/g)?.map((token) => token.replace(/^(['\"])(.*)\1$/, "$2")) ?? [];
    if (!tokens.length) return { stdout: "", stderr: "", exitCode: 0 };
    const [name, ...args] = tokens;
    try {
      switch (name) {
        case "pwd": return { stdout: `${this.runtime.fs.pwd()}\n`, stderr: "", exitCode: 0 };
        case "ls": return { stdout: `${this.runtime.fs.list().join("\n")}\n`, stderr: "", exitCode: 0 };
        case "cd": this.runtime.fs.cd(args[0] ?? "/"); return { stdout: "", stderr: "", exitCode: 0 };
        case "mkdir": this.runtime.fs.mkdir(args[0]); return { stdout: "", stderr: "", exitCode: 0 };
        case "touch": this.runtime.fs.touch(args[0]); return { stdout: "", stderr: "", exitCode: 0 };
        case "rm": this.runtime.fs.remove(args[0]); return { stdout: "", stderr: "", exitCode: 0 };
        case "cat": return { stdout: this.runtime.fs.readText(args[0]), stderr: "", exitCode: 0 };
        case "head": return { stdout: this.runtime.fs.readText(args[0]).split("\\n").slice(0, 10).join("\\n") + "\\n", stderr: "", exitCode: 0 };
        case "tail": return { stdout: this.runtime.fs.readText(args[0]).split("\\n").slice(-10).join("\\n") + "\\n", stderr: "", exitCode: 0 };
        case "python": return this.runtime.exec({ language: "python", file: args[0], args: args.slice(1) });
        case "pip": if (!this.runtime.permissions.network) throw new Error("Permissão de rede negada para pip"); return this.runtime.packages.pip(args);
        case "echo": return { stdout: `${args.join(" ")}\n`, stderr: "", exitCode: 0 };
        case "git": return this.runtime.git(args);
        case "whoami": return { stdout: "wexel\\n", stderr: "", exitCode: 0 };
        case "uname": return { stdout: "WexelAssembly wasm32 sandbox\\n", stderr: "", exitCode: 0 };
        case "help": return { stdout: "pwd ls cd mkdir touch rm cat head tail echo curl git pip whoami uname help\\n", stderr: "", exitCode: 0 };
        case "curl": if (!this.runtime.permissions.network) throw new Error("Permissão de rede negada"); return this.runtime.curl(args[0]);
        default: return { stdout: "", stderr: `wexel: comando não encontrado: ${name}\n`, exitCode: 127 };
      }
    } catch (error) { return { stdout: "", stderr: `${error instanceof Error ? error.message : String(error)}\n`, exitCode: 1 }; }
  }
}

export class WexelRuntime {
  readonly shell: WexelShell;
  readonly permissions: Required<WexelPermissions>;
  readonly fs: WexelFileSystem;
  readonly mode: "load-only" | "run";
  readonly buzz = new BuzzBox();
  readonly packages: PythonPackageManager;
  readonly v9 = new V9Executor();
  private readonly pythonRunner?: (code: string, args: string[]) => Promise<ExecResult> | ExecResult;
  private readonly denoRunner?: WexelOptions["denoRunner"];
  private readonly gitCloneRunner?: WexelOptions["gitCloneRunner"];
  private constructor(readonly core: WexelCoreInstance, options: WexelOptions) {
    this.pythonRunner = options.pythonRunner;
    this.denoRunner = options.denoRunner;
    this.gitCloneRunner = options.gitCloneRunner;
    this.mode = options.mode ?? "run";
    this.fs = new WexelFileSystem(options.storageQuotaBytes);
    this.packages = new PythonPackageManager({ fs: this.fs, indexUrl: options.pypiIndexUrl });
    this.permissions = { network: false, storage: true, files: false, modules: true, ...options.permissions };
    this.shell = new WexelShell(this);
  }
  static async create(options: WexelOptions = {}): Promise<WexelRuntime> {
    const bytes = options.coreBytes ?? await defaultCoreBytes();
    const runtime = new WexelRuntime(await instantiateCore(bytes), options);
    runtime.buzz.emit("runtime:ready", { mode: runtime.mode });
    return runtime;
  }
  async exec(request: ExecRequest): Promise<ExecResult> {
    if (this.mode === "load-only") { this.buzz.emit("script:loaded", { language: request.language }); return { stdout: "", stderr: "", exitCode: 0 }; }
    if (request.language === "wasm") throw new Error("Use loadModule() para módulos WASM");
    if (request.language === "javascript" || request.language === "typescript" || request.language === "html") {
      if (!this.denoRunner) throw new Error("Deno/WebAssembly não foi registrado para executar JavaScript, TypeScript ou HTML.");
      const code = request.code ?? (request.file ? new TextDecoder().decode(this.fs.read(request.file)) : "");
      return await this.denoRunner(code, request.language, request.args ?? []);
    }
    if (request.language === "python") {
      const code = request.code ?? (request.file ? new TextDecoder().decode(this.fs.read(request.file)) : "");
      if (!this.pythonRunner) throw new Error("CPython/WebAssembly não foi registrado. Configure pythonRunner ao criar o runtime.");
      return await this.pythonRunner(code, request.args ?? []);
    }
    return { stdout: request.code ?? "", stderr: "", exitCode: 0 };
  }
  async loadScript(source: string | BufferSource): Promise<BufferSource> {
    if (typeof source === "string") return await fetch(source).then((r) => r.arrayBuffer());
    return source;
  }
  async runScript(source: string | BufferSource, request: Omit<ExecRequest, "code" | "file">): Promise<ExecResult> {
    const bytes = await this.loadScript(source);
    const code = typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes);
    return this.exec({ ...request, code });
  }
  async loadModule(source: string | BufferSource): Promise<WebAssembly.Instance> {
    if (!this.permissions.modules) throw new Error("Permissão de módulos negada");
    const bytes = typeof source === "string" ? await fetch(source).then((r) => r.arrayBuffer()) : source;
    const instance = (await WebAssembly.instantiate(bytes, {})).instance;
    this.buzz.emit("module:loaded", { source: typeof source === "string" ? source : "buffer" });
    return instance;
  }
  createWebDocument(document: V9Document): string { return this.v9.createDocument(document); }
  async git(args: string[]): Promise<ExecResult> {
    if (args[0] !== "clone" || !args[1]) return { stdout: "", stderr: "Uso: git clone <url> [destino]\\n", exitCode: 2 };
    if (!this.permissions.network) throw new Error("Permissão de rede negada para git clone");
    if (!this.gitCloneRunner) return { stdout: "", stderr: "Git clone requer um adapter de host; BusyBox/Git WASM não foi registrado.\\n", exitCode: 2 };
    return await this.gitCloneRunner(args[1], args[2] ?? args[1].split("/").pop()?.replace(/\\.git$/, "") ?? "repo");
  }
  async curl(url: string): Promise<ExecResult> {
    const response = await fetch(url); return { stdout: await response.text(), stderr: "", exitCode: response.ok ? 0 : response.status };
  }
}

export const Wexel = {
  create: WexelRuntime.create.bind(WexelRuntime),
  /** Carrega somente o core e componentes pré-instalados; não executa código nem cria arquivos. */
  loadOnly: (options: WexelOptions = {}) => WexelRuntime.create({ ...options, mode: "load-only" as const }),
};

async function defaultCoreBytes(): Promise<ArrayBuffer> {
  const url = new URL("../assets/core.wasm", import.meta.url);
  try { return await fetch(url).then((r) => r.arrayBuffer());   } catch { throw new Error("Wexel Assembly core não encontrado. Execute o build ou forneça coreBytes."); }
}


export { BuzzBox } from "./buzz-box.js";
export { createBusyBoxRunner, type BusyBoxFactory, type BusyBoxRunOptions, type BusyBoxRunResult } from "./busybox.js";
export { PythonPackageManager, type PackageInstallResult, type PackageManagerOptions } from "./python-packages.js";
export { V9Executor, type V9Document, type V9RenderResult } from "./v9.js";
export type { WexelCoreInstance } from "@wexel/core";
