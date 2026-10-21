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
