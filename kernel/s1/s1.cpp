// S1 kernel core for Wexel. Freestanding C++ compiled to WebAssembly.
// SPDX-License-Identifier: Apache-2.0
#include <stdint.h>
#include <stddef.h>

#if defined(__wasm__)
#define S1_EXPORT(name) __attribute__((export_name(name)))
#define S1_IMPORT(name) __attribute__((import_module("wexel"), import_name(name)))
#else
#define S1_EXPORT(name)
#define S1_IMPORT(name)
#endif

namespace {
constexpr uint32_t kServiceLimit = 32;
constexpr uint32_t kNameLimit = 32;
constexpr uint32_t kEventLimit = 64;
constexpr int32_t kOk = 0;
constexpr int32_t kInvalid = -22;
constexpr int32_t kNotFound = -2;
constexpr int32_t kNoSpace = -28;
constexpr int32_t kAlready = -17;
constexpr int32_t kNotRunning = -3;

struct Service {
  char name[kNameLimit];
  uint32_t flags;
  uint32_t state; // 0=registered, 1=running, 2=stopped, 3=failed
  uint32_t starts;
};

struct Event {
  uint32_t sequence;
  int32_t code;
  char text[64];
};

Service services[kServiceLimit]{};
Event events[kEventLimit]{};
uint32_t service_count = 0;
uint32_t event_sequence = 0;
uint32_t booted = 0;
uint32_t host_capabilities = 0;
uint64_t ticks = 0;

char version_text[] = "S version S1.0.0.0";
char kernel_name[] = "S1";
char empty_text[] = "";

size_t length(const char* s) {
  if (!s) return 0;
  size_t n = 0;
  while (s[n] != '\0') ++n;
  return n;
}

bool equal(const char* a, const char* b) {
  if (!a || !b) return false;
  size_t i = 0;
  while (a[i] && b[i] && a[i] == b[i]) ++i;
  return a[i] == b[i];
}

void copy_text(char* out, size_t capacity, const char* in) {
  if (!capacity) return;
  size_t i = 0;
  if (in) while (i + 1 < capacity && in[i]) { out[i] = in[i]; ++i; }
  out[i] = '\0';
}

size_t append(char* out, size_t capacity, size_t at, const char* value) {
  if (at >= capacity) return at;
  size_t i = 0;
  while (value && value[i] && at + i + 1 < capacity) {
    out[at + i] = value[i];
    ++i;
  }
  out[at + i] = '\0';
  return at + i;
}

size_t append_u32(char* out, size_t capacity, size_t at, uint32_t value) {
  char digits[11];
  uint32_t n = 0;
  do { digits[n++] = char('0' + (value % 10)); value /= 10; } while (value && n < sizeof(digits));
  while (n && at + 1 < capacity) out[at++] = digits[--n];
  if (capacity) out[at < capacity ? at : capacity - 1] = '\0';
  return at;
}

int32_t find_service(const char* name) {
  for (uint32_t i = 0; i < service_count; ++i)
    if (equal(services[i].name, name)) return static_cast<int32_t>(i);
  return -1;
}

void event(int32_t code, const char* message) {
  Event& item = events[event_sequence % kEventLimit];
  item.sequence = ++event_sequence;
  item.code = code;
  copy_text(item.text, sizeof(item.text), message);
}

void copy_out(const char* text, char* output, uint32_t capacity) {
  if (!output || capacity == 0) return;
  uint32_t i = 0;
  while (text && text[i] && i + 1 < capacity) { output[i] = text[i]; ++i; }
  output[i] = '\0';
}
} // namespace

// Host capabilities are explicit imports. The runtime must provide these
// functions; the kernel never reaches outside WebAssembly memory directly.
extern "C" {
S1_IMPORT("log") void host_log(const char* message, uint32_t length);
S1_IMPORT("socket_open") int32_t host_socket_open(int32_t domain, int32_t type, int32_t protocol);
S1_IMPORT("socket_connect") int32_t host_socket_connect(int32_t fd, const char* address, uint32_t address_length);
S1_IMPORT("socket_send") int32_t host_socket_send(int32_t fd, const uint8_t* data, uint32_t length);
S1_IMPORT("socket_recv") int32_t host_socket_recv(int32_t fd, uint8_t* data, uint32_t capacity);
S1_IMPORT("socket_close") int32_t host_socket_close(int32_t fd);

S1_EXPORT("s1_boot") int32_t s1_boot(uint32_t capabilities) {
  if (booted) return kAlready;
  host_capabilities = capabilities;
  booted = 1;
  ticks = 0;
  event(kOk, "S1.0.0.0 booted");
  host_log(version_text, static_cast<uint32_t>(length(version_text)));
  return kOk;
}

S1_EXPORT("s1_version") const char* s1_version() { return version_text; }
S1_EXPORT("s1_name") const char* s1_name() { return kernel_name; }
S1_EXPORT("s1_is_booted") uint32_t s1_is_booted() { return booted; }
S1_EXPORT("s1_tick") uint64_t s1_tick() { return ++ticks; }
S1_EXPORT("s1_service_count") uint32_t s1_service_count() { return service_count; }

S1_EXPORT("s1_service_register") int32_t s1_service_register(const char* name, uint32_t flags) {
  if (!booted || !name || length(name) == 0 || length(name) >= kNameLimit) return kInvalid;
  if (find_service(name) >= 0) return kAlready;
  if (service_count >= kServiceLimit) return kNoSpace;
  Service& s = services[service_count];
  copy_text(s.name, sizeof(s.name), name);
  s.flags = flags;
  s.state = 0;
  s.starts = 0;
  event(kOk, "service registered");
  return static_cast<int32_t>(service_count++);
}

S1_EXPORT("s1_service_start") int32_t s1_service_start(const char* name) {
  const int32_t index = find_service(name);
  if (index < 0) return kNotFound;
  Service& s = services[index];
  if (s.state == 1) return kAlready;
  s.state = 1;
  ++s.starts;
  event(kOk, s.name);
  return kOk;
}

S1_EXPORT("s1_service_stop") int32_t s1_service_stop(const char* name) {
  const int32_t index = find_service(name);
  if (index < 0) return kNotFound;
  Service& s = services[index];
  if (s.state != 1) return kNotRunning;
  s.state = 2;
  event(kOk, s.name);
  return kOk;
}

S1_EXPORT("s1_service_state") int32_t s1_service_state(const char* name) {
  const int32_t index = find_service(name);
  return index < 0 ? kNotFound : static_cast<int32_t>(services[index].state);
}

S1_EXPORT("s1_service_name_at") const char* s1_service_name_at(uint32_t index) {
  return index < service_count ? services[index].name : empty_text;
}

S1_EXPORT("s1_service_flags_at") uint32_t s1_service_flags_at(uint32_t index) {
  return index < service_count ? services[index].flags : 0;
}

S1_EXPORT("s1_service_starts_at") uint32_t s1_service_starts_at(uint32_t index) {
  return index < service_count ? services[index].starts : 0;
}

// Virtual procfs. Return the number of bytes written, or a negative errno.
S1_EXPORT("s1_proc_read") int32_t s1_proc_read(const char* path, char* output, uint32_t capacity) {
  if (!booted || !path || !output || capacity == 0) return kInvalid;
  if (equal(path, "/proc/version")) {
    copy_out(version_text, output, capacity);
    return static_cast<int32_t>(length(output));
  }
  if (equal(path, "/proc/uptime")) {
    output[0] = '\0';
    size_t at = append(output, capacity, 0, "");
    at = append_u32(output, capacity, at, static_cast<uint32_t>(ticks / 100));
    at = append(output, capacity, at, ".00 0.00");
    return static_cast<int32_t>(length(output));
  }
  if (equal(path, "/proc/meminfo")) {
    output[0] = '\0';
    size_t at = append(output, capacity, 0, "S1 static kernel state\nServiceSlots: ");
    at = append_u32(output, capacity, at, kServiceLimit);
    at = append(output, capacity, at, "\nServicesUsed: ");
    at = append_u32(output, capacity, at, service_count);
    at = append(output, capacity, at, "\nEventSlots: ");
    at = append_u32(output, capacity, at, kEventLimit);
    return static_cast<int32_t>(length(output));
  }
  if (equal(path, "/proc/services")) {
    output[0] = '\0';
    size_t at = 0;
    for (uint32_t i = 0; i < service_count; ++i) {
      at = append(output, capacity, at, services[i].name);
      at = append(output, capacity, at, " state=");
      at = append_u32(output, capacity, at, services[i].state);
      at = append(output, capacity, at, " starts=");
      at = append_u32(output, capacity, at, services[i].starts);
      at = append(output, capacity, at, "\n");
      if (at + 1 >= capacity) break;
    }
    return static_cast<int32_t>(length(output));
  }
  if (equal(path, "/proc/events")) {
    output[0] = '\0';
    size_t at = 0;
    const uint32_t first = event_sequence > kEventLimit ? event_sequence - kEventLimit : 0;
    for (uint32_t seq = first; seq < event_sequence; ++seq) {
      const Event& e = events[seq % kEventLimit];
      if (e.sequence != seq + 1) continue;
      at = append(output, capacity, at, "#");
      at = append_u32(output, capacity, at, e.sequence);
      at = append(output, capacity, at, " code=");
      at = append_u32(output, capacity, at, static_cast<uint32_t>(e.code));
      at = append(output, capacity, at, " ");
      at = append(output, capacity, at, e.text);
      at = append(output, capacity, at, "\n");
      if (at + 1 >= capacity) break;
    }
    return static_cast<int32_t>(length(output));
  }
  return kNotFound;
}

S1_EXPORT("s1_socket_open") int32_t s1_socket_open(int32_t domain, int32_t type, int32_t protocol) {
  if (!booted || !(host_capabilities & 1u)) return -13;
  return host_socket_open(domain, type, protocol);
}
S1_EXPORT("s1_socket_connect") int32_t s1_socket_connect(int32_t fd, const char* address, uint32_t address_length) {
  if (!booted || !(host_capabilities & 1u)) return -13;
  if (!address || address_length == 0 || address_length > 256) return kInvalid;
  return host_socket_connect(fd, address, address_length);
}
S1_EXPORT("s1_socket_send") int32_t s1_socket_send(int32_t fd, const uint8_t* data, uint32_t length_bytes) {
  if (!booted || !(host_capabilities & 1u)) return -13;
  if (!data && length_bytes) return kInvalid;
  return host_socket_send(fd, data, length_bytes);
}
S1_EXPORT("s1_socket_recv") int32_t s1_socket_recv(int32_t fd, uint8_t* data, uint32_t capacity) {
  if (!booted || !(host_capabilities & 1u)) return -13;
  if (!data || capacity == 0) return kInvalid;
  return host_socket_recv(fd, data, capacity);
}
S1_EXPORT("s1_socket_close") int32_t s1_socket_close(int32_t fd) {
  if (!booted || !(host_capabilities & 1u)) return -13;
  return host_socket_close(fd);
}
}
