/**
 * persistent-fs.ts — Wexel
 *
 * Camada de persistência para o WexelFileSystem.
 * Salva e carrega o VFS do disco real (Node.js) ou IndexedDB (browser).
 *
 * Funcionalidades:
 *   - 5 GB de quota (configurável)
 *   - Salvamento incremental (só grava arquivos modificados)
 *   - Carregamento lazy (só lê do disco quando necessário)
 *   - Snapshot completo para backup
 *   - Auto-save configurável
 *
 * Uso (Node.js):
 *   const fs = await WexelPersistentFS.open("/var/wexel/sandboxes/user-1");
 *   const runtime = await Wexel.create({ coreBytes, fs });
 *
 * Uso (browser com IndexedDB):
 *   const fs = await WexelPersistentFS.openIDB("sandbox-user-1");
 *   const runtime = await Wexel.create({ coreBytes, fs });
 */

import { mkdir, readdir, readFile, writeFile, rm, stat } from "node:fs/promises";
import { join, dirname, relative } from "node:path";
import { WexelFileSystem } from "./index.js";

export interface PersistentFSOptions {
  /** Quota em bytes. Padrão: 5 GB. */
  quotaBytes?:   number;
  /** Diretório home virtual. Padrão: /home/wexel. */
  homeDirectory?: string;
  /** Auto-save a cada N ms. 0 = desabilitado. Padrão: 5000. */
  autoSaveMs?:   number;
}

/**
 * VFS do Wexel com persistência em disco (Node.js).
 *
 * Estende o WexelFileSystem adicionando load/save/autosave.
 * O disco é a fonte de verdade — o Map em memória é o cache.
 */
export class WexelPersistentFS extends WexelFileSystem {
  private readonly storePath:  string;
  private readonly dirty:      Set<string> = new Set();
  private autoSaveTimer?:      ReturnType<typeof setInterval>;
  private saving = false;

  private constructor(
    storePath:  string,
    quotaBytes: number,
    home:       string,
  ) {
    super(quotaBytes, home);
    this.storePath = storePath;
  }

  /**
   * Abre (ou cria) um VFS persistente em `storePath`.
   * Carrega todos os arquivos existentes para a memória.
   */
  static async open(
    storePath: string,
    options:   PersistentFSOptions = {},
  ): Promise<WexelPersistentFS> {
    const quota = options.quotaBytes   ?? 5 * 1024 * 1024 * 1024;
    const home  = options.homeDirectory ?? "/home/wexel";
    const autoSaveMs = options.autoSaveMs ?? 5_000;

    await mkdir(storePath, { recursive: true });

    const fs = new WexelPersistentFS(storePath, quota, home);
    await fs.loadFromDisk();

    if (autoSaveMs > 0) {
      fs.autoSaveTimer = setInterval(() => void fs.flush(), autoSaveMs);
    }

    return fs;
  }

  // ── Overrides com dirty tracking ──────────────────────────────────────────

  override write(path: string, data: string | Uint8Array): void {
    super.write(path, data);
    this.dirty.add(this.resolvePath(path));
  }

  override mkdir(path: string): void {
    super.mkdir(path);
    if (path) this.dirty.add(`${this.resolvePath(path)}/.dir`);
  }

  override remove(path: string): void {
    const resolved = this.resolvePath(path);
    super.remove(path);
    this.dirty.delete(resolved);
    // Marca para remoção no disco (usa prefixo especial)
    this.dirty.add(`\x00DEL\x00${resolved}`);
  }

  // ── Persistência ──────────────────────────────────────────────────────────

  /**
   * Grava no disco apenas os arquivos modificados desde o último flush.
   */
  async flush(): Promise<void> {
    if (this.saving || this.dirty.size === 0) return;
    this.saving = true;

    const toProcess = new Set(this.dirty);
    this.dirty.clear();

    try {
      for (const vfsPath of toProcess) {
        // Remoção
        if (vfsPath.startsWith("\x00DEL\x00")) {
          const real = this.vfsToReal(vfsPath.slice(5));
          await rm(real, { recursive: true, force: true }).catch(() => {});
          continue;
        }

        const real = this.vfsToReal(vfsPath);

        // Diretório
        if (vfsPath.endsWith("/.dir")) {
          await mkdir(dirname(real), { recursive: true }).catch(() => {});
          await mkdir(real, { recursive: true }).catch(() => {});
          continue;
        }

        // Arquivo
        if (this.exists(vfsPath)) {
          await mkdir(dirname(real), { recursive: true });
          await writeFile(real, this.read(vfsPath));
        }
      }
    } finally {
      this.saving = false;
    }
  }

  /**
   * Carrega todos os arquivos do disco para a memória.
   * Chamado uma vez na inicialização.
   */
  async loadFromDisk(): Promise<void> {
    const files = await this.walkDisk(this.storePath);
    for (const { realPath, data } of files) {
      const vfsPath = this.realToVfs(realPath);
      if (vfsPath) {
        if (realPath.endsWith("/.dir")) {
          super.mkdir(vfsPath.replace("/.dir", "") || "/");
        } else {
          super.write(vfsPath, data);
        }
      }
    }
    // Limpa dirty após carregar — nada para gravar ainda
    this.dirty.clear();
  }

  /**
   * Força gravação de tudo e fecha o auto-save.
   */
  async close(): Promise<void> {
    if (this.autoSaveTimer) {
      clearInterval(this.autoSaveTimer);
      this.autoSaveTimer = undefined;
    }
    // Marca todos os arquivos como dirty para garantir gravação completa
    for (const { path } of this.snapshot()) {
      this.dirty.add(path);
    }
    await this.flush();
  }

  /**
   * Snapshot completo do VFS para um diretório de backup.
   */
  async backup(backupPath: string): Promise<void> {
    await mkdir(backupPath, { recursive: true });
    for (const { path, data } of this.snapshot()) {
      const dest = join(backupPath, path);
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, data);
    }
  }

  /** Informações de uso do disco. */
  async diskUsage(): Promise<{ vfsBytes: number; diskBytes: number; quota: number }> {
    const { usedBytes } = this.quota;
    let diskBytes = 0;
    try {
      const files = await this.walkDisk(this.storePath);
      diskBytes = files.reduce((s, f) => s + f.data.byteLength, 0);
    } catch { /**/ }
    return { vfsBytes: usedBytes, diskBytes, quota: this.quota.limitBytes };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private vfsToReal(vfsPath: string): string {
    // /home/wexel/src/app.ts → storePath/home/wexel/src/app.ts
    const rel = vfsPath.startsWith("/") ? vfsPath.slice(1) : vfsPath;
    return join(this.storePath, rel);
  }

  private realToVfs(realPath: string): string {
    const rel = relative(this.storePath, realPath);
    return "/" + rel.replace(/\\/g, "/");
  }

  private resolvePath(path: string): string {
    // Acessa o método privado resolve() via cast
    return (this as unknown as { resolve(p: string): string }).resolve(path);
  }

  private async walkDisk(dir: string): Promise<Array<{ realPath: string; data: Uint8Array }>> {
    const results: Array<{ realPath: string; data: Uint8Array }> = [];
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return results;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      const info = await stat(full).catch(() => null);
      if (!info) continue;
      if (info.isDirectory()) {
        // Marca o diretório
        results.push({ realPath: join(full, ".dir"), data: new Uint8Array() });
        results.push(...await this.walkDisk(full));
      } else if (info.isFile()) {
        const data = await readFile(full);
        results.push({ realPath: full, data: new Uint8Array(data) });
      }
    }
    return results;
  }
}

// ── IndexedDB (browser) ────────────────────────────────────────────────────

const IDB_DB    = "wexel-fs";
const IDB_STORE = "files";
const IDB_VER   = 1;

/**
 * VFS persistente usando IndexedDB (browser).
 * Mesmo comportamento do WexelPersistentFS mas sem acesso ao disco.
 */
export class WexelIDBFS extends WexelFileSystem {
  private readonly dbName: string;
  private db?: IDBDatabase;
  private readonly dirty: Set<string> = new Set();
  private autoSaveTimer?: ReturnType<typeof setInterval>;

  private constructor(dbName: string, quotaBytes: number, home: string) {
    super(quotaBytes, home);
    this.dbName = dbName;
  }

  static async openIDB(
    dbName:  string,
    options: PersistentFSOptions = {},
  ): Promise<WexelIDBFS> {
    const quota      = options.quotaBytes    ?? 5 * 1024 * 1024 * 1024;
    const home       = options.homeDirectory ?? "/home/wexel";
    const autoSaveMs = options.autoSaveMs    ?? 5_000;

    const fs = new WexelIDBFS(dbName, quota, home);
    await fs.openDB();
    await fs.loadFromIDB();

    if (autoSaveMs > 0) {
      fs.autoSaveTimer = setInterval(() => void fs.flush(), autoSaveMs);
    }

    return fs;
  }

  private openDB(): Promise<void> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.dbName, IDB_VER);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(IDB_STORE);
      };
      req.onsuccess = () => { this.db = req.result; resolve(); };
      req.onerror   = () => reject(req.error);
    });
  }

  override write(path: string, data: string | Uint8Array): void {
    super.write(path, data);
    this.dirty.add(path);
  }

  override mkdir(path: string): void {
    super.mkdir(path);
    if (path) this.dirty.add(path + "/.dir");
  }

  override remove(path: string): void {
    this.dirty.add("\x00DEL\x00" + path);
    this.dirty.delete(path);
    super.remove(path);
  }

  async flush(): Promise<void> {
    if (!this.db || this.dirty.size === 0) return;
    const tx    = this.db.transaction(IDB_STORE, "readwrite");
    const store = tx.objectStore(IDB_STORE);
    for (const path of this.dirty) {
      if (path.startsWith("\x00DEL\x00")) {
        store.delete(path.slice(5));
      } else if (this.exists(path)) {
        store.put(this.read(path), path);
      }
    }
    this.dirty.clear();
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror    = () => reject(tx.error);
    });
  }

  private async loadFromIDB(): Promise<void> {
    if (!this.db) return;
    const tx    = this.db.transaction(IDB_STORE, "readonly");
    const store = tx.objectStore(IDB_STORE);
    const keys  = await new Promise<IDBValidKey[]>((res, rej) => {
      const req = store.getAllKeys();
      req.onsuccess = () => res(req.result);
      req.onerror   = () => rej(req.error);
    });
    for (const key of keys) {
      const path = String(key);
      const data = await new Promise<Uint8Array>((res, rej) => {
        const req = store.get(key);
        req.onsuccess = () => res(new Uint8Array(req.result as ArrayBuffer));
        req.onerror   = () => rej(req.error);
      });
      if (path.endsWith("/.dir")) {
        super.mkdir(path.replace("/.dir", ""));
      } else {
        super.write(path, data);
      }
    }
    this.dirty.clear();
  }

  async close(): Promise<void> {
    if (this.autoSaveTimer) {
      clearInterval(this.autoSaveTimer);
      this.autoSaveTimer = undefined;
    }
    for (const { path } of this.snapshot()) this.dirty.add(path);
    await this.flush();
    this.db?.close();
  }
}
