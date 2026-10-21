import { describe, expect, it } from "vitest";
import { WexelLifecycleManager } from "../src/lifecycle-manager.js";

describe("WexelLifecycleManager", () => {
  it("tracks startup, recovery, and shutdown states", async () => {
    const lifecycle = new WexelLifecycleManager();
    expect(lifecycle.state).toBe("created");

    lifecycle.starting();
    expect(lifecycle.state).toBe("starting");
    lifecycle.running();
    expect(lifecycle.snapshot().state).toBe("running");

    await lifecycle.recover(async () => {});
    expect(lifecycle.state).toBe("running");

    lifecycle.stopping();
    lifecycle.stopped();
    expect(lifecycle.state).toBe("stopped");
  });

  it("tracks and recovers any registered integration, not just a specific language", async () => {
    const lifecycle = new WexelLifecycleManager();
    let pythonLoads = 0;
    let nativeLoads = 0;
    lifecycle.registerComponent("executor:python", async () => { pythonLoads += 1; });
    lifecycle.registerComponent("extension:native-demo", async () => { nativeLoads += 1; });

    lifecycle.starting();
    await lifecycle.initializeComponents();
    lifecycle.running();
    expect(lifecycle.componentSnapshots()).toEqual([
      { name: "executor:python", state: "ready", required: true },
      { name: "extension:native-demo", state: "ready", required: true },
    ]);

    await lifecycle.recoverComponent("executor:python");
    expect(pythonLoads).toBe(2);
    expect(nativeLoads).toBe(1);
    expect(lifecycle.componentSnapshots()[0].state).toBe("ready");
    expect(lifecycle.state).toBe("running");
  });

  it("records a failed component and can retry its initializer", async () => {
    const lifecycle = new WexelLifecycleManager();
    let attempts = 0;
    lifecycle.registerComponent("integration:transient", async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("artifact unavailable");
    });
    lifecycle.starting();
    await expect(lifecycle.initializeComponents()).rejects.toThrow("artifact unavailable");
    expect(lifecycle.componentSnapshots()[0]).toMatchObject({
      name: "integration:transient",
      state: "failed",
      error: "artifact unavailable",
    });
    expect(lifecycle.state).toBe("degraded");

    await lifecycle.recoverComponent("integration:transient");
    expect(lifecycle.componentSnapshots()[0].state).toBe("ready");
    expect(lifecycle.state).toBe("running");
    expect(attempts).toBe(2);
  });

  it("records a failed recovery reason and rethrows the error", async () => {
    const lifecycle = new WexelLifecycleManager();
    lifecycle.starting();
    lifecycle.running();

    await expect(lifecycle.recover(async () => {
      throw new Error("service unavailable");
    })).rejects.toThrow("service unavailable");

    expect(lifecycle.snapshot()).toMatchObject({
      state: "failed",
      reason: "service unavailable",
    });
  });

  it("shares an in-flight recovery instead of running two recoveries", async () => {
    const lifecycle = new WexelLifecycleManager();
    lifecycle.starting();
    lifecycle.running();
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });

    const first = lifecycle.recover(async () => { calls += 1; await gate; });
    const second = lifecycle.recover(async () => { calls += 1; });
    expect(lifecycle.state).toBe("recovering");
    release();
    await Promise.all([first, second]);

    expect(calls).toBe(1);
    expect(lifecycle.state).toBe("running");
  });
});
