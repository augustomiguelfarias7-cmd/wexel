import type { WexelCoreInstance } from "@wexel/core";

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
 * Filesystem whose file bytes, names, and directory records are owned by the
 * Memory64 core. Temporary host-to-WASM buffers are released after each call.
 */
export class WexelMemory64FileSystem implements WexelFileSystemLike {
  private cwd: string;
  readonly home: string;
  constructor(
    private readonly core: WexelCoreInstance,
    quotaBytes = Number(core.exports.wexel_memory64_limit_bytes()),
    homeDirectory = "/home/wexel",
  ) {
    this.home = normalizeHome(homeDirectory);
    this.cwd = this.home;
    if (!Number.isSafeInteger(quotaBytes) || quotaBytes <= 0 || quotaBytes > 16 * 1024 * 1024 * 1024) {
      throw new Error("A quota do VFS deve ficar entre 1 byte e 16 GiB.");
    }
    if (core.exports.wexel_vfs_init(BigInt(quotaBytes)) !== 1) throw new Error("O core Memory64 não conseguiu inicializar a quota do VFS.");
    for (const directory of ["/bin", "/home", this.home, "/tmp", "/usr", "/var", "/site-packages"]) this.mkdir(directory);
  }
  pwd(): string { return this.cwd; }
  cd(path: string): void {
    const next = this.resolve(path);
    if (!this.isDirectory(next)) throw new Error(`Diretório inexistente: ${path}`);
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
      if (this.isDirectory(current)) continue;
      if (this.exists(current)) throw new Error(`Não é um diretório: ${current}`);
      const parent = current.slice(0, current.lastIndexOf("/")) || "/";
      if (!this.isDirectory(parent)) throw new Error(`Diretório pai inexistente: ${parent}`);
      const ptr = this.allocText(current);
      let owned = false;
      try {
        owned = this.core.exports.wexel_vfs_mkdir(ptr, this.utf8Length(current)) === 1;
        if (!owned) throw new Error(`Falha ao criar diretório: ${current}`);
      } finally {
        if (!owned) this.free(ptr);
      }
    }
  }
  touch(path: string): void { if (!this.exists(path)) this.write(path, new Uint8Array()); }
  remove(path: string): void {
    const target = this.resolve(path);
    if (target === "/") throw new Error("A raiz do VFS não pode ser removida.");
    const ptr = this.allocText(target);
    try {
      if (this.core.exports.wexel_vfs_remove_tree(ptr, this.utf8Length(target)) !== 1) throw new Error(`Arquivo ou diretório inexistente: ${path}`);
    } finally {
      this.free(ptr);
    }
  }
  readText(path: string): string { return new TextDecoder().decode(this.read(path)); }
  write(path: string, data: string | Uint8Array): void {
    const target = this.resolve(path);
    const parent = target.slice(0, target.lastIndexOf("/")) || "/";
    this.mkdir(parent);
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    const pathPtr = this.allocText(target);
    let dataPtr = 0n;
    let owned = false;
    try {
      dataPtr = bytes.byteLength ? this.alloc(bytes) : 0n;
      owned = this.core.exports.wexel_vfs_write(pathPtr, this.utf8Length(target), dataPtr, BigInt(bytes.byteLength)) === 1;
      if (!owned) {
        const used = this.quota.usedBytes;
        if (used + bytes.byteLength > this.quota.limitBytes) throw new Error(`Quota do filesystem excedida (${this.quota.limitBytes} bytes)`);
        throw new Error(`Falha ao gravar arquivo na VFS: ${target}`);
      }
    } finally {
      if (!owned) {
        this.free(pathPtr);
        if (dataPtr) this.free(dataPtr);
      }
    }
  }
  read(path: string): Uint8Array {
    const target = this.resolve(path);
    const pathPtr = this.allocText(target);
    let dataPtr = 0n;
    try {
      const size = this.core.exports.wexel_vfs_file_size(pathPtr, this.utf8Length(target));
      if (size < 0n) throw new Error(`Arquivo inexistente: ${path}`);
      if (size === 0n) return new Uint8Array();
      dataPtr = this.core.exports.wexel_memory64_alloc(size);
      if (!dataPtr) throw new Error("O core Memory64 não conseguiu alocar buffer de leitura.");
      const count = this.core.exports.wexel_vfs_read(pathPtr, this.utf8Length(target), dataPtr, size);
      if (count !== size) throw new Error(`Leitura incompleta da VFS: ${target}`);
      return new Uint8Array(this.core.exports.memory.buffer, this.toNumber(dataPtr), this.toNumber(size)).slice();
    } finally {
      this.free(pathPtr);
      if (dataPtr) this.free(dataPtr);
    }
  }
  list(path?: string): string[] {
    const base = path === undefined ? this.cwd : this.resolve(path);
    if (!this.isDirectory(base)) throw new Error(`Diretório inexistente: ${path ?? base}`);
    const result: string[] = [];
    const visit = (directory: string, prefix: string): void => {
      for (const name of this.listImmediate(directory)) {
        const child = directory === "/" ? `/${name}` : `${directory}/${name}`;
        const relative = prefix ? `${prefix}/${name}` : name;
        result.push(relative);
        if (this.isDirectory(child)) visit(child, relative);
      }
    };
    visit(base, "");
    return result;
  }
  get quota(): WexelQuota {
    return {
      usedBytes: this.toNumber(this.core.exports.wexel_vfs_bytes_used()),
      limitBytes: this.toNumber(this.core.exports.wexel_vfs_quota_bytes()),
    };
  }
  exists(path: string): boolean {
    const target = this.resolve(path);
    const ptr = this.allocText(target);
    try { return this.core.exports.wexel_vfs_path_exists(ptr, this.utf8Length(target)) === 1; }
    finally { this.free(ptr); }
  }
  snapshot(): Array<{ path: string; data: Uint8Array }> {
    const output: Array<{ path: string; data: Uint8Array }> = [];
    const walk = (directory: string): void => {
      for (const relative of this.listImmediate(directory)) {
        const child = directory === "/" ? `/${relative}` : `${directory}/${relative}`;
        if (this.isDirectory(child)) walk(child);
        else output.push({ path: child, data: this.read(child) });
      }
    };
    walk("/");
    return output;
  }
  private listImmediate(path: string): string[] {
    const ptr = this.allocText(path);
    let out = 0n;
    try {
      const needed = this.core.exports.wexel_vfs_list_size(ptr, this.utf8Length(path));
      if (needed < 0n) throw new Error(`Falha ao listar diretório: ${path}`);
      if (needed === 0n) return [];
      out = this.core.exports.wexel_memory64_alloc(needed);
      if (!out) throw new Error("O core Memory64 não conseguiu alocar buffer de listagem.");
      const count = this.core.exports.wexel_vfs_list(ptr, this.utf8Length(path), out, needed);
      if (count !== needed) throw new Error(`Listagem incompleta da VFS: ${path}`);
      return new TextDecoder().decode(new Uint8Array(this.core.exports.memory.buffer, this.toNumber(out), this.toNumber(count))).split("\0").filter(Boolean);
    } finally {
      this.free(ptr);
      if (out) this.free(out);
    }
  }
  private isDirectory(path: string): boolean {
    const target = this.resolve(path);
    const ptr = this.allocText(target);
    try { return this.core.exports.wexel_vfs_is_directory(ptr, this.utf8Length(target)) === 1; }
    finally { this.free(ptr); }
  }
  private allocText(value: string): bigint { return this.alloc(new TextEncoder().encode(value)); }
  private alloc(bytes: Uint8Array): bigint {
    if (bytes.byteLength === 0) return 0n;
    const ptr = this.core.exports.wexel_memory64_alloc(BigInt(bytes.byteLength));
    if (!ptr) throw new Error("Limite de memória linear do core Memory64 excedido.");
    new Uint8Array(this.core.exports.memory.buffer, this.toNumber(ptr), bytes.byteLength).set(bytes);
    return ptr;
  }
  private free(ptr: bigint): void { if (ptr) this.core.exports.wexel_memory64_free(ptr); }
  private utf8Length(value: string): number { return new TextEncoder().encode(value).byteLength; }
  private toNumber(value: bigint): number {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Ponteiro ou tamanho fora da faixa segura do host JavaScript.");
    return Number(value);
  }
  private resolve(path: string): string {
    const expanded = path === "~" || path.startsWith("~/") ? `${this.home}${path.slice(1)}` : path;
    const raw = expanded.startsWith("/") ? expanded : `${this.cwd}/${expanded}`;
    const parts: string[] = [];
    for (const part of raw.split("/")) { if (!part || part === ".") continue; if (part === "..") parts.pop(); else parts.push(part); }
    return `/${parts.join("/")}`.replace(/\/$/, "") || "/";
  }
}

export function normalizeHome(path: string): string {
  if (!path.startsWith("/")) throw new Error("O diretório home deve ser um caminho absoluto.");
  const normalized = path.replace(/\/+$/, "");
  if (normalized === "/" || normalized.includes("/../") || normalized.endsWith("/..")) throw new Error("Diretório home inválido.");
  return normalized;
}
