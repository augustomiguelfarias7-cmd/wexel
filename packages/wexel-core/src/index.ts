export interface WexelCoreExports {
  memory: WebAssembly.Memory;
  wexel_memory64_pointer_bits(): number;
  wexel_memory64_set_limit(bytes: bigint): number;
  wexel_memory64_limit_bytes(): bigint;
  wexel_memory64_size_bytes(): bigint;
  wexel_memory64_grow(bytes: bigint): number;
  wexel_memory64_alloc(bytes: bigint): bigint;
  wexel_memory64_free(pointer: bigint): void;
}

export interface WexelCoreInstance {
  instance: WebAssembly.Instance;
  exports: WexelCoreExports;
}

export async function instantiateCore(bytes: BufferSource): Promise<WexelCoreInstance> {
  const result = await WebAssembly.instantiate(bytes, {});
  const exports = result.instance.exports as unknown as WexelCoreExports;
  if (!(exports.memory instanceof WebAssembly.Memory) || typeof exports.wexel_memory64_alloc !== "function") {
    throw new Error("Wexel Core Memory64 inválido: memória linear e exports do core ausentes.");
  }
  if (exports.wexel_memory64_pointer_bits() !== 64) {
    throw new Error("O módulo fornecido não é um core Memory64 de 64 bits.");
  }
  const required: Array<keyof WexelCoreExports> = [
    "wexel_memory64_free",
    "wexel_memory64_set_limit",
    "wexel_memory64_limit_bytes",
    "wexel_memory64_size_bytes",
    "wexel_memory64_grow",
  ];
  for (const name of required) {
    if (typeof exports[name] !== "function") throw new Error(`Wexel Core Memory64 inválido: export ${name} ausente.`);
  }
  return { instance: result.instance, exports };
}

export function coreSourceUrl(): string {
  return new URL("./core.wasm", import.meta.url).toString();
}

export { WexelServiceManager } from "./service-manager.js";
export type { WexelService, WexelServiceSnapshot, WexelServiceState } from "./service-manager.js";
export { WexelLifecycleManager } from "./lifecycle-manager.js";
export type { WexelComponentSnapshot, WexelComponentState, WexelLifecycleSnapshot, WexelLifecycleState } from "./lifecycle-manager.js";
export { WexelFileSystem, WexelMemory64FileSystem, normalizeHome } from "./filesystem.js";
export type { WexelFileSystemLike, WexelQuota } from "./filesystem.js";
