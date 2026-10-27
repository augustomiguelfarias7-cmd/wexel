import type { WexelCoreInstance } from "./index.js";

export interface WexelQuota {
  usedBytes: number;
  limitBytes: number;
}

export interface WexelFileSystemLike {
  readonly home: string;
  pwd(): string;
  cd(path: string): void;
  mkdir(path: string): void;
  touch(path: string): void;
  remove(path: string): void;
  readText(path: string): string;
  write(path: string, data: string | Uint8Array): void;
  read(path: string): Uint8Array;
  list(path?: string): string[];
  readonly quota: WexelQuota;
  exists(path: string): boolean;
  snapshot(): Array<{ path: string; data: Uint8Array }>;
}

/** In-memory implementation retained for explicit test and legacy use. */
export class WexelFileSystem implements WexelFileSystemLike {
  private files = new Map<string, Uint8Array>();
  private cwd: string;
  private used = 0;
  readonly home: string;
  constructor(private readonly quotaBytes = 5 * 1024 * 1024 * 1024, homeDirectory = "/home/wexel") {
    this.home = normalizeHome(homeDirectory);
    this.cwd = this.home;
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
  list(path?: string): string[] {
    const base = path === undefined ? this.cwd : this.resolve(path);
    const prefix = base === "/" ? "/" : `${base}/`;
    return [...this.files.keys()].filter((x) => x.startsWith(prefix)).map((x) => x.slice(prefix.length)).filter((x) => x && x !== ".dir");
  }
  get quota(): WexelQuota { return { usedBytes: this.used, limitBytes: this.quotaBytes }; }
  exists(path: string): boolean { return this.files.has(this.resolve(path)) || this.files.has(`${this.resolve(path)}/.dir`); }
  snapshot(): Array<{ path: string; data: Uint8Array }> {
    return [...this.files.entries()].filter(([path]) => !path.endsWith("/.dir")).map(([path, data]) => ({ path, data: data.slice() }));
  }
  protected resolve(path: string): string {
    const expanded = path === "~" || path.startsWith("~/") ? `${this.home}${path.slice(1)}` : path;
    const raw = expanded.startsWith("/") ? expanded : `${this.cwd}/${expanded}`;
    const parts: string[] = [];
    for (const part of raw.split("/")) { if (!part || part === ".") continue; if (part === "..") parts.pop(); else parts.push(part); }
    return `/${parts.join("/")}`.replace(/\/$/, "") || "/";
  }
}

/**
 * TypeScript VFS metadata backed by the Core's Memory64 allocator.
 *
 * Paths and directory records remain ordinary TypeScript metadata; file payload
 * bytes are allocated in WebAssembly linear memory and copied out on reads.
 * The logical quota is only a limit, not a pre-allocation of that capacity.
 */
export class WexelMemory64FileSystem implements WexelFileSystemLike {
  private cwd: string;
  private readonly directories = new Set<string>(["/"]);
  private readonly files = new Map<string, { pointer: bigint; size: number }>();
  private usedBytes = 0;
  readonly home: string;
  private readonly quotaBytes: number;

  constructor(
    private readonly core: WexelCoreInstance,
    quotaBytes = Math.min(5 * 1024 * 1024 * 1024, Number(core.exports.wexel_memory64_limit_bytes())),
    homeDirectory = "/home/wexel",
  ) {
    this.home = normalizeHome(homeDirectory);
    this.cwd = this.home;
    if (!Number.isSafeInteger(quotaBytes) || quotaBytes <= 0 ||
        quotaBytes > Number(core.exports.wexel_memory64_limit_bytes())) {
      throw new Error("A quota do VFS deve ficar entre 1 byte e o limite do Core Memory64.");
    }
    this.quotaBytes = quotaBytes;
    for (const directory of ["/bin", "/home", this.home, "/tmp", "/usr", "/var", "/site-packages"]) this.mkdir(directory);
  }

  pwd(): string { return this.cwd; }

  cd(path: string): void {
    const next = this.resolve(path);
    if (!this.directories.has(next)) throw new Error(`Diretório inexistente: ${path}`);
    this.cwd = next;
  }

  mkdir(path: string): void {
    if (!path) return;
    const target = this.resolve(path);
    if (target === "/") return;
    const parts = target.split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current += `/${part}`;
      if (this.directories.has(current)) continue;
      if (this.files.has(current)) throw new Error(`Não é um diretório: ${current}`);
      const parent = current.slice(0, current.lastIndexOf("/")) || "/";
      if (!this.directories.has(parent)) throw new Error(`Diretório pai inexistente: ${parent}`);
      this.directories.add(current);
    }
  }

  touch(path: string): void {
    if (!this.exists(path)) this.write(path, new Uint8Array());
  }

  remove(path: string): void {
    const target = this.resolve(path);
    if (target === "/") throw new Error("A raiz do VFS não pode ser removida.");
    if (!this.exists(target)) throw new Error(`Arquivo ou diretório inexistente: ${path}`);
    for (const [filePath, file] of [...this.files]) {
      if (filePath === target || filePath.startsWith(`${target}/`)) {
        // Empty files use the null pointer and own no Core allocation.
        if (file.pointer !== 0n) this.core.exports.wexel_memory64_free(file.pointer);
        this.files.delete(filePath);
        this.usedBytes -= file.size;
      }
    }
    for (const directory of [...this.directories]) {
      if (directory === target || directory.startsWith(`${target}/`)) this.directories.delete(directory);
    }
  }

  readText(path: string): string { return new TextDecoder().decode(this.read(path)); }

  write(path: string, data: string | Uint8Array): void {
    const target = this.resolve(path);
    if (target === "/") throw new Error("Não é possível gravar um arquivo sobre a raiz.");
    const parent = target.slice(0, target.lastIndexOf("/")) || "/";
    this.mkdir(parent);
    if (this.directories.has(target)) throw new Error(`O caminho é um diretório: ${target}`);
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    const previous = this.files.get(target);
    const nextUsed = this.usedBytes - (previous?.size ?? 0) + bytes.byteLength;
    if (nextUsed > this.quotaBytes) throw new Error(`Quota lógica do filesystem excedida (${this.quotaBytes} bytes)`);

    // Allocate/copy before freeing the previous version so failed allocations
    // leave the old file intact.
    let pointer = 0n;
    if (bytes.byteLength > 0) {
      pointer = this.core.exports.wexel_memory64_alloc(BigInt(bytes.byteLength));
      if (!pointer) throw new Error("Memória linear do Core Memory64 insuficiente para gravar o arquivo.");
      try {
        new Uint8Array(this.core.exports.memory.buffer, this.toNumber(pointer), bytes.byteLength).set(bytes);
      } catch (error) {
        this.core.exports.wexel_memory64_free(pointer);
        throw error;
      }
    }
    // A zero-length file has no allocated payload, so its pointer must not be freed.
    if (previous && previous.pointer !== 0n) this.core.exports.wexel_memory64_free(previous.pointer);
    this.files.set(target, { pointer, size: bytes.byteLength });
    this.usedBytes = nextUsed;
  }

  read(path: string): Uint8Array {
    const target = this.resolve(path);
    const file = this.files.get(target);
    if (!file) throw new Error(`Arquivo inexistente: ${path}`);
    if (file.size === 0) return new Uint8Array();
    return new Uint8Array(
      this.core.exports.memory.buffer,
      this.toNumber(file.pointer),
      file.size,
    ).slice();
  }

  list(path?: string): string[] {
    const base = path === undefined ? this.cwd : this.resolve(path);
    if (!this.directories.has(base)) throw new Error(`Diretório inexistente: ${path ?? base}`);
    const prefix = base === "/" ? "/" : `${base}/`;
    const descendants = [
      ...[...this.directories].filter((item) => item !== base && item.startsWith(prefix)),
      ...[...this.files.keys()].filter((item) => item.startsWith(prefix)),
    ];
    return descendants.map((item) => item.slice(prefix.length)).filter(Boolean).sort();
  }

  get quota(): WexelQuota { return { usedBytes: this.usedBytes, limitBytes: this.quotaBytes }; }

  exists(path: string): boolean {
    const target = this.resolve(path);
    return this.directories.has(target) || this.files.has(target);
  }

  snapshot(): Array<{ path: string; data: Uint8Array }> {
    return [...this.files.keys()].sort().map((path) => ({ path, data: this.read(path) }));
  }

  private toNumber(value: bigint): number {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("Ponteiro ou tamanho fora da faixa segura do host JavaScript.");
    }
    return Number(value);
  }

  private resolve(path: string): string {
    const expanded = path === "~" || path.startsWith("~/") ? `${this.home}${path.slice(1)}` : path;
    const raw = expanded.startsWith("/") ? expanded : `${this.cwd}/${expanded}`;
    const parts: string[] = [];
    for (const part of raw.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") parts.pop();
      else parts.push(part);
    }
    return `/${parts.join("/")}`.replace(/\/$/, "") || "/";
  }
}

export function normalizeHome(path: string): string {
  if (!path.startsWith("/")) throw new Error("O diretório home deve ser um caminho absoluto.");
  const normalized = path.replace(/\/+$/, "") || "/";
  if (normalized === "/" || normalized.includes("/../") || normalized.endsWith("/..")) throw new Error("Diretório home inválido.");
  return normalized;
}
