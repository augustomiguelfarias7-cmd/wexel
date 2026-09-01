#![no_std]

use core::panic::PanicInfo;

#[panic_handler]
fn panic(_info: &PanicInfo) -> ! {
    loop {}
}

#[no_mangle]
pub extern "C" fn rustv_abi_version() -> u32 {
    20001
}

#[no_mangle]
pub extern "C" fn rustv_add(left: u32, right: u32) -> u32 {
    left.saturating_add(right)
}

#[no_mangle]
pub extern "C" fn rustv_exit_code() -> u32 {
    0
}
