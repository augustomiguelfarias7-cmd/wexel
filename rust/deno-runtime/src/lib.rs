//! Wexel Deno runtime host boundary.
//!
//! The Deno build is treated as a Linux guest. OS-facing operations are
//! routed through the dedicated Linux compatibility layer in linux_adapter.
//! The compatibility layer is separate from Wexel's generic JS execution
//! helpers so the Deno path does not depend on a JavaScript Deno shim.

use wasm_bindgen::prelude::*;

pub mod linux_adapter;

// ── Legacy Wexel host helpers ────────────────────────────────────────────────
// These helpers remain available to existing Wexel integration code. The
// actual Deno/Linux integration should use linux_adapter's C-compatible ABI.

#[wasm_bindgen]
extern "C" {
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
    fn host_fs_list(path: &str) -> String;
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

pub const WEXEL_DENO_ABI_VERSION: u32 = linux_adapter::WEXEL_DENO_LINUX_ABI;

#[wasm_bindgen]
pub fn wexel_deno_abi_version() -> u32 {
    WEXEL_DENO_ABI_VERSION
}

#[wasm_bindgen]
pub fn wexel_fs_read(path: &str) -> Vec<u8> {
    host_fs_read(path)
}

#[wasm_bindgen]
pub fn wexel_fs_read_text(path: &str) -> String {
    String::from_utf8(host_fs_read(path)).unwrap_or_default()
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

pub const SHARED_CTRL_BYTES: usize = 8;
pub const SHARED_PAYLOAD_BYTES: usize = 512 * 1024;

#[wasm_bindgen]
pub fn wexel_alloc(size: usize) -> *mut u8 {
    let mut buf = Vec::with_capacity(size);
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr
}

#[wasm_bindgen]
pub fn wexel_free(ptr: *mut u8, size: usize) {
    unsafe {
        let _ = Vec::from_raw_parts(ptr, 0, size);
    }
}

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

#[wasm_bindgen]
pub fn wexel_runtime_init() {
    #[cfg(target_arch = "wasm32")]
    std::panic::set_hook(Box::new(|info| {
        host_stderr_write(&format!("[wexel-runtime panic] {}\n", info));
    }));
}
