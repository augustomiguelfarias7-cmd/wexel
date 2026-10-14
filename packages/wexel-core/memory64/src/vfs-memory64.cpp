// Freestanding hierarchical VFS. Path metadata and file contents live in Memory64.
using u8 = __UINT8_TYPE__;
using u32 = __UINT32_TYPE__;
using u64 = __UINT64_TYPE__;
using i64 = __INT64_TYPE__;
using usize = __SIZE_TYPE__;
extern "C" u64 wexel_memory64_alloc(u64 size);
extern "C" void wexel_memory64_free(u64 pointer);
extern "C" u64 wexel_memory64_size_bytes();
extern "C" void* memset(void* destination, int value, usize count) {
    auto* bytes = reinterpret_cast<u8*>(destination);
    for (usize i = 0; i < count; ++i) bytes[i] = static_cast<u8>(value);
    return destination;
}
extern "C" void* memcpy(void* destination, const void* source, usize count) {
    auto* output = reinterpret_cast<u8*>(destination);
    const auto* input = reinterpret_cast<const u8*>(source);
    for (usize i = 0; i < count; ++i) output[i] = input[i];
    return destination;
}
namespace {
constexpr u64 kGiB = 1024ULL * 1024ULL * 1024ULL;
constexpr u64 kMaxQuota = 16ULL * kGiB;
constexpr u32 kInitialNodes = 64;
constexpr u32 kMaxPath = 4096;
enum NodeType : u32 { NODE_FREE = 0, NODE_DIRECTORY = 1, NODE_FILE = 2 };
struct Node {
    u64 path_ptr;
    u32 path_len;
    u32 type;
    u64 data_ptr;
    u64 size;
};
Node* nodes = nullptr;
u32 node_capacity = 0;
u64 quota_bytes = kMaxQuota;
u64 bytes_used = 0;
u32 file_count = 0;
u32 directory_count = 1; // root is implicit
void clear_node(Node& node) {
    node.path_ptr = 0;
    node.path_len = 0;
    node.type = NODE_FREE;
    node.data_ptr = 0;
    node.size = 0;
}
bool valid_range(u64 ptr, u64 len) {
    const u64 memory_bytes = wexel_memory64_size_bytes();
    if (len == 0) return ptr <= memory_bytes;
    if (ptr == 0 || len > static_cast<u64>(-1) - ptr) return false;
    return ptr + len <= memory_bytes;
}
bool valid_path(const u8* path, u32 len, bool allow_root = true) {
    if (!path || len == 0 || len > kMaxPath || path[0] != '/') return false;
    if (len == 1) return allow_root;
    if (path[len - 1] == '/') return false;
    u32 start = 1;
    for (u32 i = 1; i <= len; ++i) {
        if (i < len && path[i] == 0) return false;
        if (i == len || path[i] == '/') {
            const u32 part_len = i - start;
            if (part_len == 0 || (part_len == 1 && path[start] == '.') ||
                (part_len == 2 && path[start] == '.' && path[start + 1] == '.')) return false;
            start = i + 1;
        }
    }
    return true;
}
bool same_path(const Node& node, const u8* path, u32 len) {
    if (node.type == NODE_FREE || node.path_len != len) return false;
    const auto* stored = reinterpret_cast<const u8*>(node.path_ptr);
    for (u32 i = 0; i < len; ++i) if (stored[i] != path[i]) return false;
    return true;
}
int find_node(const u8* path, u32 len) {
    if (len == 1 && path[0] == '/') return -2;
    for (u32 i = 0; i < node_capacity; ++i) if (same_path(nodes[i], path, len)) return static_cast<int>(i);
    return -1;
}
int free_node() {
    for (u32 i = 0; i < node_capacity; ++i) if (nodes[i].type == NODE_FREE) return static_cast<int>(i);
    return -1;
}
bool grow_nodes() {
    const u32 next_capacity = node_capacity == 0 ? kInitialNodes : node_capacity * 2U;
    if (next_capacity < node_capacity || static_cast<u64>(next_capacity) > static_cast<u64>(-1) / sizeof(Node)) return false;
    const u64 pointer = wexel_memory64_alloc(static_cast<u64>(next_capacity) * sizeof(Node));
    if (!pointer) return false;
    auto* next = reinterpret_cast<Node*>(pointer);
    for (u32 i = 0; i < next_capacity; ++i) clear_node(next[i]);
    for (u32 i = 0; i < node_capacity; ++i) next[i] = nodes[i];
    if (nodes) wexel_memory64_free(reinterpret_cast<u64>(nodes));
    nodes = next;
    node_capacity = next_capacity;
    return true;
}
int reserve_node() {
    if (!nodes || free_node() < 0) if (!grow_nodes()) return -1;
    return free_node();
}
bool parent_path(const u8* path, u32 len, u32& parent_len) {
    if (len <= 1) return false;
    u32 slash = len - 1;
    while (slash > 0 && path[slash] != '/') --slash;
    parent_len = slash == 0 ? 1 : slash;
    return true;
}
bool parent_is_directory(const u8* path, u32 len) {
    u32 parent_len = 0;
    if (!parent_path(path, len, parent_len)) return false;
    if (parent_len == 1 && path[0] == '/') return true;
    const int parent = find_node(path, parent_len);
    return parent >= 0 && nodes[parent].type == NODE_DIRECTORY;
}
bool is_direct_child(const Node& child, const u8* parent, u32 parent_len) {
    if (child.type == NODE_FREE) return false;
    const auto* stored = reinterpret_cast<const u8*>(child.path_ptr);
    if (parent_len == 1 && parent[0] == '/') {
        if (child.path_len < 2 || stored[0] != '/') return false;
        for (u32 i = 1; i < child.path_len; ++i) if (stored[i] == '/') return false;
        return true;
    }
    if (child.path_len <= parent_len || stored[parent_len] != '/') return false;
    for (u32 i = 0; i < parent_len; ++i) if (stored[i] != parent[i]) return false;
    for (u32 i = parent_len + 1; i < child.path_len; ++i) if (stored[i] == '/') return false;
    return true;
}
bool is_under_or_equal(const Node& node, const u8* prefix, u32 prefix_len) {
    if (same_path(node, prefix, prefix_len)) return true;
    if (node.path_len <= prefix_len || node.path_len <= prefix_len + 1) return false;
    const auto* stored = reinterpret_cast<const u8*>(node.path_ptr);
    for (u32 i = 0; i < prefix_len; ++i) if (stored[i] != prefix[i]) return false;
    return stored[prefix_len] == '/';
}
void delete_node(u32 index) {
    Node& node = nodes[index];
    if (node.type == NODE_FILE) {
        bytes_used -= node.size;
        --file_count;
        if (node.data_ptr) wexel_memory64_free(node.data_ptr);
    } else if (node.type == NODE_DIRECTORY) {
        --directory_count;
    }
    if (node.path_ptr) wexel_memory64_free(node.path_ptr);
    clear_node(node);
}
}
extern "C" u32 wexel_vfs_init(u64 requested_quota) {
    if (requested_quota == 0 || requested_quota > kMaxQuota) return 0;
    if (nodes) {
        for (u32 i = 0; i < node_capacity; ++i) if (nodes[i].type != NODE_FREE) delete_node(i);
        wexel_memory64_free(reinterpret_cast<u64>(nodes));
    }
    nodes = nullptr;
    node_capacity = 0;
    quota_bytes = requested_quota;
    bytes_used = 0;
    file_count = 0;
    directory_count = 1;
    return 1;
}
// On success mkdir takes ownership of path_ptr. On failure the caller owns it.
extern "C" u32 wexel_vfs_mkdir(u64 path_ptr, u32 path_len) {
    if (!valid_range(path_ptr, path_len)) return 0;
    const auto* path = reinterpret_cast<const u8*>(path_ptr);
    if (!valid_path(path, path_len, false) || !parent_is_directory(path, path_len) || find_node(path, path_len) != -1) return 0;
    const int slot = reserve_node();
    if (slot < 0) return 0;
    nodes[slot] = {path_ptr, path_len, NODE_DIRECTORY, 0, 0};
    ++directory_count;
    return 1;
}
extern "C" u32 wexel_vfs_rmdir(u64 path_ptr, u32 path_len) {
    if (!valid_range(path_ptr, path_len)) return 0;
    const auto* path = reinterpret_cast<const u8*>(path_ptr);
    if (!valid_path(path, path_len, false)) return 0;
    const int index = find_node(path, path_len);
    if (index < 0 || nodes[index].type != NODE_DIRECTORY) return 0;
    for (u32 i = 0; i < node_capacity; ++i) if (is_direct_child(nodes[i], path, path_len)) return 0;
    delete_node(static_cast<u32>(index));
    return 1;
}
extern "C" u32 wexel_vfs_path_exists(u64 path_ptr, u32 path_len) {
    if (!valid_range(path_ptr, path_len)) return 0;
    const auto* path = reinterpret_cast<const u8*>(path_ptr);
    if (!valid_path(path, path_len)) return 0;
    if (path_len == 1 && path[0] == '/') return 1;
    return find_node(path, path_len) >= 0 ? 1U : 0U;
}
extern "C" u32 wexel_vfs_is_directory(u64 path_ptr, u32 path_len) {
    if (!valid_range(path_ptr, path_len)) return 0;
    const auto* path = reinterpret_cast<const u8*>(path_ptr);
    if (!valid_path(path, path_len)) return 0;
    if (path_len == 1 && path[0] == '/') return 1;
    const int index = find_node(path, path_len);
    return index >= 0 && nodes[index].type == NODE_DIRECTORY ? 1U : 0U;
}
// Returns -1 when the file does not exist or the path is a directory.
extern "C" i64 wexel_vfs_file_size(u64 path_ptr, u32 path_len) {
    if (!valid_range(path_ptr, path_len)) return -1;
    const auto* path = reinterpret_cast<const u8*>(path_ptr);
    if (!valid_path(path, path_len, false)) return -1;
    const int index = find_node(path, path_len);
    if (index < 0 || nodes[index].type != NODE_FILE) return -1;
    return static_cast<i64>(nodes[index].size);
}
// On success write takes ownership of both temporary buffers; on failure the caller owns them.
extern "C" u32 wexel_vfs_write(u64 path_ptr, u32 path_len, u64 data_ptr, u64 data_len) {
    if (!valid_range(path_ptr, path_len) || !valid_range(data_ptr, data_len)) return 0;
    const auto* path = reinterpret_cast<const u8*>(path_ptr);
    if (!valid_path(path, path_len, false) || !parent_is_directory(path, path_len)) return 0;
    const int existing = find_node(path, path_len);
    if (existing >= 0 && nodes[existing].type != NODE_FILE) return 0;
    const u64 old_size = existing >= 0 ? nodes[existing].size : 0;
    if (bytes_used < old_size || data_len > static_cast<u64>(-1) - (bytes_used - old_size)) return 0;
    const u64 next_used = bytes_used - old_size + data_len;
    if (next_used > quota_bytes) return 0;
    const int slot = existing >= 0 ? existing : reserve_node();
    if (slot < 0) return 0;
    const u64 old_data = existing >= 0 ? nodes[slot].data_ptr : 0;
    if (existing >= 0) wexel_memory64_free(path_ptr);
    nodes[slot] = {existing >= 0 ? nodes[slot].path_ptr : path_ptr, path_len,
                   NODE_FILE, data_len == 0 ? 0 : data_ptr, data_len};
    if (old_data) wexel_memory64_free(old_data);
    bytes_used = next_used;
    if (existing < 0) ++file_count;
    return 1;
}
// Reads into a caller-owned buffer: -1 missing file, -2 buffer too small, -3 invalid arguments.
extern "C" i64 wexel_vfs_read(u64 path_ptr, u32 path_len, u64 out_ptr, u64 out_capacity) {
    if (!valid_range(path_ptr, path_len) || !valid_range(out_ptr, out_capacity)) return -3;
    const auto* path = reinterpret_cast<const u8*>(path_ptr);
    if (!valid_path(path, path_len, false)) return -3;
    const int index = find_node(path, path_len);
    if (index < 0 || nodes[index].type != NODE_FILE) return -1;
    const Node& node = nodes[index];
    if (out_capacity < node.size) return -2;
    if (node.size > 0 && out_ptr == 0) return -3;
    const auto* src = reinterpret_cast<const u8*>(node.data_ptr);
    auto* dst = reinterpret_cast<u8*>(out_ptr);
    for (u64 i = 0; i < node.size; ++i) dst[i] = src[i];
    return static_cast<i64>(node.size);
}
// Removes a file or a directory subtree. Root removal is rejected.
extern "C" u32 wexel_vfs_remove_tree(u64 path_ptr, u32 path_len) {
    if (!valid_range(path_ptr, path_len)) return 0;
    const auto* path = reinterpret_cast<const u8*>(path_ptr);
    if (!valid_path(path, path_len, false) || find_node(path, path_len) < 0) return 0;
    bool removed = false;
    for (u32 i = 0; i < node_capacity; ++i) {
        if (nodes[i].type != NODE_FREE && is_under_or_equal(nodes[i], path, path_len)) {
            delete_node(i);
            removed = true;
        }
    }
    return removed ? 1U : 0U;
}
extern "C" i64 wexel_vfs_list_size(u64 path_ptr, u32 path_len) {
    if (!valid_range(path_ptr, path_len)) return -3;
    const auto* path = reinterpret_cast<const u8*>(path_ptr);
    if (!valid_path(path, path_len)) return -3;
    if (!(path_len == 1 && path[0] == '/') && !wexel_vfs_is_directory(path_ptr, path_len)) return -1;
    u64 needed = 0;
    for (u32 i = 0; i < node_capacity; ++i) if (is_direct_child(nodes[i], path, path_len)) {
        needed += static_cast<u64>(nodes[i].path_len - (path_len == 1 ? 1 : path_len + 1)) + 1;
    }
    return needed > 0x7fffffffffffffffULL ? -3 : static_cast<i64>(needed);
}
// Writes immediate child names as NUL-separated UTF-8 strings.
extern "C" i64 wexel_vfs_list(u64 path_ptr, u32 path_len, u64 out_ptr, u64 out_capacity) {
    if (!valid_range(path_ptr, path_len) || !valid_range(out_ptr, out_capacity)) return -3;
    const auto* path = reinterpret_cast<const u8*>(path_ptr);
    if (!valid_path(path, path_len)) return -3;
    if (!(path_len == 1 && path[0] == '/') && !wexel_vfs_is_directory(path_ptr, path_len)) return -1;
    const i64 needed = wexel_vfs_list_size(path_ptr, path_len);
    if (needed < 0) return needed;
    if (static_cast<u64>(needed) > out_capacity || (needed > 0 && out_ptr == 0)) return -2;
    u64 cursor = 0;
    auto* out = reinterpret_cast<u8*>(out_ptr);
    for (u32 i = 0; i < node_capacity; ++i) if (is_direct_child(nodes[i], path, path_len)) {
        const auto* full = reinterpret_cast<const u8*>(nodes[i].path_ptr);
        const u32 start = path_len == 1 ? 1 : path_len + 1;
        for (u32 j = start; j < nodes[i].path_len; ++j) out[cursor++] = full[j];
        out[cursor++] = 0;
    }
    return static_cast<i64>(cursor);
}
extern "C" u64 wexel_vfs_bytes_used() { return bytes_used; }
extern "C" u64 wexel_vfs_quota_bytes() { return quota_bytes; }
extern "C" u32 wexel_vfs_file_count() { return file_count; }
extern "C" u32 wexel_vfs_directory_count() { return directory_count; }
extern "C" u64 wexel_memory_bytes() { return wexel_memory64_size_bytes(); }
extern "C" u32 wexel_vfs_remove(u64 path_ptr, u32 path_len) {
    return wexel_vfs_remove_tree(path_ptr, path_len);
}
