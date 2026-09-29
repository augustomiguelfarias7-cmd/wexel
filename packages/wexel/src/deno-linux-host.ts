import type { WexelFileSystem } from "./index.js";
import type { NetworkFetcher } from "./deno-net-bridge.js";

export interface DenoLinuxHostOptions {
  fs: WexelFileSystem;
  networkAllowed: boolean;
  fetcher: NetworkFetcher;
  output: { stdout: string[]; stderr: string[]; exitCode: number };
}

export function createDenoLinuxHost(options: DenoLinuxHostOptions) {
  let memory: WebAssembly.Memory | undefined;

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

  return {
    bindMemory(value: WebAssembly.Memory) {
      memory = value;
    },

    imports: {
      __wexel_linux: {
        fs_open: (pathPtr: number) => {
          const path = readCString(pathPtr);
          return options.fs.exists(path) ? 3 : -errno(new Error("file inexistente"));
        },

        fs_close: (_fd: number) => 0,

        fs_read: (_fd: number, _dstPtr: number, _len: number) => -38,

        fs_write: (_fd: number, _srcPtr: number, _len: number) => -38,

        fs_seek: (_fd: number, _offset: number, _whence: number) => -38,

        fs_stat: (pathPtr: number, outPtr: number) => {
          try {
            const path = readCString(pathPtr);
            const isDir = options.fs.exists(path) && options.fs.list(path).length >= 0;
            if (!options.fs.exists(path)) return -2;
            if (!memory) return -5;
            const view = new DataView(memory.buffer);
            view.setUint32(outPtr, isDir ? 2 : 1, true);
            view.setUint32(outPtr + 4, isDir ? 0o755 : 0o644, true);
            view.setBigUint64(outPtr + 8, BigInt(isDir ? 0 : options.fs.read(path).byteLength), true);
            view.setBigUint64(outPtr + 16, BigInt(Date.now()) * 1_000_000n, true);
            return 0;
          } catch (error) {
            return -errno(error);
          }
        },

        fs_mkdir: (pathPtr: number, _mode: number) => {
          try {
            options.fs.mkdir(readCString(pathPtr));
            return 0;
          } catch (error) {
            return -errno(error);
          }
        },

        fs_unlink: (pathPtr: number) => {
          try {
            options.fs.remove(readCString(pathPtr));
            return 0;
          } catch (error) {
            return -errno(error);
          }
        },

        fs_rename: (oldPtr: number, newPtr: number) => {
          try {
            const data = options.fs.read(readCString(oldPtr));
            options.fs.write(readCString(newPtr), data);
            options.fs.remove(readCString(oldPtr));
            return 0;
          } catch (error) {
            return -errno(error);
          }
        },

        fs_getcwd: (dstPtr: number, len: number) => writeCString(dstPtr, len, options.fs.pwd()),

        env_get: (keyPtr: number, valuePtr: number, len: number) => {
          const key = readCString(keyPtr);
          const values: Record<string, string> = {
            HOME: options.fs.home,
            PATH: "/bin:/usr/bin",
            DENO_DIR: options.fs.home + "/.deno",
            SHELL: "/bin/sh",
            USER: "wexel",
            WEXEL_DENO_ABI: "30002",
          };
          return writeCString(valuePtr, len, values[key] ?? "");
        },

        net_request: (_methodPtr: number, urlPtr: number, _bodyPtr: number, _bodyLen: number, statusPtr: number) => {
          // Network calls are asynchronous in WebPink. The actual Deno
          // integration should use the async op bridge; this synchronous
          // syscall is deliberately not exposed as a fake blocking fetch.
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
