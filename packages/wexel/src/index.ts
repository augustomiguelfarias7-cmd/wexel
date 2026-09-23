import { instantiateCore, type WexelCoreInstance } from "@wexel/core";
import { BuzzBox } from "./buzz-box.js";
import { PythonPackageManager } from "./python-packages.js";
import { V9Executor, type V9Document } from "./v9.js";
import { NativeExtensionRegistry, type NativeExtensionManifest, type NativeExtension } from "./native-extensions.js";
import { DenoWasmRuntime } from "./deno-wasm.js";
import { WexelGit } from "./git.js";
import { runCurl } from "./curl.js";
import { DenoPackageManager } from "./deno-package-manager.js";

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
  mode?: "load-only" | "run";
  initialMemoryPages?: number;
  maxMemoryPages?: number;
  coreBytes?: BufferSource;
  pythonRunner?: (code: string, args: string[]) => Promise<ExecResult> | ExecResult;
  pythonRunnerFactory?: (fs: WexelFileSystem) => NonNullable<WexelOptions["pythonRunner"]>;
  denoRunner?: (code: string, language: "javascript" | "typescript", args: string[]) => Promise<ExecResult> | ExecResult;
  denoRuntime?: DenoWasmRuntime;
  /** Runtime Deno unificado (browser + Node) — tem prioridade sobre denoRuntime e denoRunner. */
  deno?: import("./deno-wasm.js").DenoRuntime;
  bashRunner?: (args: string[]) => Promise<ExecResult> | ExecResult;
  networkFetch?: typeof fetch;
  pypiIndexUrl?: string;
  v9?: V9Document;
  /** @deprecated Use deno com WexelGit integrado. */
  gitCloneRunner?: (url: string, destination: string) => Promise<ExecResult> | ExecResult;
  /** Token para repositórios privados no git clone. */
  gitToken?: string;
  nativeCliBytes?: BufferSource;
  nativeExtensions?: Array<{ manifest: NativeExtensionManifest; source: BufferSource }>;
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
  list(): string[] {
    const prefix = this.cwd === "/" ? "/" : `${this.cwd}/`;
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

// ── Shell helpers ─────────────────────────────────────────────────────────────

function shellOk(stdout: string): ExecResult  { return { stdout, stderr: "", exitCode: 0 }; }
function shellErr(stderr: string, exitCode = 1): ExecResult { return { stdout: "", stderr, exitCode }; }

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/** Tokenizador que respeita aspas simples, duplas e escapes. */
function shellTokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === "\\" && !quote) { current += input[++i] ?? ""; continue; }
    if ((ch === '"' || ch === "'") && !quote) { quote = ch; continue; }
    if (ch === quote) { quote = null; continue; }
    if (ch === " " && !quote) { if (current) { tokens.push(current); current = ""; } continue; }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

function convertWget(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-O" || args[i] === "--output-document") out.push("-o", args[++i]);
    else if (args[i] === "-q" || args[i] === "--quiet") out.push("-s");
    else out.push(args[i]);
  }
  return out;
}

const SHELL_HELP = `Wexel Shell — comandos disponíveis:

  Navegação:    pwd  cd  ls  find
  Arquivos:     cat  head  tail  grep  wc  sort  uniq  mkdir  touch  rm  mv  cp
  Escrita:      echo  printf
  Info:         whoami  id  hostname  uname  date  uptime  env  df  du  ps
  Hash:         sha256sum  md5sum  base64
  Processos:    sleep  true  false  exit  kill
  Runtimes:     python  python3  pip  deno  node  bash  sh
  Pacotes:      npm install  pnpm install  deno add
  Rede:         curl  wget
  Git:          git clone  git status  git log  git diff  git commit
  Wexel:        wexel quota  native-cli  help  clear
`;

// ── WexelShell ────────────────────────────────────────────────────────────────

export class WexelShell {
  constructor(private readonly runtime: WexelRuntime) {}

  async exec(command: string): Promise<ExecResult> {
    const tokens = shellTokenize(command);
    if (!tokens.length) return shellOk("");

    // VAR=valor inline
    const envOverrides: Record<string, string> = {};
    while (tokens[0]?.includes("=") && !/^-/.test(tokens[0])) {
      const eq  = tokens.shift()!;
      const idx = eq.indexOf("=");
      envOverrides[eq.slice(0, idx)] = eq.slice(idx + 1);
    }

    const [name, ...args] = tokens;
    if (!name) return shellOk("");

    try {
      return await this.dispatch(name, args);
    } catch (error) {
      return shellErr(`${error instanceof Error ? error.message : String(error)}\n`);
    }
  }

  private async dispatch(name: string, args: string[]): Promise<ExecResult> {
    const fs = this.runtime.fs;

    switch (name) {
      // ── navegação ──────────────────────────────────────────────────────────
      case "pwd": return shellOk(fs.pwd() + "\n");
      case "cd":  fs.cd(args[0] ?? fs.home); return shellOk("");
      case "ls": {
        const target  = args.find((a) => !a.startsWith("-"));
        const long    = args.some((a) => a.startsWith("-") && a.includes("l"));
        const all     = args.some((a) => a.startsWith("-") && a.includes("a"));
        const prev    = fs.pwd();
        if (target) fs.cd(target);
        let entries = fs.list();
        if (!all) entries = entries.filter((e) => !e.startsWith("."));
        if (target) fs.cd(prev);
        if (long) {
          return shellOk(entries.map((e) => `drwxr-xr-x 1 wexel wexel 0 Jan  1 00:00 ${e}`).join("\n") + "\n");
        }
        return shellOk(entries.join("  ") + "\n");
      }

      // ── manipulação de arquivos ────────────────────────────────────────────
      case "mkdir": {
        const recursive = args.some((a) => a === "-p" || a === "--parents");
        const targets   = args.filter((a) => !a.startsWith("-"));
        for (const t of targets) {
          if (recursive) {
            let p = "";
            for (const seg of t.split("/").filter(Boolean)) { p += `/${seg}`; fs.mkdir(p); }
          } else { fs.mkdir(t); }
        }
        return shellOk("");
      }
      case "touch": args.filter((a) => !a.startsWith("-")).forEach((f) => fs.touch(f)); return shellOk("");
      case "rm":    args.filter((a) => !a.startsWith("-")).forEach((f) => fs.remove(f)); return shellOk("");
      case "mv": {
        if (args.length < 2) return shellErr("mv: faltam operandos\n", 1);
        fs.write(args[1], fs.read(args[0])); fs.remove(args[0]); return shellOk("");
      }
      case "cp": {
        if (args.length < 2) return shellErr("cp: faltam operandos\n", 1);
        fs.write(args[1], fs.read(args[0])); return shellOk("");
      }

      // ── leitura ────────────────────────────────────────────────────────────
      case "cat":  return shellOk(args.map((f) => fs.readText(f)).join(""));
      case "head": {
        const nIdx = args.indexOf("-n");
        const n    = nIdx >= 0 ? parseInt(args[nIdx + 1] ?? "10") : 10;
        const file = args.find((a) => !a.startsWith("-"))!;
        return shellOk(fs.readText(file).split("\n").slice(0, n).join("\n") + "\n");
      }
      case "tail": {
        const nIdx = args.indexOf("-n");
        const n    = nIdx >= 0 ? parseInt(args[nIdx + 1] ?? "10") : 10;
        const file = args.find((a) => !a.startsWith("-"))!;
        return shellOk(fs.readText(file).split("\n").slice(-n).join("\n") + "\n");
      }
      case "wc": {
        const file  = args.find((a) => !a.startsWith("-"))!;
        const text  = fs.readText(file);
        const lines = text.split("\n").length;
        const words = text.trim().split(/\s+/).length;
        const bytes = new TextEncoder().encode(text).byteLength;
        return shellOk(`${lines} ${words} ${bytes} ${file}\n`);
      }
      case "grep": {
        if (args.length < 2) return shellErr("grep: uso: grep <padrão> <arquivo>\n", 2);
        const iIdx    = args.indexOf("-i");
        const file    = args.find((a, i) => !a.startsWith("-") && i !== args.indexOf(args.find((x) => !x.startsWith("-"))!));
        const pattern = args.find((a) => !a.startsWith("-"))!;
        const actualFile = args.filter((a) => !a.startsWith("-"))[1] ?? args.filter((a) => !a.startsWith("-"))[0];
        const re      = new RegExp(pattern, iIdx >= 0 ? "i" : "");
        const lines   = fs.readText(actualFile ?? file ?? "").split("\n").filter((l) => re.test(l));
        return { stdout: lines.join("\n") + (lines.length ? "\n" : ""), stderr: "", exitCode: lines.length ? 0 : 1 };
      }
      case "find": {
        const all    = fs.snapshot().map((f) => f.path);
        const nameFlag = args.findIndex((a) => a === "-name");
        const filter   = nameFlag >= 0 ? args[nameFlag + 1] : undefined;
        const results  = filter
          ? all.filter((p) => p.includes(filter.replace(/\*/g, "")))
          : all;
        return shellOk(results.join("\n") + "\n");
      }
      case "sort": {
        const file    = args.find((a) => !a.startsWith("-"))!;
        const lines   = fs.readText(file).split("\n").filter(Boolean);
        const reverse = args.includes("-r");
        lines.sort(reverse ? (a, b) => b.localeCompare(a) : undefined);
        return shellOk(lines.join("\n") + "\n");
      }
      case "uniq": {
        const file  = args.find((a) => !a.startsWith("-"))!;
        const lines = fs.readText(file).split("\n");
        return shellOk(lines.filter((l, i) => l !== lines[i - 1]).join("\n") + "\n");
      }

      // ── escrita ────────────────────────────────────────────────────────────
      case "echo": {
        const noNewline = args[0] === "-n";
        const text = (noNewline ? args.slice(1) : args).join(" ").replace(/\\n/g, "\n").replace(/\\t/g, "\t");
        return shellOk(noNewline ? text : text + "\n");
      }
      case "printf": return shellOk((args[0] ?? "").replace(/\\n/g, "\n").replace(/\\t/g, "\t"));

      // ── info do sistema ────────────────────────────────────────────────────
      case "whoami":  return shellOk("wexel\n");
      case "id":      return shellOk("uid=1000(wexel) gid=1000(wexel) groups=1000(wexel)\n");
      case "hostname":return shellOk("wexel-sandbox\n");
      case "uname": {
        if (args.includes("-a")) return shellOk("Linux wexel-sandbox 6.1.0-wexel #1 SMP wasm32 GNU/Linux\n");
        if (args.includes("-r")) return shellOk("6.1.0-wexel\n");
        if (args.includes("-m")) return shellOk("wasm32\n");
        return shellOk("Linux\n");
      }
      case "date":    return shellOk(new Date().toUTCString() + "\n");
      case "uptime":  return shellOk("up 0 min, 1 user, load average: 0.00, 0.00, 0.00\n");
      case "env":     return shellOk(`HOME=${fs.home}\nPATH=/bin:/usr/bin\nSHELL=/bin/sh\n`);
      case "printenv":return shellOk(args[0] ? `${args[0]}=\n` : `HOME=${fs.home}\nPATH=/bin:/usr/bin\n`);

      // ── disco ──────────────────────────────────────────────────────────────
      case "df": {
        const q     = fs.quota;
        const used  = Math.round(q.usedBytes / 1024);
        const avail = Math.round((q.limitBytes - q.usedBytes) / 1024);
        const total = Math.round(q.limitBytes / 1024);
        return shellOk(`Filesystem      1K-blocks  Used Available Use% Mounted on\nwexel-vfs       ${total}  ${used}  ${avail}  ${Math.round((used / total) * 100)}% /\n`);
      }
      case "du": {
        const file  = args.find((a) => !a.startsWith("-"));
        const bytes = file ? fs.read(file).byteLength : fs.snapshot().reduce((s, f) => s + f.data.byteLength, 0);
        return shellOk(`${Math.ceil(bytes / 1024)}\t${file ?? "."}\n`);
      }

      // ── hash ───────────────────────────────────────────────────────────────
      case "sha256sum":
      case "md5sum": {
        const file  = args.find((a) => !a.startsWith("-"));
        if (!file) return shellErr(`${name}: arquivo não especificado\n`, 1);
        const data  = fs.read(file);
        const algo  = name === "sha256sum" ? "SHA-256" : "MD5";
        const buf   = await crypto.subtle.digest(algo, data as unknown as BufferSource);
        const hex   = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
        return shellOk(`${hex}  ${file}\n`);
      }
      case "base64": {
        const file = args.find((a) => !a.startsWith("-"));
        if (!file) return shellErr("base64: arquivo não especificado\n", 1);
        if (args.includes("-d") || args.includes("--decode")) {
          return shellOk(atob(fs.readText(file)));
        }
        const data = fs.read(file);
        return shellOk(btoa(String.fromCharCode(...data)) + "\n");
      }

      // ── processos ──────────────────────────────────────────────────────────
      case "ps":    return shellOk("  PID TTY          TIME CMD\n    1 pts/0    00:00:00 wexel-shell\n");
      case "kill":  return shellOk("");
      case "sleep": return await new Promise<ExecResult>((r) => setTimeout(() => r(shellOk("")), (parseFloat(args[0] ?? "1") * 1000)));
      case "true":  return shellOk("");
      case "false": return { stdout: "", stderr: "", exitCode: 1 };
      case "exit":  return { stdout: "", stderr: "", exitCode: parseInt(args[0] ?? "0") || 0 };
      case "clear": return shellOk("\x1B[2J\x1B[0;0H");

      // ── runtimes ───────────────────────────────────────────────────────────
      case "python":
      case "python3": return this.runtime.exec({ language: "python", file: args[0], args: args.slice(1) });
      case "pip":
      case "pip3":
        if (!this.runtime.permissions.network) return shellErr("pip: permissão de rede negada\n", 1);
        return this.runtime.packages.pip(args);
      case "deno":  return this.runtime.deno(args);
      case "node":  return this.runtime.node(args);
      case "bash":
      case "sh":    return this.runtime.bash(args);

      // ── gerenciador de pacotes ─────────────────────────────────────────────
      case "npm":
      case "pnpm":  return this.runtime.denoPackages([name, ...args]);

      // ── rede ───────────────────────────────────────────────────────────────
      case "curl":
      case "wget":
        if (!this.runtime.permissions.network) return shellErr(`${name}: permissão de rede negada\n`, 1);
        return runCurl(name === "wget" ? convertWget(args) : args, {
          fs: this.runtime.fs,
          fetcher: this.runtime.networkFetch,
        });

      // ── git ────────────────────────────────────────────────────────────────
      case "git": return this.runtime.gitExec(args);

      // ── extensões nativas ──────────────────────────────────────────────────
      case "native-cli": return this.runtime.nativeCli(args);

      // ── wexel ──────────────────────────────────────────────────────────────
      case "wexel": {
        if (args[0] === "quota") {
          const q = fs.quota;
          return shellOk(`Usado: ${fmtBytes(q.usedBytes)} / ${fmtBytes(q.limitBytes)} (${Math.round((q.usedBytes / q.limitBytes) * 100)}%)\n`);
        }
        return shellOk("Uso: wexel quota\n");
      }

      case "help":
      case "man": return shellOk(SHELL_HELP);

      default:
        return { stdout: "", stderr: `${name}: comando não encontrado\nDigite 'help' para ver os comandos disponíveis.\n`, exitCode: 127 };
    }
  }
}

// ── WexelRuntime ──────────────────────────────────────────────────────────────

export class WexelRuntime {
  readonly shell:       WexelShell;
  readonly permissions: Required<WexelPermissions>;
  readonly fs:          WexelFileSystem;
  readonly mode:        "load-only" | "run";
  readonly buzz       = new BuzzBox();
  readonly packages:    PythonPackageManager;
  readonly v9         = new V9Executor();
  readonly extensions = new NativeExtensionRegistry();
  readonly networkFetch: typeof fetch;

  private readonly pythonRunner?: (code: string, args: string[]) => Promise<ExecResult> | ExecResult;
  private readonly _denoRunner?:  WexelOptions["denoRunner"];
  private readonly _denoRuntime?: import("./deno-wasm.js").DenoRuntime;
  private readonly bashRunner?:   WexelOptions["bashRunner"];
  private readonly gitCloneRunner?: WexelOptions["gitCloneRunner"];
  private readonly gitToken?:     string;
  private readonly nativeCliBytes?: BufferSource;
  private _git?:          WexelGit;
  private _denoPkgMgr?:  DenoPackageManager;

  private constructor(readonly core: WexelCoreInstance, options: WexelOptions) {
    this.mode         = options.mode ?? "run";
    this.fs           = new WexelFileSystem(options.storageQuotaBytes, options.homeDirectory);
    this.pythonRunner = options.pythonRunner ?? options.pythonRunnerFactory?.(this.fs);
    this._denoRuntime = options.deno;
    this._denoRunner  = options.denoRunner ?? options.denoRuntime?.run.bind(options.denoRuntime);
    this.bashRunner   = options.bashRunner;
    this.networkFetch = options.networkFetch ?? fetch;
    this.gitCloneRunner = options.gitCloneRunner;
    this.gitToken     = options.gitToken;
    this.nativeCliBytes = options.nativeCliBytes;
    this.packages     = new PythonPackageManager({ fs: this.fs, indexUrl: options.pypiIndexUrl, fetcher: this.networkFetch });
    this.permissions  = { network: false, storage: true, files: false, modules: true, ...options.permissions };
    this.shell        = new WexelShell(this);
  }

  static async create(options: WexelOptions = {}): Promise<WexelRuntime> {
    const bytes   = options.coreBytes ?? await defaultCoreBytes();
    const runtime = new WexelRuntime(await instantiateCore(bytes), options);
    for (const ext of options.nativeExtensions ?? []) await runtime.loadNativeExtension(ext.manifest, ext.source);
    runtime.buzz.emit("runtime:ready", { mode: runtime.mode });
    return runtime;
  }

  // ── exec principal ─────────────────────────────────────────────────────────

  async exec(request: ExecRequest): Promise<ExecResult> {
    if (this.mode === "load-only") { this.buzz.emit("script:loaded", { language: request.language }); return { stdout: "", stderr: "", exitCode: 0 }; }
    if (request.language === "wasm") throw new Error("Use loadModule() para módulos WASM");

    if (request.language === "javascript" || request.language === "typescript") {
      const code = request.code ?? (request.file ? this.fs.readText(request.file) : "");
      // Prioridade: DenoRuntime unificado > denoRunner legado
      if (this._denoRuntime) {
        return this._denoRuntime.run(code, request.language, request.args ?? []);
      }
      if (this._denoRunner) {
        return await this._denoRunner(code, request.language, request.args ?? []);
      }
      throw new Error("Runtime Deno não foi registrado. Use DenoRuntime.create() nas opções.");
    }

    if (request.language === "python") {
      const code = request.code ?? (request.file ? this.fs.readText(request.file) : "");
      if (!this.pythonRunner) throw new Error("CPython/WebAssembly não foi registrado. Configure pythonRunner ao criar o runtime.");
      return await this.pythonRunner(code, request.args ?? []);
    }

    return { stdout: request.code ?? "", stderr: "", exitCode: 0 };
  }

  // ── deno shell ────────────────────────────────────────────────────────────

  async deno(args: string[]): Promise<ExecResult> {
    const [command, target, ...scriptArgs] = args;
    if (command === "--version" || command === "version") {
      return { stdout: "deno 2.0.0-wexel (release, wasm32)\nv8 12.0.0\ntypescript 5.0.0\n", stderr: "", exitCode: 0 };
    }
    if (command === "eval" && target !== undefined) return this.exec({ language: "javascript", code: target, args: scriptArgs });
    if (command === "run" && target) {
      const language = denoLanguage(target);
      if (!language) return { stdout: "", stderr: `deno: extensão não suportada: ${target}\n`, exitCode: 2 };
      return this.exec({ language, file: target, args: scriptArgs });
    }
    if (command === "add" || command === "install") return this.denoPackages(["deno", command, target ?? "", ...scriptArgs]);
    if (command === "fmt") return { stdout: "", stderr: "deno fmt: não suportado no Wexel\n", exitCode: 1 };
    return { stdout: "", stderr: "Uso: deno run <arquivo.js|.ts> | deno eval <código> | deno add <pkg> | deno --version\n", exitCode: 2 };
  }

  // ── node (via denoRunner se disponível) ───────────────────────────────────

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

  // ── gerenciador de pacotes Deno ───────────────────────────────────────────

  async denoPackages(argv: string[]): Promise<ExecResult> {
    if (!this._denoPkgMgr) {
      this._denoPkgMgr = new DenoPackageManager({
        fs:             this.fs,
        networkAllowed: this.permissions.network,
        runner: (code, language, args) => this.exec({ language, code, args }),
      });
    }
    return this._denoPkgMgr.exec(argv);
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

function denoLanguage(path: string): "javascript" | "typescript" | undefined {
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
export { compileNativeSource, type CompileOptions, type CompileResult } from "./native-compiler.js";
export { RustV, type RustVOptions } from "./rustv.js";
export { DenoWasmRuntime, DenoRuntime, DENO_WASM_ABI_VERSION } from "./deno-wasm.js";
export { createDenoNativeRunner, resolvedenoBin, type DenoNativeOptions } from "./deno-native-adapter.js";
export { WexelGit, type GitOptions } from "./git.js";
export { runCurl, type CurlOptions, type CurlResult } from "./curl.js";
export { DenoPackageManager, type DenoPackageManagerOptions } from "./deno-package-manager.js";
export { WebPink, WebPinkClient, type WebPinkMessage, type WebPinkOptions, type WebPinkSandboxPolicy } from "./web-pink.js";
export type { WexelCoreInstance } from "@wexel/core";
