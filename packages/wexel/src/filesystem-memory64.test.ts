import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { coreSourceUrl, instantiateCore } from "@wexel/core";
import { WexelMemory64FileSystem } from "./filesystem.js";
import type { WexelCoreInstance } from "@wexel/core";

function makeCore(): WexelCoreInstance {
  const memory = new WebAssembly.Memory({ initial: 256, maximum: 1024 });
  let next = 1024n;
  const live = new Set<bigint>();
  const exports = {
    memory,
    wexel_memory64_pointer_bits: () => 64,
    wexel_memory64_set_limit: () => 1,
    wexel_memory64_limit_bytes: () => 16n * 1024n ** 3n,
    wexel_memory64_size_bytes: () => BigInt(memory.buffer.byteLength),
    wexel_memory64_grow: () => 1,
    wexel_memory64_alloc: (size: bigint) => {
      if (size <= 0n) return 0n;
      const aligned = (next + 15n) & ~15n;
      const end = aligned + size;
      const required = Number(end);
      if (required > memory.buffer.byteLength) {
        const pages = Math.ceil((required - memory.buffer.byteLength) / 65536);
        try { memory.grow(pages); } catch { return 0n; }
      }
      next = end;
      live.add(aligned);
      return aligned;
    },
    wexel_memory64_free: (pointer: bigint) => { live.delete(pointer); },
  };
  return { instance: {} as WebAssembly.Instance, exports } as unknown as WexelCoreInstance;
}

describe("WexelMemory64FileSystem", () => {
  it("uses a 5 GiB logical quota by default without reserving it", () => {
    const fs = new WexelMemory64FileSystem(makeCore());
    expect(fs.quota.limitBytes).toBe(5 * 1024 ** 3);
    expect(fs.quota.usedBytes).toBe(0);
  });

  it("stores file payloads in Core linear memory and supports directories", () => {
    const core = makeCore();
    const fs = new WexelMemory64FileSystem(core);
    fs.mkdir("/home/demo/nested");
    fs.write("/home/demo/nested/hello.txt", "hello Memory64");
    expect(fs.readText("/home/demo/nested/hello.txt")).toBe("hello Memory64");
    expect(fs.list("/home/demo")).toContain("nested/hello.txt");
    expect(fs.exists("/home/demo/nested")).toBe(true);
    expect(fs.quota.usedBytes).toBe(new TextEncoder().encode("hello Memory64").byteLength);
    expect(fs.snapshot().map((entry) => entry.path)).toContain("/home/demo/nested/hello.txt");
  });

  it("replaces and recursively removes files while updating logical quota", () => {
    const fs = new WexelMemory64FileSystem(makeCore());
    fs.write("/home/wexel/a.txt", "old");
    fs.write("/home/wexel/a.txt", "new value");
    expect(fs.readText("/home/wexel/a.txt")).toBe("new value");
    expect(fs.quota.usedBytes).toBe(9);
    fs.remove("/home/wexel");
    expect(fs.exists("/home/wexel/a.txt")).toBe(false);
    expect(fs.quota.usedBytes).toBe(0);
  });
});

it("integrates with the compiled Memory64 Core artifact", async () => {
  const core = await instantiateCore(await readFile(new URL(coreSourceUrl())));
  const fs = new WexelMemory64FileSystem(core);
  fs.mkdir("/home/integration/nested");
  fs.write("/home/integration/nested/core.txt", "stored in Core linear memory");
  expect(fs.readText("/home/integration/nested/core.txt")).toBe("stored in Core linear memory");
  expect(fs.list("/home/integration")).toContain("nested/core.txt");
  fs.remove("/home/integration");
  expect(fs.exists("/home/integration/nested/core.txt")).toBe(false);
  expect(fs.quota.usedBytes).toBe(0);
});
