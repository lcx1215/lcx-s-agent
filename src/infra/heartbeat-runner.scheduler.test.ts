import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { startHeartbeatRunner } from "./heartbeat-runner.js";
import * as heartbeatWake from "./heartbeat-wake.js";
import {
  type HeartbeatRunResult,
  type HeartbeatWakeHandler,
  requestHeartbeatNow,
  resetHeartbeatWakeStateForTests,
} from "./heartbeat-wake.js";

describe("startHeartbeatRunner", () => {
  function startDefaultRunner(runOnce: Parameters<typeof startHeartbeatRunner>[0]["runOnce"]) {
    return startHeartbeatRunner({
      cfg: {
        agents: { defaults: { heartbeat: { every: "30m" } } },
      } as OpenClawConfig,
      runOnce,
    });
  }

  afterEach(() => {
    resetHeartbeatWakeStateForTests();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not schedule or admit interval wakes in wake-only mode after configuration reload", async () => {
    vi.useFakeTimers();
    const runOnce = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    const cfg = { agents: { defaults: { heartbeat: { every: "1m" } } } };
    const runner = startHeartbeatRunner({ cfg, mode: "wake-only", runOnce });
    try {
      await vi.advanceTimersByTimeAsync(3 * 60_000);
      expect(runOnce).not.toHaveBeenCalled();
      requestHeartbeatNow({ reason: "interval", coalesceMs: 0 });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(runOnce).not.toHaveBeenCalled();
      runner.updateConfig(cfg);
      await vi.advanceTimersByTimeAsync(3 * 60_000);
      expect(runOnce).not.toHaveBeenCalled();
    } finally {
      runner.stop();
    }
  });

  it.each([false, true])(
    "propagates internal delivery for a wake-only request (targeted=%s)",
    async (targeted) => {
      vi.useFakeTimers();
      const runOnce = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
      const runner = startHeartbeatRunner({
        cfg: { agents: { defaults: { heartbeat: { every: "30m" } } } },
        mode: "wake-only",
        runOnce,
      });
      try {
        requestHeartbeatNow({
          reason: "cron:fixture",
          coalesceMs: 0,
          ...(targeted ? { agentId: "main", sessionKey: "agent:main:serve" } : {}),
        });
        await vi.advanceTimersByTimeAsync(1_000);
        expect(runOnce).toHaveBeenCalledTimes(1);
        expect(runOnce).toHaveBeenCalledWith(
          expect.objectContaining({ reason: "cron:fixture", delivery: "none" }),
        );
      } finally {
        runner.stop();
      }
    },
  );

  it.each([
    ["scheduled", "returned"],
    ["scheduled", "thrown"],
    ["scheduled", "mixed"],
    ["wake-only", "returned"],
    ["wake-only", "thrown"],
    ["wake-only", "mixed"],
  ] as const)("preserves an untargeted failure (%s, %s)", async (mode, failureKind) => {
    vi.useFakeTimers();
    let wakeHandler: HeartbeatWakeHandler = async () => {
      throw new Error("fixture wake handler was not registered");
    };
    vi.spyOn(heartbeatWake, "setHeartbeatWakeHandler").mockImplementation((next) => {
      if (!next) {
        throw new Error("fixture expected a wake handler");
      }
      wakeHandler = next;
      return () => {};
    });
    const runOnce = vi.fn(
      async ({ agentId }: { agentId?: string }): Promise<HeartbeatRunResult> => {
        if (failureKind === "mixed" && agentId === "ops") {
          return { status: "ran", durationMs: 1 };
        }
        if (failureKind === "thrown") {
          throw new Error("fixture model unavailable");
        }
        return { status: "failed", reason: "fixture model unavailable" };
      },
    );
    const runner = startHeartbeatRunner({
      cfg: {
        agents: {
          defaults: { heartbeat: { every: "30m" } },
          list: [
            { id: "main", heartbeat: { every: "30m" } },
            { id: "ops", heartbeat: { every: "30m" } },
          ],
        },
      },
      mode,
      runOnce,
    });
    try {
      expect(heartbeatWake.setHeartbeatWakeHandler).toHaveBeenCalledTimes(1);
      const result = await wakeHandler({
        reason: "cron:fixture-failure",
      });
      expect(result).toEqual({ status: "failed", reason: "fixture model unavailable" });
      expect(runOnce).toHaveBeenCalledTimes(2);
    } finally {
      runner.stop();
    }
  });

  it.each([
    ["scheduled", "returned"],
    ["scheduled", "thrown"],
    ["wake-only", "returned"],
    ["wake-only", "thrown"],
  ] as const)(
    "does not replay a terminally failed peer after a busy peer (%s, %s)",
    async (mode, failureKind) => {
      vi.useFakeTimers();
      const main = vi.fn(async (): Promise<HeartbeatRunResult> => {
        if (failureKind === "thrown") {
          throw new Error("fixture terminal failure");
        }
        return { status: "failed", reason: "fixture terminal failure" };
      });
      const ops = vi
        .fn()
        .mockResolvedValueOnce({ status: "skipped", reason: "requests-in-flight" })
        .mockResolvedValue({ status: "ran", durationMs: 1 });
      const runner = startHeartbeatRunner({
        cfg: {
          agents: {
            defaults: { heartbeat: { every: "30m" } },
            list: [
              { id: "main", heartbeat: { every: "30m" } },
              { id: "ops", heartbeat: { every: "30m" } },
            ],
          },
        },
        mode,
        runOnce: async ({ agentId }) => (agentId === "main" ? main() : ops()),
      });
      try {
        requestHeartbeatNow({ reason: "cron:fixture-terminal-before-busy", coalesceMs: 0 });
        await vi.advanceTimersByTimeAsync(100);
        expect(main).toHaveBeenCalledTimes(1);
        expect(ops).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1_100);
        expect(main).toHaveBeenCalledTimes(1);
        expect(ops).toHaveBeenCalledTimes(2);
        expect(heartbeatWake.hasPendingHeartbeatWake()).toBe(false);
      } finally {
        runner.stop();
      }
    },
  );

  it.each(["scheduled", "wake-only"] as const)(
    "defers an unexecuted failure when the first peer is busy (%s)",
    async (mode) => {
      vi.useFakeTimers();
      const ops = vi
        .fn()
        .mockResolvedValueOnce({ status: "skipped", reason: "requests-in-flight" })
        .mockResolvedValue({ status: "ran", durationMs: 1 });
      const main = vi
        .fn()
        .mockResolvedValue({ status: "failed", reason: "fixture terminal failure" });
      const runner = startHeartbeatRunner({
        cfg: {
          agents: {
            defaults: { heartbeat: { every: "30m" } },
            list: [
              { id: "ops", heartbeat: { every: "30m" } },
              { id: "main", heartbeat: { every: "30m" } },
            ],
          },
        },
        mode,
        runOnce: async ({ agentId }) => (agentId === "ops" ? ops() : main()),
      });
      try {
        requestHeartbeatNow({ reason: "cron:fixture-busy-before-terminal", coalesceMs: 0 });
        await vi.advanceTimersByTimeAsync(100);
        expect(ops).toHaveBeenCalledTimes(1);
        expect(main).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1_100);
        expect(ops).toHaveBeenCalledTimes(2);
        expect(main).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(3_000);
        expect(ops).toHaveBeenCalledTimes(2);
        expect(main).toHaveBeenCalledTimes(1);
        expect(heartbeatWake.hasPendingHeartbeatWake()).toBe(false);
      } finally {
        runner.stop();
      }
    },
  );

  it.each(["scheduled", "wake-only"] as const)(
    "retries only unexecuted peers after a successful prefix (%s)",
    async (mode) => {
      vi.useFakeTimers();
      const main = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
      const ops = vi
        .fn()
        .mockResolvedValueOnce({ status: "skipped", reason: "requests-in-flight" })
        .mockResolvedValue({ status: "ran", durationMs: 1 });
      const tail = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
      const runner = startHeartbeatRunner({
        cfg: {
          agents: {
            defaults: { heartbeat: { every: "30m" } },
            list: [
              { id: "main", heartbeat: { every: "30m" } },
              { id: "ops", heartbeat: { every: "30m" } },
              { id: "tail", heartbeat: { every: "30m" } },
            ],
          },
        },
        mode,
        runOnce: async ({ agentId }) =>
          agentId === "main" ? main() : agentId === "ops" ? ops() : tail(),
      });
      try {
        requestHeartbeatNow({ reason: "cron:fixture-success-before-busy", coalesceMs: 0 });
        await vi.advanceTimersByTimeAsync(100);
        expect(main).toHaveBeenCalledTimes(1);
        expect(ops).toHaveBeenCalledTimes(1);
        expect(tail).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(899);
        expect(ops).toHaveBeenCalledTimes(1);
        expect(tail).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(101);
        expect(main).toHaveBeenCalledTimes(1);
        expect(ops).toHaveBeenCalledTimes(2);
        expect(tail).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(3_000);
        expect(main).toHaveBeenCalledTimes(1);
        expect(ops).toHaveBeenCalledTimes(2);
        expect(tail).toHaveBeenCalledTimes(1);
        expect(heartbeatWake.hasPendingHeartbeatWake()).toBe(false);
      } finally {
        runner.stop();
      }
    },
  );

  it("does not replay an interval prefix during the existing due-time busy retry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const main = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    const ops = vi
      .fn()
      .mockResolvedValueOnce({ status: "skipped", reason: "requests-in-flight" })
      .mockResolvedValue({ status: "ran", durationMs: 1 });
    const runner = startHeartbeatRunner({
      cfg: {
        agents: {
          defaults: { heartbeat: { every: "1m" } },
          list: [
            { id: "main", heartbeat: { every: "1m" } },
            { id: "ops", heartbeat: { every: "1m" } },
          ],
        },
      },
      runOnce: async ({ agentId }) => (agentId === "main" ? main() : ops()),
    });
    try {
      await vi.advanceTimersByTimeAsync(60_100);
      expect(main).toHaveBeenCalledTimes(1);
      expect(ops).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_100);
      expect(main).toHaveBeenCalledTimes(1);
      expect(ops).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(58_900);
      expect(main).toHaveBeenCalledTimes(2);
      expect(ops).toHaveBeenCalledTimes(2);
    } finally {
      runner.stop();
    }
  });

  it("rechecks a deferred target after config reload without replaying completed or new peers", async () => {
    vi.useFakeTimers();
    const main = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    const ops = vi.fn().mockResolvedValue({ status: "skipped", reason: "requests-in-flight" });
    const added = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    const runner = startHeartbeatRunner({
      cfg: {
        agents: {
          defaults: { heartbeat: { every: "30m" } },
          list: [
            { id: "main", heartbeat: { every: "30m" } },
            { id: "ops", heartbeat: { every: "30m" } },
          ],
        },
      },
      mode: "wake-only",
      runOnce: async ({ agentId }) =>
        agentId === "main" ? main() : agentId === "ops" ? ops() : added(),
    });
    try {
      requestHeartbeatNow({ reason: "cron:fixture-reload", coalesceMs: 0 });
      await vi.advanceTimersByTimeAsync(100);
      expect(main).toHaveBeenCalledTimes(1);
      expect(ops).toHaveBeenCalledTimes(1);
      runner.updateConfig({
        agents: {
          defaults: { heartbeat: { every: "30m" } },
          list: [
            { id: "main", heartbeat: { every: "30m" } },
            { id: "added", heartbeat: { every: "30m" } },
          ],
        },
      });
      await vi.advanceTimersByTimeAsync(1_100);
      expect(main).toHaveBeenCalledTimes(1);
      expect(ops).toHaveBeenCalledTimes(1);
      expect(added).not.toHaveBeenCalled();
      expect(heartbeatWake.hasPendingHeartbeatWake()).toBe(false);
    } finally {
      runner.stop();
    }
  });

  it("keeps only unfinished targets through stop and original consumer registration", async () => {
    vi.useFakeTimers();
    const main = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    const ops = vi
      .fn()
      .mockResolvedValueOnce({ status: "skipped", reason: "requests-in-flight" })
      .mockResolvedValue({ status: "ran", durationMs: 1 });
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { heartbeat: { every: "30m" } },
        list: [
          { id: "main", heartbeat: { every: "30m" } },
          { id: "ops", heartbeat: { every: "30m" } },
        ],
      },
    };
    const runOnce = async ({ agentId }: { agentId?: string }) =>
      agentId === "main" ? main() : ops();
    const first = startHeartbeatRunner({ cfg, mode: "wake-only", runOnce });
    let next: ReturnType<typeof startHeartbeatRunner> | undefined;
    try {
      requestHeartbeatNow({ reason: "cron:fixture-consumer-lifecycle", coalesceMs: 0 });
      await vi.advanceTimersByTimeAsync(100);
      expect(main).toHaveBeenCalledTimes(1);
      expect(ops).toHaveBeenCalledTimes(1);
      first.stop();
      await vi.advanceTimersByTimeAsync(3_000);
      expect(main).toHaveBeenCalledTimes(1);
      expect(ops).toHaveBeenCalledTimes(1);
      next = startHeartbeatRunner({ cfg, mode: "wake-only", runOnce });
      await vi.advanceTimersByTimeAsync(250);
      expect(main).toHaveBeenCalledTimes(1);
      expect(ops).toHaveBeenCalledTimes(2);
      expect(heartbeatWake.hasPendingHeartbeatWake()).toBe(false);
    } finally {
      first.stop();
      next?.stop();
    }
  });

  it("updates scheduling when config changes without restart", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const runSpy = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });

    const runner = startDefaultRunner(runSpy);

    await vi.advanceTimersByTimeAsync(30 * 60_000 + 1_000);

    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(runSpy.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ agentId: "main", reason: "interval" }),
    );

    runner.updateConfig({
      agents: {
        defaults: { heartbeat: { every: "30m" } },
        list: [
          { id: "main", heartbeat: { every: "10m" } },
          { id: "ops", heartbeat: { every: "15m" } },
        ],
      },
    } as OpenClawConfig);

    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1_000);

    expect(runSpy).toHaveBeenCalledTimes(2);
    expect(runSpy.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ agentId: "main", heartbeat: { every: "10m" } }),
    );

    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1_000);

    expect(runSpy).toHaveBeenCalledTimes(3);
    expect(runSpy.mock.calls[2]?.[0]).toEqual(
      expect.objectContaining({ agentId: "ops", heartbeat: { every: "15m" } }),
    );

    runner.stop();
  });

  it("continues scheduling after runOnce throws an unhandled error", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    let callCount = 0;
    const runSpy = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        // First call throws (simulates crash during session compaction)
        throw new Error("session compaction error");
      }
      return { status: "ran", durationMs: 1 };
    });

    const runner = startDefaultRunner(runSpy);

    // First heartbeat fires and throws
    await vi.advanceTimersByTimeAsync(30 * 60_000 + 1_000);
    expect(runSpy).toHaveBeenCalledTimes(1);

    // Second heartbeat should still fire (scheduler must not be dead)
    await vi.advanceTimersByTimeAsync(30 * 60_000 + 1_000);
    expect(runSpy).toHaveBeenCalledTimes(2);

    runner.stop();
  });

  it("cleanup is idempotent and does not clear a newer runner's handler", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const runSpy1 = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    const runSpy2 = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });

    const cfg = {
      agents: { defaults: { heartbeat: { every: "30m" } } },
    } as OpenClawConfig;

    // Start runner A
    const runnerA = startHeartbeatRunner({ cfg, runOnce: runSpy1 });

    // Start runner B (simulates lifecycle reload)
    const runnerB = startHeartbeatRunner({ cfg, runOnce: runSpy2 });

    // Stop runner A (stale cleanup) — should NOT kill runner B's handler
    runnerA.stop();

    // Runner B should still fire
    await vi.advanceTimersByTimeAsync(30 * 60_000 + 1_000);
    expect(runSpy2).toHaveBeenCalledTimes(1);
    expect(runSpy1).not.toHaveBeenCalled();

    // Double-stop should be safe (idempotent)
    runnerA.stop();

    runnerB.stop();
  });

  it("run() returns skipped when runner is stopped", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const runSpy = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });

    const runner = startDefaultRunner(runSpy);

    runner.stop();

    // After stopping, no heartbeats should fire
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(runSpy).not.toHaveBeenCalled();
  });

  it("reschedules timer when runOnce returns requests-in-flight", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    let callCount = 0;
    const runSpy = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return { status: "skipped", reason: "requests-in-flight" };
      }
      return { status: "ran", durationMs: 1 };
    });

    const runner = startHeartbeatRunner({
      cfg: {
        agents: { defaults: { heartbeat: { every: "30m" } } },
      } as OpenClawConfig,
      runOnce: runSpy,
    });

    // First heartbeat returns requests-in-flight
    await vi.advanceTimersByTimeAsync(30 * 60_000 + 1_000);
    expect(runSpy).toHaveBeenCalledTimes(1);

    // Timer should be rescheduled; next heartbeat should still fire
    await vi.advanceTimersByTimeAsync(30 * 60_000 + 1_000);
    expect(runSpy).toHaveBeenCalledTimes(2);

    runner.stop();
  });

  it("routes targeted wake requests to the requested agent/session", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const runSpy = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    const runner = startHeartbeatRunner({
      cfg: {
        agents: {
          defaults: { heartbeat: { every: "30m" } },
          list: [
            { id: "main", heartbeat: { every: "30m" } },
            { id: "ops", heartbeat: { every: "15m" } },
          ],
        },
      } as OpenClawConfig,
      runOnce: runSpy,
    });

    requestHeartbeatNow({
      reason: "cron:job-123",
      agentId: "ops",
      sessionKey: "agent:ops:discord:channel:alerts",
      coalesceMs: 0,
    });
    await vi.advanceTimersByTimeAsync(1);

    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(runSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "ops",
        reason: "cron:job-123",
        sessionKey: "agent:ops:discord:channel:alerts",
      }),
    );

    runner.stop();
  });

  it("does not fan out to unrelated agents for session-scoped exec wakes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const runSpy = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    const runner = startHeartbeatRunner({
      cfg: {
        agents: {
          defaults: { heartbeat: { every: "30m" } },
          list: [
            { id: "main", heartbeat: { every: "30m" } },
            { id: "finance", heartbeat: { every: "30m" } },
          ],
        },
      } as OpenClawConfig,
      runOnce: runSpy,
    });

    requestHeartbeatNow({
      reason: "exec-event",
      sessionKey: "agent:main:main",
      coalesceMs: 0,
    });
    await vi.advanceTimersByTimeAsync(1);

    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(runSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
        reason: "exec-event",
        sessionKey: "agent:main:main",
      }),
    );
    expect(runSpy.mock.calls.some((call) => call[0]?.agentId === "finance")).toBe(false);

    runner.stop();
  });
});
