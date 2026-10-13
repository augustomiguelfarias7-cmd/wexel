// Wexel Core Memory64 manager. Owns WebAssembly linear-memory growth and arena allocation.
using u8 = __UINT8_TYPE__;
using u32 = __UINT32_TYPE__;
using u64 = __UINT64_TYPE__;
using usize = __SIZE_TYPE__;
extern "C" unsigned char __heap_base;

namespace {
constexpr u64 kGiB = 1024ULL * 1024ULL * 1024ULL;
constexpr u64 kPageSize = 65536ULL;
constexpr u64 kCompiledMaximum = 16ULL * kGiB;
u64 arena_next = 0;
u64 memory_limit = kCompiledMaximum;
bool allocator_ready = false;

u64 current_bytes() {
    return static_cast<u64>(__builtin_wasm_memory_size(0)) * kPageSize;
}
}

extern "C" u32 wexel_memory64_pointer_bits() {
    return static_cast<u32>(sizeof(void*) * 8U);
}

extern "C" u32 wexel_memory64_set_limit(u64 limit_bytes) {
    if (limit_bytes < current_bytes() || limit_bytes > kCompiledMaximum || limit_bytes == 0) return 0;
    memory_limit = limit_bytes;
    return 1;
}

extern "C" u64 wexel_memory64_limit_bytes() { return memory_limit; }
extern "C" u64 wexel_memory64_size_bytes() { return current_bytes(); }

extern "C" u32 wexel_memory64_grow(u64 requested_bytes) {
    if (requested_bytes > memory_limit) return 0;
    const u64 current = current_bytes();
    if (requested_bytes <= current) return 1;
    const u64 pages = (requested_bytes - current + kPageSize - 1) / kPageSize;
    const usize previous = __builtin_wasm_memory_grow(0, static_cast<usize>(pages));
    return previous != static_cast<usize>(-1) ? 1U : 0U;
}

extern "C" u64 wexel_memory64_alloc(u64 size) {
    if (!allocator_ready) {
        arena_next = (reinterpret_cast<u64>(&__heap_base) + 15ULL) & ~15ULL;
        allocator_ready = true;
    }
    if (size == 0) size = 1;
    if (size > static_cast<u64>(-1) - arena_next) return 0;
    const u64 start = (arena_next + 15ULL) & ~15ULL;
    const u64 end = start + size;
    if (end > memory_limit || !wexel_memory64_grow(end)) return 0;
    arena_next = (end + 15ULL) & ~15ULL;
    return start;
}
