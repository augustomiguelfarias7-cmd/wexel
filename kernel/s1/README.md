# Kernel S1

S1 is Wexel's own freestanding C++ kernel core compiled to WebAssembly. It is
not a Linux port and does not execute guest WebAssembly modules. Its exported
ABI provides boot/version reporting, a bounded service registry, service
lifecycle state, a ring-buffer event log, virtual `/proc` reads, and a socket
interface delegated to explicitly supplied Wexel host imports.

## ABI

- `s1_boot(capabilities)`: initializes the kernel once. Bit 0 enables sockets.
- `s1_version()`: returns `S version S1.0.0.0`.
- `s1_proc_read(path, output, capacity)`: reads `/proc/version`,
  `/proc/uptime`, `/proc/meminfo`, `/proc/services`, or `/proc/events`.
- `s1_service_register/start/stop/state`: manages registered service records.
- `s1_socket_open/connect/send/recv/close`: delegates network operations to
  the host ABI. Calls are denied until the runtime explicitly enables sockets.

The initial implementation is freestanding and statically bounded. It does
not claim to provide hardware privilege, preemptive scheduling, process
isolation, a full POSIX kernel, or a complete Linux-compatible procfs. Those
require additional subsystems and runtime integration.

## Build

Run `bash scripts/build-s1-kernel.sh` with Clang/LLD installed. The build
produces `packages/wexel/assets/s-kernel/s1.wasm`. No Emscripten or GitHub
Actions workflow is used.
