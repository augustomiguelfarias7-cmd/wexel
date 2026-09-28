#include <cstdint>

/* Wexel C++ Runtime, compiled natively to standalone WebAssembly. */

extern "C" __attribute__((export_name("wexel_cpp_runtime_abi_version")))
std::uint32_t wexel_cpp_runtime_abi_version() { return 2; }

extern "C" __attribute__((export_name("wexel_cpp_runtime_language")))
std::uint32_t wexel_cpp_runtime_language() { return 2; }

extern "C" __attribute__((export_name("wexel_cpp_runtime_add")))
std::int32_t wexel_cpp_runtime_add(std::int32_t a, std::int32_t b) { return a + b; }

extern "C" __attribute__((export_name("wexel_cpp_vfs_checksum")))
std::uint32_t wexel_cpp_vfs_checksum(std::uint32_t ptr, std::uint32_t len) {
  const auto *data = reinterpret_cast<const std::uint8_t *>(static_cast<std::uintptr_t>(ptr));
  std::uint32_t hash = 2166136261u;
  for (std::uint32_t i = 0; i < len; ++i) { hash ^= data[i]; hash *= 16777619u; }
  return hash;
}
