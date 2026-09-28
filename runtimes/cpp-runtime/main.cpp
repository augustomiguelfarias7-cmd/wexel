/* Wexel C++ Runtime, compiled natively to standalone WebAssembly. */

using u32 = unsigned int;
using i32 = int;

extern "C" __attribute__((export_name("wexel_cpp_runtime_abi_version")))
u32 wexel_cpp_runtime_abi_version() { return 2; }

extern "C" __attribute__((export_name("wexel_cpp_runtime_language")))
u32 wexel_cpp_runtime_language() { return 2; }

extern "C" __attribute__((export_name("wexel_cpp_runtime_add")))
i32 wexel_cpp_runtime_add(i32 a, i32 b) { return a + b; }

extern "C" __attribute__((export_name("wexel_cpp_vfs_checksum")))
u32 wexel_cpp_vfs_checksum(u32 ptr, u32 len) {
  const unsigned char *data = reinterpret_cast<const unsigned char *>(static_cast<unsigned long>(ptr));
  u32 hash = 2166136261u;
  for (u32 i = 0; i < len; ++i) { hash ^= data[i]; hash *= 16777619u; }
  return hash;
}
