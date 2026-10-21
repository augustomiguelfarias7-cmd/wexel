import { describe, expect, it } from "vitest";
import { WexelServiceManager } from "../src/service-manager.js";

describe("WexelServiceManager", () => {
  it("starts services in registration order and stops them in reverse order", async () => {
    const manager = new WexelServiceManager();
    const calls: string[] = [];
    manager.register("memory", { start: () => { calls.push("start:memory"); }, stop: () => { calls.push("stop:memory"); } });
    manager.register("network", { start: () => { calls.push("start:network"); }, stop: () => { calls.push("stop:network"); } });

    await manager.startAll();
    expect(manager.getState("memory")).toBe("running");
    expect(manager.getState("network")).toBe("running");
    await manager.stopAll();

    expect(calls).toEqual(["start:memory", "start:network", "stop:network", "stop:memory"]);
    expect(manager.getState("memory")).toBe("stopped");
    expect(manager.getState("network")).toBe("stopped");
  });

  it("rolls back services already started when startup fails", async () => {
    const manager = new WexelServiceManager();
    const calls: string[] = [];
    manager.register("first", { start: () => { calls.push("start:first"); }, stop: () => { calls.push("stop:first"); } });
    manager.register("second", { start: () => { throw new Error("startup failed"); } });

    await expect(manager.startAll()).rejects.toThrow("startup failed");
    expect(calls).toEqual(["start:first", "stop:first"]);
    expect(manager.getState("first")).toBe("stopped");
    expect(manager.getState("second")).toBe("failed");
  });

  it("rejects duplicate names and reports service state", async () => {
    const manager = new WexelServiceManager();
    manager.register("cache", {});
    expect(() => manager.register("cache", {})).toThrow("Serviço já registrado: cache");
    expect(manager.list()).toEqual([{ name: "cache", state: "registered" }]);
    await manager.start("cache");
    expect(manager.getState("cache")).toBe("running");
  });
});
