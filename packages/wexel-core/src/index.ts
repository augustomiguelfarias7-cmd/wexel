export interface WexelCoreExports {
  memory: WebAssembly.Memory;
  wexel_memory64_pointer_bits(): number;
  wexel_memory64_set_limit(bytes: bigint): number;
  wexel_memory64_limit_bytes(): bigint;
  wexel_memory64_size_bytes(): bigint;
  wexel_memory64_grow(bytes: bigint): number;
  wexel_memory64_alloc(bytes: bigint): bigint;
  wexel_memory64_free(pointer: bigint): void;
  wexel_vfs_init(quotaBytes: bigint): number;
  wexel_vfs_mkdir(pathPointer: bigint, pathLength: number): number;
  wexel_vfs_rmdir(pathPointer: bigint, pathLength: number): number;
  wexel_vfs_path_exists(pathPointer: bigint, pathLength: number): number;
  wexel_vfs_is_directory(pathPointer: bigint, pathLength: number): number;
  wexel_vfs_file_size(pathPointer: bigint, pathLength: number): bigint;
  wexel_vfs_write(pathPointer: bigint, pathLength: number, dataPointer: bigint, dataLength: bigint): number;
  wexel_vfs_read(pathPointer: bigint, pathLength: number, outPointer: bigint, outCapacity: bigint): bigint;
  wexel_vfs_remove_tree(pathPointer: bigint, pathLength: number): number;
  wexel_vfs_list_size(pathPointer: bigint, pathLength: number): bigint;
  wexel_vfs_list(pathPointer: bigint, pathLength: number, outPointer: bigint, outCapacity: bigint): bigint;
  wexel_vfs_bytes_used(): bigint;
  wexel_vfs_quota_bytes(): bigint;
  wexel_vfs_file_count(): number;
  wexel_vfs_directory_count(): number;
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
    "wexel_memory64_free", "wexel_vfs_init", "wexel_vfs_mkdir", "wexel_vfs_rmdir",
    "wexel_vfs_path_exists", "wexel_vfs_is_directory", "wexel_vfs_file_size", "wexel_vfs_write",
    "wexel_vfs_read", "wexel_vfs_remove_tree", "wexel_vfs_list_size", "wexel_vfs_list",
    "wexel_vfs_bytes_used", "wexel_vfs_quota_bytes", "wexel_vfs_file_count", "wexel_vfs_directory_count",
  ];
  for (const name of required) {
    if (typeof exports[name] !== "function") throw new Error(`Wexel Core Memory64 inválido: export ${name} ausente.`);
  }
  return { instance: result.instance, exports };
}

export function coreSourceUrl(): string {
  return new URL("./core.wasm", import.meta.url).toString();
}
