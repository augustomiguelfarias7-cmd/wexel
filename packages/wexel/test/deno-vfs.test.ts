import { describe, expect, it } from "vitest";
import { WexelFileSystem } from "../src/index.js";
import {
  denoLanguageFromPath,
  isDenoSourcePath,
  listDenoSources,
  readDenoSource,
  saveDenoSource,
} from "../src/deno-vfs.js";

describe("Deno VFS source routing", () => {
  it("routes JavaScript and TypeScript extensions", () => {
    expect(denoLanguageFromPath("/app/main.js")).toBe("javascript");
    expect(denoLanguageFromPath("/app/main.mjs")).toBe("javascript");
    expect(denoLanguageFromPath("/app/main.ts")).toBe("typescript");
    expect(denoLanguageFromPath("/app/main.mts")).toBe("typescript");
    expect(denoLanguageFromPath("/app/readme.md")).toBeUndefined();
  });

  it("stores and reads source through the VFS", () => {
    const fs = new WexelFileSystem();
    const js = saveDenoSource(fs, "/home/wexel/main.js", "console.log('js')");
    const ts = saveDenoSource(fs, "/home/wexel/main.ts", "const value: number = 42;");

    expect(js.language).toBe("javascript");
    expect(ts.language).toBe("typescript");
    expect(readDenoSource(fs, "/home/wexel/main.ts").source).toContain("42");
    expect(isDenoSourcePath("/home/wexel/main.ts")).toBe(true);
  });

  it("lists only Deno source files", () => {
    const fs = new WexelFileSystem();
    saveDenoSource(fs, "/home/wexel/main.js", "console.log(1)");
    saveDenoSource(fs, "/home/wexel/main.ts", "console.log(2)");
    fs.write("/home/wexel/readme.md", "# Wexel");

    expect(listDenoSources(fs)).toHaveLength(2);
  });
});
