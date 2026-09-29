import type { WexelFileSystem } from "./index.js";
import type { NetworkFetcher } from "./deno-net-bridge.js";

export interface DenoLinuxHostOptions {
  fs: WexelFileSystem;
  networkAllowed: boolean;
  fetcher: NetworkFetcher;
  output: { stdout: string[]; stderr: string[]; exitCode: number };
}

type Fd = { path: string; offset: number; writable: boolean };

export function createDenoLinuxHost(options: DenoLinuxHostOptions) {
  let memory: WebAssembly.Memory | undefined;
  let nextFd = 3;
  const fds = new Map<number, Fd>();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const readCString = (ptr: number): string => {
    if (!memory) throw new Error("Deno Linux host: memory ainda não foi ligada.");
    const bytes = new Uint8Array(memory.buffer);
    let end = ptr >>> 0;
    while (end < bytes.length && bytes[end] !== 0) end++;
    return decoder.decode(bytes.subarray(ptr >>> 0, end));
  };

  const readBytes = (ptr: number, len: number): Uint8Array => {
    if (!memory) throw new Error("Deno Linux host: memory ainda não foi ligada.");
    return new Uint8Array(memory.buffer, ptr >>> 0, len >>> 0);
  };

  const writeBytes = (ptr: number, data: Uint8Array): number => {
    if (!memory) throw new Error("Deno Linux host: memory ainda não foi ligada.");
    new Uint8Array(memory.buffer, ptr >>> 0, data.byteLength).set(data);
    return data.byteLength;
  };

  const writeCString = (ptr: number, maxLen: number, value: string): number => {
    const bytes = encoder.encode(value);
    const capacity = Math.max(0, (maxLen >>> 0) - 1);
    const written = bytes.subarray(0, capacity);
    writeBytes(ptr, written);
    if (memory && (ptr >>> 0) + written.byteLength < memory.buffer.byteLength) {
      new Uint8Array(memory.buffer)[(ptr >>> 0) + written.byteLength] = 0;
    }
    return written.byteLength;
  };

  const errno = (error: unknown): number => {
    const message = error instanceof Error ? error.message : String(error);
    if (/exist/i.test(message)) return 2;
    if (/permission|denied/i.test(message)) return 13;
    if (/directory/i.test(message)) return 20;
    return 5;
  };

  const resolveFd = (fd: number): Fd => {
    const entry = fds.get(fd);
    if (!entry) throw new Error("bad file descriptor");
    return entry;
  };

  return {
    bindMemory(value: WebAssembly.Memory) { memory = value; },

    imports: {
      __wexel_linux: {
        fs_open: (pathPtr: number, flags: number, _mode: number) => {
          try {
            const path = readCString(pathPtr);
            const writable = (flags & 1) !== 0 || (flags & 2) !== 0;
            if (!options.fs.exists(path)) {
              if ((flags & 0x40) === 0) return -2;
              options.fs.write(path, new Uint8Array());
            }
            const fd = nextFd++;
            fds.set(fd, { path, offset: 0, writable });
            return fd;
          } catch (error) {
            return -errno(error);
          }
        },

        fs_close: (fd: number) => fds.delete(fd) ? 0 : -9,

        fs_read: (fd: number, dstPtr: number, len: number) => {
          try {
            const file = resolveFd(fd);
            const data = options.fs.read(file.path);
            const chunk = data.subarray(file.offset, file.offset + (len >>> 0));
            writeBytes(dstPtr, chunk);
            file.offset += chunk.byteLength;
            return chunk.byteLength;
          } catch (error) {
            return -errno(error);
          }
        },

        fs_write: (fd: number, srcPtr: number, len: number) => {
          try {
            const file = resolveFd(fd);
            if (!file.writable) return -13;
            const old = options.fs.read(file.path);
            const incoming = readBytes(srcPtr, len);
            const next = new Uint8Array(Math.max(old.byteLength, file.offset + incoming.byteLength));
            next.set(old);
            next.set(incoming, file.offset);
            options.fs.write(file.path, next);
            file.offset += incoming.byteLength;
            return incoming.byteLength;
          } catch (error) {
            return -errno(error);
          }
        },

        fs_seek: (fd: number, offset: number, whence: number) => {
          try {
            const file = resolveFd(fd);
            const size = options.fs.read(file.path).byteLength;
            const base = whence === 0 ? 0 : whence === 1 ? file.offset : size;
            const next = base + Number(offset);
            if (next < 0) return -22;
            file.offset = next;
            return next;
          } catch (error) {
            return -errno(error);
          }
        },

        fs_stat: (pathPtr: number, outPtr: number) => {
          try {
            const path = readCString(pathPtr);
            if (!options.fs.exists(path)) return -2;
            if (!memory) return -5;
            const view = new DataView(memory.buffer);
            const isDir = options.fs.list(path).length >= 0;
            const size = isDir ? 0 : options.fs.read(path).byteLength;
            view.setUint32(outPtr, isDir ? 2 : 1, true);
            view.setUint32(outPtr + 4, isDir ? 0o755 : 0o644, true);
            view.setBigUint64(outPtr + 8, BigInt(size), true);
            view.setBigUint64(outPtr + 16, BigInt(Date.now()) * 1_000_000n, true);
            return 0;
          } catch (error) {
            return -errno(error);
          }
        },

        fs_mkdir: (pathPtr: number, _mode: number) => {
          try { options.fs.mkdir(readCString(pathPtr)); return 0; }
          catch (error) { return -errno(error); }
        },

        fs_unlink: (pathPtr: number) => {
          try { options.fs.remove(readCString(pathPtr)); return 0; }
          catch (error) { return -errno(error); }
        },

        fs_rename: (oldPtr: number, newPtr: number) => {
          try {
            const oldPath = readCString(oldPtr);
            const newPath = readCString(newPtr);
            const data = options.fs.read(oldPath);
            options.fs.write(newPath, data);
            options.fs.remove(oldPath);
            return 0;
          } catch (error) {
            return -errno(error);
          }
        },

        fs_getcwd: (dstPtr: number, len: number) => writeCString(dstPtr, len, options.fs.pwd()),

        env_get: (keyPtr: number, valuePtr: number, len: number) => {
          const values: Record<string, string> = {
            HOME: options.fs.home,
            PATH: "/bin:/usr/bin",
            DENO_DIR: options.fs.home + "/.deno",
            SHELL: "/bin/sh",
            USER: "wexel",
            WEXEL_DENO_ABI: "30002",
          };
          return writeCString(valuePtr, len, values[readCString(keyPtr)] ?? "");
        },

        net_request: (_methodPtr: number, _urlPtr: number, _bodyPtr: number, _bodyLen: number, statusPtr: number) => {
          if (!options.networkAllowed) return -13;
          if (memory) new DataView(memory.buffer).setUint16(statusPtr, 501, true);
          return -38;
        },

        clock_now_ns: () => BigInt(Date.now()) * 1_000_000n,
        sleep_ms: (_ms: number) => 0,

        stdout_write: (ptr: number, len: number) => {
          options.output.stdout.push(decoder.decode(readBytes(ptr, len)));
          return len;
        },

        stderr_write: (ptr: number, len: number) => {
          options.output.stderr.push(decoder.decode(readBytes(ptr, len)));
          return len;
        },

        proc_exit: (code: number) => {
          options.output.exitCode = Number(code);
          throw new Error("WEXEL_DENO_PROCESS_EXIT");
        },
      },
    },
  };
}
