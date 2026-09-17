import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { Wexel, createBusyBoxRunner } from "../src/index.js";
import { NodeExecution } from "../src/node-execution.js";

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
  it("retorna erro de execução quando o módulo BusyBox não pode inicializar", async () => {
    const busyBox = await createBusyBoxRunner(async () => { throw new Error("artefato inválido"); }, "busybox.wasm");
    await expect(busyBox.run({ args: ["busybox", "echo", "ok"] })).resolves.toMatchObject({ exitCode: 1, stderr: expect.stringContaining("artefato inválido") });
  });
  it("executa comandos do shell virtual", async () => {
    const rt = await runtime();
    expect((await rt.shell.exec("pwd")).stdout).toBe("/home/wexel\n");
    expect((await rt.shell.exec("mkdir projeto")).exitCode).toBe(0);
    expect((await rt.shell.exec("ls")).stdout).toContain("projeto/.dir");
  });
  it("inicializa uma VFS Linux-like e resolve ~ para o home virtual", async () => {
    const rt = await runtime();
    expect(rt.fs.home).toBe("/home/wexel");
    expect(rt.fs.exists("/bin")).toBe(true);
    expect(rt.fs.exists("/tmp")).toBe(true);
    rt.fs.write("~/arquivo.txt", "isolado");
    expect(rt.fs.readText("/home/wexel/arquivo.txt")).toBe("isolado");
  });
  it("bloqueia rede por padrão", async () => {
    const rt = await runtime();
    const result = await rt.shell.exec("curl https://example.com");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Permissão de rede negada");
  });
  it("aplica uma quota lógica de 5 GB sem reservar RAM na inicialização", async () => {
    const rt = await runtime();
    rt.fs.write("hello.txt", "Olá");
    expect(rt.fs.quota.usedBytes).toBeGreaterThan(0);
    expect(rt.fs.quota.limitBytes).toBe(5 * 1024 * 1024 * 1024);
    expect(new TextDecoder().decode(rt.fs.read("hello.txt"))).toBe("Olá");
  });
  it("permite carregar sem executar no modo load-only", async () => {
    const rt = await Wexel.create({ mode: "load-only", coreBytes: await readFile(new URL("../../wexel-core/dist/core.wasm", import.meta.url)) });
    expect((await rt.exec({ language: "javascript", code: "throw new Error()" })).exitCode).toBe(0);
  });
  it("executa comandos deno usando a VFS e um runtime Deno/WebAssembly registrado", async () => {
    const rt = await Wexel.create({ coreBytes: await readFile(new URL("../../wexel-core/dist/core.wasm", import.meta.url)), denoRunner: async (code) => ({ stdout: code, stderr: "", exitCode: 0 }) });
    rt.fs.write("/programa.ts", "console.log(42)");
    expect((await rt.shell.exec("deno run /programa.ts argumento")).stdout).toContain("console.log(42)");
    expect((await rt.shell.exec('deno eval "console.log(1)"')).stdout).toContain("console.log(1)");
    expect((await rt.shell.exec("deno run /programa.py")).exitCode).toBe(2);
  });
  it("isola múltiplas sandboxes de backend sem executar scripts ao criá-las", async () => {
    const coreBytes = await readFile(new URL("../../wexel-core/dist/core.wasm", import.meta.url));
    const execution = await NodeExecution.create({ coreBytes });
    const first = await execution.createSandbox({ id: "primeira" });
    const second = await execution.createSandbox({ id: "segunda" });
    first.runtime.fs.write("/somente-na-primeira.txt", "ok");
    expect(first.runtime.fs.home).toBe("/home/primeira");
    expect(second.runtime.fs.exists("/somente-na-primeira.txt")).toBe(false);
    expect(execution.listSandboxes().map((sandbox) => sandbox.id)).toEqual(["primeira", "segunda"]);
    expect(execution.destroySandbox("primeira")).toBe(true);
    expect(execution.getSandbox("primeira")).toBeUndefined();
  });
  it("conecta sandboxes pela microrede Web Pink e limita a internet do host", async () => {
    const coreBytes = await readFile(new URL("../../wexel-core/dist/core.wasm", import.meta.url));
    const execution = await NodeExecution.create({
      coreBytes,
      webPink: { allowHosts: ["api.example.com"], fetcher: async () => new Response("ok") },
    });
    const api = await execution.createSandbox({ id: "api", permissions: { network: true } });
    const worker = await execution.createSandbox({ id: "worker" });
    api.webPink!.send("worker", { type: "job" });
    expect(worker.webPink!.receive()[0]).toMatchObject({ from: "api", payload: { type: "job" } });
    expect((await api.runtime.shell.exec("curl https://api.example.com/status")).stdout).toBe("ok");
    const denied = await api.runtime.shell.exec("curl https://blocked.example.com");
    expect(denied.exitCode).toBe(1);
    expect(denied.stderr).toContain("Web Pink bloqueou host");
  });
  it("expõe comandos Linux-like adicionais sem subprocesso implícito", async () => {
    const rt = await runtime();
    expect((await rt.shell.exec("touch a.txt")).exitCode).toBe(0);
    expect((await rt.shell.exec("echo olá")).stdout).toContain("olá");
    expect((await rt.shell.exec("whoami")).stdout).toContain("wexel");
    expect((await rt.shell.exec("uname")).stdout).toContain("wasm32");
    expect((await rt.shell.exec("rm a.txt")).exitCode).toBe(0);
    expect(rt.fs.exists("a.txt")).toBe(false);
  });
  it("monta HTML e CSS no V9 sem executar JavaScript", async () => {
    const rt = await runtime();
    const html = rt.createWebDocument({ html: "<main>ok</main>", css: "main { color: red }" });
    expect(html).toContain("<main>ok</main>");
    expect(html).toContain("main { color: red }");
  });
  it("aceita um executor CPython/WebAssembly real por adapter", async () => {
    const rt = await runtime();
    const python = await Wexel.create({ coreBytes: await readFile(new URL("../../wexel-core/dist/core.wasm", import.meta.url)), pythonRunner: async () => ({ stdout: "42\n", stderr: "", exitCode: 0 }) });
    expect((await python.exec({ language: "python", code: "print(42)" })).stdout).toBe("42\n");
    expect(rt).toBeDefined();
  });
});
