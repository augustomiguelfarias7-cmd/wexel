// SPDX-License-Identifier: Apache-2.0
#include <stdint.h>

namespace {
alignas(16) uint8_t io_arena[65536];
uint32_t io_cursor = 0;
}

extern "C" {
__attribute__((export_name("s1_alloc")))
uint32_t s1_alloc(uint32_t size) {
  if (size == 0 || size > sizeof(io_arena)) return 0;
  const uint32_t aligned = (io_cursor + 15u) & ~15u;
  if (aligned > sizeof(io_arena) || size > sizeof(io_arena) - aligned) return 0;
  io_cursor = aligned + size;
  return static_cast<uint32_t>(reinterpret_cast<uintptr_t>(io_arena + aligned));
}

__attribute__((export_name("s1_reset_alloc")))
void s1_reset_alloc() {
  io_cursor = 0;
}
}
