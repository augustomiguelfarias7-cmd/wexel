// Freestanding Memory64 VFS. It manages filesystem metadata, not linear-memory growth.
using u8 = __UINT8_TYPE__;
using u32 = __UINT32_TYPE__;
using u64 = __UINT64_TYPE__;
using i64 = __INT64_TYPE__;

extern "C" u64 wexel_memory64_alloc(u64 size);
extern "C" u64 wexel_memory64_size_bytes();

namespace {
constexpr u64 kGiB = 1024ULL * 1024ULL * 1024ULL;
constexpr u64 kMaxQuota = 16ULL * kGiB;
constexpr u32 kMaxNodes = 512;
constexpr u32 kMaxPath = 1024;

enum NodeType : u32 { NODE_FREE = 0, NODE_DIRECTORY = 1, NODE_FILE = 2 };
struct Node {
    u64 path_ptr;
    u32 path_len;
    u32 type;
    u64 data_ptr;
    u64 size;
};
Node nodes[kMaxNodes]{};
u64 quota_bytes = kMaxQuota;
u64 bytes_used = 0;
u32 file_count = 0;
u32 directory_count = 1; // root directory is always present

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

bool valid_range(u64 ptr, u64 len) {
    const u64 memory_bytes = wexel_memory64_size_bytes();
    if (len == 0) return ptr <= memory_bytes;
    if (ptr == 0 || len > static_cast<u64>(-1) - ptr) return false;
    return ptr + len <= memory_bytes;
}

bool same_path(const Node& node, const u8* path, u32 len) {
    if (node.type == NODE_FREE || node.path_len != len) return false;
    const auto* stored = reinterpret_cast<const u8*>(node.path_ptr);
    for (u32 i = 0; i < len; ++i) if (stored[i] != path[i]) return false;
    return true;
}

int find_node(const u8* path, u32 len) {
    if (len == 1 && path[0] == '/') return -2; // implicit root
    for (u32 i = 0; i < kMaxNodes; ++i) if (same_path(nodes[i], path, len)) return static_cast<int>(i);
    return -1;
}

int free_node() {
    for (u32 i = 0; i < kMaxNodes; ++i) if (nodes[i].type == NODE_FREE) return static_cast<int>(i);
    return -1;
}

bool parent_path(const u8* path, u32 len, u32& parent_len) {
    if (len <= 1) return false;
    u32 slash = len - 1;
    while (slash > 0 && path[slash] != '/') --slash;
    parent_len = slash == 0 ? 1 : slash;
    return true;
}

bool parent_is_directory(const u8* path, u32 len) {
    u32 plen = 0;
    if (!parent_path(path, len, plen)) return false;
    if (plen == 1 && path[0] == '/') return true;
    const int parent = find_node(path, plen);
    return parent >= 0 && nodes[parent].type == NODE_DIRECTORY;
}

bool is_direct_child(const Node& child, const u8* parent, u32 parent_len) {
    if (child.type == NODE_FREE) return false;
    const auto* p = reinterpret_cast<const u8*>(child.path_ptr);
    if (parent_len == 1 && parent[0] == '/') {
        if (child.path_len < 2 || p[0] != '/') return false;
        for (u32 i = 1; i < child.path_len; ++i) if (p[i] == '/') return false;
        return true;
    }
    if (child.path_len <= parent_len || p[parent_len] != '/') return false;
    for (u32 i = 0; i < parent_len; ++i) if (p[i] != parent[i]) return false;
    for (u32 i = parent_len + 1; i < child.path_len; ++i) if (p[i] == '/') return false;
    return true;
}
}

extern "C" u32 wexel_vfs_init(u64 requested_quota) {
    if (requested_quota == 0 || requested_quota > kMaxQuota) return 0;
    quota_bytes = requested_quota;
    return 1;
}

extern "C" u32 wexel_vfs_mkdir(u64 path_ptr, u32 path_len) {
    if (!valid_range(path_ptr, path_len)) return 0;
    const auto* path = reinterpret_cast<const u8*>(path_ptr);
    if (!valid_path(path, path_len, false) || !parent_is_directory(path, path_len)) return 0;
    if (find_node(path, path_len) != -1) return 0;
    const int slot = free_node();
    if (slot < 0) return 0;
    const u64 stored_path = wexel_memory64_alloc(path_len);
    if (!stored_path) return 0;
    auto* dst = reinterpret_cast<u8*>(stored_path);
    for (u32 i = 0; i < path_len; ++i) dst[i] = path[i];
    nodes[slot] = {stored_path, path_len, NODE_DIRECTORY, 0, 0};
    ++directory_count;
    return 1;
}

extern "C" u32 wexel_vfs_rmdir(u64 path_ptr, u32 path_len) {
    if (!valid_range(path_ptr, path_len)) return 0;
    const auto* path = reinterpret_cast<const u8*>(path_ptr);
    if (!valid_path(path, path_len, false)) return 0;
    const int index = find_node(path, path_len);
    if (index < 0 || nodes[index].type != NODE_DIRECTORY) return 0;
    for (u32 i = 0; i < kMaxNodes; ++i) {
        if (i != static_cast<u32>(index) && is_direct_child(nodes[i], path, path_len)) return 0;
    }
    nodes[index] = {};
    --directory_count;
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

extern "C" u32 wexel_vfs_write(u64 path_ptr, u32 path_len, u64 data_ptr, u64 data_len) {
    if (!valid_range(path_ptr, path_len) || !valid_range(data_ptr, data_len)) return 0;
    const auto* path = reinterpret_cast<const u8*>(path_ptr);
    const auto* data = reinterpret_cast<const u8*>(data_ptr);
    if (!valid_path(path, path_len, false) || !parent_is_directory(path, path_len)) return 0;
    const int existing = find_node(path, path_len);
    if (existing >= 0 && nodes[existing].type != NODE_FILE) return 0;
    const int slot = existing >= 0 ? existing : free_node();
    if (slot < 0) return 0;
    const u64 old_size = existing >= 0 ? nodes[slot].size : 0;
    if (bytes_used < old_size || data_len > static_cast<u64>(-1) - (bytes_used - old_size)) return 0;
    const u64 next_used = bytes_used - old_size + data_len;
    if (next_used > quota_bytes) return 0;
    const u64 stored_path = existing >= 0 ? nodes[slot].path_ptr : wexel_memory64_alloc(path_len);
    if (!stored_path) return 0;
    if (existing < 0) {
        auto* dst_path = reinterpret_cast<u8*>(stored_path);
        for (u32 i = 0; i < path_len; ++i) dst_path[i] = path[i];
    }
    u64 stored_data = 0;
    if (data_len > 0) {
        stored_data = wexel_memory64_alloc(data_len);
        if (!stored_data) return 0;
        auto* dst = reinterpret_cast<u8*>(stored_data);
        for (u64 i = 0; i < data_len; ++i) dst[i] = data[i];
    }
    nodes[slot] = {stored_path, path_len, NODE_FILE, stored_data, data_len};
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

extern "C" u32 wexel_vfs_remove(u64 path_ptr, u32 path_len) {
    if (!valid_range(path_ptr, path_len)) return 0;
    const auto* path = reinterpret_cast<const u8*>(path_ptr);
    if (!valid_path(path, path_len, false)) return 0;
    const int index = find_node(path, path_len);
    if (index < 0 || nodes[index].type != NODE_FILE) return 0;
    bytes_used -= nodes[index].size;
    nodes[index] = {};
    --file_count;
    return 1;
}

// Writes immediate child names as NUL-separated UTF-8 strings. Returns byte count,
// -1 when path is not a directory, -2 when output buffer is too small, -3 invalid args.
extern "C" i64 wexel_vfs_list(u64 path_ptr, u32 path_len, u64 out_ptr, u64 out_capacity) {
    if (!valid_range(path_ptr, path_len) || !valid_range(out_ptr, out_capacity)) return -3;
    const auto* path = reinterpret_cast<const u8*>(path_ptr);
    if (!valid_path(path, path_len)) return -3;
    if (!(path_len == 1 && path[0] == '/') && !wexel_vfs_is_directory(path_ptr, path_len)) return -1;
    u64 needed = 0;
    for (u32 i = 0; i < kMaxNodes; ++i) if (is_direct_child(nodes[i], path, path_len)) {
        const u64 name_len = nodes[i].path_len - (path_len == 1 ? 1 : path_len + 1);
        needed += name_len + 1;
    }
    if (needed > out_capacity) return -2;
    u64 cursor = 0;
    auto* out = reinterpret_cast<u8*>(out_ptr);
    for (u32 i = 0; i < kMaxNodes; ++i) if (is_direct_child(nodes[i], path, path_len)) {
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
