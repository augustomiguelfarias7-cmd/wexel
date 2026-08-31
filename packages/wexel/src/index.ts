import { instantiateCore, type WexelCoreInstance } from "@wexel/core";

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
}

export class WexelFileSystem {
  private files = new Map<string, Uint8Array>();
  private cwd = "/";
  private used = 0;
  constructor(private readonly quotaBytes = 3 * 1024 * 1024 * 1024) {}

  pwd(): string { return this.cwd; }
  cd(path: string): void {
    const next = this.resolve(path);
    if (next !== "/" && !this.files.has(`${next}/.dir`)) throw new Error(`Diretório inexistente: ${path}`);
    this.cwd = next;
  }
  mkdir(path: string): void { this.files.set(`${this.resolve(path)}/.dir`, new Uint8Array()); }
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
    const tokens = command.trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) return { stdout: "", stderr: "", exitCode: 0 };
    const [name, ...args] = tokens;
    try {
      switch (name) {
        case "pwd": return { stdout: `${this.runtime.fs.pwd()}\n`, stderr: "", exitCode: 0 };
        case "ls": return { stdout: `${this.runtime.fs.list().join("\n")}\n`, stderr: "", exitCode: 0 };
        case "cd": this.runtime.fs.cd(args[0] ?? "/"); return { stdout: "", stderr: "", exitCode: 0 };
        case "mkdir": this.runtime.fs.mkdir(args[0]); return { stdout: "", stderr: "", exitCode: 0 };
        case "cat": return { stdout: new TextDecoder().decode(this.runtime.fs.read(args[0])), stderr: "", exitCode: 0 };
        case "python": return this.runtime.exec({ language: "python", file: args[0], args: args.slice(1) });
        case "echo": return { stdout: `${args.join(" ")}\n`, stderr: "", exitCode: 0 };
        case "git": return { stdout: "Git backend is a controlled extension and is not enabled in this runtime.\n", stderr: "", exitCode: 2 };
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
  private readonly pythonRunner?: (code: string, args: string[]) => Promise<ExecResult> | ExecResult;
  private readonly denoRunner?: WexelOptions["denoRunner"];
  private constructor(readonly core: WexelCoreInstance, options: WexelOptions) {
    this.pythonRunner = options.pythonRunner;
    this.denoRunner = options.denoRunner;
    this.mode = options.mode ?? "run";
    this.fs = new WexelFileSystem(options.storageQuotaBytes);
    this.permissions = { network: false, storage: true, files: false, modules: true, ...options.permissions };
    this.shell = new WexelShell(this);
  }
  static async create(options: WexelOptions = {}): Promise<WexelRuntime> {
    const bytes = options.coreBytes ?? await defaultCoreBytes();
    return new WexelRuntime(await instantiateCore(bytes), options);
  }
  async exec(request: ExecRequest): Promise<ExecResult> {
    if (this.mode === "load-only") return { stdout: "", stderr: "", exitCode: 0 };
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
    return (await WebAssembly.instantiate(bytes, {})).instance;
  }
  async curl(url: string): Promise<ExecResult> {
    const response = await fetch(url); return { stdout: await response.text(), stderr: "", exitCode: response.ok ? 0 : response.status };
  }
}

export const Wexel = { create: WexelRuntime.create.bind(WexelRuntime) };

async function defaultCoreBytes(): Promise<ArrayBuffer> {
  const url = new URL("../assets/core.wasm", import.meta.url);
  try { return await fetch(url).then((r) => r.arrayBuffer());   } catch { throw new Error("Wexel Assembly core não encontrado. Execute o build ou forneça coreBytes."); }
}


export type { WexelCoreInstance } from "@wexel/core";
