#include <stdint.h>

/* Wexel C Runtime, compiled natively to standalone WebAssembly. */

__attribute__((export_name("wexel_c_runtime_abi_version")))
uint32_t wexel_c_runtime_abi_version(void) { return 2; }

__attribute__((export_name("wexel_c_runtime_language")))
uint32_t wexel_c_runtime_language(void) { return 1; }

__attribute__((export_name("wexel_c_runtime_add")))
int32_t wexel_c_runtime_add(int32_t a, int32_t b) { return a + b; }

__attribute__((export_name("wexel_c_vfs_checksum")))
uint32_t wexel_c_vfs_checksum(uint32_t ptr, uint32_t len) {
  const uint8_t *data = (const uint8_t *)(uintptr_t)ptr;
  uint32_t hash = 2166136261u;
  for (uint32_t i = 0; i < len; ++i) { hash ^= data[i]; hash *= 16777619u; }
  return hash;
}
