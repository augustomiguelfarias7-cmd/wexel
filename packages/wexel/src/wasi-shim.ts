/**
 * wasi-shim.ts — Wexel
 * WASI preview1 for browser + VFS. On Node prefer node:wasi (node-wasi-python.ts).
 */

export type WasiFileSystem = {
  read(path: string): Uint8Array;
  readText(path: string): string;
  write(path: string, data: string | Uint8Array): void;
  exists(path: string): boolean;
  mkdir?(path: string): void;
};

export interface WasiShimOptions {
  args?: string[];
  env?: Record<string, string>;
  fs?: WasiFileSystem;
  captureStdio?: boolean;
}

const E = { SUCCESS: 0, BADF: 8, NOENT: 44, NOSYS: 52 } as const;

export class WasiExit extends Error {
  constructor(readonly code: number) {
    super(`WASI proc_exit(${code})`);
    this.name = "WasiExit";
  }
}

export class WexelWasiShim {
  readonly args: string[];
  readonly env: Record<string, string>;
  readonly fs?: WasiFileSystem;
  private stdout = "";
  private stderr = "";
  private exitCode = 0;
  private readonly fds = new Map<number, { kind: string; path?: string; pos: number; data?: Uint8Array }>();
  private nextFd = 3;
  private instance: WebAssembly.Instance | null = null;
  private readonly capture: boolean;

  constructor(options: WasiShimOptions = {}) {
    this.args = options.args ?? ["python"];
    this.env = options.env ?? { PYTHONHOME: "/", PYTHONPATH: "/Lib:/site-packages" };
    this.fs = options.fs;
    this.capture = options.captureStdio !== false;
    this.fds.set(0, { kind: "stdio", pos: 0 });
    this.fds.set(1, { kind: "stdio", pos: 0 });
    this.fds.set(2, { kind: "stdio", pos: 0 });
  }

  get stdoutText() {
    return this.stdout;
  }
  get stderrText() {
    return this.stderr;
  }
  get status() {
    return this.exitCode;
  }

  setInstance(instance: WebAssembly.Instance) {
    this.instance = instance;
  }

  getImportObject(): WebAssembly.Imports {
    return { wasi_snapshot_preview1: this.preview1() as unknown as WebAssembly.ModuleImports };
  }

  start(instance: WebAssembly.Instance): number {
    this.setInstance(instance);
    const start = (instance.exports as Record<string, unknown>)._start;
    if (typeof start !== "function") throw new Error("WASI: export _start ausente");
    try {
      (start as () => void)();
    } catch (e) {
      if (e instanceof WasiExit) {
        this.exitCode = e.code;
        return e.code;
      }
      throw e;
    }
    return this.exitCode;
  }

  private mem(): Uint8Array {
    const memory = this.instance?.exports.memory as WebAssembly.Memory | undefined;
    if (!memory) throw new Error("WASI: memory ausente");
    return new Uint8Array(memory.buffer);
  }

  private view(): DataView {
    const memory = this.instance?.exports.memory as WebAssembly.Memory | undefined;
    if (!memory) throw new Error("WASI: memory ausente");
    return new DataView(memory.buffer);
  }

  private preview1() {
    const self = this;
    const nosys = () => E.NOSYS;
    return {
      args_sizes_get(argcPtr: number, argvBufSizePtr: number) {
        const view = self.view();
        const enc = self.args.map((a) => new TextEncoder().encode(a + "\0"));
        view.setUint32(argcPtr, self.args.length, true);
        view.setUint32(argvBufSizePtr, enc.reduce((n, b) => n + b.length, 0), true);
        return E.SUCCESS;
      },
      args_get(argvPtr: number, argvBufPtr: number) {
        const mem = self.mem();
        const view = self.view();
        let buf = argvBufPtr;
        for (let i = 0; i < self.args.length; i++) {
          view.setUint32(argvPtr + i * 4, buf, true);
          const bytes = new TextEncoder().encode(self.args[i] + "\0");
          mem.set(bytes, buf);
          buf += bytes.length;
        }
        return E.SUCCESS;
      },
      environ_sizes_get(cPtr: number, bPtr: number) {
        const view = self.view();
        const entries = Object.entries(self.env).map(([k, v]) => new TextEncoder().encode(`${k}=${v}\0`));
        view.setUint32(cPtr, entries.length, true);
        view.setUint32(bPtr, entries.reduce((n, b) => n + b.length, 0), true);
        return E.SUCCESS;
      },
      environ_get(environPtr: number, environBufPtr: number) {
        const mem = self.mem();
        const view = self.view();
        let buf = environBufPtr;
        let i = 0;
        for (const [k, v] of Object.entries(self.env)) {
          view.setUint32(environPtr + i * 4, buf, true);
          const bytes = new TextEncoder().encode(`${k}=${v}\0`);
          mem.set(bytes, buf);
          buf += bytes.length;
          i++;
        }
        return E.SUCCESS;
      },
      clock_time_get(_id: number, _p: bigint, timePtr: number) {
        self.view().setBigUint64(timePtr, BigInt(Date.now()) * 1_000_000n, true);
        return E.SUCCESS;
      },
      clock_res_get(_id: number, resPtr: number) {
        self.view().setBigUint64(resPtr, 1_000_000n, true);
        return E.SUCCESS;
      },
      random_get(bufPtr: number, bufLen: number) {
        const slice = self.mem().subarray(bufPtr, bufPtr + bufLen);
        if (typeof crypto !== "undefined" && crypto.getRandomValues) crypto.getRandomValues(slice);
        else for (let i = 0; i < slice.length; i++) slice[i] = (Math.random() * 256) | 0;
        return E.SUCCESS;
      },
      fd_write(fd: number, iovsPtr: number, iovsLen: number, nwrittenPtr: number) {
        const view = self.view();
        const mem = self.mem();
        let written = 0;
        let out = "";
        for (let i = 0; i < iovsLen; i++) {
          const ptr = view.getUint32(iovsPtr + i * 8, true);
          const len = view.getUint32(iovsPtr + i * 8 + 4, true);
          out += new TextDecoder().decode(mem.subarray(ptr, ptr + len));
          written += len;
        }
        if (fd === 1) {
          if (self.capture) self.stdout += out;
          else console.log(out);
        } else if (fd === 2) {
          if (self.capture) self.stderr += out;
          else console.error(out);
        }
        view.setUint32(nwrittenPtr, written, true);
        return E.SUCCESS;
      },
      fd_read(fd: number, iovsPtr: number, iovsLen: number, nreadPtr: number) {
        const view = self.view();
        const mem = self.mem();
        const entry = self.fds.get(fd);
        if (!entry) return E.BADF;
        let data = entry.data ?? new Uint8Array();
        if (entry.path && self.fs?.exists(entry.path)) {
          data = self.fs.read(entry.path);
          entry.data = data;
        }
        let read = 0;
        for (let i = 0; i < iovsLen; i++) {
          const ptr = view.getUint32(iovsPtr + i * 8, true);
          const len = view.getUint32(iovsPtr + i * 8 + 4, true);
          const avail = Math.min(len, Math.max(0, data.length - entry.pos));
          if (avail <= 0) break;
          mem.set(data.subarray(entry.pos, entry.pos + avail), ptr);
          entry.pos += avail;
          read += avail;
        }
        view.setUint32(nreadPtr, read, true);
        return E.SUCCESS;
      },
      fd_close(fd: number) {
        if (fd > 2) self.fds.delete(fd);
        return E.SUCCESS;
      },
      fd_seek(fd: number, offset: bigint, whence: number, newOffsetPtr: number) {
        const entry = self.fds.get(fd);
        if (!entry) return E.BADF;
        const size = entry.data?.length ?? 0;
        let base = whence === 1 ? entry.pos : whence === 2 ? size : 0;
        entry.pos = Math.max(0, base + Number(offset));
        self.view().setBigUint64(newOffsetPtr, BigInt(entry.pos), true);
        return E.SUCCESS;
      },
      fd_fdstat_get(fd: number, statPtr: number) {
        if (!self.fds.has(fd)) return E.BADF;
        self.view().setUint8(statPtr, 2);
        return E.SUCCESS;
      },
      fd_prestat_get(fd: number, prestatPtr: number) {
        if (fd === 3 && self.fs) {
          self.view().setUint8(prestatPtr, 0);
          self.view().setUint32(prestatPtr + 4, 1, true);
          return E.SUCCESS;
        }
        return E.BADF;
      },
      fd_prestat_dir_name(fd: number, pathPtr: number, pathLen: number) {
        if (fd !== 3 || !self.fs) return E.BADF;
        self.mem().set(new TextEncoder().encode("/").subarray(0, pathLen), pathPtr);
        return E.SUCCESS;
      },
      path_open(
        _d: number,
        _f: number,
        pathPtr: number,
        pathLen: number,
        _o: number,
        _b: bigint,
        _i: bigint,
        _fd: number,
        fdPtr: number,
      ) {
        if (!self.fs) return E.NOSYS;
        const path = new TextDecoder().decode(self.mem().subarray(pathPtr, pathPtr + pathLen));
        const normalized = path.startsWith("/") ? path : `/${path}`;
        let data = new Uint8Array();
        if (self.fs.exists(normalized)) {
          try {
            data = self.fs.read(normalized);
          } catch {
            /* empty */
          }
        }
        const fd = self.nextFd++;
        self.fds.set(fd, { kind: "file", path: normalized, pos: 0, data });
        self.view().setUint32(fdPtr, fd, true);
        return E.SUCCESS;
      },
      path_filestat_get(_fd: number, _flags: number, pathPtr: number, pathLen: number) {
        if (!self.fs) return E.NOSYS;
        const path = new TextDecoder().decode(self.mem().subarray(pathPtr, pathPtr + pathLen));
        const n = path.startsWith("/") ? path : `/${path}`;
        return self.fs.exists(n) ? E.SUCCESS : E.NOENT;
      },
      path_create_directory(_fd: number, pathPtr: number, pathLen: number) {
        if (!self.fs?.mkdir) return E.NOSYS;
        const path = new TextDecoder().decode(self.mem().subarray(pathPtr, pathPtr + pathLen));
        self.fs.mkdir(path.startsWith("/") ? path : `/${path}`);
        return E.SUCCESS;
      },
      proc_exit(code: number) {
        self.exitCode = code;
        throw new WasiExit(code);
      },
      sched_yield: () => E.SUCCESS,
      poll_oneoff: nosys,
      fd_advise: () => E.SUCCESS,
      fd_allocate: nosys,
      fd_datasync: () => E.SUCCESS,
      fd_sync: () => E.SUCCESS,
      fd_fdstat_set_flags: () => E.SUCCESS,
      fd_filestat_get: nosys,
      fd_filestat_set_size: nosys,
      fd_filestat_set_times: () => E.SUCCESS,
      fd_pread: nosys,
      fd_pwrite: nosys,
      fd_readdir: nosys,
      fd_renumber: nosys,
      fd_tell(fd: number, offsetPtr: number) {
        const entry = self.fds.get(fd);
        if (!entry) return E.BADF;
        self.view().setBigUint64(offsetPtr, BigInt(entry.pos), true);
        return E.SUCCESS;
      },
      path_filestat_set_times: () => E.SUCCESS,
      path_link: nosys,
      path_readlink: nosys,
      path_remove_directory: nosys,
      path_rename: nosys,
      path_symlink: nosys,
      path_unlink_file: nosys,
      sock_accept: nosys,
      sock_recv: nosys,
      sock_send: nosys,
      sock_shutdown: nosys,
    };
  }
}

export function createWasiImports(options: WasiShimOptions = {}) {
  const shim = new WexelWasiShim(options);
  return { shim, imports: shim.getImportObject() };
}
