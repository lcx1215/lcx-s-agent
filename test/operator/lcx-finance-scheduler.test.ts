import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  financeResearchProcessEnv,
  financeResearchPreflightRetryDue,
  inspectFinanceSchedulerStatus,
  inspectFinanceResearchReceiptPersistence,
  describeFinanceCycleExecution,
  parseFinanceSchedulerArgs,
  resolveActiveIntradayRule,
  runFinanceScheduler,
} from "../../scripts/operator/lcx-finance-scheduler.js";
import { caseflowFingerprint } from "../../src/agents/finance-caseflow.js";
import {
  FINANCE_INTRADAY_OPENING_RANGE_EMITS,
  FINANCE_INTRADAY_OPENING_RANGE_FORM,
  FINANCE_INTRADAY_OPENING_RANGE_FORM_VERSION,
  FINANCE_INTRADAY_OPENING_RANGE_RULE,
  FINANCE_INTRADAY_OPENING_RANGE_RULE_V3,
  FINANCE_INTRADAY_OPENING_RANGE_FORM_VERSION_V3,
} from "../../src/agents/finance-intraday-paper.js";
import {
  FINANCE_SCHEDULER_LOCK,
  FINANCE_SCHEDULER_PID,
} from "../../src/agents/finance-scheduler-lock.js";
import type { FinanceCycleProcessResult } from "../../src/agents/finance-scheduler-process.js";
import {
  readFinanceSchedulerState,
  inspectFinanceSchedulerProgress,
  writeFinanceSchedulerState,
} from "../../src/agents/finance-scheduler-state.js";
import {
  activateFinanceStrategyRule,
  retireFinanceStrategyRule,
  declareFinanceStrategyRule,
} from "../../src/agents/finance-strategy-rule-ledger.js";
import type {
  FinanceTradeDecisionReviewer,
  FinanceTradeDecisionReviewRequest,
} from "../../src/agents/finance-trade-decision-review.js";
import { FINANCE_UNIVERSE_SELECTION_SNAPSHOT_FILENAME } from "../../src/agents/finance-universe-selection.js";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  runCycle: vi.fn(),
  delay: vi.fn(),
  killTree: vi.fn(),
  loadConfig: vi.fn(() => ({})),
  syncAlpacaHistory: vi.fn(),
  runSourceHeartbeat: vi.fn(async () => ({
    checkedProviders: [] as string[],
    healthyCount: 0,
    degradedCount: 0,
    unhealthyCount: 0,
  })),
  createIntradayController: vi.fn(() => ({
    accountId: "paper-account",
    executionPolicyAuthorizationMode: "until_expiry",
    executionPolicyExpiresAt: "2026-09-30T23:00:00.000Z",
    inspectReconciliation: vi.fn(async () => ({
      readiness: { status: "reconciled" },
      observedAt: "2026-09-21T14:59:00.000Z",
      protection: { status: "none" },
    })),
  })),
  runIntradayMonitorTick: vi.fn(),
  executeIntradayDecision: vi.fn(),
  createTradeDecisionReviewer: vi.fn(),
  tradeDecisionReviewer: vi.fn(),
  readUniverse: vi.fn(),
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
vi.mock("../../src/agents/finance-source-heartbeat.js", () => ({
  runFinanceSourceHeartbeat: mocks.runSourceHeartbeat,
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
vi.mock("../../src/agents/finance-research-runner.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/agents/finance-research-runner.js")>();
  return { ...actual, readFinanceResearchEquityUniverseSnapshot: mocks.readUniverse };
});

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
const REQUIRED_RESEARCH_GATES = ["source", "committee", "quality", "module_execution"] as const;

function acceptedResearchCandidate(planPath: string, asOf: string) {
  return {
    status: "candidate",
    plan: { asOf },
    gates: REQUIRED_RESEARCH_GATES.map((id) => ({ id, passed: true })),
    portfolioPlanWritten: planPath,
  };
}

function writePortfolioContext(filename: string): void {
  fs.writeFileSync(
    filename,
    JSON.stringify({
      accountId: "paper-account",
      venue: "alpaca",
      validityMinutes: 30,
      conflictPolicy: "block",
      activeStrategyIds: ["fixture-strategy"],
    }),
  );
}

function researchAsOfFromArgs(argv: readonly string[]): string {
  const index = argv.indexOf("--as-of");
  const asOf = index < 0 ? undefined : argv[index + 1];
  if (!asOf) {
    throw new Error("research preflight is missing --as-of");
  }
  return asOf;
}

let directory: string;
let originalTermListeners: number;
let originalIntListeners: number;
let stderrMessages: string[];

type UniverseSnapshotFixture = { generatedAt: string; selected: string[] };

function writeUniverseSnapshot(snapshot: UniverseSnapshotFixture): void {
  fs.writeFileSync(
    path.join(directory, FINANCE_UNIVERSE_SELECTION_SNAPSHOT_FILENAME),
    `${JSON.stringify(snapshot)}\n`,
  );
}

function appendSelectedUniverseReceipt(
  snapshot: UniverseSnapshotFixture,
  overrides: Record<string, unknown> = {},
): void {
  fs.appendFileSync(
    path.join(directory, "finance-universe-selection-runs.jsonl"),
    `${JSON.stringify({
      schemaVersion: "lcx_finance_universe_selection_attempt_v1",
      runId: `fixture-${snapshot.generatedAt.replaceAll(/[^0-9]/gu, "")}`,
      attemptedAt: snapshot.generatedAt,
      completedAt: snapshot.generatedAt,
      status: "selected",
      processStatus: "succeeded",
      exitCode: 0,
      snapshotRef: caseflowFingerprint(snapshot),
      generatedAt: snapshot.generatedAt,
      selectedCount: snapshot.selected.length,
      ...overrides,
    })}\n`,
  );
}

function appendStartedUniverseReceipt(runId: string, startedAt: string): void {
  fs.appendFileSync(
    path.join(directory, "finance-universe-selection-runs.jsonl"),
    `${JSON.stringify({
      schemaVersion: "lcx_finance_universe_selection_attempt_v1",
      runId,
      attemptedAt: startedAt,
      completedAt: startedAt,
      status: "started",
      processStatus: "running",
      exitCode: null,
    })}\n`,
  );
}

function seedSelectedUniverse(snapshot: UniverseSnapshotFixture): void {
  writeUniverseSnapshot(snapshot);
  appendSelectedUniverseReceipt(snapshot);
}

async function activateIntradayRule(
  overrides: Record<string, unknown> = {},
  ruleId: string = FINANCE_INTRADAY_OPENING_RANGE_RULE,
  targetDirectory = directory,
  formVersion: string = FINANCE_INTRADAY_OPENING_RANGE_FORM_VERSION,
): Promise<void> {
  await declareFinanceStrategyRule(targetDirectory, {
    kind: "declared",
    ruleId,
    form: FINANCE_INTRADAY_OPENING_RANGE_FORM,
    formVersion,
    displayName: "ORB fixture",
    instruments: ["SPY"],
    emits: FINANCE_INTRADAY_OPENING_RANGE_EMITS,
    schedule: { kind: "intraday", timezone: "America/New_York" },
    body: {
      universe: ["SPY"],
      frozenRule: { openingRangeBars: 6, rewardRisk: 2 },
      data: { intervalSeconds: 300, feed: "iex" },
      ...overrides,
    },
    observedAt: "2026-09-20T12:00:00Z",
  });
  await activateFinanceStrategyRule(targetDirectory, {
    kind: "activated",
    ruleId,
    observedAt: "2026-09-20T12:01:00Z",
  });
}

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "finance-scheduler-test-"));
  stderrMessages = [];
  mocks.runCycle.mockResolvedValue(success);
  mocks.loadConfig.mockReturnValue({});
  mocks.createIntradayController.mockReturnValue({
    accountId: "paper-account",
    executionPolicyAuthorizationMode: "until_expiry",
    executionPolicyExpiresAt: "2026-09-30T23:00:00.000Z",
    inspectReconciliation: vi.fn(async () => ({
      readiness: { status: "reconciled" },
      observedAt: "2026-09-21T14:59:00.000Z",
      protection: { status: "none" },
    })),
  });
  mocks.syncAlpacaHistory.mockResolvedValue({
    accountId: "paper-account",
    accountReconciliation: { status: "reconciled" },
  });
  mocks.runSourceHeartbeat.mockResolvedValue({
    checkedProviders: [],
    healthyCount: 0,
    degradedCount: 0,
    unhealthyCount: 0,
  });
  mocks.readUniverse.mockImplementation(() => {
    throw new Error("fixture has no current dynamic universe snapshot");
  });
  originalTermListeners = process.listenerCount("SIGTERM");
  originalIntListeners = process.listenerCount("SIGINT");
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderrMessages.push(String(chunk));
    return true;
  });
});

it("rebinds dynamic v3 controller candidates to the refreshed selected universe", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-22T22:00:00.000Z"));
  await activateIntradayRule(
    {
      measuredResult: { status: "paper_contract_only", executionAuthority: "none" },
      paperExecutionEligibility: "paper_execution_eligible",
      paperUniverseScope: "fresh_us_equity_selection_v1",
    },
    FINANCE_INTRADAY_OPENING_RANGE_RULE_V3,
    directory,
    FINANCE_INTRADAY_OPENING_RANGE_FORM_VERSION_V3,
  );
  const policyPath = path.join(directory, "alpaca-policy.json");
  fs.writeFileSync(policyPath, JSON.stringify({ expiresAt: "2026-09-22T23:00:00.000Z" }));
  mocks.createIntradayController.mockReturnValue({
    accountId: "paper-account",
    executionPolicyAuthorizationMode: "until_expiry",
    executionPolicyExpiresAt: "2026-09-22T23:00:00.000Z",
    inspectReconciliation: vi.fn(async () => ({
      readiness: { status: "reconciled" },
      observedAt: "2026-09-22T21:59:00.000Z",
      protection: { status: "none" },
    })),
  });
  writeFinanceSchedulerState(directory, {
    lastFired: { day: "2026-09-22" },
    lastSucceeded: {},
    lastStatus: {},
  });
  const priorSnapshot = { generatedAt: "2026-09-21T22:00:00.000Z", selected: ["SPY", "OLD"] };
  const refreshedSnapshot = { generatedAt: "2026-09-22T22:00:00.000Z", selected: ["SPY", "NEW"] };
  seedSelectedUniverse(priorSnapshot);
  mocks.readUniverse
    .mockReturnValueOnce(priorSnapshot)
    .mockImplementationOnce(() => {
      writeUniverseSnapshot(refreshedSnapshot);
      return refreshedSnapshot;
    })
    .mockReturnValue(refreshedSnapshot);
  mocks.runCycle
    .mockResolvedValueOnce({
      ...success,
      stdout: JSON.stringify({
        ok: true,
        scoredFiled: { appended: 0, skipped: 0 },
        pending: [],
        declined: [],
        issues: [],
      }),
    })
    .mockResolvedValueOnce({
      ...success,
      stdout: JSON.stringify({
        snapshotPersisted: true,
        generatedAt: refreshedSnapshot.generatedAt,
        selected: refreshedSnapshot.selected,
      }),
    });
  mocks.runIntradayMonitorTick.mockResolvedValue({ status: "no_signal" });
  mocks.delay
    .mockImplementationOnce(async () => {})
    .mockImplementationOnce(async () => process.emit("SIGTERM"));

  await expect(
    runFinanceScheduler([
      "--loop",
      "--dir",
      directory,
      "--intraday-monitor",
      "--intraday-place",
      "--no-source-heartbeat",
      "--place",
      "--venue",
      "alpaca",
      "--execution-policy",
      policyPath,
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

  expect(mocks.runIntradayMonitorTick.mock.calls.map(([call]) => call.instrument)).toEqual([
    "SPY",
    "OLD",
    "SPY",
    "NEW",
  ]);
  expect(mocks.createIntradayController).toHaveBeenCalledTimes(2);
  const controllerCalls = mocks.createIntradayController.mock.calls as unknown as Array<
    [{ instruments: string[] }]
  >;
  expect(controllerCalls.map(([options]) => options.instruments)).toEqual([
    ["SPY", "OLD"],
    ["SPY", "NEW"],
  ]);
});
afterEach(() => {
  expect(process.listenerCount("SIGTERM")).toBe(originalTermListeners);
  expect(process.listenerCount("SIGINT")).toBe(originalIntListeners);
  fs.rmSync(directory, { recursive: true, force: true });
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetAllMocks();
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
  expect(mocks.runCycle).toHaveBeenCalledTimes(3);
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
  expect(mocks.runSourceHeartbeat).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ directory, signal: expect.any(AbortSignal) }),
  );
  expect(fs.existsSync(path.join(directory, FINANCE_SCHEDULER_LOCK))).toBe(false);
});

it("does not block the resident scheduler loop on a slow provider heartbeat", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-21T10:00:00Z"));
  let finishHeartbeat: (() => void) | undefined;
  mocks.runSourceHeartbeat.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishHeartbeat = () =>
          resolve({ checkedProviders: [], healthyCount: 0, degradedCount: 0, unhealthyCount: 0 });
      }),
  );
  mocks.delay.mockImplementationOnce(async () => {
    process.emit("SIGTERM");
  });

  const running = runFinanceScheduler(["--loop", "--dir", directory]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const schedulerReachedNextTick = mocks.delay.mock.calls.length === 1;
  if (!schedulerReachedNextTick) {
    process.emit("SIGTERM");
  }
  finishHeartbeat?.();

  await expect(running).resolves.toBe(143);
  expect(schedulerReachedNextTick).toBe(true);
  expect(mocks.runSourceHeartbeat).toHaveBeenCalledOnce();
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

it("enables provider heartbeat by default and supports an explicit isolated-run opt-out", () => {
  expect(parseFinanceSchedulerArgs(["--loop"]).sourceHeartbeatEnabled).toBe(true);
  expect(
    parseFinanceSchedulerArgs(["--loop", "--no-source-heartbeat"]).sourceHeartbeatEnabled,
  ).toBe(false);
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
    placementRequested: false,
    placementEligibility: "not_requested",
    instrumentSource: "explicit",
    instruments: ["SPY", "QQQ"],
    executionInstruments: [],
    intervalSeconds: 300,
    feed: "iex",
    openingRangeBars: 6,
    rewardRisk: 2,
  });
  expect(options.extraArgs).not.toContain("--place");
});

it("accepts the active-rule instrument source without a duplicated ticker list", () => {
  const options = parseFinanceSchedulerArgs([
    "--loop",
    "--intraday-monitor",
    "--intraday-active-rule",
  ]);
  expect(options.intraday).toMatchObject({
    instrumentSource: "active_rule",
    instruments: [],
    openingRangeBars: 6,
    rewardRisk: 2,
  });
  expect(() =>
    parseFinanceSchedulerArgs([
      "--loop",
      "--intraday-monitor",
      "--intraday-active-rule",
      "--intraday-instruments",
      "SPY",
    ]),
  ).toThrow("choose either --intraday-active-rule or --intraday-instruments");
});

it("resolves only one compatible active intraday rule and refuses draft or conflicting rules", async () => {
  await declareFinanceStrategyRule(directory, {
    kind: "declared",
    ruleId: FINANCE_INTRADAY_OPENING_RANGE_RULE,
    form: FINANCE_INTRADAY_OPENING_RANGE_FORM,
    formVersion: FINANCE_INTRADAY_OPENING_RANGE_FORM_VERSION,
    instruments: ["SPY"],
    emits: FINANCE_INTRADAY_OPENING_RANGE_EMITS,
    schedule: { kind: "intraday" },
    body: {
      universe: ["SPY"],
      frozenRule: { openingRangeBars: 6, rewardRisk: 2 },
      data: { intervalSeconds: 300, feed: "iex" },
      measuredResult: { status: "paper_contract_only", executionAuthority: "none" },
    },
    observedAt: "2026-09-20T12:00:00Z",
  });
  await expect(
    resolveActiveIntradayRule(directory, {
      openingRangeBars: 6,
      rewardRisk: 2,
      intervalSeconds: 300,
      feed: "iex",
    }),
  ).rejects.toThrow("found 0");
  await activateFinanceStrategyRule(directory, {
    kind: "activated",
    ruleId: FINANCE_INTRADAY_OPENING_RANGE_RULE,
    observedAt: "2026-09-20T12:01:00Z",
  });
  await expect(
    resolveActiveIntradayRule(directory, {
      openingRangeBars: 6,
      rewardRisk: 2,
      intervalSeconds: 300,
      feed: "iex",
    }),
  ).resolves.toMatchObject({
    instruments: ["SPY"],
    eligibility: { status: "paper_contract_only", automatedPaperPlacementAllowed: true },
  });

  const conflictingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "finance-intraday-conflict-"));
  try {
    await activateIntradayRule({}, "alternate_orb_rule", conflictingDirectory);
    await activateIntradayRule({}, FINANCE_INTRADAY_OPENING_RANGE_RULE, conflictingDirectory);
    await expect(
      resolveActiveIntradayRule(conflictingDirectory, {
        openingRangeBars: 6,
        rewardRisk: 2,
        intervalSeconds: 300,
        feed: "iex",
      }),
    ).rejects.toThrow("found 2");
  } finally {
    fs.rmSync(conflictingDirectory, { recursive: true, force: true });
  }
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

it("creates and calls a fresh single-use reviewer for each actionable intraday decision", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-21T15:00:00Z"));
  await activateIntradayRule({ paperExecutionEligibility: "paper_execution_eligible" });
  const policy = path.join(directory, "alpaca-policy.json");
  fs.writeFileSync(policy, "{}");
  const decisions = ["intraday-signal-1", "intraday-signal-2"].map((signalId) => ({
    input: { signalId },
  }));
  const createSingleUseReviewer = (candidateId: string): FinanceTradeDecisionReviewer => {
    let calls = 0;
    return vi.fn(async (request: FinanceTradeDecisionReviewRequest) => {
      calls += 1;
      if (calls > 1) {
        return {
          status: "failed" as const,
          attempted: false,
          provider: "fixture-provider",
          modelId: "fixture-model",
          latencyMs: 0,
          providerCallObserved: false,
          adapterAttested: false,
          failureCode: "call_budget_exhausted" as const,
        };
      }
      return {
        status: "completed" as const,
        attempted: true,
        provider: "fixture-provider",
        modelId: "fixture-model",
        latencyMs: 1,
        providerCallObserved: true,
        adapterAttested: true,
        decisions: [
          {
            candidateId: request.candidates[0]?.candidateId ?? candidateId,
            decision: "approve" as const,
            rationale: "The supplied paper candidate is valid for this fixture.",
          },
        ],
      };
    });
  };
  const reviewers = decisions.map(({ input }) => createSingleUseReviewer(input.signalId));
  const usedReviewers: FinanceTradeDecisionReviewer[] = [];
  const reviewedSignalIds: string[] = [];
  const reviewedCandidateIds: string[] = [];
  mocks.createTradeDecisionReviewer
    .mockReturnValueOnce(reviewers[0])
    .mockReturnValueOnce(reviewers[1]);
  for (const decision of decisions) {
    mocks.runIntradayMonitorTick.mockResolvedValueOnce({
      status: "decision_recorded",
      signal: {
        action: "buy",
        reason: "opening_range_breakout",
        signalId: decision.input.signalId,
      },
      decision,
    });
  }
  const invokeReviewer = async (params: {
    decision: { input: { signalId: string } };
    tradeDecisionReviewer?: FinanceTradeDecisionReviewer;
  }) => {
    const reviewer = params.tradeDecisionReviewer;
    if (!reviewer) {
      throw new Error("actionable intraday decision requires its reviewer");
    }
    const signalId = params.decision.input.signalId;
    usedReviewers.push(reviewer);
    reviewedSignalIds.push(signalId);
    const result = await reviewer(
      { candidates: [{ candidateId: signalId }] } as never,
      new AbortController().signal,
    );
    const decision = result.decisions?.[0];
    if (decision) {
      reviewedCandidateIds.push(decision.candidateId);
    }
    return {
      status: result.status === "completed" ? ("placed" as const) : ("refused" as const),
      tradeDecisionReview: {
        status: result.status,
        ...(decision ? { decision } : {}),
        ...(result.failureCode ? { failureCode: result.failureCode } : {}),
      },
    };
  };
  mocks.executeIntradayDecision
    .mockImplementationOnce(invokeReviewer)
    .mockImplementationOnce(invokeReviewer);
  mocks.delay
    .mockImplementationOnce(async () => {})
    .mockImplementationOnce(async () => {
      process.emit("SIGTERM");
    });

  await expect(
    runFinanceScheduler([
      "--loop",
      "--dir",
      directory,
      "--intraday-monitor",
      "--intraday-place",
      "--intraday-active-rule",
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
  expect(mocks.createTradeDecisionReviewer).toHaveBeenCalledTimes(2);
  expect(mocks.createTradeDecisionReviewer).toHaveBeenNthCalledWith(1, {});
  expect(mocks.createTradeDecisionReviewer).toHaveBeenNthCalledWith(2, {});
  expect(mocks.executeIntradayDecision).toHaveBeenCalledTimes(2);
  expect(usedReviewers).toEqual(reviewers);
  expect(reviewedSignalIds).toEqual(["intraday-signal-1", "intraday-signal-2"]);
  expect(reviewedCandidateIds).toEqual(reviewedSignalIds);
  expect(reviewers[0]).toHaveBeenCalledOnce();
  expect(reviewers[1]).toHaveBeenCalledOnce();
});

it("prioritizes executable instruments and never submits research-scope signals", async () => {
  fs.writeFileSync(path.join(directory, "alpaca-policy.json"), "{}");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-21T15:00:00Z"));
  await activateIntradayRule({ paperExecutionEligibility: "paper_execution_eligible" });
  const snapshot = { generatedAt: "2026-09-21T14:30:00Z", selected: ["QQQ", "SPY"] };
  seedSelectedUniverse(snapshot);
  mocks.readUniverse.mockReturnValue(snapshot);
  mocks.runIntradayMonitorTick.mockImplementation(async ({ instrument }) => ({
    status: "decision_recorded",
    signal: { action: "buy", signalId: instrument },
    decision: { input: { signalId: instrument } },
  }));
  mocks.executeIntradayDecision.mockResolvedValue({ status: "placed" });
  mocks.delay.mockImplementationOnce(async () => {
    process.emit("SIGTERM");
  });
  await runFinanceScheduler([
    "--loop",
    "--dir",
    directory,
    "--intraday-monitor",
    "--intraday-place",
    "--no-source-heartbeat",
    "--place",
    "--venue",
    "alpaca",
    "--execution-policy",
    path.join(directory, "alpaca-policy.json"),
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
  ]);
  expect(mocks.runIntradayMonitorTick.mock.calls.map(([call]) => call.instrument)).toEqual([
    "SPY",
    "QQQ",
  ]);
  expect(mocks.executeIntradayDecision).toHaveBeenCalledOnce();
  expect(mocks.executeIntradayDecision).toHaveBeenCalledWith(
    expect.objectContaining({
      decision: { input: { signalId: "SPY" } },
    }),
  );
});

it("uses the validated system universe when monitoring has no explicit diagnostic symbols", () => {
  expect(parseFinanceSchedulerArgs(["--loop", "--intraday-monitor"]).intraday).toMatchObject({
    instrumentSource: "system_universe",
    instruments: [],
  });
});

it("monitors only symbols from the validated dynamic universe, never a static ticker fallback", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-21T14:30:00.000Z"));
  await activateIntradayRule();
  const snapshot = {
    generatedAt: "2026-09-21T14:00:00.000Z",
    selected: ["AAA", "BBB"],
  };
  seedSelectedUniverse(snapshot);
  mocks.readUniverse.mockReturnValue(snapshot);
  mocks.runIntradayMonitorTick.mockResolvedValue({ status: "no_signal" });
  mocks.delay.mockImplementationOnce(async () => {
    process.emit("SIGTERM");
  });
  await expect(
    runFinanceScheduler([
      "--loop",
      "--dir",
      directory,
      "--intraday-monitor",
      "--no-source-heartbeat",
    ]),
  ).resolves.toBe(143);
  expect(mocks.readUniverse).toHaveBeenCalledTimes(2);
  expect(mocks.runIntradayMonitorTick.mock.calls.map(([call]) => call.instrument)).toEqual([
    "AAA",
    "BBB",
  ]);
  expect(mocks.runIntradayMonitorTick.mock.calls[0]?.[0]).toMatchObject({
    scope: {
      kind: "system_universe",
      universeSnapshotRef: expect.any(String),
      selectedInstruments: ["AAA", "BBB"],
    },
    strategyContract: { instruments: ["SPY"] },
  });
});

it("allows a receipt-free validated snapshot to bootstrap a first scheduler run", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-20T14:30:00.000Z"));
  await activateIntradayRule();
  const snapshot = {
    generatedAt: "2026-09-20T14:00:00.000Z",
    selected: ["BOOTSTRAP"],
  };
  writeUniverseSnapshot(snapshot);
  mocks.readUniverse.mockReturnValue(snapshot);
  mocks.runIntradayMonitorTick.mockResolvedValue({ status: "no_signal" });
  mocks.delay.mockImplementationOnce(async () => {
    process.emit("SIGTERM");
  });

  await expect(
    runFinanceScheduler([
      "--loop",
      "--dir",
      directory,
      "--intraday-monitor",
      "--no-source-heartbeat",
    ]),
  ).resolves.toBe(143);

  expect(mocks.runIntradayMonitorTick.mock.calls.map(([call]) => call.instrument)).toEqual([
    "BOOTSTRAP",
  ]);
});

it("rejects a fresh canonical snapshot when the latest receipt is still started", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-20T14:30:00.000Z"));
  await activateIntradayRule();
  const snapshot = {
    generatedAt: "2026-09-20T14:20:00.000Z",
    selected: ["INTERRUPTED"],
  };
  writeUniverseSnapshot(snapshot);
  appendStartedUniverseReceipt("crashed-before-selected-receipt", "2026-09-20T14:10:00.000Z");
  mocks.readUniverse.mockReturnValue(snapshot);
  mocks.delay.mockImplementationOnce(async () => {
    process.emit("SIGTERM");
  });

  await expect(
    runFinanceScheduler([
      "--loop",
      "--dir",
      directory,
      "--intraday-monitor",
      "--no-source-heartbeat",
    ]),
  ).resolves.toBe(143);

  expect(mocks.runIntradayMonitorTick).not.toHaveBeenCalled();
  expect(mocks.runCycle).not.toHaveBeenCalled();
});

it("has no intraday candidates when the dynamic universe receipt is missing or stale", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-21T14:30:00.000Z"));
  await activateIntradayRule();
  mocks.runIntradayMonitorTick.mockResolvedValue({ status: "no_signal" });
  mocks.delay.mockImplementationOnce(async () => {
    process.emit("SIGTERM");
  });
  await expect(
    runFinanceScheduler([
      "--loop",
      "--dir",
      directory,
      "--intraday-monitor",
      "--no-source-heartbeat",
    ]),
  ).resolves.toBe(143);
  expect(mocks.readUniverse).toHaveBeenCalledTimes(2);
  expect(mocks.runIntradayMonitorTick).not.toHaveBeenCalled();
});

it.each([
  ["snapshotRef", { snapshotRef: "f".repeat(64) }],
  ["generatedAt", { generatedAt: "2026-09-19T14:00:00.000Z" }],
  ["selectedCount", { selectedCount: 99 }],
])(
  "fails closed when the latest selected receipt has a mismatched %s",
  async (_field, override) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-20T14:30:00.000Z"));
    await activateIntradayRule();
    const snapshot = {
      generatedAt: "2026-09-20T14:00:00.000Z",
      selected: ["AAA", "BBB"],
    };
    writeUniverseSnapshot(snapshot);
    appendSelectedUniverseReceipt(snapshot, override);
    mocks.readUniverse.mockReturnValue(snapshot);
    mocks.delay.mockImplementationOnce(async () => {
      process.emit("SIGTERM");
    });

    await expect(
      runFinanceScheduler([
        "--loop",
        "--dir",
        directory,
        "--intraday-monitor",
        "--no-source-heartbeat",
      ]),
    ).resolves.toBe(143);

    expect(mocks.runIntradayMonitorTick).not.toHaveBeenCalled();
    expect(mocks.runCycle).not.toHaveBeenCalled();
  },
);

it("rebinds a long-lived monitor to the universe written by a successful night refresh", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-22T22:00:00.000Z"));
  await activateIntradayRule({
    measuredResult: { status: "paper_contract_only", executionAuthority: "none" },
  });
  const policyPath = path.join(directory, "alpaca-policy.json");
  const loadedPolicyExpiry = "2026-09-22T23:00:00.000Z";
  fs.writeFileSync(policyPath, JSON.stringify({ expiresAt: loadedPolicyExpiry }));
  mocks.createIntradayController.mockReturnValue({
    accountId: "paper-account",
    executionPolicyAuthorizationMode: "until_expiry",
    executionPolicyExpiresAt: loadedPolicyExpiry,
    inspectReconciliation: vi.fn(async () => ({
      readiness: { status: "reconciled" },
      observedAt: "2026-09-22T21:59:00.000Z",
      protection: { status: "none" },
    })),
  });
  writeFinanceSchedulerState(directory, {
    lastFired: { day: "2026-09-22" },
    lastSucceeded: {},
    lastStatus: {},
  });
  const priorSnapshot = {
    generatedAt: "2026-09-21T22:00:00.000Z",
    selected: ["SPY", "OLD"],
  };
  const refreshedSnapshot = {
    generatedAt: "2026-09-22T22:00:00.000Z",
    selected: ["SPY", "NEW"],
  };
  seedSelectedUniverse(priorSnapshot);
  mocks.readUniverse
    .mockReturnValueOnce(priorSnapshot)
    .mockImplementationOnce(() => {
      writeUniverseSnapshot(refreshedSnapshot);
      return refreshedSnapshot;
    })
    .mockReturnValue(refreshedSnapshot);
  mocks.runCycle
    .mockResolvedValueOnce({
      ...success,
      stdout: JSON.stringify({
        ok: true,
        scoredFiled: { appended: 0, skipped: 0 },
        pending: [],
        declined: [],
        issues: [],
      }),
    })
    .mockResolvedValueOnce({
      ...success,
      stdout: JSON.stringify({
        snapshotPersisted: true,
        generatedAt: "2026-09-22T22:00:00.000Z",
        selected: ["SPY", "NEW"],
      }),
    });
  mocks.runIntradayMonitorTick.mockResolvedValue({ status: "no_signal" });
  let progressAtStop: Record<string, unknown> | undefined;
  mocks.delay
    .mockImplementationOnce(async () => {
      fs.writeFileSync(policyPath, JSON.stringify({ authorizationMode: "until_revoked" }));
    })
    .mockImplementationOnce(async () => {
      progressAtStop = JSON.parse(
        fs.readFileSync(path.join(directory, FINANCE_SCHEDULER_LOCK, "progress.json"), "utf8"),
      ) as Record<string, unknown>;
      process.emit("SIGTERM");
    });

  await expect(
    runFinanceScheduler([
      "--loop",
      "--dir",
      directory,
      "--intraday-monitor",
      "--intraday-place",
      "--no-source-heartbeat",
      "--place",
      "--venue",
      "alpaca",
      "--execution-policy",
      path.join(directory, "alpaca-policy.json"),
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

  expect(mocks.readUniverse).toHaveBeenCalledTimes(4);
  expect(mocks.runIntradayMonitorTick.mock.calls.map(([call]) => call.instrument)).toEqual([
    "SPY",
    "OLD",
    "SPY",
    "NEW",
  ]);
  const firstScope = mocks.runIntradayMonitorTick.mock.calls[0]?.[0].scope;
  const refreshedScope = mocks.runIntradayMonitorTick.mock.calls[2]?.[0].scope;
  expect(firstScope).toMatchObject({
    kind: "system_universe",
    selectedInstruments: ["SPY", "OLD"],
  });
  expect(refreshedScope).toMatchObject({
    kind: "system_universe",
    selectedInstruments: ["SPY", "NEW"],
  });
  expect(refreshedScope?.universeSnapshotRef).not.toBe(firstScope?.universeSnapshotRef);
  expect(mocks.createIntradayController).toHaveBeenCalledTimes(2);
  expect(mocks.executeIntradayDecision).not.toHaveBeenCalled();
  expect(progressAtStop).toMatchObject({
    executionPolicyAuthorizationMode: "until_revoked",
    executionPolicyExpiresAt: null,
    intradayControllerPolicyAuthorizationMode: "until_expiry",
    intradayControllerPolicyExpiresAt: loadedPolicyExpiry,
    intraday: {
      placementEnabled: true,
      placementEligibility: "paper_contract_only",
      universeStatus: "validated",
      instruments: ["SPY", "NEW"],
      executionInstruments: ["SPY"],
    },
  });
});

it("recovers a long-lived monitor after startup without a universe and a successful refresh", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-22T22:00:00.000Z"));
  await activateIntradayRule();
  writeFinanceSchedulerState(directory, {
    lastFired: { day: "2026-09-22" },
    lastSucceeded: {},
    lastStatus: {},
  });
  mocks.readUniverse
    .mockImplementationOnce(() => {
      throw new Error("no startup snapshot");
    })
    .mockImplementationOnce(() => {
      const snapshot = {
        generatedAt: "2026-09-22T22:00:00.000Z",
        selected: ["SPY", "RECOVERED"],
      };
      writeUniverseSnapshot(snapshot);
      return snapshot;
    })
    .mockReturnValue({
      generatedAt: "2026-09-22T22:00:00.000Z",
      selected: ["SPY", "RECOVERED"],
    });
  mocks.runCycle
    .mockResolvedValueOnce({
      ...success,
      stdout: JSON.stringify({
        ok: true,
        scoredFiled: { appended: 0, skipped: 0 },
        pending: [],
        declined: [],
        issues: [],
      }),
    })
    .mockResolvedValueOnce({
      ...success,
      stdout: JSON.stringify({
        snapshotPersisted: true,
        generatedAt: "2026-09-22T22:00:00.000Z",
        selected: ["SPY", "RECOVERED"],
      }),
    });
  mocks.runIntradayMonitorTick.mockResolvedValue({ status: "no_signal" });
  mocks.delay
    .mockImplementationOnce(async () => {})
    .mockImplementationOnce(async () => {
      process.emit("SIGTERM");
    });

  await expect(
    runFinanceScheduler([
      "--loop",
      "--dir",
      directory,
      "--intraday-monitor",
      "--no-source-heartbeat",
    ]),
  ).resolves.toBe(143);

  expect(mocks.readUniverse).toHaveBeenCalledTimes(4);
  expect(mocks.runIntradayMonitorTick.mock.calls.map(([call]) => call.instrument)).toEqual([
    "SPY",
    "RECOVERED",
    "SPY",
    "RECOVERED",
  ]);
  expect(mocks.runIntradayMonitorTick.mock.calls[0]?.[0].scope).toMatchObject({
    kind: "system_universe",
    selectedInstruments: ["SPY", "RECOVERED"],
  });
});

it("clears a previously bound universe when the night selector fails", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-22T22:00:00.000Z"));
  await activateIntradayRule();
  writeFinanceSchedulerState(directory, {
    lastFired: { day: "2026-09-22" },
    lastSucceeded: {},
    lastStatus: {},
  });
  const priorSnapshot = {
    generatedAt: "2026-09-21T22:00:00.000Z",
    selected: ["SPY", "STALE"],
  };
  seedSelectedUniverse(priorSnapshot);
  mocks.readUniverse.mockReturnValueOnce(priorSnapshot);
  mocks.runCycle
    .mockResolvedValueOnce({
      ...success,
      stdout: JSON.stringify({
        ok: true,
        scoredFiled: { appended: 0, skipped: 0 },
        pending: [],
        declined: [],
        issues: [],
      }),
    })
    .mockResolvedValueOnce({
      ...success,
      ok: false,
      exitCode: 1,
      status: "failed",
      stdout: "",
      stderr: "selector failed",
    });
  mocks.runIntradayMonitorTick.mockResolvedValue({ status: "no_signal" });
  let progressAtStop: Record<string, unknown> | undefined;
  mocks.delay
    .mockImplementationOnce(async () => {})
    .mockImplementationOnce(async () => {
      const progress = JSON.parse(
        fs.readFileSync(path.join(directory, FINANCE_SCHEDULER_LOCK, "progress.json"), "utf8"),
      ) as { intraday?: Record<string, unknown> };
      progressAtStop = progress.intraday;
      process.emit("SIGTERM");
    });

  await expect(
    runFinanceScheduler([
      "--loop",
      "--dir",
      directory,
      "--intraday-monitor",
      "--no-source-heartbeat",
    ]),
  ).resolves.toBe(143);

  expect(mocks.runIntradayMonitorTick.mock.calls.map(([call]) => call.instrument)).toEqual([
    "SPY",
    "STALE",
    "SPY",
    "STALE",
  ]);
  expect(mocks.readUniverse).toHaveBeenCalledTimes(3);
  expect(progressAtStop).toMatchObject({
    placementEnabled: false,
    universeStatus: "unavailable",
    instruments: ["SPY", "STALE"],
    executionInstruments: [],
  });
  const selectionReceipt = JSON.parse(
    fs
      .readFileSync(path.join(directory, "finance-universe-selection-runs.jsonl"), "utf8")
      .trim()
      .split("\n")
      .at(-1)!,
  );
  expect(selectionReceipt).toMatchObject({ status: "failed" });
  expect(fs.existsSync(path.join(directory, FINANCE_UNIVERSE_SELECTION_SNAPSHOT_FILENAME))).toBe(
    false,
  );
  expect(
    JSON.parse(
      fs.readFileSync(
        path.join(directory, `finance-universe-selection-${selectionReceipt.runId}-previous.json`),
        "utf8",
      ),
    ),
  ).toEqual(priorSnapshot);
  expect(readFinanceSchedulerState(directory).lastSucceeded.night).toBe("2026-09-22");
});

it("keeps failed receipt appends fail-closed across restart and preserves snapshots", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-22T22:00:00.000Z"));
  await activateIntradayRule();
  writeFinanceSchedulerState(directory, {
    lastFired: { day: "2026-09-22" },
    lastSucceeded: {},
    lastStatus: {},
  });
  const priorSnapshot = {
    generatedAt: "2026-09-21T22:00:00.000Z",
    selected: ["SPY", "PRIOR"],
  };
  const selectedSnapshot = {
    generatedAt: "2026-09-22T22:00:00.000Z",
    selected: ["SPY", "UNRECEIPTED"],
  };
  seedSelectedUniverse(priorSnapshot);
  mocks.readUniverse.mockReturnValueOnce(priorSnapshot).mockImplementationOnce(() => {
    writeUniverseSnapshot(selectedSnapshot);
    return selectedSnapshot;
  });
  mocks.runCycle
    .mockResolvedValueOnce({
      ...success,
      stdout: JSON.stringify({
        ok: true,
        scoredFiled: { appended: 0, skipped: 0 },
        pending: [],
        declined: [],
        issues: [],
      }),
    })
    .mockResolvedValueOnce({
      ...success,
      stdout: JSON.stringify({
        snapshotPersisted: true,
        generatedAt: selectedSnapshot.generatedAt,
        selected: selectedSnapshot.selected,
      }),
    });
  const universeReceiptPath = path.join(directory, "finance-universe-selection-runs.jsonl");
  const appendFile = fs.appendFileSync.bind(fs);
  vi.spyOn(fs, "appendFileSync").mockImplementation((filename, data, options) => {
    if (String(filename) === universeReceiptPath && !String(data).includes('"status":"started"')) {
      throw new Error("simulated receipt disk failure");
    }
    return appendFile(filename, data, options);
  });
  mocks.runIntradayMonitorTick.mockResolvedValue({ status: "no_signal" });
  mocks.delay
    .mockImplementationOnce(async () => {})
    .mockImplementationOnce(async () => {
      process.emit("SIGTERM");
    });

  const args = ["--loop", "--dir", directory, "--intraday-monitor", "--no-source-heartbeat"];
  await expect(runFinanceScheduler(args)).resolves.toBe(143);
  expect(mocks.runIntradayMonitorTick.mock.calls.map(([call]) => call.instrument)).toEqual([
    "SPY",
    "PRIOR",
    "SPY",
    "PRIOR",
  ]);
  expect(fs.existsSync(path.join(directory, FINANCE_UNIVERSE_SELECTION_SNAPSHOT_FILENAME))).toBe(
    false,
  );
  const preservedSnapshots = fs
    .readdirSync(directory)
    .filter((name) => name.endsWith("-previous.json") || name.endsWith("-unreceipted.json"));
  expect(preservedSnapshots).toHaveLength(1);
  expect(
    stderrMessages.some((message) =>
      message.includes("universe selection receipt append failed: simulated receipt disk failure"),
    ),
  ).toBe(true);
  const latestReceipt = fs.readFileSync(universeReceiptPath, "utf8").trim().split("\n").at(-1)!;
  expect(JSON.parse(latestReceipt)).toMatchObject({ status: "started" });

  mocks.runIntradayMonitorTick.mockClear();
  mocks.readUniverse.mockImplementation(() => {
    const snapshotPath = path.join(directory, FINANCE_UNIVERSE_SELECTION_SNAPSHOT_FILENAME);
    if (!fs.existsSync(snapshotPath)) {
      throw new Error("canonical snapshot was invalidated before receipt failure");
    }
    return JSON.parse(fs.readFileSync(snapshotPath, "utf8")) as UniverseSnapshotFixture;
  });
  mocks.delay.mockImplementationOnce(async () => {
    process.emit("SIGTERM");
  });
  await expect(runFinanceScheduler(args)).resolves.toBe(143);
  expect(mocks.runIntradayMonitorTick).not.toHaveBeenCalled();
});

it("does not run selector when the started receipt append fails", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-22T22:00:00.000Z"));
  await activateIntradayRule();
  writeFinanceSchedulerState(directory, {
    lastFired: { day: "2026-09-22" },
    lastSucceeded: {},
    lastStatus: {},
  });
  const priorSnapshot = {
    generatedAt: "2026-09-21T22:00:00.000Z",
    selected: ["SPY", "PRIOR"],
  };
  seedSelectedUniverse(priorSnapshot);
  mocks.readUniverse.mockReturnValue(priorSnapshot);
  mocks.runCycle.mockResolvedValueOnce({
    ...success,
    stdout: JSON.stringify({
      ok: true,
      scoredFiled: { appended: 0, skipped: 0 },
      pending: [],
      declined: [],
      issues: [],
    }),
  });
  const universeReceiptPath = path.join(directory, "finance-universe-selection-runs.jsonl");
  const appendFile = fs.appendFileSync.bind(fs);
  const canonicalPath = path.join(directory, FINANCE_UNIVERSE_SELECTION_SNAPSHOT_FILENAME);
  const rename = fs.renameSync.bind(fs);
  const canonicalRenameAttempts: string[] = [];
  vi.spyOn(fs, "appendFileSync").mockImplementation((filename, data, options) => {
    if (String(filename) === universeReceiptPath && String(data).includes('"status":"started"')) {
      throw new Error("simulated started receipt disk failure");
    }
    return appendFile(filename, data, options);
  });
  vi.spyOn(fs, "renameSync").mockImplementation((oldPath, newPath) => {
    if (String(oldPath) === canonicalPath) {
      canonicalRenameAttempts.push(String(newPath));
    }
    return rename(oldPath, newPath);
  });
  mocks.runIntradayMonitorTick.mockResolvedValue({ status: "no_signal" });
  mocks.delay
    .mockImplementationOnce(async () => {})
    .mockImplementationOnce(async () => {
      process.emit("SIGTERM");
    });

  await expect(
    runFinanceScheduler([
      "--loop",
      "--dir",
      directory,
      "--intraday-monitor",
      "--no-source-heartbeat",
    ]),
  ).resolves.toBe(143);

  expect(mocks.runCycle).toHaveBeenCalledOnce();
  expect(mocks.runIntradayMonitorTick.mock.calls.map(([call]) => call.instrument)).toEqual([
    "SPY",
    "PRIOR",
    "SPY",
    "PRIOR",
  ]);
  expect(fs.readFileSync(canonicalPath, "utf8").trim()).toBe(JSON.stringify(priorSnapshot));
  expect(canonicalRenameAttempts).toEqual([]);
  const latestReceipt = fs.readFileSync(universeReceiptPath, "utf8").trim().split("\n").at(-1)!;
  expect(JSON.parse(latestReceipt)).toMatchObject({ status: "failed" });
});

it("rejects the old snapshot when rename and failed receipt writes fail after started persists", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-22T22:00:00.000Z"));
  await activateIntradayRule();
  writeFinanceSchedulerState(directory, {
    lastFired: { day: "2026-09-22" },
    lastSucceeded: {},
    lastStatus: {},
  });
  const priorSnapshot = {
    generatedAt: "2026-09-21T22:00:00.000Z",
    selected: ["SPY", "OLD"],
  };
  seedSelectedUniverse(priorSnapshot);
  mocks.readUniverse.mockReturnValue(priorSnapshot);
  const canonicalPath = path.join(directory, FINANCE_UNIVERSE_SELECTION_SNAPSHOT_FILENAME);
  const rename = fs.renameSync.bind(fs);
  const appendFile = fs.appendFileSync.bind(fs);
  const universeReceiptPath = path.join(directory, "finance-universe-selection-runs.jsonl");
  const eventOrder: string[] = [];
  vi.spyOn(fs, "appendFileSync").mockImplementation((filename, data, options) => {
    if (String(filename) === universeReceiptPath) {
      if (String(data).includes('"status":"started"')) {
        eventOrder.push("started");
      }
      if (String(data).includes('"status":"failed"')) {
        throw new Error("simulated final failed receipt disk failure");
      }
    }
    return appendFile(filename, data, options);
  });
  vi.spyOn(fs, "renameSync").mockImplementation((oldPath, newPath) => {
    if (String(oldPath) === canonicalPath) {
      eventOrder.push("rename");
      throw new Error("simulated persistent snapshot rename failure");
    }
    return rename(oldPath, newPath);
  });
  mocks.runIntradayMonitorTick.mockResolvedValue({ status: "no_signal" });
  mocks.delay
    .mockImplementationOnce(async () => {})
    .mockImplementationOnce(async () => {
      process.emit("SIGTERM");
    });
  const args = ["--loop", "--dir", directory, "--intraday-monitor", "--no-source-heartbeat"];

  await expect(runFinanceScheduler(args)).resolves.toBe(143);
  expect(mocks.runCycle).toHaveBeenCalledOnce();
  expect(eventOrder.slice(0, 2)).toEqual(["started", "rename"]);
  expect(fs.readFileSync(canonicalPath, "utf8").trim()).toBe(JSON.stringify(priorSnapshot));
  expect(mocks.runIntradayMonitorTick.mock.calls.map(([call]) => call.instrument)).toEqual([
    "SPY",
    "OLD",
    "SPY",
    "OLD",
  ]);
  const latestReceipt = fs
    .readFileSync(path.join(directory, "finance-universe-selection-runs.jsonl"), "utf8")
    .trim()
    .split("\n")
    .at(-1)!;
  expect(JSON.parse(latestReceipt)).toMatchObject({ status: "started" });

  mocks.runIntradayMonitorTick.mockClear();
  mocks.delay.mockImplementationOnce(async () => {
    process.emit("SIGTERM");
  });
  await expect(runFinanceScheduler(args)).resolves.toBe(143);
  expect(mocks.runIntradayMonitorTick).not.toHaveBeenCalled();
});

it("does not re-arm a same-millisecond failed snapshot receipt, then recovers on success", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-22T22:00:00.000Z"));
  await activateIntradayRule();
  writeFinanceSchedulerState(directory, {
    lastFired: { day: "2026-09-22" },
    lastSucceeded: {},
    lastStatus: {},
  });
  const priorSnapshot = {
    generatedAt: "2026-09-22T21:56:00.000Z",
    selected: ["SPY", "INVALIDATED"],
  };
  const recoveredSnapshot = {
    generatedAt: "2026-09-22T22:00:00.000Z",
    selected: ["SPY", "RECOVERED"],
  };
  writeUniverseSnapshot(priorSnapshot);
  fs.writeFileSync(
    path.join(directory, "finance-universe-selection-runs.jsonl"),
    `${JSON.stringify({
      schemaVersion: "lcx_finance_universe_selection_attempt_v1",
      runId: "failed-before-restart",
      attemptedAt: "2026-09-22T21:54:00.000Z",
      completedAt: "2026-09-22T21:56:00.000Z",
      status: "failed",
      processStatus: "failed",
      exitCode: 1,
      error: "selector unavailable",
    })}\n`,
  );
  mocks.readUniverse
    .mockReturnValueOnce(priorSnapshot)
    .mockImplementationOnce(() => {
      writeUniverseSnapshot(recoveredSnapshot);
      return recoveredSnapshot;
    })
    .mockReturnValue(recoveredSnapshot);
  mocks.runCycle
    .mockResolvedValueOnce({
      ...success,
      stdout: JSON.stringify({
        ok: true,
        scoredFiled: { appended: 0, skipped: 0 },
        pending: [],
        declined: [],
        issues: [],
      }),
    })
    .mockResolvedValueOnce({
      ...success,
      stdout: JSON.stringify({
        snapshotPersisted: true,
        generatedAt: "2026-09-22T22:00:00.000Z",
        selected: ["SPY", "RECOVERED"],
      }),
    });
  mocks.runIntradayMonitorTick.mockResolvedValue({ status: "no_signal" });
  mocks.delay
    .mockImplementationOnce(async () => {})
    .mockImplementationOnce(async () => {
      process.emit("SIGTERM");
    });

  const args = ["--loop", "--dir", directory, "--intraday-monitor", "--no-source-heartbeat"];
  await expect(runFinanceScheduler(args)).resolves.toBe(143);
  expect(mocks.runIntradayMonitorTick.mock.calls.map(([call]) => call.instrument)).toEqual([
    "SPY",
    "RECOVERED",
    "SPY",
    "RECOVERED",
  ]);
  const receipts = fs
    .readFileSync(path.join(directory, "finance-universe-selection-runs.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(receipts.map((receipt) => receipt.status)).toEqual(["failed", "started", "selected"]);

  mocks.runIntradayMonitorTick.mockClear();
  mocks.delay.mockImplementationOnce(async () => {
    process.emit("SIGTERM");
  });
  await expect(runFinanceScheduler(args)).resolves.toBe(143);
  expect(mocks.runIntradayMonitorTick.mock.calls.map(([call]) => call.instrument)).toEqual([
    "SPY",
    "RECOVERED",
  ]);
  expect(mocks.runIntradayMonitorTick.mock.calls[0]?.[0].scope).toMatchObject({
    kind: "system_universe",
    selectedInstruments: ["SPY", "RECOVERED"],
  });
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

  const failedReview = {
    status: "failed",
    candidateCount: 1,
    modelCalls: 1,
    failureCode: "output_truncated",
  };
  const placed = describeFinanceCycleExecution(
    JSON.stringify({
      ok: true,
      placed: [{ instrument: "SPY", quantity: 1, notional: 500 }],
      drift: [{ action: "buy" }],
      refusals: [],
      tradeDecisionReview: failedReview,
    }),
    ["--place", "--venue", "alpaca"],
    "day",
  );
  expect(placed).toMatchObject({
    outcome: "placement_reported",
    reportedPlacements: 1,
    tradeDecisionReview: { status: "failed", failureCode: "output_truncated" },
  });

  const refused = describeFinanceCycleExecution(
    JSON.stringify({
      ok: false,
      placed: [],
      drift: [{ action: "buy" }],
      refusals: ["SPY: shared execution gate refusal"],
      tradeDecisionReview: failedReview,
    }),
    ["--place", "--venue", "alpaca"],
    "day",
  );
  expect(refused).toMatchObject({
    outcome: "blocked_or_partial",
    refusalCount: 1,
    tradeDecisionReview: { status: "failed", failureCode: "output_truncated" },
  });

  expect(
    describeFinanceCycleExecution(
      JSON.stringify({
        ok: true,
        placed: [],
        drift: [{ action: "buy" }],
        refusals: [],
        tradeDecisionReview: failedReview,
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
  vi.stubEnv("LCX_FINANCE_RESEARCH_HTTP_PROXY", "http://127.0.0.1:7897");
  vi.stubEnv("LCX_FINANCE_HTTP_PROXY", "");
  const context = path.join(directory, "portfolio-context.json");
  const plan = path.join(directory, "research-portfolio-plan-latest.json");
  writePortfolioContext(context);
  mocks.runCycle
    .mockImplementationOnce(async ({ argv }: { argv: readonly string[] }) => {
      fs.writeFileSync(context, JSON.stringify({ accountId: "different-account", venue: "paper" }));
      const frozenPath = argv[argv.indexOf("--portfolio-context") + 1];
      expect(JSON.parse(fs.readFileSync(frozenPath, "utf8"))).toMatchObject({
        accountId: "paper-account",
        venue: "alpaca",
      });
      return {
        ...success,
        stdout: JSON.stringify(acceptedResearchCandidate(plan, researchAsOfFromArgs(argv))),
      };
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
  expect(mocks.runCycle.mock.calls[0][0].env.LCX_FINANCE_HTTP_PROXY).toBe("http://127.0.0.1:7897");
  expect(mocks.runCycle.mock.calls[1][0].env).toBeUndefined();
  expect(process.env.LCX_FINANCE_HTTP_PROXY).toBe("");
  const researchArgv = mocks.runCycle.mock.calls[0][0].argv as string[];
  const evidencePath = researchArgv[researchArgv.indexOf("--controller-evidence") + 1];
  const frozenContextPath = researchArgv[researchArgv.indexOf("--portfolio-context") + 1];
  expect(evidencePath).toMatch(
    /^.*\/day-research-controller-evidence-\d{4}-\d{2}-\d{2}-[0-9a-f-]{36}\.json$/u,
  );
  expect(frozenContextPath).toMatch(
    /^.*\/day-research-portfolio-context-\d{4}-\d{2}-\d{2}-[0-9a-f-]{36}\.json$/u,
  );
  expect(frozenContextPath).not.toBe(context);
  expect(mocks.runCycle.mock.calls[0][0].argv).toEqual(
    expect.arrayContaining([
      expect.stringContaining("lcx-finance-research-run.ts"),
      "--execute-modules",
      "--decision-mode",
      "strategy_candidate",
      "--controller-evidence",
      evidencePath,
      "--portfolio-context",
      frozenContextPath,
      "--portfolio-plan-out",
      plan,
      "--persist-theses",
      "--finance-state-dir",
      directory,
    ]),
  );
  expect(mocks.runCycle.mock.calls[0][0].argv).not.toContain("--controller-research-scope");
  expect(JSON.parse(fs.readFileSync(evidencePath, "utf8"))).toEqual([
    expect.objectContaining({
      id: "finance-controller:broker-account-summary",
      source: "finance-broker-profit-summary",
      text: expect.any(String),
    }),
  ]);
  expect(JSON.parse(JSON.parse(fs.readFileSync(evidencePath, "utf8"))[0].text)).toMatchObject({
    accountScope: { accountId: "paper-account", venue: "alpaca:paper" },
    currentAccountFactsStatus: "unknown",
    missingFields: expect.arrayContaining(["positionSnapshots"]),
  });
  const frozenContext = fs.readFileSync(frozenContextPath, "utf8");
  expect(JSON.parse(frozenContext)).toMatchObject({ accountId: "paper-account", venue: "alpaca" });
  expect(JSON.parse(fs.readFileSync(context, "utf8"))).toMatchObject({
    accountId: "different-account",
  });
  expect(fs.readFileSync(frozenContextPath, "utf8")).toBe(frozenContext);
  expect(mocks.runCycle.mock.calls[1][0].argv).toEqual(
    expect.arrayContaining(["--portfolio-plan", plan]),
  );
});

it("fails day preflight before research when the account context is invalid", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-29T19:30:00Z"));
  const context = path.join(directory, "portfolio-context.json");
  fs.writeFileSync(context, "{}");
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
  ).resolves.toBe(1);
  expect(mocks.runCycle).not.toHaveBeenCalled();
  expect(readFinanceSchedulerState(directory).lastRun).toMatchObject({
    ok: false,
    execution: { outcome: "not_run", blockReason: "controller_evidence_invalid_scope" },
    researchPlanRefresh: { ok: false, controllerEvidenceStatus: "invalid_scope" },
  });
  expect(
    financeResearchPreflightRetryDue(
      readFinanceSchedulerState(directory),
      new Date("2026-09-29T19:40:00Z"),
    ),
  ).toBe(false);
});

it.each(["context_read", "progress_write"] as const)(
  "records %s errors before dispatch as retryable local failures",
  async (fault) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-29T19:30:00Z"));
    const context = path.join(directory, "portfolio-context.json");
    writePortfolioContext(context);
    const originalRead = fs.readFileSync;
    const originalRename = fs.renameSync;
    const spy =
      fault === "context_read"
        ? vi.spyOn(fs, "readFileSync").mockImplementation((file, options) => {
            if (String(file) === context) {
              throw new Error("transient EIO");
            }
            return originalRead(file, options);
          })
        : vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
            if (String(to).endsWith("/progress.json")) {
              throw new Error("transient EIO");
            }
            return originalRename(from, to);
          });
    try {
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
      ).resolves.toBe(1);
    } finally {
      spy.mockRestore();
    }
    expect(mocks.runCycle).not.toHaveBeenCalled();
    expect(readFinanceSchedulerState(directory).lastRun).toMatchObject({
      status: "failed",
      execution: { outcome: "not_run", blockReason: "controller_evidence_read_failed" },
      researchPlanRefresh: { controllerEvidenceStatus: "read_failed" },
    });
    expect(
      financeResearchPreflightRetryDue(
        readFinanceSchedulerState(directory),
        new Date("2026-09-29T19:40:00Z"),
      ),
    ).toBe(true);
  },
);

it("records invalid research proxy configuration before child dispatch", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-29T19:30:00Z"));
  vi.stubEnv("LCX_FINANCE_RESEARCH_HTTP_PROXY", "socks5://invalid");
  const context = path.join(directory, "portfolio-context.json");
  writePortfolioContext(context);
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
  ).resolves.toBe(1);
  expect(mocks.runCycle).not.toHaveBeenCalled();
  expect(readFinanceSchedulerState(directory).lastRun).toMatchObject({
    status: "failed",
    execution: { outcome: "not_run", blockReason: "controller_evidence_invalid_config" },
    researchPlanRefresh: { controllerEvidenceStatus: "invalid_config" },
  });
});

it("retries one transient local evidence write failure without replaying execution", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-29T19:30:00Z"));
  const context = path.join(directory, "portfolio-context.json");
  writePortfolioContext(context);
  const originalWrite = fs.writeFileSync;
  const spy = vi.spyOn(fs, "writeFileSync").mockImplementation((file, data, options) => {
    if (String(file).includes("day-research-portfolio-context-")) {
      throw new Error("transient EIO");
    }
    return originalWrite(file, data, options);
  });
  const args = [
    "--once",
    "day",
    "--dir",
    directory,
    "--research-portfolio-context",
    context,
    "--research-ask",
    "review active strategy budgets",
  ];
  try {
    await expect(runFinanceScheduler(args)).resolves.toBe(1);
  } finally {
    spy.mockRestore();
  }
  expect(mocks.runCycle).not.toHaveBeenCalled();
  expect(readFinanceSchedulerState(directory).lastRun).toMatchObject({
    researchAttempt: 1,
    execution: { outcome: "not_run", blockReason: "controller_evidence_read_failed" },
    researchPlanRefresh: { ok: false, controllerEvidenceStatus: "read_failed" },
  });
  expect(
    financeResearchPreflightRetryDue(
      readFinanceSchedulerState(directory),
      new Date("2026-09-29T19:40:00Z"),
    ),
  ).toBe(true);
  vi.setSystemTime(new Date("2026-09-29T19:40:00Z"));
  await expect(runFinanceScheduler(args)).resolves.toBe(1);
  expect(mocks.runCycle).toHaveBeenCalledOnce();
  expect(readFinanceSchedulerState(directory).lastRun).toMatchObject({
    researchAttempt: 2,
    execution: { outcome: "not_run" },
  });
});

it.each([
  "failed_gate",
  "failed_source",
  "failed_committee",
  "stale",
  "missing_quality",
  "missing_module",
  "missing_source",
  "missing_committee",
] as const)(
  "refuses an allocation plan whose research preflight is not fully authorized: %s",
  async (variant) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const firedAt = "2026-09-29T19:35:00.000Z";
    vi.setSystemTime(new Date(firedAt));
    const context = path.join(directory, "portfolio-context.json");
    const planPath = path.join(directory, "research-portfolio-plan-latest.json");
    writePortfolioContext(context);
    fs.writeFileSync(planPath, "existing-plan-must-not-be-executed");
    const accepted = acceptedResearchCandidate(planPath, firedAt);
    const failedGateId =
      variant === "failed_gate"
        ? "quality"
        : variant === "failed_source"
          ? "source"
          : variant === "failed_committee"
            ? "committee"
            : undefined;
    const missingGateId =
      variant === "missing_quality"
        ? "quality"
        : variant === "missing_module"
          ? "module_execution"
          : variant === "missing_source"
            ? "source"
            : variant === "missing_committee"
              ? "committee"
              : undefined;
    const gates = accepted.gates
      .filter((gate) => gate.id !== missingGateId)
      .map((gate) => (gate.id === failedGateId ? { ...gate, passed: false } : gate));
    const payload = {
      ...accepted,
      plan: { asOf: variant === "stale" ? "2026-09-28T19:35:00.000Z" : firedAt },
      gates,
    };
    mocks.runCycle.mockResolvedValueOnce({ ...success, stdout: JSON.stringify(payload) });

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
    ).resolves.toBe(1);

    expect(mocks.runCycle).toHaveBeenCalledOnce();
    expect(readFinanceSchedulerState(directory).lastRun).toMatchObject({
      ok: false,
      execution: { outcome: "not_run", blockReason: "research_plan_not_accepted" },
      researchPlanRefresh: { ok: false, planPath: null },
    });
    expect(fs.readFileSync(planPath, "utf8")).toBe("existing-plan-must-not-be-executed");
  },
);

it.each(["candidate", "needs_review"])(
  "routes night research and reports aggregate acceptance: %s",
  async (reviewStatus) => {
    vi.stubEnv("LCX_FINANCE_RESEARCH_HTTP_PROXY", "http://127.0.0.1:7897");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-22T22:00:00.000Z"));
    await activateIntradayRule();
    const context = path.join(directory, "portfolio-context.json");
    writePortfolioContext(context);
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
      .mockImplementationOnce(async () => {
        vi.setSystemTime(new Date("2026-09-22T22:05:00.000Z"));
        return {
          ...success,
          stdout: JSON.stringify({
            snapshotPersisted: true,
            generatedAt: "2026-09-22T22:00:00.000Z",
            selected: ["AAA", "BBB"],
          }),
        };
      })
      .mockResolvedValueOnce({ ...success, stdout: JSON.stringify({ status: reviewStatus }) });
    mocks.readUniverse.mockReturnValue({
      generatedAt: "2026-09-22T22:00:00.000Z",
      selected: ["AAA", "BBB"],
    } as never);

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
    ).resolves.toBe(reviewStatus === "candidate" ? 0 : 1);

    expect(mocks.runCycle).toHaveBeenCalledTimes(3);
    expect(mocks.runCycle.mock.calls[0][0].env).toBeUndefined();
    expect(mocks.runCycle.mock.calls[1][0].env).toBeUndefined();
    expect(mocks.runCycle.mock.calls[2][0].env.LCX_FINANCE_HTTP_PROXY).toBe(
      "http://127.0.0.1:7897",
    );
    const evidencePath = path.join(directory, "night-review-evidence-2026-09-22.json");
    expect(mocks.runCycle.mock.calls[1][0].argv).toEqual(
      expect.arrayContaining([
        expect.stringContaining("lcx-finance-universe-select.ts"),
        "--json",
        "--write-snapshot",
        "--dir",
        directory,
      ]),
    );
    expect(mocks.runCycle.mock.calls[2][0].argv).toEqual(
      expect.arrayContaining([
        expect.stringContaining("lcx-finance-research-run.ts"),
        "--execute-modules",
        "--decision-mode",
        "research_only",
        "--as-of",
        "2026-09-22T22:05:00.000Z",
        "--controller-research-scope",
        "--max-api-calls",
        "160",
        "--controller-evidence",
        evidencePath,
        "--persist-theses",
        "--finance-state-dir",
        directory,
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
    const universeReceipt = JSON.parse(
      fs
        .readFileSync(path.join(directory, "finance-universe-selection-runs.jsonl"), "utf8")
        .trim()
        .split("\n")
        .at(-1)!,
    );
    expect(universeReceipt).toMatchObject({ status: "selected", selectedCount: 2 });
    expect(readFinanceSchedulerState(directory).lastSucceeded.night).toBe(
      reviewStatus === "candidate" ? "2026-09-22" : undefined,
    );
    expect(readFinanceSchedulerState(directory).lastRun).toMatchObject({
      ok: reviewStatus === "candidate",
      cycleExitCode: 0,
      exitCode: reviewStatus === "candidate" ? 0 : 2,
      nightReview: { exitCode: 0, ok: reviewStatus === "candidate" },
    });
  },
);

it("does not enter the day cycle when research plan refresh is unverified", async () => {
  writePortfolioContext(path.join(directory, "context.json"));
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

it("publishes a no-signal monitor result through the existing progress status", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-21T14:30:00.000Z"));
  await activateIntradayRule();
  const referenceTime = "2026-09-21T14:25:00.000Z";
  mocks.runIntradayMonitorTick.mockResolvedValue({
    status: "no_signal",
    signal: {
      instrument: "SPY",
      action: "hold",
      reason: "no_trigger",
      referencePriceAt: referenceTime,
    },
  });
  mocks.delay.mockImplementationOnce(async () => {
    const status = inspectFinanceSchedulerStatus(
      { directory, source: "explicit" },
      new Date("2026-09-21T14:30:00.000Z"),
    );
    expect(status.progress.intraday?.lastTick).toMatchObject({
      instrument: "SPY",
      monitorStatus: "no_signal",
      action: "hold",
      reason: "no_trigger",
      referenceTime,
    });
    expect(status.progress.intraday?.lastTick).not.toHaveProperty("outcomeStatus");
    process.emit("SIGTERM");
  });

  await expect(
    runFinanceScheduler([
      "--loop",
      "--dir",
      directory,
      "--intraday-monitor",
      "--intraday-instruments",
      "SPY",
      "--no-source-heartbeat",
    ]),
  ).resolves.toBe(143);
  expect(mocks.runIntradayMonitorTick).toHaveBeenCalledOnce();
});

it("refreshes completed-symbol progress without masking a hung monitor", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-21T14:30:00.000Z"));
  await activateIntradayRule();
  const snapshot = {
    generatedAt: "2026-09-21T14:00:00.000Z",
    selected: ["AAA", "BBB", "CCC"],
  };
  seedSelectedUniverse(snapshot);
  mocks.readUniverse.mockReturnValue(snapshot);
  const root = { directory, source: "explicit" as const };
  mocks.runIntradayMonitorTick.mockImplementation(async ({ instrument }) => {
    if (instrument === "AAA") {
      vi.setSystemTime(new Date(Date.now() + 121_000));
      expect(inspectFinanceSchedulerStatus(root).progress.status).toBe("stalled");
    } else if (instrument === "CCC") {
      expect(inspectFinanceSchedulerStatus(root).progress.status).toBe("responsive");
    } else {
      expect(inspectFinanceSchedulerStatus(root).progress.status).toBe("responsive");
      vi.setSystemTime(new Date(Date.now() + 65_000));
    }
    return { status: "no_signal" };
  });
  mocks.delay.mockImplementationOnce(async () => process.emit("SIGTERM"));

  await expect(
    runFinanceScheduler([
      "--loop",
      "--dir",
      directory,
      "--intraday-monitor",
      "--no-source-heartbeat",
    ]),
  ).resolves.toBe(143);
  expect(mocks.runIntradayMonitorTick.mock.calls.map(([call]) => call.instrument)).toEqual([
    "AAA",
    "BBB",
    "CCC",
  ]);
});

it("publishes the actual outcome of an already-terminal monitor decision", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-21T15:00:00.000Z"));
  await activateIntradayRule();
  const referenceTime = "2026-09-21T08:00:00.000Z";
  mocks.runIntradayMonitorTick.mockResolvedValue({
    status: "buy_already_terminal",
    decision: {
      input: {
        instrument: "SPY",
        action: "buy",
        reason: "opening_range_breakout",
        referencePriceAt: referenceTime,
        signalId: "intraday-prior-buy",
      },
    },
    outcome: { status: "uncertain" },
  });
  mocks.delay.mockImplementationOnce(async () => {
    const status = inspectFinanceSchedulerStatus(
      { directory, source: "explicit" },
      new Date("2026-09-21T15:00:00.000Z"),
    );
    expect(status.progress.intraday?.lastTick).toMatchObject({
      instrument: "SPY",
      monitorStatus: "buy_already_terminal",
      action: "buy",
      referenceTime,
      outcomeStatus: "uncertain",
    });
    expect(status.progress.intraday?.lastTick).not.toHaveProperty("executionStatus");
    process.emit("SIGTERM");
  });

  await expect(
    runFinanceScheduler([
      "--loop",
      "--dir",
      directory,
      "--intraday-monitor",
      "--intraday-instruments",
      "SPY",
      "--no-source-heartbeat",
    ]),
  ).resolves.toBe(143);
  expect(mocks.runIntradayMonitorTick).toHaveBeenCalledOnce();
  expect(mocks.executeIntradayDecision).not.toHaveBeenCalled();
});

it("publishes the actual execution result beside its monitored decision", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-21T15:00:00.000Z"));
  await activateIntradayRule({ paperExecutionEligibility: "paper_execution_eligible" });
  fs.writeFileSync(path.join(directory, "alpaca-policy.json"), "{}");
  const referenceTime = "2026-09-21T14:55:00.000Z";
  const decision = {
    input: {
      instrument: "SPY",
      action: "buy",
      reason: "opening_range_breakout",
      referencePriceAt: referenceTime,
      signalId: "intraday-test-signal",
    },
  };
  mocks.runIntradayMonitorTick.mockResolvedValue({
    status: "decision_recorded",
    signal: { ...decision.input },
    decision,
  });
  mocks.executeIntradayDecision.mockResolvedValue({
    status: "already_terminal",
    outcome: { status: "uncertain" },
  });
  mocks.delay.mockImplementationOnce(async () => {
    const status = inspectFinanceSchedulerStatus(
      { directory, source: "explicit" },
      new Date("2026-09-21T15:00:00.000Z"),
    );
    expect(status.progress.intraday?.lastTick).toMatchObject({
      instrument: "SPY",
      monitorStatus: "decision_recorded",
      action: "buy",
      reason: "opening_range_breakout",
      referenceTime,
      executionStatus: "already_terminal",
      outcomeStatus: "uncertain",
    });
    process.emit("SIGTERM");
  });

  await expect(
    runFinanceScheduler([
      "--loop",
      "--dir",
      directory,
      "--intraday-monitor",
      "--intraday-place",
      "--intraday-active-rule",
      "--intraday-interval-seconds",
      "300",
      "--intraday-feed",
      "iex",
      "--place",
      "--venue",
      "alpaca",
      "--execution-policy",
      path.join(directory, "alpaca-policy.json"),
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
      "--no-source-heartbeat",
    ]),
  ).resolves.toBe(143);
  expect(mocks.executeIntradayDecision).toHaveBeenCalledOnce();
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

it("uses the live intraday controller for bounded idle recovery before monitoring", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-21T15:00:00Z"));
  await activateIntradayRule({ paperExecutionEligibility: "paper_execution_eligible" });
  const policy = path.join(directory, "alpaca-policy.json");
  fs.writeFileSync(policy, "{}");
  const inspectReconciliation = vi.fn(async () => ({
    readiness: { status: "reconciled" },
    observedAt: "2026-09-21T14:59:00.000Z",
    protection: { status: "none" },
  }));
  mocks.createIntradayController.mockReturnValue({
    accountId: "paper-account",
    executionPolicyAuthorizationMode: "until_expiry",
    executionPolicyExpiresAt: "2026-09-30T23:00:00.000Z",
    inspectReconciliation,
  });
  mocks.runIntradayMonitorTick.mockImplementation(async () => {
    expect(inspectReconciliation).toHaveBeenCalledOnce();
    return { status: "no_signal" };
  });
  mocks.delay.mockImplementationOnce(async () => process.emit("SIGTERM"));

  await expect(
    runFinanceScheduler([
      "--loop",
      "--dir",
      directory,
      "--intraday-monitor",
      "--intraday-active-rule",
      "--intraday-place",
      "--sync-alpaca-history",
      "--no-source-heartbeat",
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
  expect(inspectReconciliation).toHaveBeenCalledOnce();
  expect(mocks.syncAlpacaHistory).not.toHaveBeenCalled();
  expect(mocks.executeIntradayDecision).not.toHaveBeenCalled();
});

it("continues monitor-only ticks after bounded idle recovery fails", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-21T15:00:00Z"));
  await activateIntradayRule({ paperExecutionEligibility: "paper_execution_eligible" });
  const policy = path.join(directory, "alpaca-policy.json");
  fs.writeFileSync(policy, "{}");
  const inspectReconciliation = vi.fn(async () => {
    throw new Error("execution_recovery_incomplete");
  });
  mocks.createIntradayController.mockReturnValue({
    accountId: "paper-account",
    executionPolicyAuthorizationMode: "until_expiry",
    executionPolicyExpiresAt: "2026-09-30T23:00:00.000Z",
    inspectReconciliation,
  });
  mocks.runIntradayMonitorTick.mockResolvedValue({ status: "no_signal" });
  mocks.delay.mockImplementationOnce(async () => process.emit("SIGTERM"));

  await expect(
    runFinanceScheduler([
      "--loop",
      "--dir",
      directory,
      "--intraday-monitor",
      "--intraday-active-rule",
      "--intraday-place",
      "--sync-alpaca-history",
      "--no-source-heartbeat",
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
  expect(inspectReconciliation).toHaveBeenCalledOnce();
  expect(mocks.runIntradayMonitorTick).toHaveBeenCalledOnce();
  expect(mocks.syncAlpacaHistory).not.toHaveBeenCalled();
  expect(mocks.executeIntradayDecision).not.toHaveBeenCalled();
  expect(stderrMessages.join("\n")).toContain("idle broker reconciliation failed");
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

it("keeps night settlement success independent from a failed universe refresh", async () => {
  await expect(runFinanceScheduler(["--once", "night", "--dir", directory])).resolves.toBe(0);
  const run = JSON.parse(
    fs.readFileSync(path.join(directory, "daily-cycle-runs.jsonl"), "utf8").trim(),
  );
  const selection = JSON.parse(
    fs
      .readFileSync(path.join(directory, "finance-universe-selection-runs.jsonl"), "utf8")
      .trim()
      .split("\n")
      .at(-1)!,
  );
  expect(run).toMatchObject({
    ok: true,
    status: "succeeded",
    universeSelection: { status: "failed" },
  });
  expect(selection).toMatchObject({ status: "failed" });
  expect(readFinanceSchedulerState(directory).lastSucceeded.night).toBeDefined();
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

it("checks the actual research receipt independently of candidate acceptance", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "research-storage-proof-"));
  try {
    const datedPath = path.join(dir, "receipt.json");
    const summary = {
      status: "needs_review",
      plan: { asOf: "2026-09-28T00:00:00Z" },
      written: { datedPath },
    };
    expect(inspectFinanceResearchReceiptPersistence(JSON.stringify(summary))).toBe(false);
    fs.writeFileSync(
      datedPath,
      JSON.stringify({ schemaVersion: "lcx_finance_research_run_v1", ...summary }),
    );
    expect(inspectFinanceResearchReceiptPersistence(JSON.stringify(summary))).toBe(true);
    expect(
      inspectFinanceResearchReceiptPersistence(JSON.stringify({ ...summary, status: "candidate" })),
    ).toBe(false);
    expect(
      inspectFinanceResearchReceiptPersistence(
        JSON.stringify({ ...summary, plan: { asOf: "2026-09-29T00:00:00Z" } }),
      ),
    ).toBe(false);
    fs.writeFileSync(datedPath, "not-json");
    expect(inspectFinanceResearchReceiptPersistence(JSON.stringify(summary))).toBe(false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("keeps research proxy opt-in, child-local and free of embedded credentials", () => {
  expect(financeResearchProcessEnv({ LCX_FINANCE_HTTP_PROXY: "" })).toBeUndefined();
  expect(financeResearchProcessEnv({ LCX_FINANCE_RESEARCH_HTTP_PROXY: "" })).toMatchObject({
    LCX_FINANCE_HTTP_PROXY: "",
  });
  for (const proxy of ["socks5://localhost:1", "http://user:secret@localhost:1", "not-a-url"]) {
    expect(() => financeResearchProcessEnv({ LCX_FINANCE_RESEARCH_HTTP_PROXY: proxy })).toThrow();
  }
});

it.each([false, true])(
  "refreshes a late active rule, retries controller failure=%s, and stops retired entries",
  async (failFirstController) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-21T15:00:00Z"));
    const policy = path.join(directory, "alpaca-policy.json");
    fs.writeFileSync(policy, "{}");
    if (failFirstController) {
      mocks.createIntradayController.mockImplementationOnce(() => {
        throw new Error("temporary controller failure");
      });
    }
    mocks.runIntradayMonitorTick.mockResolvedValue({
      status: "decision_recorded",
      signal: { action: "buy", reason: "fixture", signalId: "fixture" },
      decision: { input: { action: "buy", signalId: "fixture" } },
    });
    mocks.executeIntradayDecision.mockResolvedValue({ status: "blocked" });
    let ticks = 0;
    mocks.delay.mockImplementation(async () => {
      ticks++;
      if (ticks === 1) {
        expect(mocks.runIntradayMonitorTick).not.toHaveBeenCalled();
        await activateIntradayRule({ paperExecutionEligibility: "paper_execution_eligible" });
      } else if (ticks === 2) {
        expect(mocks.executeIntradayDecision).toHaveBeenCalledTimes(failFirstController ? 0 : 1);
      } else if (ticks === 3) {
        expect(mocks.executeIntradayDecision).toHaveBeenCalledTimes(failFirstController ? 1 : 2);
        await retireFinanceStrategyRule(directory, {
          kind: "retired",
          ruleId: FINANCE_INTRADAY_OPENING_RANGE_RULE,
          observedAt: "2026-09-21T15:00:00Z",
        });
      } else {
        expect(mocks.runIntradayMonitorTick).toHaveBeenCalledTimes(2);
        expect(mocks.executeIntradayDecision).toHaveBeenCalledTimes(failFirstController ? 1 : 2);
        process.emit("SIGTERM");
      }
    });
    await expect(
      runFinanceScheduler([
        "--loop",
        "--dir",
        directory,
        "--intraday-monitor",
        "--intraday-active-rule",
        "--intraday-place",
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
    expect(mocks.createIntradayController).toHaveBeenCalledTimes(failFirstController ? 2 : 1);
    expect(mocks.runCycle).not.toHaveBeenCalled();
  },
);

it("starts a fresh progress deadline when long research hands off to execution", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const started = new Date("2026-09-21T15:00:00Z").getTime();
  vi.setSystemTime(started);
  const context = path.join(directory, "portfolio-context.json");
  writePortfolioContext(context);
  mocks.runCycle
    .mockImplementationOnce(async ({ argv }: { argv: readonly string[] }) => {
      expect(
        inspectFinanceSchedulerProgress(directory, process.pid, true, Date.now()),
      ).toMatchObject({ status: "responsive", cycleStage: "research_preflight" });
      vi.setSystemTime(started + 14 * 60_000);
      return {
        ...success,
        stdout: JSON.stringify(
          acceptedResearchCandidate(
            path.join(directory, "research-portfolio-plan-latest.json"),
            researchAsOfFromArgs(argv),
          ),
        ),
      };
    })
    .mockImplementationOnce(async () => {
      vi.setSystemTime(started + 28 * 60_000);
      expect(
        inspectFinanceSchedulerProgress(directory, process.pid, true, Date.now()),
      ).toMatchObject({ status: "responsive", cycleStage: "execution", ageMs: 14 * 60_000 });
      expect(
        inspectFinanceSchedulerProgress(directory, process.pid, true, started + 32 * 60_000),
      ).toMatchObject({ status: "stalled", cycleStage: "execution" });
      return success;
    });
  await expect(
    runFinanceScheduler([
      "--once",
      "day",
      "--dir",
      directory,
      "--research-portfolio-context",
      context,
      "--research-ask",
      "fixture",
    ]),
  ).resolves.toBe(0);
  expect(mocks.runCycle).toHaveBeenCalledTimes(2);
});

it.each([false, true])(
  "keeps research monitoring single-flight and joins it before handoff or shutdown (cancel=%s)",
  async (cancel) => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date("2026-09-21T19:30:00Z"));
    await activateIntradayRule({ paperExecutionEligibility: "paper_execution_eligible" });
    const policy = path.join(directory, "policy.json");
    const context = path.join(directory, "context.json");
    fs.writeFileSync(policy, "{}");
    writePortfolioContext(context);
    let finishResearch!: (result: FinanceCycleProcessResult) => void;
    let researchStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      researchStarted = resolve;
    });
    let finishIntraday!: () => void;
    let intradayStarted!: () => void;
    const entered = new Promise<void>((resolve) => {
      intradayStarted = resolve;
    });
    mocks.runCycle
      .mockImplementationOnce(() => {
        researchStarted();
        return new Promise<FinanceCycleProcessResult>((resolve) => {
          finishResearch = resolve;
        });
      })
      .mockResolvedValueOnce(success);
    mocks.runIntradayMonitorTick.mockResolvedValueOnce({ status: "no_signal" }).mockResolvedValue({
      status: "decision_recorded",
      signal: { action: "buy", reason: "fixture", signalId: "fixture" },
      decision: { input: { action: "buy", signalId: "fixture" } },
    });
    mocks.executeIntradayDecision.mockImplementation(() => {
      intradayStarted();
      return new Promise((resolve) => {
        finishIntraday = () => resolve({ status: "blocked" });
      });
    });
    mocks.delay.mockImplementation(async () => {
      process.emit("SIGTERM");
    });
    const running = runFinanceScheduler([
      "--loop",
      "--dir",
      directory,
      "--no-source-heartbeat",
      "--intraday-monitor",
      "--intraday-active-rule",
      "--intraday-place",
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
      "--research-portfolio-context",
      context,
      "--research-ask",
      "fixture",
    ]);
    try {
      await started;
      await vi.advanceTimersByTimeAsync(60_000);
      await entered;
      await vi.advanceTimersByTimeAsync(180_000);
      expect(mocks.runIntradayMonitorTick).toHaveBeenCalledTimes(2);
      expect(mocks.executeIntradayDecision).toHaveBeenCalledTimes(1);
      expect(mocks.runCycle).toHaveBeenCalledTimes(1);
      if (cancel) {
        process.emit("SIGTERM");
      }
      finishResearch(
        cancel
          ? { ...success, ok: false, status: "cancelled", exitCode: null, stdout: "" }
          : {
              ...success,
              stdout: JSON.stringify(
                acceptedResearchCandidate(
                  path.join(directory, "research-portfolio-plan-latest.json"),
                  researchAsOfFromArgs(mocks.runCycle.mock.calls[0][0].argv),
                ),
              ),
            },
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      // The child has finished, but an in-flight trade still owns execution and the process lock.
      expect(mocks.runCycle).toHaveBeenCalledTimes(1);
      expect(fs.existsSync(path.join(directory, FINANCE_SCHEDULER_LOCK))).toBe(true);
      await vi.advanceTimersByTimeAsync(180_000);
      expect(mocks.executeIntradayDecision).toHaveBeenCalledTimes(1);
      finishIntraday();
      await expect(running).resolves.toBe(143);
      expect(mocks.runCycle).toHaveBeenCalledTimes(cancel ? 1 : 2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      process.emit("SIGTERM");
      finishResearch?.({ ...success, ok: false, status: "cancelled", stdout: "" });
      finishIntraday?.();
      await running;
      vi.clearAllTimers();
    }
  },
);

it("allows one delayed preflight retry only with a durable no-execution receipt", () => {
  const state = {
    lastFired: { day: "2026-09-29" },
    lastSucceeded: {},
    lastStatus: { day: "failed" },
    lastRun: {
      mode: "day",
      etDate: "2026-09-29",
      status: "failed",
      ok: false,
      researchAttempt: 1,
      completedAt: "2026-09-29T19:35:00Z",
      execution: { outcome: "not_run", blockReason: "research_plan_not_accepted" },
      researchPlanRefresh: { ok: false },
    },
  };
  const at = new Date("2026-09-29T19:45:00Z");
  expect(financeResearchPreflightRetryDue(state, at)).toBe(true);
  expect(financeResearchPreflightRetryDue(state, new Date("2026-09-29T19:44:59Z"))).toBe(false);
  expect(financeResearchPreflightRetryDue(state, new Date("2026-09-29T20:00:00Z"))).toBe(false);
  expect(financeResearchPreflightRetryDue(state, new Date("2026-09-30T19:45:00Z"))).toBe(false);
  for (const patch of [
    { researchAttempt: 2 },
    { researchAttempt: undefined },
    { completedAt: "invalid" },
    { completedAt: "2026-09-29T19:55:00Z" },
    { status: "running" },
    { mode: "night" },
    { execution: { outcome: "unknown", blockReason: "research_plan_not_accepted" } },
    { execution: { outcome: "not_run", blockReason: "execution_gate_blocked" } },
    { researchPlanRefresh: { ok: true } },
  ]) {
    expect(
      financeResearchPreflightRetryDue({ ...state, lastRun: { ...state.lastRun, ...patch } }, at),
    ).toBe(false);
  }
  expect(
    financeResearchPreflightRetryDue({ ...state, lastSucceeded: { day: "2026-09-29" } }, at),
  ).toBe(false);
  expect(financeResearchPreflightRetryDue({ ...state, lastStatus: { day: "running" } }, at)).toBe(
    false,
  );
});

it("persists the preflight retry count and never replays execution or a third attempt", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-29T19:30:00Z"));
  const context = path.join(directory, "portfolio-context.json");
  writePortfolioContext(context);
  mocks.runCycle.mockResolvedValue({
    ...success,
    ok: false,
    status: "failed",
    exitCode: 2,
    stdout: '{"status":"needs_review"}',
  });
  const args = [
    "--once",
    "day",
    "--dir",
    directory,
    "--research-portfolio-context",
    context,
    "--research-ask",
    "review active strategies",
  ];
  await expect(runFinanceScheduler(args)).resolves.toBe(1);
  expect(readFinanceSchedulerState(directory).lastRun).toMatchObject({
    researchAttempt: 1,
    execution: { outcome: "not_run" },
  });
  const firstResearchArgv = mocks.runCycle.mock.calls[0][0].argv as string[];
  const firstEvidencePath =
    firstResearchArgv[firstResearchArgv.indexOf("--controller-evidence") + 1];
  const firstEvidence = fs.readFileSync(firstEvidencePath, "utf8");
  await expect(runFinanceScheduler(args)).resolves.toBe(1);
  expect(mocks.runCycle).toHaveBeenCalledTimes(1);
  vi.setSystemTime(new Date("2026-09-29T19:40:00Z"));
  await expect(runFinanceScheduler(args)).resolves.toBe(1);
  expect(readFinanceSchedulerState(directory).lastRun).toMatchObject({
    researchAttempt: 2,
    execution: { outcome: "not_run" },
  });
  const retryResearchArgv = mocks.runCycle.mock.calls[1][0].argv as string[];
  const retryEvidencePath =
    retryResearchArgv[retryResearchArgv.indexOf("--controller-evidence") + 1];
  expect(retryEvidencePath).not.toBe(firstEvidencePath);
  expect(fs.readFileSync(firstEvidencePath, "utf8")).toBe(firstEvidence);
  vi.setSystemTime(new Date("2026-09-29T19:50:00Z"));
  await expect(runFinanceScheduler(args)).resolves.toBe(1);
  expect(mocks.runCycle).toHaveBeenCalledTimes(2);
  expect(
    mocks.runCycle.mock.calls.every(([call]) =>
      call.argv.some((arg: string) => arg.endsWith("lcx-finance-research-run.ts")),
    ),
  ).toBe(true);
});

it("automatically wakes the single preflight retry after backoff in the resident loop", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-29T19:30:00Z"));
  const context = path.join(directory, "portfolio-context.json");
  writePortfolioContext(context);
  mocks.runCycle.mockResolvedValue({
    ...success,
    ok: false,
    status: "failed",
    exitCode: 2,
    stdout: '{"status":"needs_review"}',
  });
  for (const time of ["19:35", "19:40", "19:50"]) {
    mocks.delay.mockImplementationOnce(async () => {
      vi.setSystemTime(new Date(`2026-09-29T${time}:00Z`));
    });
  }
  mocks.delay.mockImplementationOnce(async () => {
    process.emit("SIGTERM");
  });
  await expect(
    runFinanceScheduler([
      "--loop",
      "--dir",
      directory,
      "--research-portfolio-context",
      context,
      "--research-ask",
      "review active strategies",
    ]),
  ).resolves.toBe(143);
  expect(mocks.runCycle).toHaveBeenCalledTimes(2);
  for (const [call] of mocks.runCycle.mock.calls) {
    expect(call.argv).toEqual(
      expect.arrayContaining(["--include-yahoo-public-sources", "--max-api-calls", "160"]),
    );
  }
  expect(readFinanceSchedulerState(directory).lastRun).toMatchObject({
    researchAttempt: 2,
    execution: { outcome: "not_run" },
  });
});

it.each([
  "valid",
  "failed_gate",
  "failed_source",
  "failed_committee",
  "stale",
  "mixed_plan",
  "missing_reason",
  "missing_source",
  "missing_committee",
  "missing_quality",
  "missing_module",
  "inline_plan",
])("handles reviewed no-allocation without executing a stale plan: %s", async (variant) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const at = "2026-09-29T19:35:00.000Z";
  vi.setSystemTime(new Date(at));
  const context = path.join(directory, "portfolio-context.json");
  const oldPlan = path.join(directory, "research-portfolio-plan-latest.json");
  writePortfolioContext(context);
  fs.writeFileSync(oldPlan, "old-plan-must-not-be-executed");
  const failedGateId =
    variant === "failed_gate"
      ? "quality"
      : variant === "failed_source"
        ? "source"
        : variant === "failed_committee"
          ? "committee"
          : undefined;
  const missingGateId =
    variant === "missing_source"
      ? "source"
      : variant === "missing_committee"
        ? "committee"
        : variant === "missing_quality"
          ? "quality"
          : variant === "missing_module"
            ? "module_execution"
            : undefined;
  const payload = {
    status: "candidate",
    plan: { asOf: variant === "stale" ? "2026-09-28T19:00:00.000Z" : at },
    gates: REQUIRED_RESEARCH_GATES.filter((id) => id !== missingGateId).map((id) => ({
      id,
      passed: id !== failedGateId,
    })),
    portfolioAbstention: {
      reason:
        variant === "missing_reason" ? "" : "Evidence does not support a positive allocation.",
      evidenceIds: ["controller:rule"],
    },
    ...(variant === "mixed_plan" ? { portfolioPlanWritten: oldPlan } : {}),
    ...(variant === "inline_plan" ? { portfolioPlan: { allocations: [] } } : {}),
  };
  mocks.runCycle.mockResolvedValueOnce({ ...success, stdout: JSON.stringify(payload) });
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
  ).resolves.toBe(variant === "valid" ? 0 : 1);
  expect(mocks.runCycle).toHaveBeenCalledTimes(1);
  const state = readFinanceSchedulerState(directory);
  expect(state.lastRun).toMatchObject({
    ok: variant === "valid",
    execution: {
      outcome: "not_run",
      blockReason: variant === "valid" ? "research_no_allocation" : "research_plan_not_accepted",
    },
    researchPlanRefresh: { ok: variant === "valid", planPath: null },
  });
  expect(fs.readFileSync(oldPlan, "utf8")).toBe("old-plan-must-not-be-executed");
  expect(financeResearchPreflightRetryDue(state, new Date("2026-09-29T19:45:00.000Z"))).toBe(
    variant !== "valid",
  );
});
