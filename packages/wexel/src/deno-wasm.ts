import type { ExecResult } from "./index.js";

export const DENO_WASM_ABI_VERSION = 30000;

interface DenoWasmExports {
  memory: WebAssembly.Memory;
  deno_abi_version(): number;
  deno_alloc(length: number): number;
  deno_exec(codePointer: number, codeLength: number, language: number, argsPointer: number, argsLength: number): number;
  deno_stdout_pointer(): number;
  deno_stdout_length(): number;
  deno_stderr_pointer(): number;
  deno_stderr_length(): number;
}

/** Runtime Deno compatível com WASM, sem acesso ao filesystem ou processos do host. */
export class DenoWasmRuntime {
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();
  private constructor(private readonly exports: DenoWasmExports) {}

  static async instantiate(source: BufferSource): Promise<DenoWasmRuntime> {
    const instance = (await WebAssembly.instantiate(source, {})).instance;
    const exports = instance.exports as unknown as DenoWasmExports;
    if (!exports.memory || typeof exports.deno_abi_version !== "function" || typeof exports.deno_alloc !== "function" || typeof exports.deno_exec !== "function") {
      throw new Error("Módulo Deno/WASM inválido: exports ABI obrigatórios ausentes.");
    }
    if (exports.deno_abi_version() !== DENO_WASM_ABI_VERSION) {
      throw new Error(`ABI Deno/WASM incompatível: esperado ${DENO_WASM_ABI_VERSION}, recebido ${exports.deno_abi_version()}.`);
    }
    return new DenoWasmRuntime(exports);
  }

  async run(code: string, language: "javascript" | "typescript", args: string[] = []): Promise<ExecResult> {
    const codeBytes = this.encoder.encode(code);
    const argsBytes = this.encoder.encode(JSON.stringify(args));
    const codePointer = this.write(codeBytes);
    const argsPointer = this.write(argsBytes);
    const exitCode = this.exports.deno_exec(codePointer, codeBytes.byteLength, language === "typescript" ? 2 : 1, argsPointer, argsBytes.byteLength);
    return {
      stdout: this.read(this.exports.deno_stdout_pointer(), this.exports.deno_stdout_length()),
      stderr: this.read(this.exports.deno_stderr_pointer(), this.exports.deno_stderr_length()),
      exitCode,
    };
  }

  private write(bytes: Uint8Array): number {
    const pointer = this.exports.deno_alloc(bytes.byteLength);
    new Uint8Array(this.exports.memory.buffer, pointer, bytes.byteLength).set(bytes);
    return pointer;
  }

  private read(pointer: number, length: number): string {
    return this.decoder.decode(new Uint8Array(this.exports.memory.buffer, pointer, length));
  }
}
