import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { S1Kernel } from "./s1-kernel.js";

const wasmPath = fileURLToPath(new URL("../assets/s-kernel/s1.wasm", import.meta.url));

describe("S1 WebAssembly kernel", () => {
  it("boots with the declared version and virtual proc entries", async () => {
    const kernel = await S1Kernel.boot({ wasmPath });
    expect(kernel.version).toBe("S version S1.0.0.0");
    expect(kernel.readProc("/proc/version")).toBe("S version S1.0.0.0");
    expect(kernel.readProc("/proc/meminfo")).toContain("ServicesUsed: 0");
  });

  it("manages service lifecycle state and exposes it through procfs", async () => {
    const kernel = await S1Kernel.boot({ wasmPath });
    expect(kernel.registerService("busybox", 1)).toBe(0);
    expect(kernel.startService("busybox")).toBe(0);
    expect(kernel.serviceState("busybox")).toBe(1);
    expect(kernel.readProc("/proc/services")).toContain("busybox state=1");
    expect(kernel.stopService("busybox")).toBe(0);
    expect(kernel.serviceState("busybox")).toBe(2);
  });

  it("denies sockets unless the host explicitly grants network capability", async () => {
    const kernel = await S1Kernel.boot({ wasmPath });
    expect(kernel.openSocket(2, 1)).toBe(-13);
  });
});
