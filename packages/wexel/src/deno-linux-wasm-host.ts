/**
 * deno-linux-wasm-host.ts
 *
 * Deno-specific Linux-to-Wexel host bridge.
 *
 * This is the concrete syscall boundary used by the future Deno native-binary
 * translator. It converts supported Linux operations into Wexel primitives.
 * It intentionally does not execute an ELF itself.
 */

import type { WexelFileSystem } from "./index.js";
import {
  type DenoLinuxWasmCall,
  type DenoLinuxWasmHost,
  type DenoLinuxWasmResult,
  translateDenoLinuxSyscall,
} from "./deno-linux-wasm-translator.js";

const ENOSYS = 38;
const EBADF = 9;

export interface DenoLinuxWasmHostOptions {
  fs: WexelFileSystem;
  networkAllowed?: boolean;
  fetcher?: typeof fetch;
}

export class DenoLinuxWasmHostBridge implements DenoLinuxWasmHost {
  private readonly fs: WexelFileSystem;
  private readonly networkAllowed: boolean;
  private readonly fetcher: typeof fetch;

  constructor(options: DenoLinuxWasmHostOptions) {
    this.fs = options.fs;
    this.networkAllowed = options.networkAllowed ?? false;
    this.fetcher = options.fetcher ?? fetch;
  }

  syscall(call: DenoLinuxWasmCall): DenoLinuxWasmResult {
    const name = translateDenoLinuxSyscall(
      Number(call.args[0] ?? -1),
    );

    // The public bridge accepts an explicit syscall number as args[0].
    // Unsupported operations must fail deterministically rather than being
    // approximated by JavaScript.
    if (!name) return { errno: ENOSYS, value: -1n };

    switch (name) {
      case "getpid":
        return { errno: 0, value: 1n };

      case "gettid":
        return { errno: 0, value: 1n };

      case "clock_gettime":
        return {
          errno: 0,
          value: BigInt(Math.floor(performance.now() * 1_000_000)),
        };

      case "getrandom": {
        const size = Number(call.args[2] ?? 0n);
        if (size < 0) return { errno: 22, value: -1n };
        const bytes = new Uint8Array(size);
        crypto.getRandomValues(bytes);
        return { errno: 0, value: BigInt(size) };
      }

      case "uname":
        // uname's pointed-to struct is memory owned by the translated module.
        // The binary translator is responsible for copying the Wexel Linux
        // identity into that guest memory.
        return { errno: 0, value: 0n };

      case "read":
      case "write":
      case "close":
      case "openat":
      case "statx":
      case "fstat":
      case "lseek":
      case "mmap":
      case "munmap":
      case "mprotect":
      case "brk":
      case "nanosleep":
      case "futex":
      case "epoll_create1":
      case "epoll_ctl":
      case "epoll_wait":
      case "socket":
      case "connect":
      case "accept4":
      case "bind":
      case "listen":
      case "sendto":
      case "recvfrom":
      case "setsockopt":
      case "getsockopt":
        // These require guest-memory access and per-process state. Keep them
        // explicit until the Deno binary translator supplies a guest-memory
        // view and process descriptor table.
        return { errno: ENOSYS, value: -1n };

      default:
        return { errno: EBADF, value: -1n };
    }
  }

  get policy(): { networkAllowed: boolean; cwd: string; home: string } {
    return {
      networkAllowed: this.networkAllowed,
      cwd: this.fs.pwd(),
      home: this.fs.home,
    };
  }

  get network(): typeof this.fetcher {
    return this.fetcher;
  }
}
