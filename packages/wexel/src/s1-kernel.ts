import fs from "node:fs";
import { fileURLToPath } from "node:url";

export interface S1SocketHost {
  open(domain: number, type: number, protocol: number): number;
  connect(fd: number, address: string): number;
  send(fd: number, data: Uint8Array): number;
  recv(fd: number, capacity: number): Uint8Array | number;
  close(fd: number): number;
}

export interface S1KernelOptions {
  wasmBytes?: BufferSource;
  wasmPath?: string;
  allowNetwork?: boolean;
  sockets?: S1SocketHost;
  onOutput?: (message: string) => void;
}

type S1Exports = WebAssembly.Exports & {
  memory: WebAssembly.Memory;
  s1_boot(capabilities: number): number;
  s1_version(): number;
  s1_alloc(size: number): number;
  s1_reset_alloc(): void;
  s1_proc_read(path: number, output: number, capacity: number): number;
  s1_service_register(name: number, flags: number): number;
  s1_service_start(name: number): number;
  s1_service_stop(name: number): number;
  s1_service_state(name: number): number;
  s1_service_count(): number;
  s1_service_name_at(index: number): number;
  s1_service_flags_at(index: number): number;
  s1_service_starts_at(index: number): number;
  s1_socket_open(domain: number, type: number, protocol: number): number;
  s1_socket_connect(fd: number, address: number, length: number): number;
  s1_socket_send(fd: number, data: number, length: number): number;
  s1_socket_recv(fd: number, data: number, capacity: number): number;
  s1_socket_close(fd: number): number;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class S1Kernel {
  private constructor(private readonly wasm: S1Exports, private readonly onOutput?: (message: string) => void) {}

  static async boot(options: S1KernelOptions): Promise<S1Kernel> {
    let wasmBytes = options.wasmBytes;
    const wasmPath = options.wasmPath ?? fileURLToPath(new URL("../assets/s-kernel/s1.wasm", import.meta.url));
    if (!wasmBytes) wasmBytes = fs.readFileSync(wasmPath);
    if (!wasmBytes) throw new Error("S1 requer wasmBytes ou wasmPath.");

    let instanceRef: WebAssembly.Instance | undefined;
    const readString = (ptr: number, len: number): string => {
      const instance = instanceRef;
      if (!instance) return "";
      return decoder.decode(new Uint8Array((instance.exports as S1Exports).memory.buffer, ptr, len));
    };
    const sockets = options.sockets;
    const imports: WebAssembly.Imports = {
      wexel: {
        log: (ptr: number, len: number) => options.onOutput?.(readString(ptr, len)),
        socket_open: (domain: number, type: number, protocol: number) =>
          options.allowNetwork && sockets ? sockets.open(domain, type, protocol) : -13,
        socket_connect: (fd: number, ptr: number, len: number) =>
          options.allowNetwork && sockets ? sockets.connect(fd, readString(ptr, len)) : -13,
        socket_send: (fd: number, ptr: number, len: number) => {
          if (!options.allowNetwork || !sockets || !instanceRef) return -13;
          const memory = (instanceRef.exports as S1Exports).memory;
          const bytes = new Uint8Array(memory.buffer, ptr, len).slice();
          return sockets.send(fd, bytes);
        },
        socket_recv: (fd: number, ptr: number, capacity: number) => {
          if (!options.allowNetwork || !sockets || !instanceRef) return -13;
          const result = sockets.recv(fd, capacity);
          if (typeof result === "number") return result;
          const memory = (instanceRef.exports as S1Exports).memory;
          const count = Math.min(capacity, result.byteLength);
          new Uint8Array(memory.buffer, ptr, count).set(result.subarray(0, count));
          return count;
        },
        socket_close: (fd: number) => options.allowNetwork && sockets ? sockets.close(fd) : -13,
      },
    };

    const { instance } = await WebAssembly.instantiate(wasmBytes, imports);
    instanceRef = instance;
    const wasm = instance.exports as S1Exports;
    const kernel = new S1Kernel(wasm, options.onOutput);
    const status = wasm.s1_boot(options.allowNetwork && sockets ? 1 : 0);
    if (status !== 0) throw new Error(`Falha ao iniciar S1: código ${status}`);
    return kernel;
  }

  get version(): string {
    const ptr = this.wasm.s1_version();
    const memory = new Uint8Array(this.wasm.memory.buffer);
    let end = ptr;
    while (memory[end] !== 0) end++;
    return decoder.decode(memory.subarray(ptr, end));
  }

  readProc(path: string): string {
    this.wasm.s1_reset_alloc();
    const pathBytes = encoder.encode(path + "\0");
    const pathPtr = this.allocate(pathBytes);
    const outputPtr = this.wasm.s1_alloc(4096);
    if (!pathPtr || !outputPtr) throw new Error("Arena ABI S1 esgotada.");
    const result = this.wasm.s1_proc_read(pathPtr, outputPtr, 4096);
    if (result < 0) throw new Error(`S1: entrada proc indisponível (${result}): ${path}`);
    return decoder.decode(new Uint8Array(this.wasm.memory.buffer, outputPtr, result));
  }

  registerService(name: string, flags = 0): number {
    return this.withString(name, (ptr) => this.wasm.s1_service_register(ptr, flags));
  }
  startService(name: string): number {
    return this.withString(name, (ptr) => this.wasm.s1_service_start(ptr));
  }
  stopService(name: string): number {
    return this.withString(name, (ptr) => this.wasm.s1_service_stop(ptr));
  }
  serviceState(name: string): number {
    return this.withString(name, (ptr) => this.wasm.s1_service_state(ptr));
  }
  listServices(): Array<{ name: string; flags: number; starts: number }> {
    const result = [];
    for (let i = 0; i < this.wasm.s1_service_count(); i++) {
      const ptr = this.wasm.s1_service_name_at(i);
      const memory = new Uint8Array(this.wasm.memory.buffer);
      let end = ptr;
      while (memory[end] !== 0) end++;
      result.push({
        name: decoder.decode(memory.subarray(ptr, end)),
        flags: this.wasm.s1_service_flags_at(i),
        starts: this.wasm.s1_service_starts_at(i),
      });
    }
    return result;
  }

  private withString(value: string, callback: (ptr: number) => number): number {
    this.wasm.s1_reset_alloc();
    const ptr = this.allocate(encoder.encode(value + "\0"));
    if (!ptr) throw new Error("Arena ABI S1 esgotada.");
    return callback(ptr);
  }

  private allocate(bytes: Uint8Array): number {
    const ptr = this.wasm.s1_alloc(bytes.byteLength);
    if (ptr) new Uint8Array(this.wasm.memory.buffer, ptr, bytes.byteLength).set(bytes);
    return ptr;
  }
}
