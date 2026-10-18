import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WexelOrchester } from "./wexel-orchester.js";

const temporaryDirectories: string[] = [];

async function makeFakeWorker(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "wexel-orchester-test-"));
  temporaryDirectories.push(directory);
  const workerPath = join(directory, "worker.mjs");
  await writeFile(workerPath, `
process.on("message", (message) => {
  if (message.type === "init") {
    process.send({ type: "ready" });
  } else if (message.type === "exec") {
    process.send({
      type: "result",
      requestId: message.requestId,
      result: { stdout: message.request.code ?? "", stderr: "", exitCode: 0 }
    });
  } else if (message.type === "shutdown") {
    process.disconnect();
    setImmediate(() => process.exit(0));
  }
});
`);
  return workerPath;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("WexelOrchester", () => {
  it("requires a non-empty Core artifact", () => {
    expect(() => WexelOrchester.create({ coreBytes: new Uint8Array() })).toThrow(/não vazio/i);
  });

  it("starts isolated workers, executes IPC requests and shuts them down", async () => {
    const workerPath = await makeFakeWorker();
    const events: string[] = [];
    const orchestrator = WexelOrchester.create({
      coreBytes: new Uint8Array([0, 97, 115, 109]),
      workerPath,
      startupTimeoutMs: 3000,
      shutdownTimeoutMs: 1000,
      onEvent: (event) => events.push(event.type),
    });

    try {
      const first = await orchestrator.createSandbox();
      const second = await orchestrator.createSandbox();
      expect(first.id).toMatch(/^[A-Z]{3}$/);
      expect(second.id).toMatch(/^[A-Z]{3}$/);
      expect(first.id).not.toBe(second.id);
      expect(first.pid).toBeDefined();
      expect(second.pid).toBeDefined();
      expect(first.pid).not.toBe(second.pid);
      expect(first.status).toBe("ready");
      expect(await first.exec({ language: "javascript", code: "ipc-ok" })).toEqual({
        stdout: "ipc-ok",
        stderr: "",
        exitCode: 0,
      });
      expect(events).toContain("sandbox-ready");
      expect(events).toContain("command-result");
      expect(await orchestrator.destroySandbox(first.id)).toBe(true);
      expect(await orchestrator.destroySandbox(first.id)).toBe(false);
      expect(orchestrator.listSandboxes()).toHaveLength(1);
    } finally {
      await orchestrator.dispose();
    }
    expect(orchestrator.listSandboxes()).toHaveLength(0);
  });

  it("rejects invalid and duplicate sandbox IDs", async () => {
    const orchestrator = WexelOrchester.create({
      coreBytes: new Uint8Array([1]),
      workerPath: await makeFakeWorker(),
      startupTimeoutMs: 3000,
    });
    try {
      await expect(orchestrator.createSandbox({ id: "bad" })).rejects.toThrow(/três letras/i);
      const sandbox = await orchestrator.createSandbox({ id: "ABC" });
      await expect(orchestrator.createSandbox({ id: "ABC" })).rejects.toThrow(/já existe/i);
      expect(sandbox.id).toBe("ABC");
    } finally {
      await orchestrator.dispose();
    }
  });
});
