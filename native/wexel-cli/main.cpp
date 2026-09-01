#include <cstdint>

extern "C" {

// ABI mínima e estável para CLIs nativas do Wexel Assembly.
uint32_t wexel_cli_abi_version() { return 20001; }

uint32_t wexel_cli_add(uint32_t left, uint32_t right) {
  return left + right;
}

uint32_t wexel_cli_exit_code() { return 0; }

}
