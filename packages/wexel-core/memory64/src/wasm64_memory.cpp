// Wexel Core Memory64 manager. Owns WebAssembly linear-memory growth and arena allocation.
using u8 = __UINT8_TYPE__;
using u32 = __UINT32_TYPE__;
using u64 = __UINT64_TYPE__;
using usize = __SIZE_TYPE__;
extern "C" unsigned char __heap_base;
namespace {
constexpr u64 kGiB = 1024ULL * 1024ULL * 1024ULL;
constexpr u64 kPageSize = 65536ULL;
constexpr u64 kAlignment = 16ULL;
constexpr u64 kFreeFlag = 1ULL;
constexpr u64 kCompiledMaximum = 16ULL * kGiB;
struct BlockHeader {
    u64 size_and_flags;
    BlockHeader* next_free;
};
u64 arena_next = 0;
u64 arena_start = 0;
u64 memory_limit = kCompiledMaximum;
BlockHeader* free_head = nullptr;
bool allocator_ready = false;
u64 align_up(u64 value) {
    if (value > static_cast<u64>(-1) - (kAlignment - 1)) return 0;
    return (value + kAlignment - 1) & ~(kAlignment - 1);
}
u64 current_bytes() {
    return static_cast<u64>(__builtin_wasm_memory_size(0)) * kPageSize;
}
u64 payload_size(const BlockHeader* block) {
    return block->size_and_flags & ~kFreeFlag;
}
bool is_free(const BlockHeader* block) {
    return (block->size_and_flags & kFreeFlag) != 0;
}
u64 block_end(const BlockHeader* block) {
    return reinterpret_cast<u64>(block) + sizeof(BlockHeader) + payload_size(block);
}
void initialize_allocator() {
    if (allocator_ready) return;
    arena_start = align_up(reinterpret_cast<u64>(&__heap_base));
    arena_next = arena_start;
    allocator_ready = arena_start != 0;
}
void coalesce_free_list() {
    BlockHeader* block = free_head;
    while (block && block->next_free) {
        BlockHeader* next = block->next_free;
        if (block_end(block) == reinterpret_cast<u64>(next)) {
            block->size_and_flags = (payload_size(block) + sizeof(BlockHeader) + payload_size(next)) | kFreeFlag;
            block->next_free = next->next_free;
        } else {
            block = next;
        }
    }
}
}
extern "C" u32 wexel_memory64_pointer_bits() { return static_cast<u32>(sizeof(void*) * 8U); }
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
extern "C" u64 wexel_memory64_alloc(u64 requested_size) {
    initialize_allocator();
    if (!allocator_ready) return 0;
    const u64 size = align_up(requested_size == 0 ? 1 : requested_size);
    if (size == 0 || size > static_cast<u64>(-1) - sizeof(BlockHeader)) return 0;
    BlockHeader** link = &free_head;
    while (*link) {
        BlockHeader* block = *link;
        const u64 available = payload_size(block);
        if (available >= size) {
            const u64 remainder = available - size;
            if (remainder >= sizeof(BlockHeader) + kAlignment) {
                auto* split = reinterpret_cast<BlockHeader*>(reinterpret_cast<u64>(block) + sizeof(BlockHeader) + size);
                split->size_and_flags = (remainder - sizeof(BlockHeader)) | kFreeFlag;
                split->next_free = block->next_free;
                *link = split;
                block->size_and_flags = size;
            } else {
                *link = block->next_free;
                block->size_and_flags = available;
                block->next_free = nullptr;
            }
            return reinterpret_cast<u64>(block) + sizeof(BlockHeader);
        }
        link = &block->next_free;
    }
    if (arena_next > static_cast<u64>(-1) - sizeof(BlockHeader) - size) return 0;
    const u64 end = arena_next + sizeof(BlockHeader) + size;
    if (end > memory_limit || !wexel_memory64_grow(end)) return 0;
    auto* block = reinterpret_cast<BlockHeader*>(arena_next);
    block->size_and_flags = size;
    block->next_free = nullptr;
    arena_next = end;
    return reinterpret_cast<u64>(block) + sizeof(BlockHeader);
}
extern "C" void wexel_memory64_free(u64 pointer) {
    initialize_allocator();
    if (!allocator_ready || pointer < arena_start + sizeof(BlockHeader) || pointer >= arena_next || (pointer & (kAlignment - 1)) != 0) return;
    auto* block = reinterpret_cast<BlockHeader*>(pointer - sizeof(BlockHeader));
    const u64 size = payload_size(block);
    if (is_free(block) || size == 0 || size > arena_next - pointer) return;
    block->size_and_flags = size | kFreeFlag;
    BlockHeader** link = &free_head;
    while (*link && reinterpret_cast<u64>(*link) < reinterpret_cast<u64>(block)) link = &(*link)->next_free;
    block->next_free = *link;
    *link = block;
    coalesce_free_list();
}
