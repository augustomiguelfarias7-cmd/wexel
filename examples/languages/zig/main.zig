const std = @import("std");

pub fn main() void {
    std.debug.print("Hello from Zig compiled to WebAssembly inside Wexel\n", .{});
    std.debug.print("2 + 40 = {d}\n", .{2 + 40});
}
