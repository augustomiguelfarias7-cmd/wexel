export interface WexelCoreExports {
  memory: WebAssembly.Memory;
  alloc(size: number): number;
  add(a: number, b: number): number;
  write_byte(ptr: number, value: number): void;
}

export interface WexelCoreInstance {
  instance: WebAssembly.Instance;
  exports: WexelCoreExports;
}

export async function instantiateCore(bytes: BufferSource): Promise<WexelCoreInstance> {
  const result = await WebAssembly.instantiate(bytes, {});
  const exports = result.instance.exports as unknown as WexelCoreExports;
  if (!exports.memory || typeof exports.alloc !== "function") {
    throw new Error("Wexel Assembly core inválido: exportações obrigatórias ausentes");
  }
  return { instance: result.instance, exports };
}

export function coreSourceUrl(): string {
  return new URL("./core.wasm", import.meta.url).toString();
}
