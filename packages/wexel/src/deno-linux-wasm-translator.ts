/**
 * deno-linux-wasm-translator.ts
 *
 * Deno-specific Linux ABI translation layer.
 *
 * IMPORTANT:
 * This module does not compile Deno to WASM and does not pretend that a
 * Linux ELF can execute directly in a browser. It defines the translation
 * boundary used by a future binary translator: Linux/Deno ABI operations are
 * represented as Wexel WASM host operations.
 *
 * The actual x86-64 machine-code translation backend is intentionally kept
 * behind this interface so the runtime never silently falls back to a fake
 * JavaScript Deno implementation.
 */

export const DENO_LINUX_WASM_ABI = 1;

export type DenoLinuxSyscall =
  | "read"
  | "write"
  | "close"
  | "openat"
  | "statx"
  | "fstat"
  | "lseek"
  | "mmap"
  | "munmap"
  | "mprotect"
  | "brk"
  | "clock_gettime"
  | "getrandom"
  | "nanosleep"
  | "getpid"
  | "gettid"
  | "exit"
  | "exit_group"
  | "futex"
  | "epoll_create1"
  | "epoll_ctl"
  | "epoll_wait"
  | "socket"
  | "connect"
  | "accept4"
  | "bind"
  | "listen"
  | "sendto"
  | "recvfrom"
  | "setsockopt"
  | "getsockopt"
  | "uname";

export interface DenoLinuxWasmCall {
  syscall: DenoLinuxSyscall;
  args: bigint[];
}

export interface DenoLinuxWasmResult {
  errno: number;
  value: bigint;
}

/**
 * Host-side ABI expected by the Deno binary translation backend.
 *
 * The methods are deliberately low-level. A WASM implementation can expose
 * these as imports without coupling the Deno adapter to the Wexel VFS class.
 */
export interface DenoLinuxWasmHost {
  syscall(call: DenoLinuxWasmCall): DenoLinuxWasmResult | Promise<DenoLinuxWasmResult>;
}

/**
 * Maps the Linux syscall number used by x86-64 Linux to the Deno translation
 * ABI operation. Unknown calls return undefined instead of being guessed.
 */
export function translateDenoLinuxSyscall(
  number: number,
): DenoLinuxSyscall | undefined {
  return DENO_X64_SYSCALLS[number];
}

const DENO_X64_SYSCALLS: Record<number, DenoLinuxSyscall> = {
  0: "read",
  1: "write",
  3: "close",
  8: "lseek",
  9: "mmap",
  10: "mprotect",
  11: "munmap",
  12: "brk",
  13: "rt_sigaction",
  14: "rt_sigprocmask",
  35: "nanosleep",
  39: "getpid",
  41: "socket",
  42: "connect",
  43: "accept4",
  44: "sendto",
  45: "recvfrom",
  49: "bind",
  50: "listen",
  54: "setsockopt",
  55: "getsockopt",
  60: "exit",
  62: "kill",
  63: "uname",
  202: "futex",
  217: "getdents64",
  228: "clock_gettime",
  231: "exit_group",
  232: "epoll_wait",
  233: "epoll_ctl",
  235: "epoll_create1",
  257: "openat",
  262: "newfstatat",
  318: "getrandom",
  332: "statx",
};
