/**
 * Linux ABI boundary used by the x86-64 -> WASM binary translator.
 *
 * The translator lowers the native Linux syscall instruction to one WASM
 * import. This layer gives that import a stable, typed Wexel ABI.
 */
export const DENO_LINUX_WASM_ABI = 2;

export type DenoLinuxSyscall =
  | "read" | "write" | "readv" | "writev" | "close" | "ioctl"
  | "lseek" | "mmap" | "mprotect" | "munmap" | "brk"
  | "rt_sigaction" | "rt_sigprocmask" | "rt_sigreturn"
  | "nanosleep" | "clock_gettime" | "clock_getres"
  | "getpid" | "gettid" | "getcwd" | "chdir"
  | "dup" | "dup2" | "pipe" | "pipe2"
  | "openat" | "newfstatat" | "fstat" | "statx" | "getdents64"
  | "mkdirat" | "unlinkat" | "renameat" | "access"
  | "getrandom" | "futex" | "set_robust_list" | "arch_prctl"
  | "exit" | "exit_group" | "kill"
  | "epoll_create1" | "epoll_ctl" | "epoll_wait"
  | "socket" | "connect" | "accept4" | "bind" | "listen"
  | "sendto" | "recvfrom" | "setsockopt" | "getsockopt"
  | "uname";

export interface DenoLinuxWasmCall {
  syscall: DenoLinuxSyscall | number;
  args: bigint[];
}

export interface DenoLinuxWasmResult {
  /** Linux-style return value. Negative errno values stay negative. */
  value: bigint;
  /** Optional decoded errno for diagnostics/host telemetry. */
  errno?: number;
}

export interface DenoLinuxSyscallSpec {
  number:number;
  name:DenoLinuxSyscall;
  argumentCount:number;
  /** true when the operation can block on a host resource. */
  mayBlock:boolean;
}

/**
 * Host-side ABI expected by the native-binary translation backend.
 */
export interface DenoLinuxWasmHost {
  syscall(call:DenoLinuxWasmCall):DenoLinuxWasmResult | Promise<DenoLinuxWasmResult>;
}

export function translateDenoLinuxSyscall(number:number):DenoLinuxSyscall|undefined {
  return DENO_X64_SYSCALLS[number]?.name;
}

export function getDenoLinuxSyscallSpec(number:number):DenoLinuxSyscallSpec|undefined {
  return DENO_X64_SYSCALLS[number];
}

const spec = (
  number:number,
  name:DenoLinuxSyscall,
  argumentCount:number,
  mayBlock=false,
):DenoLinuxSyscallSpec => ({number,name,argumentCount,mayBlock});

const DENO_X64_SYSCALL_SPECS:DenoLinuxSyscallSpec[] = [
  spec(0,"read",3,true), spec(1,"write",3,true), spec(3,"close",1),
  spec(7,"poll",3,true), spec(8,"lseek",3), spec(9,"mmap",6),
  spec(10,"mprotect",3), spec(11,"munmap",2), spec(12,"brk",1),
  spec(13,"rt_sigaction",4), spec(14,"rt_sigprocmask",4),
  spec(15,"rt_sigreturn",0), spec(16,"ioctl",3,true),
  spec(17,"pread64",4,true), spec(18,"pwrite64",4,true),
  spec(19,"readv",3,true), spec(20,"writev",3,true),
  spec(22,"pipe",1), spec(32,"dup",1), spec(33,"dup2",2),
  spec(35,"nanosleep",2,true), spec(39,"getpid",0), spec(40,"sendfile",4,true),
  spec(41,"socket",3,true), spec(42,"connect",3,true), spec(43,"accept4",4,true),
  spec(44,"sendto",6,true), spec(45,"recvfrom",6,true),
  spec(49,"bind",3), spec(50,"listen",2), spec(51,"getsockname",3),
  spec(52,"getpeername",3), spec(54,"setsockopt",5), spec(55,"getsockopt",5),
  spec(56,"clone",5), spec(60,"exit",1), spec(61,"wait4",4,true),
  spec(62,"kill",2), spec(63,"uname",1), spec(72,"fcntl",3),
  spec(79,"getcwd",2), spec(80,"chdir",1), spec(83,"mkdir",2),
  spec(87,"unlink",1), spec(89,"readlink",3), spec(97,"getrlimit",2),
  spec(131,"sigaltstack",2), spec(157,"prctl",5),
  spec(202,"futex",6,true), spec(217,"getdents64",3),
  spec(218,"set_robust_list",2), spec(219,"get_robust_list",3),
  spec(228,"clock_gettime",2), spec(229,"clock_getres",2),
  spec(231,"exit_group",1), spec(232,"epoll_wait",4,true),
  spec(233,"epoll_ctl",4), spec(235,"epoll_create1",1),
  spec(257,"openat",4), spec(258,"mkdirat",3), spec(263,"unlinkat",3),
  spec(264,"renameat",4), spec(269,"faccessat",3), spec(270,"pselect6",6,true),
  spec(273,"set_robust_list",2), spec(302,"prlimit64",4),
  spec(318,"getrandom",3,true), spec(322,"execveat",5),
  spec(332,"statx",5), spec(158,"arch_prctl",2),
];

const DENO_X64_SYSCALLS:Record<number,DenoLinuxSyscallSpec> = Object.fromEntries(
  DENO_X64_SYSCALL_SPECS.map(item=>[item.number,item]),
) as Record<number,DenoLinuxSyscallSpec>;

export { X64_WASM_TRANSLATOR_ABI, translateX64ToWasm, x64RegisterName, x64RegisterIndex,
  type X64Register, type X64Instruction, type X64TranslationDiagnostic,
  type X64TranslationResult, type X64WasmTranslatorOptions } from "./x86-64-wasm-translator.js";
