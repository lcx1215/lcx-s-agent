import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  inspectFinanceSchedulerStatus,
  parseFinanceSchedulerArgs,
  runFinanceScheduler,
} from "../../scripts/operator/lcx-finance-scheduler.js";
import {
  FINANCE_SCHEDULER_LOCK,
  FINANCE_SCHEDULER_PID,
} from "../../src/agents/finance-scheduler-lock.js";
import type { FinanceCycleProcessResult } from "../../src/agents/finance-scheduler-process.js";
import { readFinanceSchedulerState } from "../../src/agents/finance-scheduler-state.js";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  runCycle: vi.fn(),
  delay: vi.fn(),
  killTree: vi.fn(),
  loadConfig: vi.fn(() => ({})),
}));
vi.mock("../../src/process/kill-tree.js", () => ({ killProcessTree: mocks.killTree }));
vi.mock("node:timers/promises", () => ({ setTimeout: mocks.delay }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("../../src/agents/finance-scheduler-process.js", () => ({
  DEFAULT_FINANCE_CYCLE_TIMEOUT_MS: 900_000,
  runFinanceCycleProcess: mocks.runCycle,
}));
vi.mock("../../src/config/config.js", () => ({ loadConfig: mocks.loadConfig }));
vi.mock("../../src/config/env-vars.js", () => ({ applyConfigEnvVars: vi.fn() }));
vi.mock("../../src/cli/serve-detach.js", () => ({ buildDetachedServeEnv: () => ({}) }));

const success: FinanceCycleProcessResult = {
  exitCode: 0,
  signal: null,
  status: "succeeded",
  ok: true,
  stdout: '{"ok":true}',
  stderr: "",
  outputTruncated: false,
};
let directory: string;
let originalTermListeners: number;
let originalIntListeners: number;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "finance-scheduler-test-"));
  mocks.runCycle.mockResolvedValue(success);
  originalTermListeners = process.listenerCount("SIGTERM");
  originalIntListeners = process.listenerCount("SIGINT");
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => {
  expect(process.listenerCount("SIGTERM")).toBe(originalTermListeners);
  expect(process.listenerCount("SIGINT")).toBe(originalIntListeners);
  fs.rmSync(directory, { recursive: true, force: true });
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

it.each(["explicit", "env"])(
  "pins the resolved %s book, timeout and limits in the ready detached child",
  async (source) => {
    const relative = path.relative(process.cwd(), directory);
    vi.stubEnv("LCX_FINANCE_STATE_DIR", source === "env" ? relative : "different-book");
    const child = Object.assign(new EventEmitter(), {
      pid: 123,
      connected: true,
      unref: vi.fn(),
      disconnect: vi.fn(),
      kill: vi.fn(),
    });
    mocks.spawn.mockImplementation(() => {
      queueMicrotask(() => child.emit("message", { type: "finance-scheduler-ready" }));
      return child;
    });
    await expect(
      runFinanceScheduler([
        "--detach",
        ...(source === "explicit" ? ["--dir", relative] : []),
        "--cycle-timeout-ms",
        "5000",
        "--venue",
        "paper",
        "--max-orders",
        "2",
      ]),
    ).resolves.toBe(0);
    expect(mocks.spawn).toHaveBeenCalledExactlyOnceWith(
      process.execPath,
      [
        "--import",
        "tsx",
        expect.stringContaining("lcx-finance-scheduler.ts"),
        "--loop",
        "--dir",
        directory,
        "--cycle-timeout-ms",
        "5000",
        "--venue",
        "paper",
        "--max-orders",
        "2",
      ],
      expect.objectContaining({ detached: true, env: {} }),
    );
    expect(child.unref).toHaveBeenCalledOnce();
    expect(child.disconnect).toHaveBeenCalledOnce();
  },
);

it("does not announce detached readiness when the child exits during startup", async () => {
  const child = Object.assign(new EventEmitter(), { connected: false, unref: vi.fn() });
  mocks.spawn.mockImplementation(() => {
    queueMicrotask(() => child.emit("exit", 1));
    return child;
  });
  await expect(runFinanceScheduler(["--detach", "--dir", directory])).rejects.toThrow(
    "before ready",
  );
  expect(child.unref).not.toHaveBeenCalled();
});

it.each([
  ["--once", "day", "--loop"],
  ["--once", "invalid"],
  ["--loop", "--max-orders", "1.5"],
  ["--loop", "--max-order-notional"],
  ["--loop", "--max-instrument-notional", "Infinity"],
  ["--loop", "--cycle-timeout-ms", "0"],
  ["--loop", "--cycle-timeout-ms", "2147483648"],
  ["--loop", "--dir", " "],
  ["--loop", "--venue", "live"],
  ["--loop", "--unknown"],
  ["--loop", "--place", "--place"],
  ["--loop", "--max-orders", "--place"],
])("rejects malformed invocation %j before spawning", (...argv) => {
  expect(() => parseFinanceSchedulerArgs(argv)).toThrow();
  expect(mocks.spawn).not.toHaveBeenCalled();
  expect(mocks.runCycle).not.toHaveBeenCalled();
});

it.each(["failed", "timed_out", "cancelled", "spawn_error"] as const)(
  "returns nonzero and preserves attempt evidence for %s",
  async (status) => {
    mocks.runCycle.mockImplementation(async () => {
      const pending = readFinanceSchedulerState(directory);
      expect(pending.lastRun?.status).toBe("running");
      expect(pending.lastFired.day).toBeDefined();
      return { ...success, ok: false, status, exitCode: 1 };
    });
    await expect(runFinanceScheduler(["--once", "day", "--dir", directory])).resolves.toBe(1);
    const state = readFinanceSchedulerState(directory);
    expect(state.lastSucceeded).toEqual({});
    expect(state.lastRun?.status).toBe(status);
    expect(fs.existsSync(path.join(directory, FINANCE_SCHEDULER_LOCK))).toBe(false);
    expect(fs.existsSync(path.join(directory, FINANCE_SCHEDULER_PID))).toBe(false);
    expect(
      fs.readFileSync(path.join(directory, "daily-cycle-runs.jsonl"), "utf8").trim().split("\n"),
    ).toHaveLength(1);
  },
);

it("records successful completion separately and forwards execution limits unchanged", async () => {
  await expect(
    runFinanceScheduler([
      "--once",
      "night",
      "--dir",
      directory,
      "--place",
      "--venue",
      "paper",
      "--max-orders",
      "2",
    ]),
  ).resolves.toBe(0);
  const state = readFinanceSchedulerState(directory);
  expect(state.lastSucceeded.night).toBe(state.lastFired.night);
  expect(state.lastRun?.status).toBe("succeeded");
  expect(mocks.runCycle).toHaveBeenCalledWith(
    expect.objectContaining({
      argv: expect.arrayContaining([
        "--dir",
        directory,
        "--place",
        "--venue",
        "paper",
        "--max-orders",
        "2",
      ]),
    }),
  );
});

it("fails closed on corrupt state and releases its lock without spawning", async () => {
  fs.writeFileSync(path.join(directory, "daily-cycle-scheduler.json"), "{bad");
  await expect(runFinanceScheduler(["--once", "day", "--dir", directory])).rejects.toThrow();
  expect(mocks.runCycle).not.toHaveBeenCalled();
  expect(fs.existsSync(path.join(directory, FINANCE_SCHEDULER_LOCK))).toBe(false);
  expect(fs.readFileSync(path.join(directory, "daily-cycle-scheduler.json"), "utf8")).toBe("{bad");
});

it("aborts the active cycle on SIGTERM before releasing its lock", async () => {
  mocks.runCycle.mockImplementation(async ({ signal }: { signal: AbortSignal }) => {
    expect(fs.existsSync(path.join(directory, FINANCE_SCHEDULER_LOCK))).toBe(true);
    process.emit("SIGTERM");
    expect(signal.aborted).toBe(true);
    expect(fs.existsSync(path.join(directory, FINANCE_SCHEDULER_LOCK))).toBe(true);
    return { ...success, ok: false, status: "cancelled", exitCode: null, signal: "SIGTERM" };
  });
  await expect(runFinanceScheduler(["--once", "day", "--dir", directory])).resolves.toBe(143);
  expect(readFinanceSchedulerState(directory).lastRun?.status).toBe("cancelled");
  expect(fs.existsSync(path.join(directory, FINANCE_SCHEDULER_LOCK))).toBe(false);
});

it("does not choose a fallback book after a config error", async () => {
  mocks.loadConfig.mockImplementationOnce(() => {
    throw new Error("unreadable config");
  });
  await expect(runFinanceScheduler(["--once", "day"])).rejects.toThrow("supply --dir explicitly");
  expect(mocks.runCycle).not.toHaveBeenCalled();
});

it("reports status without creating a missing state directory", async () => {
  const missing = path.join(directory, "missing");
  await expect(runFinanceScheduler(["--status", "--dir", missing])).resolves.toBe(0);
  expect(fs.existsSync(missing)).toBe(false);
  expect(mocks.runCycle).not.toHaveBeenCalled();
});

it("continues to the night slot after a failed day without retrying either slot on the next tick", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-21T22:00:00Z"));
  mocks.runCycle.mockResolvedValueOnce({ ...success, status: "failed", ok: false, exitCode: 1 });
  mocks.delay.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => {
    process.emit("SIGTERM");
  });
  await expect(runFinanceScheduler(["--loop", "--dir", directory])).resolves.toBe(143);
  expect(mocks.runCycle).toHaveBeenCalledTimes(2);
  const state = readFinanceSchedulerState(directory);
  expect(state.lastFired).toEqual({ day: "2026-09-21", night: "2026-09-21" });
  expect(state.lastSucceeded).toEqual({ night: "2026-09-21" });
});

it("recomputes market time after a long cycle instead of firing yesterday's night slot after midnight", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-21T22:00:00Z"));
  mocks.runCycle.mockImplementationOnce(async () => {
    vi.setSystemTime(new Date("2026-09-22T04:01:00Z"));
    return success;
  });
  mocks.delay.mockImplementationOnce(async () => {
    process.emit("SIGTERM");
  });
  await expect(runFinanceScheduler(["--loop", "--dir", directory])).resolves.toBe(143);
  expect(mocks.runCycle).toHaveBeenCalledOnce();
  expect(readFinanceSchedulerState(directory).lastFired).toEqual({ day: "2026-09-21" });
});

it("releases an idle loop on SIGINT without starting a cycle", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-21T10:00:00Z"));
  mocks.delay.mockImplementationOnce(async () => {
    process.emit("SIGINT");
  });
  await expect(runFinanceScheduler(["--loop", "--dir", directory])).resolves.toBe(130);
  expect(mocks.runCycle).not.toHaveBeenCalled();
  expect(fs.existsSync(path.join(directory, FINANCE_SCHEDULER_LOCK))).toBe(false);
});

it("handles a detached spawn error without reporting ready", async () => {
  const child = Object.assign(new EventEmitter(), { connected: false, unref: vi.fn() });
  mocks.spawn.mockImplementation(() => {
    queueMicrotask(() => child.emit("error", new Error("spawn unavailable")));
    return child;
  });
  await expect(runFinanceScheduler(["--detach", "--dir", directory])).rejects.toThrow(
    "spawn unavailable",
  );
  expect(child.unref).not.toHaveBeenCalled();
});

it("bounds detached startup and terminates only its own child on timeout", async () => {
  vi.useFakeTimers();
  const child = Object.assign(new EventEmitter(), {
    pid: 123,
    connected: true,
    disconnect: vi.fn(),
    unref: vi.fn(),
  });
  mocks.spawn.mockReturnValue(child);
  const run = runFinanceScheduler(["--detach", "--dir", directory]);
  const failed = expect(run).rejects.toThrow("startup timed out");
  await vi.advanceTimersByTimeAsync(10_000);
  await failed;
  expect(mocks.killTree).toHaveBeenCalledExactlyOnceWith(123);
  expect(child.disconnect).toHaveBeenCalledOnce();
  expect(child.unref).not.toHaveBeenCalled();
  expect(child.listenerCount("message")).toBe(0);
});

it("reports schedule timing without calling the cycle or treating old attempts as success", async () => {
  const root = { directory, source: "explicit" as const };
  const inspect = (time: string) => inspectFinanceSchedulerStatus(root, new Date(time));
  expect(inspect("2026-09-21T18:00:00Z").slots.map((slot) => slot.status)).toEqual([
    "not_due",
    "not_due",
  ]);
  expect(inspect("2026-09-21T20:00:00Z").slots.map((slot) => slot.status)).toEqual([
    "due_unattempted",
    "not_due",
  ]);
  expect(inspect("2026-09-20T22:00:00Z").slots.map((slot) => slot.status)).toEqual([
    "outside_schedule",
    "outside_schedule",
  ]);
  fs.writeFileSync(
    path.join(directory, "daily-cycle-scheduler.json"),
    JSON.stringify({ lastFired: { day: "2026-09-21" } }),
  );
  fs.writeFileSync(path.join(directory, FINANCE_SCHEDULER_PID), String(process.pid));
  const legacy = inspect("2026-09-21T20:00:00Z");
  expect(legacy.slots[0].status).toBe("attempted_outcome_unknown");
  expect(legacy.ownerObservation).toBe("legacy_or_unlocked_process");
  expect(legacy.executionHealthVerified).toBe(false);
  fs.writeFileSync(
    path.join(directory, "daily-cycle-scheduler.json"),
    JSON.stringify({
      lastFired: { day: "2026-09-21" },
      lastSucceeded: { day: "2026-09-21" },
      lastStatus: { day: "failed" },
    }),
  );
  expect(inspect("2026-09-21T20:00:00Z").slots[0].status).toBe("failed");
  const stdout = vi.spyOn(process.stdout, "write");
  await runFinanceScheduler(["--status", "--json", "--dir", directory]);
  const output = stdout.mock.calls.at(-1)![0];
  expect(JSON.parse(String(output))).toMatchObject({
    boundary: "read_only_finance_scheduler_status",
    executionHealthVerified: false,
  });
  expect(mocks.runCycle).not.toHaveBeenCalled();
  expect(() => parseFinanceSchedulerArgs(["--loop", "--json"])).toThrow("--json requires --status");
});
