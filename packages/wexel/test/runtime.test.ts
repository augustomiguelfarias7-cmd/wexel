import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { Wexel } from "../src/index.js";

async function runtime() {
  const core = await readFile(new URL("../../wexel-core/dist/core.wasm", import.meta.url));
  return Wexel.create({ coreBytes: core });
}

describe("Wexel runtime", () => {
  it("instancia o Execution Core WebAssembly", async () => {
    const rt = await runtime();
    expect(rt.core.exports.add(20, 22)).toBe(42);
    expect(rt.core.exports.memory).toBeInstanceOf(WebAssembly.Memory);
  });
  it("executa comandos do shell virtual", async () => {
    const rt = await runtime();
    expect((await rt.shell.exec("pwd")).stdout).toBe("/\n");
    expect((await rt.shell.exec("mkdir projeto")).exitCode).toBe(0);
    expect((await rt.shell.exec("ls")).stdout).toContain("projeto/.dir");
  });
  it("bloqueia rede por padrão", async () => {
    const rt = await runtime();
    const result = await rt.shell.exec("curl https://example.com");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Permissão de rede negada");
  });
  it("aplica uma quota lógica sem reservar 3 GB de RAM", async () => {
    const rt = await runtime();
    rt.fs.write("hello.txt", "Olá");
    expect(rt.fs.quota.usedBytes).toBeGreaterThan(0);
    expect(rt.fs.quota.limitBytes).toBe(3 * 1024 * 1024 * 1024);
    expect(new TextDecoder().decode(rt.fs.read("hello.txt"))).toBe("Olá");
  });
  it("permite carregar sem executar no modo load-only", async () => {
    const rt = await Wexel.create({ mode: "load-only", coreBytes: await readFile(new URL("../../wexel-core/dist/core.wasm", import.meta.url)) });
    expect((await rt.exec({ language: "javascript", code: "throw new Error()" })).exitCode).toBe(0);
  });
  it("roteia JavaScript e TypeScript para um adapter Deno/WASM", async () => {
    const rt = await Wexel.create({ coreBytes: await readFile(new URL("../../wexel-core/dist/core.wasm", import.meta.url)), denoRunner: async (code) => ({ stdout: code, stderr: "", exitCode: 0 }) });
    expect((await rt.exec({ language: "typescript", code: "console.log(1)" })).stdout).toContain("console.log");
  });
  it("aceita um executor CPython/WebAssembly real por adapter", async () => {
    const rt = await runtime();
    const python = await Wexel.create({ coreBytes: await readFile(new URL("../../wexel-core/dist/core.wasm", import.meta.url)), pythonRunner: async () => ({ stdout: "42\n", stderr: "", exitCode: 0 }) });
    expect((await python.exec({ language: "python", code: "print(42)" })).stdout).toBe("42\n");
    expect(rt).toBeDefined();
  });
});
