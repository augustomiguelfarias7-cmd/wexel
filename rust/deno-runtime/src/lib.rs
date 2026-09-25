//! wexel-deno-runtime
//!
//! Runtime WASM que implementa as syscalls necessárias para o Deno
//! achar que está rodando num Linux real dentro do browser.
//!
//! Cada syscall é uma função extern "C" exposta ao JS host via wasm-bindgen.
//! O JS host (WasmFsClient + NetBridgeWorker) responde via SharedArrayBuffer.
//!
//! Arquitetura de threads (igual ao WebContainers):
//!   - WebAssembly.Memory({ shared: true }) compartilhada entre Workers
//!   - Cada Web Worker instancia o mesmo módulo WASM com a mesma memória
//!   - memory.atomic.wait32 / memory.atomic.notify para sincronização

use wasm_bindgen::prelude::*;

// ── Imports do JS host ────────────────────────────────────────────────────────
// Estas funções são implementadas no TypeScript (WasmFsClient, NetBridgeWorker)
// e injetadas no módulo WASM pelo host.

#[wasm_bindgen]
extern "C" {
    // Filesystem
    #[wasm_bindgen(js_namespace = ["__wexel_syscalls"], js_name = "fs_read")]
    fn host_fs_read(path: &str) -> Vec<u8>;

    #[wasm_bindgen(js_namespace = ["__wexel_syscalls"], js_name = "fs_write")]
    fn host_fs_write(path: &str, data: &[u8]);

    #[wasm_bindgen(js_namespace = ["__wexel_syscalls"], js_name = "fs_exists")]
    fn host_fs_exists(path: &str) -> bool;

    #[wasm_bindgen(js_namespace = ["__wexel_syscalls"], js_name = "fs_mkdir")]
    fn host_fs_mkdir(path: &str);

    #[wasm_bindgen(js_namespace = ["__wexel_syscalls"], js_name = "fs_remove")]
    fn host_fs_remove(path: &str);

    #[wasm_bindgen(js_namespace = ["__wexel_syscalls"], js_name = "fs_list")]
    fn host_fs_list(path: &str) -> String; // JSON array

    #[wasm_bindgen(js_namespace = ["__wexel_syscalls"], js_name = "fs_cwd")]
    fn host_fs_cwd() -> String;

    #[wasm_bindgen(js_namespace = ["__wexel_syscalls"], js_name = "fs_cd")]
    fn host_fs_cd(path: &str);

    #[wasm_bindgen(js_namespace = ["__wexel_syscalls"], js_name = "env_get")]
    fn host_env_get(key: &str) -> String;

    #[wasm_bindgen(js_namespace = ["__wexel_syscalls"], js_name = "stdout_write")]
    fn host_stdout_write(text: &str);

    #[wasm_bindgen(js_namespace = ["__wexel_syscalls"], js_name = "stderr_write")]
    fn host_stderr_write(text: &str);

    #[wasm_bindgen(js_namespace = ["__wexel_syscalls"], js_name = "proc_exit")]
    fn host_proc_exit(code: i32);
}

// ── ABI de versão ─────────────────────────────────────────────────────────────

/// Versão da ABI do runtime Wexel-Deno.
/// O TypeScript verifica isso antes de usar o módulo.
#[wasm_bindgen]
pub fn wexel_deno_abi_version() -> u32 {
    10000
}

// ── Syscalls de filesystem ────────────────────────────────────────────────────

#[wasm_bindgen]
pub fn wexel_fs_read(path: &str) -> Vec<u8> {
    host_fs_read(path)
}

#[wasm_bindgen]
pub fn wexel_fs_read_text(path: &str) -> String {
    let bytes = host_fs_read(path);
    String::from_utf8(bytes).unwrap_or_default()
}

#[wasm_bindgen]
pub fn wexel_fs_write(path: &str, data: &[u8]) {
    host_fs_write(path, data);
}

#[wasm_bindgen]
pub fn wexel_fs_write_text(path: &str, text: &str) {
    host_fs_write(path, text.as_bytes());
}

#[wasm_bindgen]
pub fn wexel_fs_exists(path: &str) -> bool {
    host_fs_exists(path)
}

#[wasm_bindgen]
pub fn wexel_fs_mkdir(path: &str) {
    host_fs_mkdir(path);
}

#[wasm_bindgen]
pub fn wexel_fs_remove(path: &str) {
    host_fs_remove(path);
}

#[wasm_bindgen]
pub fn wexel_fs_list(path: &str) -> String {
    host_fs_list(path)
}

#[wasm_bindgen]
pub fn wexel_fs_cwd() -> String {
    host_fs_cwd()
}

#[wasm_bindgen]
pub fn wexel_fs_cd(path: &str) {
    host_fs_cd(path);
}

// ── Syscalls de processo ──────────────────────────────────────────────────────

#[wasm_bindgen]
pub fn wexel_env_get(key: &str) -> String {
    host_env_get(key)
}

#[wasm_bindgen]
pub fn wexel_stdout_write(text: &str) {
    host_stdout_write(text);
}

#[wasm_bindgen]
pub fn wexel_stderr_write(text: &str) {
    host_stderr_write(text);
}

#[wasm_bindgen]
pub fn wexel_proc_exit(code: i32) {
    host_proc_exit(code);
}

// ── Memória compartilhada (threads) ───────────────────────────────────────────
//
// Estas funções implementam sincronização entre threads via
// memory.atomic operações — a mesma técnica que o WebContainers usa.
//
// O layout da memória compartilhada:
//   [0..4]   i32 — lock de syscall (0=livre, 1=ocupado)
//   [4..8]   i32 — tamanho do payload
//   [8..]    u8  — payload de dados

/// Tamanho da seção de controle no início da memória compartilhada.
pub const SHARED_CTRL_BYTES: usize = 8;
/// Capacidade do payload por operação.
pub const SHARED_PAYLOAD_BYTES: usize = 512 * 1024; // 512 KB

/// Executa uma operação de syscall usando memória compartilhada.
/// Esta função pode ser chamada de qualquer thread WASM.
#[wasm_bindgen]
pub fn wexel_alloc(size: usize) -> *mut u8 {
    let mut buf = Vec::with_capacity(size);
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr
}

/// Libera memória alocada por wexel_alloc.
#[wasm_bindgen]
pub fn wexel_free(ptr: *mut u8, size: usize) {
    unsafe {
        let _ = Vec::from_raw_parts(ptr, 0, size);
    }
}

// ── Executor de código JS/TS via host ─────────────────────────────────────────

/// Representa o resultado de uma execução.
#[wasm_bindgen]
pub struct ExecResult {
    pub exit_code: i32,
}

#[wasm_bindgen]
impl ExecResult {
    #[wasm_bindgen(constructor)]
    pub fn new(exit_code: i32) -> ExecResult {
        ExecResult { exit_code }
    }
}

/// Inicializa o runtime para uma nova execução.
/// Chamado pelo Web Worker antes de executar código.
#[wasm_bindgen]
pub fn wexel_runtime_init() {
    // Inicializa o panic handler para capturar erros Rust → stderr
    #[cfg(target_arch = "wasm32")]
    std::panic::set_hook(Box::new(|info| {
        let msg = info.to_string();
        host_stderr_write(&format!("[wexel-runtime panic] {}\n", msg));
    }));
}
