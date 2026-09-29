//! Linux-facing compatibility layer for the Deno guest runtime.
//!
//! The Deno build used by Wexel is treated as a Linux runtime. This module
//! translates the OS-facing operations Deno expects into Wexel host calls.
//! It deliberately does not emulate a Linux kernel and does not expose the
//! host filesystem or host network directly.
//!
//! Guest view:
//!   Linux/Deno -> Wexel Linux adapter -> Wexel VFS / WebPink / process policy
//!
//! The ABI is intentionally C-compatible so a Deno build can call it without
//! depending on wasm-bindgen-generated JavaScript glue.

use core::ffi::c_char;

pub const WEXEL_DENO_LINUX_ABI: u32 = 30002;
pub const AT_FDCWD: i32 = -100;

#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct WexelIoResult {
    pub code: i32,
    pub value: i64,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct WexelStat {
    pub kind: u32,
    pub mode: u32,
    pub size: u64,
    pub mtime_ns: u64,
}

pub const WEXEL_FILE: u32 = 1;
pub const WEXEL_DIRECTORY: u32 = 2;

#[link(wasm_import_module = "__wexel_linux")]
extern "C" {
    fn fs_open(path: *const c_char, flags: u32, mode: u32) -> i32;
    fn fs_close(fd: i32) -> i32;
    fn fs_read(fd: i32, dst: *mut u8, len: usize) -> i64;
    fn fs_write(fd: i32, src: *const u8, len: usize) -> i64;
    fn fs_seek(fd: i32, offset: i64, whence: i32) -> i64;
    fn fs_stat(path: *const c_char, out: *mut WexelStat) -> i32;
    fn fs_mkdir(path: *const c_char, mode: u32) -> i32;
    fn fs_unlink(path: *const c_char) -> i32;
    fn fs_rename(old: *const c_char, new: *const c_char) -> i32;
    fn fs_getcwd(dst: *mut u8, len: usize) -> i64;

    fn env_get(key: *const c_char, value: *mut u8, len: usize) -> i64;

    fn net_request(
        method: *const c_char,
        url: *const c_char,
        body: *const u8,
        body_len: usize,
        out_status: *mut u16,
    ) -> i32;

    fn clock_now_ns() -> u64;
    fn sleep_ms(ms: u64) -> i32;

    fn stdout_write(ptr: *const u8, len: usize) -> i64;
    fn stderr_write(ptr: *const u8, len: usize) -> i64;
    fn proc_exit(code: i32) -> !;
}

pub unsafe fn open(path: *const c_char, flags: u32, mode: u32) -> i32 {
    fs_open(path, flags, mode)
}

pub unsafe fn close(fd: i32) -> i32 {
    fs_close(fd)
}

pub unsafe fn read(fd: i32, dst: &mut [u8]) -> i64 {
    fs_read(fd, dst.as_mut_ptr(), dst.len())
}

pub unsafe fn write(fd: i32, src: &[u8]) -> i64 {
    fs_write(fd, src.as_ptr(), src.len())
}

pub unsafe fn seek(fd: i32, offset: i64, whence: i32) -> i64 {
    fs_seek(fd, offset, whence)
}

pub unsafe fn stat(path: *const c_char, out: &mut WexelStat) -> i32 {
    fs_stat(path, out as *mut WexelStat)
}

pub unsafe fn mkdir(path: *const c_char, mode: u32) -> i32 {
    fs_mkdir(path, mode)
}

pub unsafe fn unlink(path: *const c_char) -> i32 {
    fs_unlink(path)
}

pub unsafe fn rename(old: *const c_char, new: *const c_char) -> i32 {
    fs_rename(old, new)
}

pub unsafe fn getcwd(dst: &mut [u8]) -> i64 {
    fs_getcwd(dst.as_mut_ptr(), dst.len())
}

pub unsafe fn get_env(key: *const c_char, value: &mut [u8]) -> i64 {
    env_get(key, value.as_mut_ptr(), value.len())
}

pub unsafe fn network_request(
    method: *const c_char,
    url: *const c_char,
    body: &[u8],
    status: &mut u16,
) -> i32 {
    net_request(method, url, body.as_ptr(), body.len(), status)
}

pub fn now_ns() -> u64 {
    unsafe { clock_now_ns() }
}

pub fn sleep(milliseconds: u64) -> i32 {
    unsafe { sleep_ms(milliseconds) }
}

pub fn stdout(bytes: &[u8]) -> i64 {
    unsafe { stdout_write(bytes.as_ptr(), bytes.len()) }
}

pub fn stderr(bytes: &[u8]) -> i64 {
    unsafe { stderr_write(bytes.as_ptr(), bytes.len()) }
}

pub fn exit(code: i32) -> ! {
    unsafe { proc_exit(code) }
}

/// Normalize a Linux-style absolute path before passing it to the Wexel VFS.
///
/// The adapter never resolves paths against the host filesystem. Parent
/// traversal is collapsed inside the guest namespace and cannot escape /.
pub fn normalize_guest_path(input: &str) -> Result<String, &'static str> {
    if !input.starts_with('/') {
        return Err("path must be absolute");
    }

    let mut parts: Vec<&str> = Vec::new();
    for part in input.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.pop().is_none() {
                    return Err("path escapes guest root");
                }
            }
            value => parts.push(value),
        }
    }

    if parts.is_empty() {
        Ok("/".to_owned())
    } else {
        Ok(format!("/{}", parts.join("/")))
    }
}
