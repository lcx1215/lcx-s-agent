import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  inspectFinanceSchedulerStatus,
  describeFinanceCycleExecution,
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
  syncAlpacaHistory: vi.fn(),
  createIntradayController: vi.fn(() => ({ accountId: "paper-account" })),
  runIntradayMonitorTick: vi.fn(),
  executeIntradayDecision: vi.fn(),
  createTradeDecisionReviewer: vi.fn(),
  tradeDecisionReviewer: vi.fn(),
}));
vi.mock("../../src/process/kill-tree.js", () => ({ killProcessTree: mocks.killTree }));
vi.mock("node:timers/promises", () => ({ setTimeout: mocks.delay }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: mocks.spawn };
});
vi.mock("../../src/agents/finance-scheduler-process.js", () => ({
  DEFAULT_FINANCE_CYCLE_TIMEOUT_MS: 900_000,
  runFinanceCycleProcess: mocks.runCycle,
}));
vi.mock("../../src/config/config.js", () => ({ loadConfig: mocks.loadConfig }));
vi.mock("../../src/config/env-vars.js", () => ({ applyConfigEnvVars: vi.fn() }));
vi.mock("../../src/cli/serve-detach.js", () => ({ buildDetachedServeEnv: () => ({}) }));
vi.mock("../../src/agents/finance-alpaca-history-sync.js", () => ({
  syncConfiguredAlpacaPaperHistory: mocks.syncAlpacaHistory,
}));
vi.mock("../../src/agents/finance-alpaca-cycle-controller.js", () => ({
  createFinanceAlpacaCycleController: mocks.createIntradayController,
}));
vi.mock("../../src/agents/finance-intraday-monitor.js", () => ({
  runFinanceIntradayMonitorTick: mocks.runIntradayMonitorTick,
}));
vi.mock("../../src/agents/finance-intraday-execution.js", () => ({
  executeFinanceIntradayDecision: mocks.executeIntradayDecision,
}));
vi.mock("../../src/agents/finance-trade-decision-review.js", () => ({
  createFinanceTradeDecisionReviewer: mocks.createTradeDecisionReviewer,
}));

const success: FinanceCycleProcessResult = {
  exitCode: 0,
  signal: null,
  status: "succeeded",
  ok: true,
  stdout:
    '{"ok":true,"scoredFiled":{"appended":0,"skipped":0},"pending":[],"declined":[],"issues":[]}',
  stderr: "",
  outputTruncated: false,
};
let directory: string;
let originalTermListeners: number;
let originalIntListeners: number;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "finance-scheduler-test-"));
  mocks.runCycle.mockResolvedValue(success);
  mocks.syncAlpacaHistory.mockResolvedValue({
    accountId: "paper-account",
    accountReconciliation: { status: "reconciled" },
  });
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
      "day",
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
  expect(state.lastSucceeded.day).toBe(state.lastFired.day);
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

it("forwards explicit read-only history synchronization without enabling placement", () => {
  const options = parseFinanceSchedulerArgs(["--loop", "--sync-alpaca-history"]);
  expect(options.extraArgs).toEqual(["--sync-alpaca-history"]);
  expect(options.extraArgs).not.toContain("--place");
});

it("parses a resident event-driven intraday monitor without granting placement", () => {
  const options = parseFinanceSchedulerArgs([
    "--loop",
    "--intraday-monitor",
    "--intraday-instruments",
    "SPY,QQQ",
    "--intraday-interval-seconds",
    "300",
    "--intraday-feed",
    "iex",
    "--intraday-opening-range-bars",
    "6",
    "--intraday-reward-risk",
    "2",
  ]);
  expect(options.intraday).toEqual({
    place: false,
    instruments: ["SPY", "QQQ"],
    intervalSeconds: 300,
    feed: "iex",
    openingRangeBars: 6,
    rewardRisk: 2,
  });
  expect(options.extraArgs).not.toContain("--place");
});

it("requires shared authorization and explicit caps for intraday paper placement", () => {
  const base = [
    "--loop",
    "--intraday-monitor",
    "--intraday-place",
    "--intraday-instruments",
    "SPY",
  ];
  expect(() => parseFinanceSchedulerArgs(base)).toThrow("shared --place authorization");
});

it("routes an actionable intraday Paper decision through the configured review owner", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-21T15:00:00Z"));
  const policy = path.join(directory, "alpaca-policy.json");
  fs.writeFileSync(policy, "{}");
  const decision = { input: { signalId: "intraday-signal-1" } };
  const reviewer = vi.fn();
  mocks.createTradeDecisionReviewer.mockReturnValue(reviewer);
  mocks.runIntradayMonitorTick.mockResolvedValue({
    status: "decision_recorded",
    signal: { action: "buy", reason: "opening_range_breakout", signalId: "intraday-signal-1" },
    decision,
  });
  mocks.executeIntradayDecision.mockResolvedValue({
    status: "placed",
    tradeDecisionReview: {
      status: "completed",
      latencyMs: 4,
      decision: { decision: "approve" },
    },
  });
  mocks.delay.mockImplementationOnce(async () => {
    process.emit("SIGTERM");
  });

  await expect(
    runFinanceScheduler([
      "--loop",
      "--dir",
      directory,
      "--intraday-monitor",
      "--intraday-place",
      "--intraday-instruments",
      "SPY",
      "--intraday-interval-seconds",
      "300",
      "--intraday-feed",
      "iex",
      "--intraday-opening-range-bars",
      "6",
      "--intraday-reward-risk",
      "2",
      "--place",
      "--venue",
      "alpaca",
      "--execution-policy",
      policy,
      "--execution-quote-feed",
      "iex",
      "--execution-max-age-ms",
      "30000",
      "--max-order-notional",
      "1000",
      "--max-instrument-notional",
      "5000",
      "--max-orders",
      "8",
    ]),
  ).resolves.toBe(143);
  expect(mocks.createTradeDecisionReviewer).toHaveBeenCalledOnce();
  expect(mocks.createTradeDecisionReviewer).toHaveBeenCalledWith({});
  expect(mocks.executeIntradayDecision).toHaveBeenCalledWith(
    expect.objectContaining({
      decision,
      tradeDecisionReviewer: reviewer,
    }),
  );
});

it("refuses an intraday monitor without an explicit universe", () => {
  expect(() => parseFinanceSchedulerArgs(["--loop", "--intraday-monitor"])).toThrow(
    "--intraday-instruments",
  );
});

it("distinguishes preview success from enabled trading and blocked execution", () => {
  const report = JSON.stringify({
    ok: true,
    placed: [],
    drift: [{ action: "sell" }],
    refusals: [],
  });
  expect(describeFinanceCycleExecution(report, ["--sync-alpaca-history"], "day")).toMatchObject({
    placementEnabled: false,
    venue: "paper",
    outcome: "preview_only",
    tradeIntentCount: 1,
  });
  expect(
    describeFinanceCycleExecution(report, ["--place", "--venue", "alpaca"], "day").outcome,
  ).toBe("not_executed");
  expect(
    describeFinanceCycleExecution(
      JSON.stringify({
        ok: true,
        placed: [],
        drift: [{ action: "buy" }],
        refusals: [],
      }),
      ["--place", "--venue", "alpaca"],
      "day",
    ),
  ).toMatchObject({ outcome: "not_executed" });
  expect(
    describeFinanceCycleExecution(
      JSON.stringify({ ok: true, placed: [], drift: [], refusals: [] }),
      ["--place"],
      "day",
    ).outcome,
  ).toBe("no_trade");
  expect(
    describeFinanceCycleExecution(
      JSON.stringify({ ok: true, refusals: ["controller unavailable"] }),
      ["--place"],
      "day",
    ).outcome,
  ).toBe("blocked_or_partial");
  expect(
    describeFinanceCycleExecution(
      JSON.stringify({ ok: false, failureKind: "execution_readiness_gate" }),
      ["--place", "--venue", "alpaca"],
      "day",
    ),
  ).toMatchObject({
    venue: "alpaca",
    placementEnabled: true,
    outcome: "blocked_by_readiness",
    blockReason: "paper_readiness_not_met",
  });
  expect(describeFinanceCycleExecution("broken", [], "day").outcome).toBe("failed_or_unknown");
});

it("surfaces bounded model-review evidence and distinguishes veto from review failure", () => {
  const veto = describeFinanceCycleExecution(
    JSON.stringify({
      ok: true,
      placed: [],
      drift: [{ action: "buy" }],
      refusals: ["SPY: model vetoed the proposed candidate"],
      tradeDecisionReview: {
        status: "completed",
        candidateCount: 1,
        modelCalls: 1,
        provider: "fixture-provider",
        modelId: "fixture-model",
        latencyMs: 12,
        providerCallObserved: true,
        adapterAttested: true,
        decisions: [
          {
            candidateId: "paper-run:SPY:buy",
            decision: "veto",
            rationale: "Do not echo rationale to scheduler status.",
          },
        ],
      },
    }),
    ["--place", "--venue", "alpaca"],
    "day",
  );
  expect(veto).toMatchObject({
    outcome: "model_vetoed",
    tradeDecisionReview: {
      status: "completed",
      candidateCount: 1,
      modelCalls: 1,
      vetoedCount: 1,
      approvedCount: 0,
      provider: "fixture-provider",
      latencyMs: 12,
    },
  });
  expect(JSON.stringify(veto)).not.toContain("Do not echo rationale");

  expect(
    describeFinanceCycleExecution(
      JSON.stringify({
        ok: false,
        placed: [],
        refusals: ["SPY: model review unavailable"],
        tradeDecisionReview: {
          status: "failed",
          candidateCount: 1,
          modelCalls: 0,
          failureCode: "reviewer_unavailable",
        },
      }),
      ["--place", "--venue", "alpaca"],
      "day",
    ).outcome,
  ).toBe("model_review_failed");
});

it("routes the exact portfolio plan to the cycle with a cwd-independent path", async () => {
  const plan = "state/finance/portfolio-plan.json";
  await runFinanceScheduler(["--once", "day", "--dir", directory, "--portfolio-plan", plan]);
  expect(mocks.runCycle.mock.calls[0][0].argv).toEqual(
    expect.arrayContaining(["--portfolio-plan", path.resolve(plan)]),
  );
  expect(mocks.runCycle.mock.calls[0][0].argv).not.toContain("--place");
});

it("refreshes a grounded research plan before the unique day cycle", async () => {
  const context = path.join(directory, "portfolio-context.json");
  const plan = path.join(directory, "research-portfolio-plan-latest.json");
  fs.writeFileSync(context, "{}");
  mocks.runCycle
    .mockResolvedValueOnce({
      ...success,
      stdout: JSON.stringify({ status: "candidate", portfolioPlanWritten: plan }),
    })
    .mockResolvedValueOnce(success);

  await expect(
    runFinanceScheduler([
      "--once",
      "day",
      "--dir",
      directory,
      "--research-portfolio-context",
      context,
      "--research-ask",
      "review active strategy budgets",
    ]),
  ).resolves.toBe(0);

  expect(mocks.runCycle).toHaveBeenCalledTimes(2);
  expect(mocks.runCycle.mock.calls[0][0].argv).toEqual(
    expect.arrayContaining([
      expect.stringContaining("lcx-finance-research-run.ts"),
      "--execute-modules",
      "--decision-mode",
      "strategy_candidate",
      "--portfolio-context",
      context,
      "--portfolio-plan-out",
      plan,
    ]),
  );
  expect(mocks.runCycle.mock.calls[1][0].argv).toEqual(
    expect.arrayContaining(["--portfolio-plan", plan]),
  );
});

it("routes night settlement, ledgers and news through the same module research owner", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-22T22:00:00.000Z"));
  const context = path.join(directory, "portfolio-context.json");
  fs.writeFileSync(context, "{}");
  mocks.runCycle
    .mockResolvedValueOnce({
      ...success,
      stdout: JSON.stringify({
        ok: true,
        scoredFiled: { appended: 1, skipped: 0 },
        reflection: { lesson: "review invalidation" },
        pending: [],
        declined: [],
        issues: [],
      }),
    })
    .mockResolvedValueOnce({ ...success, stdout: JSON.stringify({ status: "candidate" }) });

  await expect(
    runFinanceScheduler([
      "--once",
      "night",
      "--dir",
      directory,
      "--research-portfolio-context",
      context,
      "--research-ask",
      "review active strategy budgets",
    ]),
  ).resolves.toBe(0);

  expect(mocks.runCycle).toHaveBeenCalledTimes(2);
  const evidencePath = path.join(directory, "night-review-evidence-2026-09-22.json");
  expect(mocks.runCycle.mock.calls[1][0].argv).toEqual(
    expect.arrayContaining([
      expect.stringContaining("lcx-finance-research-run.ts"),
      "--execute-modules",
      "--decision-mode",
      "research_only",
      "--controller-evidence",
      evidencePath,
    ]),
  );
  expect(JSON.parse(fs.readFileSync(evidencePath, "utf8"))).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ source: "finance-night-settlement" }),
      expect.objectContaining({ source: "finance-position-ledger" }),
      expect.objectContaining({ source: "finance-strategy-rule-ledger" }),
      expect.objectContaining({ source: "finance-intraday-control-ledger" }),
    ]),
  );
  expect(readFinanceSchedulerState(directory).lastSucceeded.night).toBe("2026-09-22");
});

it("does not enter the day cycle when research plan refresh is unverified", async () => {
  mocks.runCycle.mockResolvedValueOnce({
    ...success,
    stdout: JSON.stringify({ status: "needs_review" }),
  });
  await expect(
    runFinanceScheduler([
      "--once",
      "day",
      "--dir",
      directory,
      "--research-portfolio-context",
      path.join(directory, "context.json"),
      "--research-ask",
      "review active strategy budgets",
    ]),
  ).resolves.toBe(1);
  expect(mocks.runCycle).toHaveBeenCalledOnce();
  expect(readFinanceSchedulerState(directory).lastSucceeded.day).toBeUndefined();
});

it("requires a complete automatic research plan binding and refuses a competing static plan", () => {
  expect(() =>
    parseFinanceSchedulerArgs(["--loop", "--research-portfolio-context", "context.json"]),
  ).toThrow("requires both");
  expect(() =>
    parseFinanceSchedulerArgs([
      "--loop",
      "--research-portfolio-context",
      "context.json",
      "--research-ask",
      "review",
      "--portfolio-plan",
      "static.json",
    ]),
  ).toThrow("cannot combine");
});

it("distinguishes missing, stalled and invalid progress even when the PID is alive", () => {
  const root = { directory, source: "explicit" as const };
  const at = new Date("2026-09-22T12:00:00Z");
  const inspect = () => inspectFinanceSchedulerStatus(root, at);
  fs.writeFileSync(path.join(directory, FINANCE_SCHEDULER_PID), String(process.pid));
  fs.mkdirSync(path.join(directory, FINANCE_SCHEDULER_LOCK));
  expect(inspect().progress.status).toBe("unavailable");
  const filename = path.join(directory, FINANCE_SCHEDULER_LOCK, "progress.json");
  const base = {
    pid: process.pid,
    observedAt: "2026-09-22T11:57:00Z",
    phase: "idle",
    timeoutMs: 900000,
    placementEnabled: false,
  };
  fs.writeFileSync(filename, JSON.stringify(base));
  expect(inspect().progress.status).toBe("stalled");
  fs.writeFileSync(filename, JSON.stringify({ ...base, phase: "cycle" }));
  expect(inspect().progress.status).toBe("responsive");
  expect(inspect().executionHealthVerified).toBe(false);
  fs.writeFileSync(filename, JSON.stringify({ ...base, observedAt: "2026-09-22T12:01:00Z" }));
  expect(inspect().progress.status).toBe("invalid");
  fs.writeFileSync(filename, JSON.stringify({ ...base, pid: process.pid + 1 }));
  expect(inspect().progress.status).toBe("invalid");
  fs.writeFileSync(filename, "{");
  expect(inspect().progress.status).toBe("unreadable");
  expect(fs.readFileSync(filename, "utf8")).toBe("{");
  expect(mocks.runCycle).not.toHaveBeenCalled();
});

it("publishes bounded cycle progress and returns to idle without replaying orders", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-21T20:00:00Z"));
  const root = { directory, source: "explicit" as const };
  mocks.runCycle.mockImplementationOnce(async () => {
    expect(inspectFinanceSchedulerStatus(root).progress).toMatchObject({
      status: "responsive",
      phase: "cycle",
      placementEnabled: true,
    });
    return success;
  });
  mocks.delay.mockImplementationOnce(async () => {
    expect(inspectFinanceSchedulerStatus(root).progress).toMatchObject({
      status: "responsive",
      phase: "idle",
      placementEnabled: true,
    });
    process.emit("SIGTERM");
  });
  expect(await runFinanceScheduler(["--loop", "--dir", directory, "--place"])).toBe(143);
  expect(mocks.runCycle).toHaveBeenCalledOnce();
  expect(fs.existsSync(path.join(directory, FINANCE_SCHEDULER_LOCK))).toBe(false);
});

it("refreshes broker reconciliation while an Alpaca history loop is idle", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-22T17:00:00Z"));
  mocks.delay.mockImplementationOnce(async () => process.emit("SIGTERM"));

  expect(
    await runFinanceScheduler([
      "--loop",
      "--dir",
      directory,
      "--sync-alpaca-history",
      "--venue",
      "alpaca",
    ]),
  ).toBe(143);
  expect(mocks.syncAlpacaHistory).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ directory, signal: expect.any(AbortSignal) }),
  );
  expect(mocks.runCycle).not.toHaveBeenCalled();
});

it("exposes an interrupted previous-day attempt that blocks future scheduling", () => {
  fs.writeFileSync(
    path.join(directory, "daily-cycle-scheduler.json"),
    JSON.stringify({
      lastFired: { day: "2026-09-21" },
      lastSucceeded: {},
      lastStatus: { day: "running" },
    }),
  );
  const report = inspectFinanceSchedulerStatus(
    { directory, source: "explicit" },
    new Date("2026-09-22T20:00:00Z"),
  );
  expect(report.slots[0].status).toBe("reconciliation_required");
  expect(mocks.runCycle).not.toHaveBeenCalled();
});

it("does not leak daytime placement and equity requirements into night settlement", async () => {
  await runFinanceScheduler([
    "--once",
    "night",
    "--dir",
    directory,
    "--place",
    "--equity-from-venue",
    "--venue",
    "alpaca",
    "--sync-alpaca-history",
  ]);
  const argv = mocks.runCycle.mock.calls[0][0].argv;
  expect(argv).not.toContain("--place");
  expect(argv).not.toContain("--equity-from-venue");
  expect(argv).toContain("--sync-alpaca-history");
});

it("pins and forwards the local controller policy without changing placement mode", () => {
  const parsed = parseFinanceSchedulerArgs(["--loop", "--execution-policy", "state/policy.json"]);
  expect(parsed.extraArgs).toEqual(["--execution-policy", path.resolve("state/policy.json")]);
});

it.each(["--loop", "--detach", "--once"])(
  "rejects incomplete Alpaca placement before acquiring ownership: %s",
  async (command) => {
    await expect(
      runFinanceScheduler([
        command,
        ...(command === "--once" ? ["day"] : []),
        "--dir",
        directory,
        "--place",
        "--venue",
        "alpaca",
      ]),
    ).rejects.toThrow("--execution-policy");
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.runCycle).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(directory, FINANCE_SCHEDULER_LOCK))).toBe(false);
    expect(fs.existsSync(path.join(directory, FINANCE_SCHEDULER_PID))).toBe(false);
  },
);

it("requires every native execution input and rejects an unsupported quote lifetime", () => {
  const args = [
    "--loop",
    "--place",
    "--venue",
    "alpaca",
    "--execution-policy",
    "policy.json",
    "--execution-quote-feed",
    "iex",
    "--execution-max-age-ms",
    "30000",
  ];
  for (const flag of ["--execution-policy", "--execution-quote-feed", "--execution-max-age-ms"]) {
    const missing = [...args];
    missing.splice(missing.indexOf(flag), 2);
    expect(() => parseFinanceSchedulerArgs(missing)).toThrow(flag);
  }
  expect(parseFinanceSchedulerArgs(args).extraArgs).toContain("--place");
  expect(() => parseFinanceSchedulerArgs([...args.slice(0, -1), "120001"])).toThrow("120000");
  expect(parseFinanceSchedulerArgs(["--status", "--place", "--venue", "alpaca"]).command).toBe(
    "status",
  );
  expect(parseFinanceSchedulerArgs(["--loop", "--venue", "alpaca"]).extraArgs).not.toContain(
    "--place",
  );
});

it.each(["0", "0.7", "1"])(
  "forwards the explicit core allocation unchanged: %s",
  async (fraction) => {
    await runFinanceScheduler(["--once", "day", "--dir", directory, "--core-weight", fraction]);
    expect(mocks.runCycle.mock.calls[0][0].argv).toEqual(
      expect.arrayContaining(["--core-weight", fraction]),
    );
  },
);

it.each(["-0.1", "1.1", "NaN", "Infinity"])(
  "rejects invalid core allocation before a cycle: %s",
  (fraction) => {
    expect(() => parseFinanceSchedulerArgs(["--loop", "--core-weight", fraction])).toThrow();
    expect(mocks.runCycle).not.toHaveBeenCalled();
  },
);
