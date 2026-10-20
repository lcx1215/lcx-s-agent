import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { writeResearchCapitalDecision } from "../../scripts/operator/lcx-finance-research-run.js";
import {
  parseArgs as parseFinanceResearchCliArgs,
  run as runFinanceResearchCli,
  compactFinanceResearchSummary,
} from "../../scripts/operator/lcx-finance-research-run.js";
import {
  captureFinanceIntradayCloseBars,
  readFinanceScheduledResearchFeedback,
  reconcileResidentAlpacaAccount,
  financeResearchProcessEnv,
  financeResearchPreflightRetryDue,
  inspectFinanceSchedulerStatus,
  inspectFinanceResearchReceiptPersistence,
  describeFinanceCycleExecution,
  parseFinanceSchedulerArgs,
  resolveActiveIntradayRule,
  runFinanceRetiredIntradayExitTick,
  runFinanceScheduler,
  recoverFinanceUniverseIfNeeded,
} from "../../scripts/operator/lcx-finance-scheduler.js";
import * as configuredAdapter from "../../src/agents/configured-finance-model-adapter.js";
import { createFinanceAlpacaCycleController } from "../../src/agents/finance-alpaca-cycle-controller.js";
import { syncAlpacaIntradayBars } from "../../src/agents/finance-alpaca-intraday.js";
import {
  appendFinanceBars,
  readFinanceBarLedger,
  type FinanceBarAppendInput,
} from "../../src/agents/finance-bar-ledger.js";
import { caseflowFingerprint } from "../../src/agents/finance-caseflow.js";
import { latestCompletedWeekdaySessionDate } from "../../src/agents/finance-cycle-schedule.js";
import {
  appendFinanceIntradayBars,
  readFinanceIntradayLedger,
} from "../../src/agents/finance-intraday-ledger.js";
import {
  FINANCE_INTRADAY_OPENING_RANGE_EMITS,
  FINANCE_INTRADAY_OPENING_RANGE_FORM,
  FINANCE_INTRADAY_OPENING_RANGE_FORM_VERSION,
  FINANCE_INTRADAY_OPENING_RANGE_RULE,
  FINANCE_INTRADAY_OPENING_RANGE_RULE_V3,
  FINANCE_INTRADAY_OPENING_RANGE_FORM_VERSION_V3,
} from "../../src/agents/finance-intraday-paper.js";
import * as intradayPositions from "../../src/agents/finance-intraday-position.js";
import * as collectionRegistry from "../../src/agents/finance-market-collection-registry.js";
import * as priceContext from "../../src/agents/finance-night-review-context.js";
import * as realtimeRegistry from "../../src/agents/finance-realtime-source-registry.js";
import { financeResearchPortfolioContextSchema } from "../../src/agents/finance-research-portfolio-plan.js";
import * as researchRunner from "../../src/agents/finance-research-runner.js";
import { runFinanceResearchRun } from "../../src/agents/finance-research-runner.js";
import { commitFinanceSchedulerDatabaseState } from "../../src/agents/finance-scheduler-ledger.js";
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
  financeBarLedgerPath,
  financeResearchScoredPath,
  financeTuningProposalsPath,
} from "../../src/agents/finance-state-dir.js";
import {
  activateFinanceStrategyRule,
  retireFinanceStrategyRule,
  declareFinanceStrategyRule,
  readFinanceStrategyRuleLedger,
} from "../../src/agents/finance-strategy-rule-ledger.js";
import type {
  FinanceTradeDecisionReviewer,
  FinanceTradeDecisionReviewRequest,
} from "../../src/agents/finance-trade-decision-review.js";
import * as tradeReviewEvidence from "../../src/agents/finance-trade-review-evidence.js";
import { FINANCE_UNIVERSE_SELECTION_SNAPSHOT_FILENAME } from "../../src/agents/finance-universe-selection.js";
import * as prompt from "../../src/agents/local-text-model-adapter.js";
import * as checkpointStore from "../../src/agents/logical-agent-pool-checkpoint-store.js";
import type { QualityHarnessModelRequest } from "../../src/agents/quality-harness-contract.js";
import * as quantTools from "../../src/agents/tools/quant-math-tool.js";
import type { OpenClawConfig } from "../../src/config/config.js";
import { prepareOriginalFinanceModuleMain } from "../fixtures/lcx-waterflow-finance-module-main-probe.js";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  runCycle: vi.fn(),
  delay: vi.fn(),
  killTree: vi.fn(),
  loadConfig: vi.fn(() => ({})),
  syncAlpacaHistory: vi.fn(),
  historicalMaintenance: vi.fn(),
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
  recordFinanceResult: vi.fn(async () => ({
    status: "unavailable",
    reason: "artifact_recording_disabled",
  })),
  createTradeDecisionReviewer: vi.fn(),
  tradeDecisionReviewer: vi.fn(),
  readUniverse: vi.fn(),
  resolveCalendar: vi.fn(async () => null),
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
vi.mock("../../src/agents/finance-historical-position-maintenance.js", () => ({
  runFinanceHistoricalPositionMaintenance: mocks.historicalMaintenance,
}));
vi.mock("../../src/agents/finance-alpaca-market-calendar.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/agents/finance-alpaca-market-calendar.js")>();
  return { ...actual, createFinanceAlpacaMarketSessionResolver: () => mocks.resolveCalendar };
});
vi.mock("../../src/agents/finance-alpaca-history-sync.js", () => ({
  syncConfiguredAlpacaPaperHistory: mocks.syncAlpacaHistory,
}));
vi.mock("../../src/agents/finance-alpaca-cycle-controller.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/agents/finance-alpaca-cycle-controller.js")>();
  return { ...actual, createFinanceAlpacaCycleController: mocks.createIntradayController };
});
vi.mock("../../src/agents/finance-intraday-monitor.js", () => ({
  runFinanceIntradayMonitorTick: mocks.runIntradayMonitorTick,
  resolveFinanceIntradayCashSession: vi.fn(async () => ({ status: "cash_session_open" })),
}));
vi.mock("../../src/agents/finance-result-recording.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/agents/finance-result-recording.js")>();
  return { ...actual, recordFinanceIntradayResult: mocks.recordFinanceResult };
});
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

// Component replies echo the actual dispatched handoff; this is not native producer proof.
function dispatchedControllerHandoff(
  argv: readonly string[],
): NonNullable<researchRunner.FinanceResearchRunInput["controllerHandoff"]> {
  const handoffPath = argv[argv.indexOf("--controller-handoff") + 1];
  const expected = argv[argv.indexOf("--controller-handoff-sha256") + 1];
  if (!handoffPath || !expected) {
    throw new Error("controller handoff flags missing");
  }
  const bytes = fs.readFileSync(handoffPath);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  expect(sha256).toBe(expected);
  return {
    ...(JSON.parse(bytes.toString("utf8")) as Omit<
      NonNullable<researchRunner.FinanceResearchRunInput["controllerHandoff"]>,
      "producer"
    >),
    producer: { path: handoffPath, sha256, bytes: bytes.length },
  };
}

function acceptedResearchCandidate(planPath: string, asOf: string, argv?: readonly string[]) {
  return {
    status: "candidate",
    ...(argv ? { controllerHandoff: dispatchedControllerHandoff(argv) } : {}),
    plan: { asOf },
    gates: REQUIRED_RESEARCH_GATES.map((id) => ({ id, passed: true })),
    portfolioPlanWritten: planPath,
    portfolioPlanWrite: {
      path: planPath,
      sha256: "a".repeat(64),
      asOf,
      accountId: "paper-account",
      venue: "alpaca",
    },
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
let originalTermListenerRefs: ReturnType<typeof process.listeners>;
let originalIntListenerRefs: ReturnType<typeof process.listeners>;

function emitSchedulerSignal(signal: "SIGTERM" | "SIGINT"): boolean {
  const baseline = signal === "SIGTERM" ? originalTermListenerRefs : originalIntListenerRefs;
  const added = process.listeners(signal).filter((listener) => !baseline.includes(listener));
  expect(added).toHaveLength(1);
  const listener = added[0];
  if (!listener) {
    throw new Error("scheduler signal listener was not registered");
  }
  expect(listener.name).toBe(signal === "SIGTERM" ? "onTerm" : "onInt");
  // Exercise the real scheduler's cancellation handler without broadcasting to runner listeners.
  listener.call(process, signal);
  return true;
}
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
  mocks.resolveCalendar.mockReset();
  mocks.resolveCalendar.mockResolvedValue(null);
  mocks.loadConfig.mockReturnValue({});
  mocks.historicalMaintenance.mockResolvedValue({
    status: "idle",
    observedAt: new Date().toISOString(),
    decisions: [],
  });
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
  originalTermListenerRefs = process.listeners("SIGTERM");
  originalIntListenerRefs = process.listeners("SIGINT");
  originalTermListeners = originalTermListenerRefs.length;
  originalIntListeners = originalIntListenerRefs.length;
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
  // Snapshot visibility changes when its producer writes, never on the Nth read.
  mocks.readUniverse.mockImplementation(() =>
    JSON.parse(
      fs.readFileSync(path.join(directory, FINANCE_UNIVERSE_SELECTION_SNAPSHOT_FILENAME), "utf8"),
    ),
  );
  mocks.runCycle.mockImplementation(async ({ argv }) => {
    if (argv.some((arg: string) => arg.includes("lcx-finance-universe-select.ts"))) {
      writeUniverseSnapshot(refreshedSnapshot);
      return {
        ...success,
        stdout: JSON.stringify({ snapshotPersisted: true, ...refreshedSnapshot }),
      };
    }
    return {
      ...success,
      stdout: JSON.stringify({
        ok: true,
        scoredFiled: { appended: 0, skipped: 0 },
        pending: [],
        declined: [],
        issues: [],
      }),
    };
  });
  mocks.runIntradayMonitorTick.mockResolvedValue({ status: "no_signal" });
  mocks.delay
    .mockImplementationOnce(async () => {})
    .mockImplementationOnce(async () => emitSchedulerSignal("SIGTERM"));

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

async function managedExitFixture(signal = new AbortController().signal) {
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
  const policyPath = path.join(directory, "managed-exit-policy.json");
  fs.writeFileSync(
    policyPath,
    JSON.stringify({
      schemaVersion: "lcx_alpaca_cycle_policy_v1",
      accountId: "paper-account",
      planId: "managed-exit-fixture",
      revision: "1",
      peakEquity: 100000,
      peakScope: "fixture",
      unhedged: true,
      maxPortfolioDrawdownFraction: 0.2,
      maxGrossExposure: 100000,
      authorizationMode: "until_revoked",
    }),
  );
  const options = parseFinanceSchedulerArgs([
    "--loop",
    "--dir",
    directory,
    "--intraday-monitor",
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
    "10000",
    "--max-instrument-notional",
    "20000",
    "--max-orders",
    "8",
  ]);
  const contract = await resolveActiveIntradayRule(directory, options.intraday!);
  vi.spyOn(intradayPositions, "readFinanceRetiredIntradayExitTargets").mockResolvedValue([]);
  vi.spyOn(intradayPositions, "readFinanceDynamicIntradayExitTargets").mockResolvedValue([
    { instrument: "BROKEN", quantity: 1, contract },
    { instrument: "WBD", quantity: 32, contract },
  ]);
  return {
    root: { directory, source: "explicit" as const },
    options: {
      ...options,
      intraday: {
        ...options.intraday!,
        instrumentSource: "system_universe" as const,
        strategyContract: contract,
      },
    },
    signal,
    resolveMarketSession: mocks.resolveCalendar,
  };
}

it.each(["controller", "monitor"])(
  "continues managed exits after one target's %s preparation fails",
  async (stage) => {
    const context = await managedExitFixture();
    mocks.runIntradayMonitorTick.mockResolvedValue({ status: "no_closed_session_bar" });
    if (stage === "controller") {
      mocks.createIntradayController.mockImplementationOnce(() => {
        throw new Error("fixture controller unavailable");
      });
    } else {
      mocks.runIntradayMonitorTick.mockRejectedValueOnce(
        new Error("Alpaca intraday bars response is malformed"),
      );
    }
    await runFinanceRetiredIntradayExitTick(context);
    expect(mocks.runIntradayMonitorTick).toHaveBeenCalledWith(
      expect.objectContaining({
        instrument: "WBD",
        exitOnly: true,
        scope: { kind: "managed_position_exit" },
      }),
    );
    expect(stderrMessages.join("\n")).toContain("retired intraday BROKEN monitor failed:");
    expect(mocks.executeIntradayDecision).not.toHaveBeenCalled();
    expect(mocks.tradeDecisionReviewer).not.toHaveBeenCalled();
  },
);

it("stops managed exits on cancellation rather than treating it as a target failure", async () => {
  const abort = new AbortController();
  const context = await managedExitFixture(abort.signal);
  mocks.runIntradayMonitorTick.mockImplementationOnce(async () => {
    abort.abort();
    throw new Error("fixture cancelled");
  });
  await runFinanceRetiredIntradayExitTick(context);
  expect(mocks.runIntradayMonitorTick).toHaveBeenCalledOnce();
  expect(mocks.executeIntradayDecision).not.toHaveBeenCalled();
  expect(stderrMessages.join("\n")).not.toContain("retired intraday BROKEN monitor failed:");
});

it("does not continue another managed exit after an unexpected execution failure", async () => {
  const context = await managedExitFixture();
  mocks.runIntradayMonitorTick.mockResolvedValue({
    status: "decision_recorded",
    decision: { input: { action: "sell" } },
  });
  mocks.executeIntradayDecision.mockRejectedValueOnce(new Error("fixture order outcome unknown"));
  await runFinanceRetiredIntradayExitTick(context);
  expect(mocks.runIntradayMonitorTick).toHaveBeenCalledOnce();
  expect(mocks.executeIntradayDecision).toHaveBeenCalledOnce();
  expect(stderrMessages.join("\n")).toContain("retired intraday exit cycle failed:");
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
  const hostSignalObserver = vi.fn();
  process.on("SIGTERM", hostSignalObserver);
  originalTermListenerRefs.push(hostSignalObserver);
  try {
    mocks.runCycle.mockImplementation(async ({ signal }: { signal: AbortSignal }) => {
      expect(fs.existsSync(path.join(directory, FINANCE_SCHEDULER_LOCK))).toBe(true);
      emitSchedulerSignal("SIGTERM");
      expect(signal.aborted).toBe(true);
      expect(fs.existsSync(path.join(directory, FINANCE_SCHEDULER_LOCK))).toBe(true);
      return { ...success, ok: false, status: "cancelled", exitCode: null, signal: "SIGTERM" };
    });
    await expect(runFinanceScheduler(["--once", "day", "--dir", directory])).resolves.toBe(143);
    expect(readFinanceSchedulerState(directory).lastRun?.status).toBe("cancelled");
    expect(fs.existsSync(path.join(directory, FINANCE_SCHEDULER_LOCK))).toBe(false);
    expect(hostSignalObserver).not.toHaveBeenCalled();
  } finally {
    process.removeListener("SIGTERM", hostSignalObserver);
    originalTermListenerRefs = originalTermListenerRefs.filter(
      (listener) => listener !== hostSignalObserver,
    );
  }
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
    emitSchedulerSignal("SIGTERM");
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
    emitSchedulerSignal("SIGTERM");
  });
  await expect(runFinanceScheduler(["--loop", "--dir", directory])).resolves.toBe(143);
  expect(mocks.runCycle).toHaveBeenCalledOnce();
  expect(readFinanceSchedulerState(directory).lastFired).toEqual({ day: "2026-09-21" });
});

it("releases an idle loop on SIGINT without starting a cycle", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-21T10:00:00Z"));
  mocks.delay.mockImplementationOnce(async () => {
    emitSchedulerSignal("SIGINT");
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
    emitSchedulerSignal("SIGTERM");
  });

  const running = runFinanceScheduler(["--loop", "--dir", directory]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const schedulerReachedNextTick = mocks.delay.mock.calls.length === 1;
  if (!schedulerReachedNextTick) {
    emitSchedulerSignal("SIGTERM");
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
  const knowledgeWorkspace = path.join(directory, "original-research-workspace");
  vi.stubEnv("OPENCLAW_WORKSPACE_DIR", knowledgeWorkspace);
  const capabilityFactory = vi.spyOn(
    tradeReviewEvidence,
    "createFinanceTradeReviewFinancialCapabilities",
  );
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
      emitSchedulerSignal("SIGTERM");
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
  expect(mocks.createTradeDecisionReviewer).toHaveBeenNthCalledWith(
    1,
    {},
    {
      taskObjective: undefined,
      evidenceScope: {
        directory,
        accountId: "paper-account",
        artifactRecallOptions: { config: {}, agentId: "main", workspaceDir: knowledgeWorkspace },
        marketCollectionTool: expect.objectContaining({
          name: "finance_market_collection_refresh",
        }),
        instruments: ["SPY"],
        financialCapabilities: [
          expect.objectContaining({
            toolName: "finance_framework_core_inspect",
            execute: expect.any(Function),
          }),
          expect.objectContaining({
            toolName: "finance_learning_capability_apply",
            execute: expect.any(Function),
          }),
          expect.objectContaining({
            toolName: "finance_trade_result_recall",
            execute: expect.any(Function),
          }),
        ],
      },
    },
  );
  expect(mocks.createTradeDecisionReviewer).toHaveBeenNthCalledWith(
    2,
    {},
    {
      taskObjective: undefined,
      evidenceScope: {
        directory,
        accountId: "paper-account",
        artifactRecallOptions: { config: {}, agentId: "main", workspaceDir: knowledgeWorkspace },
        marketCollectionTool: expect.objectContaining({
          name: "finance_market_collection_refresh",
        }),
        instruments: ["SPY"],
        financialCapabilities: [
          expect.objectContaining({
            toolName: "finance_framework_core_inspect",
            execute: expect.any(Function),
          }),
          expect.objectContaining({
            toolName: "finance_learning_capability_apply",
            execute: expect.any(Function),
          }),
          expect.objectContaining({
            toolName: "finance_trade_result_recall",
            execute: expect.any(Function),
          }),
        ],
      },
    },
  );
  expect(mocks.executeIntradayDecision).toHaveBeenCalledTimes(2);
  expect(capabilityFactory).toHaveBeenCalledTimes(2);
  expect(capabilityFactory).toHaveBeenNthCalledWith(1, {
    workspaceDir: knowledgeWorkspace,
    config: {},
    agentId: "main",
  });
  expect(capabilityFactory).toHaveBeenNthCalledWith(2, {
    workspaceDir: knowledgeWorkspace,
    config: {},
    agentId: "main",
  });
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
    emitSchedulerSignal("SIGTERM");
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
    emitSchedulerSignal("SIGTERM");
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
  expect(mocks.readUniverse).toHaveBeenCalled();
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
    emitSchedulerSignal("SIGTERM");
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
    emitSchedulerSignal("SIGTERM");
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
    emitSchedulerSignal("SIGTERM");
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
  expect(mocks.readUniverse).toHaveBeenCalled();
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
      emitSchedulerSignal("SIGTERM");
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
  // Snapshot visibility changes when its producer writes, never on the Nth read.
  mocks.readUniverse.mockImplementation(() =>
    JSON.parse(
      fs.readFileSync(path.join(directory, FINANCE_UNIVERSE_SELECTION_SNAPSHOT_FILENAME), "utf8"),
    ),
  );
  mocks.runCycle.mockImplementation(async ({ argv }) => {
    if (argv.some((arg: string) => arg.includes("lcx-finance-universe-select.ts"))) {
      writeUniverseSnapshot(refreshedSnapshot);
      return {
        ...success,
        stdout: JSON.stringify({ snapshotPersisted: true, ...refreshedSnapshot }),
      };
    }
    return {
      ...success,
      stdout: JSON.stringify({
        ok: true,
        scoredFiled: { appended: 0, skipped: 0 },
        pending: [],
        declined: [],
        issues: [],
      }),
    };
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
      emitSchedulerSignal("SIGTERM");
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

  expect(mocks.readUniverse).toHaveBeenCalled();
  expect(mocks.runIntradayMonitorTick.mock.calls.map(([call]) => call.instrument)).toEqual([
    "SPY",
    "SPY",
    "NEW",
  ]);
  const firstScope = mocks.runIntradayMonitorTick.mock.calls[0]?.[0].scope;
  const refreshedScope = mocks.runIntradayMonitorTick.mock.calls[1]?.[0].scope;
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
  const refreshedSnapshot = {
    generatedAt: "2026-09-22T22:00:00.000Z",
    selected: ["SPY", "RECOVERED"],
  };
  // Snapshot visibility changes when its producer writes, never on the Nth read.
  mocks.readUniverse.mockImplementation(() =>
    JSON.parse(
      fs.readFileSync(path.join(directory, FINANCE_UNIVERSE_SELECTION_SNAPSHOT_FILENAME), "utf8"),
    ),
  );
  mocks.runCycle.mockImplementation(async ({ argv }) => {
    if (argv.some((arg: string) => arg.includes("lcx-finance-universe-select.ts"))) {
      writeUniverseSnapshot(refreshedSnapshot);
      return {
        ...success,
        stdout: JSON.stringify({ snapshotPersisted: true, ...refreshedSnapshot }),
      };
    }
    return {
      ...success,
      stdout: JSON.stringify({
        ok: true,
        scoredFiled: { appended: 0, skipped: 0 },
        pending: [],
        declined: [],
        issues: [],
      }),
    };
  });
  mocks.runIntradayMonitorTick.mockResolvedValue({ status: "no_signal" });
  mocks.delay
    .mockImplementationOnce(async () => {})
    .mockImplementationOnce(async () => {
      emitSchedulerSignal("SIGTERM");
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

  expect(mocks.readUniverse).toHaveBeenCalled();
  expect(mocks.runIntradayMonitorTick.mock.calls.map(([call]) => call.instrument)).toEqual([
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
  mocks.readUniverse.mockImplementation(() =>
    JSON.parse(
      fs.readFileSync(path.join(directory, FINANCE_UNIVERSE_SELECTION_SNAPSHOT_FILENAME), "utf8"),
    ),
  );
  mocks.runCycle.mockImplementation(async ({ argv }) =>
    argv.some((arg: string) => arg.includes("lcx-finance-universe-select.ts"))
      ? {
          ...success,
          ok: false,
          exitCode: 1,
          status: "failed",
          stdout: "",
          stderr: "selector failed",
        }
      : {
          ...success,
          stdout: JSON.stringify({
            ok: true,
            scoredFiled: { appended: 0, skipped: 0 },
            pending: [],
            declined: [],
            issues: [],
          }),
        },
  );
  mocks.runIntradayMonitorTick.mockResolvedValue({ status: "no_signal" });
  let progressAtStop: Record<string, unknown> | undefined;
  mocks.delay
    .mockImplementationOnce(async () => {})
    .mockImplementationOnce(async () => {
      const progress = JSON.parse(
        fs.readFileSync(path.join(directory, FINANCE_SCHEDULER_LOCK, "progress.json"), "utf8"),
      ) as { intraday?: Record<string, unknown> };
      progressAtStop = progress.intraday;
      emitSchedulerSignal("SIGTERM");
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
  ]);
  expect(mocks.readUniverse).toHaveBeenCalled();
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
      emitSchedulerSignal("SIGTERM");
    });

  const args = ["--loop", "--dir", directory, "--intraday-monitor", "--no-source-heartbeat"];
  await expect(runFinanceScheduler(args)).resolves.toBe(143);
  expect(mocks.runIntradayMonitorTick.mock.calls.map(([call]) => call.instrument)).toEqual([
    "SPY",
    "PRIOR",
    "SPY",
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
    emitSchedulerSignal("SIGTERM");
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
      emitSchedulerSignal("SIGTERM");
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
      emitSchedulerSignal("SIGTERM");
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
  ]);
  const latestReceipt = fs
    .readFileSync(path.join(directory, "finance-universe-selection-runs.jsonl"), "utf8")
    .trim()
    .split("\n")
    .at(-1)!;
  expect(JSON.parse(latestReceipt)).toMatchObject({ status: "started" });

  mocks.runIntradayMonitorTick.mockClear();
  mocks.delay.mockImplementationOnce(async () => {
    emitSchedulerSignal("SIGTERM");
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
      emitSchedulerSignal("SIGTERM");
    });

  const args = ["--loop", "--dir", directory, "--intraday-monitor", "--no-source-heartbeat"];
  await expect(runFinanceScheduler(args)).resolves.toBe(143);
  expect(mocks.runIntradayMonitorTick.mock.calls.map(([call]) => call.instrument)).toEqual([
    "SPY",
    "RECOVERED",
    "SPY",
  ]);
  const receipts = fs
    .readFileSync(path.join(directory, "finance-universe-selection-runs.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(receipts.map((receipt) => receipt.status)).toEqual(["failed", "started", "selected"]);

  mocks.runIntradayMonitorTick.mockClear();
  mocks.delay.mockImplementationOnce(async () => {
    emitSchedulerSignal("SIGTERM");
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

it.each(["missing", "tampered"] as const)(
  "refuses a research summary with %s scheduled controller handoff",
  async (variant) => {
    const context = path.join(directory, "portfolio-context.json");
    const plan = path.join(directory, "research-portfolio-plan-latest.json");
    writePortfolioContext(context);
    mocks.runCycle.mockImplementationOnce(async ({ argv }: { argv: readonly string[] }) => {
      const candidate = acceptedResearchCandidate(plan, researchAsOfFromArgs(argv), argv);
      if (variant === "missing") {
        delete candidate.controllerHandoff;
      } else {
        if (!candidate.controllerHandoff) {
          throw new Error("component handoff missing");
        }
        candidate.controllerHandoff.sourceScope.runId = "unrelated-parent-run";
      }
      return { ...success, stdout: JSON.stringify(candidate) };
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
        "review active strategy budgets",
      ]),
    ).resolves.toBe(1);
    expect(mocks.runCycle).toHaveBeenCalledOnce();
    expect(readFinanceSchedulerState(directory).lastRun).toMatchObject({
      execution: { outcome: "not_run", blockReason: "research_plan_not_accepted" },
    });
    expect(mocks.executeIntradayDecision).not.toHaveBeenCalled();
  },
);

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
        stdout: JSON.stringify(acceptedResearchCandidate(plan, researchAsOfFromArgs(argv), argv)),
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

it("refuses the original planned research receipt before any execution child", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-29T19:35:00.000Z"));
  const contextPath = path.join(directory, "portfolio-context.json");
  const planPath = path.join(directory, "research-portfolio-plan-latest.json");
  writePortfolioContext(contextPath);
  fs.writeFileSync(planPath, "existing-plan-must-not-be-executed");
  const fetchGuard = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("Network forbidden"));
  const modelGuard = vi.fn().mockRejectedValue(new Error("Model calls forbidden"));
  const moduleGuard = vi.fn().mockRejectedValue(new Error("Module stack forbidden"));
  const produced: {
    receipt?: Awaited<ReturnType<typeof runFinanceResearchRun>>;
    bytes?: string;
  } = {};
  mocks.runCycle.mockImplementationOnce(async ({ argv }: { argv: readonly string[] }) => {
    expect(argv).toContain("--workflow-models");
    expect(argv).toContain("--execute-modules");
    const frozenPath = argv[argv.indexOf("--portfolio-context") + 1];
    const producer = await runFinanceResearchRun({
      input: {
        ask: argv[argv.indexOf("--ask") + 1],
        asOf: researchAsOfFromArgs(argv),
        decisionMode: "strategy_candidate",
        executeModules: argv.includes("--execute-modules"),
        portfolioContext: financeResearchPortfolioContextSchema.parse(
          JSON.parse(fs.readFileSync(frozenPath, "utf8")),
        ),
        targets: [{ id: "offline-plan-qqq", instrument: "QQQ", assetClass: "equity" }],
      },
      workspaceDir: directory,
      financeStateDir: directory,
      liveFetch: false,
      allowProviderCalls: false,
      modelInvoker: modelGuard,
      moduleExecutor: moduleGuard,
      batchOptions: { realtimeAdapters: [], collectionAdapters: [] },
    });
    const producerBytes = `${JSON.stringify(producer, null, 2)}\n`;
    produced.receipt = producer;
    produced.bytes = producerBytes;
    fs.writeFileSync(path.join(directory, "original-planned-research-receipt.json"), producerBytes);
    // Only the process transport is replaced. The producer receipt is returned unchanged.
    return { ...success, stdout: producerBytes };
  });
  await expect(
    runFinanceScheduler([
      "--once",
      "day",
      "--dir",
      directory,
      "--research-portfolio-context",
      contextPath,
      "--research-ask",
      "review active strategy budgets",
    ]),
  ).resolves.toBe(1);
  const producer = produced.receipt;
  const producerBytes = produced.bytes;
  expect(producer).toMatchObject({
    status: "planned",
    answerDecision: "return_failed_reason",
    plan: { asOf: "2026-09-29T19:35:00.000Z" },
  });
  expect(producer?.gates).toEqual(
    expect.arrayContaining([
      { id: "source", passed: false, reason: "dry plan; no network fetch" },
      { id: "committee", passed: false, reason: "dry plan; model DAG not executed" },
      { id: "quality", passed: false, reason: "dry plan; quality harness not executed" },
    ]),
  );
  expect(mocks.runCycle).toHaveBeenCalledOnce();
  expect(mocks.spawn).not.toHaveBeenCalled();
  expect(fetchGuard).not.toHaveBeenCalled();
  expect(modelGuard).not.toHaveBeenCalled();
  expect(moduleGuard).not.toHaveBeenCalled();
  const executionChildCalls = mocks.runCycle.mock.calls.filter(([call]) =>
    (call as { argv: readonly string[] }).argv.some((arg) =>
      arg.endsWith("/lcx-finance-daily-cycle.ts"),
    ),
  ).length;
  expect(executionChildCalls).toBe(0);
  const state = readFinanceSchedulerState(directory);
  expect(state.lastRun).toMatchObject({
    ok: false,
    execution: { outcome: "not_run", blockReason: "research_plan_not_accepted" },
    researchPlanRefresh: { ok: false, planPath: null, processResult: { stdout: producerBytes } },
  });
  expect(state.lastSucceeded.day).toBeUndefined();
  expect(fs.readFileSync(planPath, "utf8")).toBe("existing-plan-must-not-be-executed");
  const log = fs.readFileSync(path.join(directory, "daily-cycle-runs.jsonl"), "utf8");
  expect(JSON.parse(log.trim())).toMatchObject({
    ok: false,
    execution: { outcome: "not_run", blockReason: "research_plan_not_accepted" },
  });
  const evidenceDir = process.env.LCX_FINANCE_PLANNED_REFUSAL_PROOF_DIR;
  if (evidenceDir) {
    fs.mkdirSync(evidenceDir, { recursive: true });
    fs.cpSync(directory, path.join(evidenceDir, "private-bytes"), { recursive: true });
    fs.writeFileSync(
      path.join(evidenceDir, "native-result.json"),
      JSON.stringify(
        {
          producer,
          producerSha256: createHash("sha256").update(producerBytes!).digest("hex"),
          schedulerState: state,
          childArguments: mocks.runCycle.mock.calls[0][0].argv,
          executionChildCalls,
          providerCalls: fetchGuard.mock.calls.length,
          modelCalls: modelGuard.mock.calls.length,
          moduleCalls: moduleGuard.mock.calls.length,
          limitation:
            "Private once-day consumer with process transport substitute; no actual child research, broker execution, service or natural scheduler run.",
        },
        null,
        2,
      ) + "\n",
    );
  }
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
    mocks.runCycle.mockImplementationOnce(async ({ argv }: { argv: readonly string[] }) => ({
      ...success,
      stdout: JSON.stringify({ ...payload, controllerHandoff: dispatchedControllerHandoff(argv) }),
    }));

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
      .mockImplementationOnce(async ({ argv }: { argv: string[] }) => ({
        ...success,
        stdout: JSON.stringify(
          compactFinanceResearchSummary({
            schemaVersion: "lcx_finance_research_operator_v1",
            boundary: "local_finance_research_run_only",
            status: reviewStatus as "candidate" | "needs_review",
            answerDecision:
              reviewStatus === "candidate" ? "candidate_for_review" : "return_failed_reason",
            plan: { asOf: researchAsOfFromArgs(argv) },
            gates: REQUIRED_RESEARCH_GATES.map((id) => ({
              id,
              passed: true,
              reason: "private gate response",
            })),
          }),
        ),
      }));
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

it.each(["source_failed", "quality_failed", "missing_gates"] as const)(
  "rejects contradictory night candidate research gates: %s",
  async (fault) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-22T22:00:00.000Z"));
    await activateIntradayRule();
    const context = path.join(directory, "portfolio-context.json");
    writePortfolioContext(context);
    let summary: ReturnType<typeof compactFinanceResearchSummary> | undefined;
    mocks.runCycle
      .mockResolvedValueOnce(success)
      .mockResolvedValueOnce({
        ...success,
        stdout: JSON.stringify({
          snapshotPersisted: true,
          generatedAt: "2026-09-22T22:00:00.000Z",
          selected: ["SPY"],
        }),
      })
      .mockImplementationOnce(async ({ argv }: { argv: string[] }) => {
        summary = compactFinanceResearchSummary({
          schemaVersion: "lcx_finance_research_operator_v1",
          boundary: "local_finance_research_run_only",
          status: "candidate",
          answerDecision: "candidate_for_review",
          plan: { asOf: researchAsOfFromArgs(argv) },
          gates:
            fault === "missing_gates"
              ? []
              : REQUIRED_RESEARCH_GATES.map((id) => ({
                  id,
                  passed: !(
                    (fault === "source_failed" && id === "source") ||
                    (fault === "quality_failed" && id === "quality")
                  ),
                  reason: "private contradictory low process response",
                })),
        });
        return { ...success, stdout: JSON.stringify(summary) };
      });
    mocks.readUniverse.mockReturnValue({
      generatedAt: "2026-09-22T22:00:00.000Z",
      selected: ["SPY"],
    } as never);
    const result = await runFinanceScheduler([
      "--once",
      "night",
      "--dir",
      directory,
      "--research-portfolio-context",
      context,
      "--research-ask",
      "review active evidence boundaries",
    ]);
    const native = readFinanceSchedulerState(directory);
    const proofDirectory = process.env.LCX_NIGHT_REVIEW_ACCEPTANCE_PROOF_DIR;
    if (proofDirectory) {
      fs.mkdirSync(proofDirectory, { recursive: true });
      fs.writeFileSync(
        path.join(proofDirectory, `${fault}.json`),
        JSON.stringify(
          {
            boundary:
              "original_scheduler_consumer_of_private_compact_CLI_response_no_model_or_provider_execution",
            fault,
            summary,
            result,
            state: native,
            actualCalls: mocks.runCycle.mock.calls.map(([input]) => ({
              argv: input.argv,
              phase: input.phase,
            })),
          },
          null,
          2,
        ) + "\n",
      );
    }
    expect(result).toBe(1);
    expect(native.lastSucceeded.night).toBeUndefined();
    expect(native.lastRun).toMatchObject({
      ok: false,
      status: "failed",
      nightReview: { ok: false },
    });
    expect(mocks.runCycle).toHaveBeenCalledTimes(3);
    const expected =
      fault === "missing_gates"
        ? REQUIRED_RESEARCH_GATES.map((id) => `night_review_gate_missing:${id}`)
        : [`night_review_gate_not_passed:${fault === "source_failed" ? "source" : "quality"}`];
    expect(native.lastRun).toMatchObject({
      nightReview: { acceptance: { ok: false, failedReasons: expect.arrayContaining(expected) } },
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
    emitSchedulerSignal("SIGTERM");
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
    emitSchedulerSignal("SIGTERM");
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
  mocks.delay.mockImplementationOnce(async () => emitSchedulerSignal("SIGTERM"));

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
    emitSchedulerSignal("SIGTERM");
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
    emitSchedulerSignal("SIGTERM");
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
  mocks.delay.mockImplementationOnce(async () => emitSchedulerSignal("SIGTERM"));

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

it.each(["reconciled", "ready", "differences", "restricted", "blocked"])(
  "runs authorized historical maintenance only after idle reconciliation=%s",
  async (readiness) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-22T17:00:00Z"));
    const policy = path.join(directory, "maintenance-policy.json");
    fs.writeFileSync(
      policy,
      JSON.stringify({ authorizationMode: "until_revoked", accountId: "paper-account" }),
    );
    mocks.syncAlpacaHistory.mockResolvedValue({
      accountId: "paper-account",
      accountReconciliation: { status: readiness },
    });
    mocks.historicalMaintenance.mockImplementation(async () => {
      expect(mocks.syncAlpacaHistory).toHaveBeenCalledOnce();
      return {
        status: "completed",
        observedAt: new Date().toISOString(),
        decisions: [{ status: "unknown" }],
      };
    });
    mocks.delay
      .mockImplementationOnce(async () => {
        if (readiness === "reconciled" || readiness === "ready") {
          const progress = JSON.parse(
            fs.readFileSync(path.join(directory, FINANCE_SCHEDULER_LOCK, "progress.json"), "utf8"),
          );
          expect(progress.historicalMaintenance).toMatchObject({
            status: "completed",
            decisionCount: 1,
            unknownCount: 1,
          });
        }
      })
      .mockImplementationOnce(async () => emitSchedulerSignal("SIGTERM"));
    await expect(
      runFinanceScheduler([
        "--loop",
        "--dir",
        directory,
        "--sync-alpaca-history",
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
        "--no-source-heartbeat",
      ]),
    ).resolves.toBe(143);
    expect(mocks.syncAlpacaHistory).toHaveBeenCalledOnce();
    if (readiness === "reconciled" || readiness === "ready") {
      expect(mocks.historicalMaintenance).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          directory,
          policy: { authorizationMode: "until_revoked", accountId: "paper-account" },
          budget: {
            automation: "unattended",
            allowedInstruments: ["*"],
            maxOrderNotional: 1000,
            maxInstrumentNotional: 5000,
            maxOrdersPerRun: 8,
          },
          feed: "iex",
          maxAgeMs: 30000,
          signal: expect.any(AbortSignal),
        }),
      );
    } else {
      expect(mocks.historicalMaintenance).not.toHaveBeenCalled();
    }
    expect(mocks.runCycle).not.toHaveBeenCalled();
  },
);

it.each([false, true])(
  "keeps stream maintenance independent of idle timing and throttles failed=%s attempts",
  async (failed) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.parse("2026-09-22T17:00:00Z");
    vi.setSystemTime(start);
    const policy = path.join(directory, "maintenance-policy.json");
    fs.writeFileSync(policy, JSON.stringify({ authorizationMode: "until_revoked" }));
    if (failed) {
      mocks.historicalMaintenance.mockRejectedValue(new Error("private-provider-error"));
    }
    const context = {
      root: { directory, source: "explicit" as const },
      options: parseFinanceSchedulerArgs([
        "--loop",
        "--dir",
        directory,
        "--sync-alpaca-history",
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
        "--no-source-heartbeat",
      ]),
      signal: new AbortController().signal,
    };
    for (const seconds of [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300]) {
      vi.setSystemTime(start + seconds * 1000);
      await reconcileResidentAlpacaAccount(context, "stream");
    }
    expect(mocks.syncAlpacaHistory).toHaveBeenCalledTimes(11);
    expect(mocks.historicalMaintenance).toHaveBeenCalledTimes(2);
    await reconcileResidentAlpacaAccount(context, "idle");
    expect(mocks.historicalMaintenance).toHaveBeenCalledTimes(2);
    expect(stderrMessages.join("\n")).not.toContain("private-provider-error");
  },
);

it.each(["ready", "blocked", "restricted"] as const)(
  "dispatches maintenance for real controller readiness=%s only when ready",
  async (readiness) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-22T17:00:00Z"));
    const policy = path.join(directory, "maintenance-policy.json");
    fs.writeFileSync(policy, JSON.stringify({ authorizationMode: "until_revoked" }));
    const intradayController = createFinanceAlpacaCycleController({
      directory,
      policy: {},
      instruments: ["SPY"],
      feed: "iex",
      maxAgeMs: 30000,
    });
    const inspectReconciliation = vi
      .spyOn(intradayController, "inspectReconciliation")
      .mockResolvedValue({
        readiness: {
          status: readiness,
          historyStatus: "reconciled",
          quarantinedInstruments: [],
          uncertaintyReserve: 0,
          reasons: [],
        },
        observedAt: new Date().toISOString(),
        protection: {
          protective: [],
          unresolved: [],
          coverage: [],
          coverageBasis: "recognized_working_sell_stops",
        },
      });
    const context = {
      root: { directory, source: "explicit" as const },
      options: parseFinanceSchedulerArgs([
        "--loop",
        "--dir",
        directory,
        "--sync-alpaca-history",
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
        "--no-source-heartbeat",
      ]),
      signal: new AbortController().signal,
      intradayController,
    };
    await reconcileResidentAlpacaAccount(context, "stream");
    expect(inspectReconciliation).toHaveBeenCalledOnce();
    expect(mocks.syncAlpacaHistory).not.toHaveBeenCalled();
    if (readiness === "ready") {
      expect(mocks.historicalMaintenance).toHaveBeenCalledOnce();
    } else {
      expect(mocks.historicalMaintenance).not.toHaveBeenCalled();
    }
  },
);

it.each(["missing_caps", "expired_policy", "unknown_policy", "no_place"])(
  "does not dispatch historical maintenance for %s",
  async (boundary) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-22T17:00:00Z"));
    const policy = path.join(directory, "maintenance-policy.json");
    fs.writeFileSync(
      policy,
      JSON.stringify(
        boundary === "unknown_policy"
          ? {}
          : boundary === "expired_policy"
            ? { expiresAt: "2026-09-21T00:00:00Z" }
            : { authorizationMode: "until_revoked" },
      ),
    );
    mocks.delay.mockImplementationOnce(async () => emitSchedulerSignal("SIGTERM"));
    await runFinanceScheduler([
      "--loop",
      "--dir",
      directory,
      "--sync-alpaca-history",
      "--venue",
      "alpaca",
      ...(boundary === "no_place" ? [] : ["--place"]),
      "--execution-policy",
      policy,
      "--execution-quote-feed",
      "iex",
      "--execution-max-age-ms",
      "30000",
      ...(boundary === "missing_caps"
        ? []
        : [
            "--max-order-notional",
            "1000",
            "--max-instrument-notional",
            "5000",
            "--max-orders",
            "8",
          ]),
      "--no-source-heartbeat",
    ]);
    expect(mocks.historicalMaintenance).not.toHaveBeenCalled();
  },
);

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
  mocks.delay.mockImplementationOnce(async () => emitSchedulerSignal("SIGTERM"));

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
  mocks.delay.mockImplementationOnce(async () => emitSchedulerSignal("SIGTERM"));

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
    intradayCloseCapture: { status: "skipped", reason: "intraday_not_configured" },
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
        emitSchedulerSignal("SIGTERM");
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
            argv,
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
    const snapshot = { generatedAt: new Date().toISOString(), selected: ["SPY", "QQQ"] };
    seedSelectedUniverse(snapshot);
    mocks.readUniverse.mockImplementation(() =>
      JSON.parse(
        fs.readFileSync(path.join(directory, FINANCE_UNIVERSE_SELECTION_SNAPSHOT_FILENAME), "utf8"),
      ),
    );
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
      emitSchedulerSignal("SIGTERM");
    });
    let schedulerSettled = false;
    const running = runFinanceScheduler([
      "--loop",
      "--dir",
      directory,
      "--no-source-heartbeat",
      "--intraday-monitor",
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
    void running.then(
      () => {
        schedulerSettled = true;
      },
      () => {
        schedulerSettled = true;
      },
    );
    try {
      await started;
      await vi.advanceTimersByTimeAsync(60_000);
      await entered;
      await vi.advanceTimersByTimeAsync(180_000);
      expect(mocks.runIntradayMonitorTick).toHaveBeenCalledTimes(2);
      expect(mocks.runIntradayMonitorTick.mock.calls.map(([call]) => call.instrument)).toEqual([
        "SPY",
        "QQQ",
      ]);
      expect(mocks.executeIntradayDecision).toHaveBeenCalledTimes(1);
      expect(mocks.runCycle).toHaveBeenCalledTimes(1);
      if (cancel) {
        emitSchedulerSignal("SIGTERM");
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
                  mocks.runCycle.mock.calls[0][0].argv,
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
      // SPY remains queued after the in-flight QQQ operation closes: do not start
      // another discretionary review after research has requested execution handoff.
      expect(mocks.runIntradayMonitorTick).toHaveBeenCalledTimes(2);
      expect(mocks.runCycle).toHaveBeenCalledTimes(cancel ? 1 : 2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      if (!schedulerSettled) {
        emitSchedulerSignal("SIGTERM");
      }
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
    emitSchedulerSignal("SIGTERM");
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
    expect(call.argv).toEqual(expect.arrayContaining(["--max-api-calls", "160"]));
    expect(call.argv).not.toContain("--include-yahoo-public-sources");
  }
  expect(readFinanceSchedulerState(directory).lastRun).toMatchObject({
    researchAttempt: 2,
    execution: { outcome: "not_run" },
  });
});

it.each([
  "valid",
  "unpublished",
  "nonzero",
  "tampered",
  "wrong_account",
  "expired",
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
  mocks.runCycle.mockImplementationOnce(async ({ argv }: { argv: readonly string[] }) => {
    const portfolioPlanWrite = [
      "valid",
      "nonzero",
      "tampered",
      "wrong_account",
      "expired",
    ].includes(variant)
      ? await writeResearchCapitalDecision(oldPlan, {
          asOf: at,
          context: JSON.parse(fs.readFileSync(context, "utf8")),
          researchReceiptId: "quality:withhold",
          abstention: payload.portfolioAbstention,
        })
      : undefined;
    if (portfolioPlanWrite && variant !== "valid") {
      const plan = JSON.parse(fs.readFileSync(oldPlan, "utf8"));
      if (variant === "nonzero") {
        plan.allocations[0].budgetFraction = 0.5;
      }
      if (variant === "wrong_account") {
        plan.accountId = "foreign-account";
      }
      if (variant === "expired") {
        plan.validUntil = "2026-09-28T00:00:00.000Z";
      }
      const bytes = JSON.stringify(plan);
      fs.writeFileSync(oldPlan, bytes);
      if (variant !== "tampered") {
        // Retain matching bytes so native account/budget/time validation is exercised.
        Object.assign(portfolioPlanWrite, {
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
      }
    }
    return {
      ...success,
      stdout: JSON.stringify({
        ...payload,
        ...(portfolioPlanWrite ? { portfolioPlanWritten: oldPlan, portfolioPlanWrite } : {}),
        controllerHandoff: dispatchedControllerHandoff(argv),
      }),
    };
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
    researchPlanRefresh: {
      ok: variant === "valid",
      planPath: variant === "valid" ? oldPlan : null,
    },
  });
  if (variant === "valid") {
    expect(
      JSON.parse(fs.readFileSync(oldPlan, "utf8")).allocations.every(
        (a: { budgetFraction: number }) => a.budgetFraction === 0,
      ),
    ).toBe(true);
  } else if (!["nonzero", "tampered", "wrong_account", "expired"].includes(variant)) {
    expect(fs.readFileSync(oldPlan, "utf8")).toBe("old-plan-must-not-be-executed");
  }
  expect(financeResearchPreflightRetryDue(state, new Date("2026-09-29T19:45:00.000Z"))).toBe(
    variant !== "valid",
  );
});

it.each(["", "__12345678-1234-4567-8123-123456789abc"])(
  "consumes the indexed latest day archive under the writer host root, including a legitimate 5MB receipt %s",
  (suffix) => {
    const workspace = path.join(directory, "workspace");
    vi.stubEnv("OPENCLAW_WORKSPACE_DIR", workspace);
    const archive = path.join(workspace, "state", "finance-research-runs", "2026-10-03");
    fs.mkdirSync(archive, { recursive: true });
    const filename = path.join(
      archive,
      `2026-10-03T01-00-00-000Z${suffix}__finance-research-run.json`,
    );
    const scope = {
      accountId: "account-a",
      venue: "alpaca",
      activeStrategyIds: ["trend"],
      requiredInstruments: ["SPY"],
    };
    const sourceAt = "2026-10-03T01:00:00.000Z";
    const receipt = {
      plan: { asOf: sourceAt, ask: "profit objective", portfolioContext: scope },
      moduleExecution: { nodes: [], replanFeedback: { status: "completed", nextAction: "none" } },
      gates: [{ id: "quality", passed: false, reason: "fees_unknown" }],
      padding: "x".repeat(5_000_000),
    };
    const bytes = JSON.stringify(receipt) + "\n";
    fs.writeFileSync(filename, bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const day = {
      runId: "day-feedback",
      mode: "day",
      firedAt: sourceAt,
      researchPlanRefresh: {
        processResult: { stdout: JSON.stringify({ written: { datedPath: filename, sha256 } }) },
      },
    };
    commitFinanceSchedulerDatabaseState(directory, "{}", [
      day,
      { runId: "night-later", mode: "night", firedAt: "2026-10-03T22:00:00Z" },
    ]);
    const request = {
      directory,
      asOf: "2026-10-04T01:00:00Z",
      ask: "profit objective",
      portfolioContext: scope,
      signal: new AbortController().signal,
    };
    expect(readFinanceScheduledResearchFeedback(request)).toMatchObject({
      status: "present",
      replanStatus: "completed",
      nextAction: "none",
      failedGates: [{ id: "quality", reason: "fees_unknown" }],
      sourceSha256: sha256,
    });
    expect(
      readFinanceScheduledResearchFeedback({
        ...request,
        portfolioContext: { ...scope, accountId: "account-b" },
      }),
    ).toMatchObject({
      status: "omitted",
      reason: "prior_receipt_task_or_portfolio_scope_mismatch",
    });
    expect(
      readFinanceScheduledResearchFeedback({ ...request, asOf: "2026-10-10T00:00:00Z" }),
    ).toMatchObject({ status: "omitted", reason: "prior_receipt_time_mismatch_or_stale" });
    fs.appendFileSync(filename, " ");
    expect(readFinanceScheduledResearchFeedback(request)).toMatchObject({
      status: "omitted",
      reason: "prior_receipt_hash_mismatch",
    });
    const abort = new AbortController();
    abort.abort();
    expect(() =>
      readFinanceScheduledResearchFeedback({ ...request, signal: abort.signal }),
    ).toThrow();
  },
);

it.each(["absent", "present"] as const)(
  "passes original prior Quality failure through the actual next scheduled feedback file without trading (%s history)",
  async (history) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-02T19:30:00Z"));
    const externalFetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("external_io_forbidden"));
    const prepared = await prepareOriginalFinanceModuleMain({
      directory: path.join(directory, "original-prior-research"),
      fault: "quality_failure",
      asOf: new Date().toISOString(),
    });
    vi.setSystemTime(new Date(prepared.input.asOf));
    const producer = await runFinanceResearchRun({
      input: prepared.input,
      workspaceDir: prepared.workspace,
      financeStateDir: prepared.book,
      liveFetch: true,
      allowProviderCalls: false,
      qualityEnabled: true,
      modelInvoker: async (request, signal) =>
        prepared.scriptedOutput(request as Parameters<typeof prepared.scriptedOutput>[0], signal),
      qualityModelRouting: prepared.routing,
      batchOptions: {
        realtimeAdapters: [
          prepared.realtime("primary_market_data"),
          prepared.realtime("cross_check_market_data"),
        ],
        collectionAdapters: [prepared.collection],
        maxSourcesPerJob: 2,
        maxConcurrency: 1,
        sourceTimeoutMs: 20,
        totalTimeoutMs: 2_000,
      },
    });
    expect(producer.status).toBe("needs_review");
    expect(producer.quality?.status).toBe("quality-failed");
    expect(producer.gates.find((gate) => gate.id === "quality")?.passed).toBe(false);
    expect(producer.portfolioPlan).toBeUndefined();
    const oldFeedback = producer.quality?.attempts.at(-1)?.feedback ?? [];
    const specificGap =
      "offline_quality_contradiction: supplied evidence does not justify the draft";
    expect(oldFeedback.some((gap) => gap.includes(specificGap))).toBe(true);
    // Follow the original producer's fixed offline session within the feedback TTL.
    const nextSession = new Date(Date.parse(producer.plan.asOf) + 86_400_000);
    while ([0, 6].includes(nextSession.getUTCDay())) {
      nextSession.setUTCDate(nextSession.getUTCDate() + 1);
    }
    nextSession.setUTCHours(19, 30, 0, 0);
    const nextAsOf = nextSession.toISOString();
    vi.setSystemTime(nextSession);
    const workspace = prepared.workspace;
    vi.stubEnv("OPENCLAW_WORKSPACE_DIR", workspace);
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(workspace, "private-next-state"));
    vi.stubEnv("LCX_MODEL_TRAJECTORY", "0");
    // The original next CLI reads the scheduler book, not the prior producer's child book.
    const priorRule = (await readFinanceStrategyRuleLedger(prepared.book)).ledger.rules.find(
      (rule) => rule.ruleId === "private-trend",
    );
    if (!priorRule) {
      throw new Error("original private rule not found");
    }
    for (const transition of priorRule.transitions) {
      if (transition.body.kind === "declared") {
        await declareFinanceStrategyRule(directory, transition.body);
      } else if (transition.body.kind === "activated") {
        await activateFinanceStrategyRule(directory, transition.body);
      }
    }
    let barWriter: Awaited<ReturnType<typeof appendFinanceBars>> | undefined;
    let barReadback: Awaited<ReturnType<typeof readFinanceBarLedger>> | undefined;
    let barLedgerBytes: Buffer | undefined;
    if (history === "present") {
      const asOf = new Date().toISOString();
      const cutoff = Date.parse(latestCompletedWeekdaySessionDate(asOf) + "T00:00:00Z");
      const bars: Extract<FinanceBarAppendInput, { derivation: "ohlcv" }>["bars"] = [];
      for (let offset = 1500; offset >= 0; offset--) {
        const day = new Date(cutoff - offset * 86_400_000);
        if ([0, 6].includes(day.getUTCDay())) {
          continue;
        }
        const close = 100 + (1500 - offset) * 0.05 + Math.sin(offset);
        bars.push({
          date: day.toISOString().slice(0, 10),
          open: close,
          high: close + 1,
          low: close - 1,
          close,
          volume: 1000000,
        });
      }
      barWriter = await appendFinanceBars(directory, {
        instrument: "SPY",
        derivation: "ohlcv",
        observedAt: asOf,
        provenance: {
          origin: "private offline synthetic historical input",
          sourceUrlOrArtifact: "fixture://scheduler-private-price-ledger/SPY",
        },
        bars,
      });
      barReadback = await readFinanceBarLedger(directory, { asOf, instrument: "SPY" });
      expect(barReadback.headRef).toBe(barWriter.headRef);
      expect(barReadback.bars.length).toBe(bars.length);
      expect(barReadback.bars.at(-1)?.date).toBe(latestCompletedWeekdaySessionDate(asOf));
      barLedgerBytes = fs.readFileSync(financeBarLedgerPath(directory));
    }
    const context = path.join(directory, "portfolio-context.json");
    fs.writeFileSync(context, JSON.stringify(producer.plan.portfolioContext));
    const ask = producer.plan.ask;
    const sourceAt = producer.plan.asOf;
    const archive = path.join(workspace, "state", "finance-research-runs", sourceAt.slice(0, 10));
    fs.mkdirSync(archive, { recursive: true });
    const filename = path.join(
      archive,
      `${sourceAt.replace(/[:.]/gu, "-")}__finance-research-run.json`,
    );
    // Archive the complete actual return unchanged; only source/model IO above is synthetic.
    const bytes = JSON.stringify(producer, null, 2) + "\n";
    fs.writeFileSync(filename, bytes);
    const sourceSha256 = createHash("sha256").update(bytes).digest("hex");
    const day = {
      runId: "prior-day",
      mode: "day",
      firedAt: sourceAt,
      researchPlanRefresh: {
        processResult: {
          stdout: JSON.stringify({ written: { datedPath: filename, sha256: sourceSha256 } }),
        },
      },
    };
    commitFinanceSchedulerDatabaseState(
      directory,
      JSON.stringify(readFinanceSchedulerState(directory)),
      [day],
    );
    const priorFeedbackReadback = readFinanceScheduledResearchFeedback({
      directory,
      asOf: new Date().toISOString(),
      ask,
      portfolioContext: producer.plan.portfolioContext,
      signal: new AbortController().signal,
    });
    let nextFile: { argv: string[]; path: string; bytes: string } | undefined;
    let nextCliOutput: Awaited<ReturnType<typeof runFinanceResearchCli>> | undefined;
    let nextWrittenReadback:
      | { path: string; sha256: string; bytes: number; raw: string }
      | undefined;
    let nextFrozenContext: { path: string; sha256: string; bytes: number; raw: string } | undefined;
    let nextControllerHandoffReadback:
      | { path: string; sha256: string; bytes: number; raw: string }
      | undefined;
    const nextRunnerInputs: researchRunner.FinanceResearchRunInput[] = [];
    const nextModelInputs: QualityHarnessModelRequest[] = [];
    const nextHttpInputs: Array<{ stage: string; model: string; prompt: string }> = [];
    const nextMathCalls: Array<{
      toolCallId: string;
      input: unknown;
      inputSha256: string;
      output: unknown;
    }> = [];
    const strategyScopeReads: Array<{
      input: Parameters<typeof priceContext.readFinanceActiveStrategyResearchScope>[0];
      output: Awaited<ReturnType<typeof priceContext.readFinanceActiveStrategyResearchScope>>;
    }> = [];
    const priceHydrationReads: Array<{
      input: Parameters<typeof priceContext.buildFinanceActiveStrategyResearchEvidence>[0];
      output: Awaited<ReturnType<typeof priceContext.buildFinanceActiveStrategyResearchEvidence>>;
    }> = [];
    let forbiddenNetworkCalls = 0;
    const proofRoot = process.env.LCX_FINANCE_SCHEDULER_FEEDBACK_PROOF_DIR
      ? path.join(process.env.LCX_FINANCE_SCHEDULER_FEEDBACK_PROOF_DIR, `${history}-history`)
      : undefined;
    const saveHandoff = (phase: "before_assertions" | "completed") => {
      if (!proofRoot || !nextFile) {
        return;
      }
      fs.mkdirSync(proofRoot, { recursive: true });
      fs.writeFileSync(path.join(proofRoot, "original-prior-research-receipt.json"), bytes);
      fs.writeFileSync(
        path.join(proofRoot, "original-next-controller-evidence.json"),
        nextFile.bytes,
      );
      if (nextWrittenReadback) {
        fs.writeFileSync(
          path.join(proofRoot, "next-written-receipt.json"),
          nextWrittenReadback.raw,
        );
      }
      if (nextFrozenContext) {
        fs.writeFileSync(path.join(proofRoot, "next-frozen-context.json"), nextFrozenContext.raw);
      }
      if (nextControllerHandoffReadback) {
        fs.writeFileSync(
          path.join(proofRoot, "next-controller-handoff.json"),
          nextControllerHandoffReadback.raw,
        );
      }
      if (barLedgerBytes) {
        fs.writeFileSync(
          path.join(proofRoot, "original-controller-price-ledger.sqlite"),
          barLedgerBytes,
        );
      }
      fs.writeFileSync(
        path.join(
          proofRoot,
          phase === "completed" ? "native-handoff.json" : "handoff-before-assertions.json",
        ),
        JSON.stringify(
          {
            phase,
            sourceSha256,
            oldQualityFeedback: oldFeedback,
            priorFeedbackReadback,
            capturedChild: nextFile,
            nextEvidenceSha256: createHash("sha256").update(nextFile.bytes).digest("hex"),
            schedulerReadback: readFinanceSchedulerState(directory).lastRun,
            originalQualityRequests: prepared.qualityRequests,
            nextRunnerInputs,
            nextCliOutput,
            nextWrittenReadback,
            nextFrozenContext,
            nextControllerHandoffReadback,
            nextModelInputs,
            nextHttpInputs,
            history,
            barWriter,
            barReadback,
            barLedgerSource: barLedgerBytes
              ? {
                  path: financeBarLedgerPath(directory),
                  sha256: createHash("sha256").update(barLedgerBytes).digest("hex"),
                  bytes: barLedgerBytes.length,
                }
              : undefined,
            nextMathCalls,
            priceHydrationReads,
            strategyScopeReads,
            localModelHttpCalls: nextHttpInputs.length,
            forbiddenNetworkCalls,
            boundary:
              "actual original prior runner/Quality -> next scheduler file/argv -> original CLI parseArgs/run/checkpoint/runner/model HTTP prompt. Sources and model HTTP bodies are local substitutes; no next input override or accepted receipt stub. Private original rule declarations supply the scheduler book. Not natural semantic adoption, complete scene or trading.",
          },
          null,
          2,
        ) + "\n",
      );
    };
    mocks.runCycle.mockImplementationOnce(async ({ argv }: { argv: string[] }) => {
      const evidencePath = argv[argv.indexOf("--controller-evidence") + 1];
      const nextBytes = fs.readFileSync(evidencePath, "utf8");
      const evidence = JSON.parse(nextBytes);
      nextFile = { argv: [...argv], path: evidencePath, bytes: nextBytes };
      saveHandoff("before_assertions");
      expect(evidence).toHaveLength(2);
      expect(JSON.parse(evidence[1].text)).toMatchObject({
        sourceSha256,
        sourceAsOf: sourceAt,
        failedGates: expect.arrayContaining([
          { id: "quality", reason: producer.gates.find((gate) => gate.id === "quality")!.reason },
        ]),
      });
      expect(
        JSON.parse(evidence[1].text).qualityFeedback.some((gap: string) =>
          gap.includes(specificGap),
        ),
      ).toBe(true);
      expect(argv[argv.indexOf("--ask") + 1]).toBe(ask);
      const frozenContext = argv[argv.indexOf("--portfolio-context") + 1];
      const contextBytes = fs.readFileSync(frozenContext);
      nextFrozenContext = {
        path: frozenContext,
        sha256: createHash("sha256").update(contextBytes).digest("hex"),
        bytes: contextBytes.length,
        raw: contextBytes.toString("utf8"),
      };
      expect(JSON.parse(nextFrozenContext.raw)).toEqual(producer.plan.portfolioContext);
      if (history === "present") {
        const manifestPath = argv[argv.indexOf("--controller-handoff") + 1];
        const manifestBytes = fs.readFileSync(manifestPath);
        nextControllerHandoffReadback = {
          path: manifestPath,
          sha256: createHash("sha256").update(manifestBytes).digest("hex"),
          bytes: manifestBytes.length,
          raw: manifestBytes.toString("utf8"),
        };
        expect(nextControllerHandoffReadback.sha256).toBe(
          argv[argv.indexOf("--controller-handoff-sha256") + 1],
        );
        expect(JSON.parse(nextControllerHandoffReadback.raw)).toMatchObject({
          schemaVersion: "finance_scheduled_research_handoff_v1",
          sourceScope: {
            accountId: producer.plan.portfolioContext!.accountId,
            venue: producer.plan.portfolioContext!.venue,
            asOf: researchAsOfFromArgs(argv),
          },
          inputs: {
            controllerEvidence: {
              path: evidencePath,
              sha256: createHash("sha256").update(nextBytes).digest("hex"),
              bytes: Buffer.byteLength(nextBytes),
            },
            portfolioContext: {
              path: frozenContext,
              sha256: nextFrozenContext.sha256,
              bytes: nextFrozenContext.bytes,
            },
          },
        });
      }
      const privateConfig: OpenClawConfig = {
        agents: { defaults: { model: "fixture/fast", memorySearch: { enabled: false } } },
        tools: {
          financeModelSlots: {
            fast: "fixture/fast",
            reasoning: "fixture/reasoning",
            review: "fixture/review",
          },
        },
        models: {
          providers: {
            fixture: {
              api: "openai-completions",
              baseUrl: "https://fixture.invalid/v1",
              apiKey: "private-synthetic-token",
              models: ["fast", "reasoning", "review"].map((id) => ({
                id,
                name: id,
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 320_000,
                maxTokens: 32_000,
              })),
            },
          },
        },
      };
      mocks.loadConfig.mockReturnValue(privateConfig);
      const originalStore = checkpointStore.createCanonicalStateRootLogicalAgentCheckpointStore;
      vi.spyOn(
        checkpointStore,
        "createCanonicalStateRootLogicalAgentCheckpointStore",
      ).mockImplementation(() =>
        originalStore({ stateDir: path.join(workspace, "private-next-quality-checkpoints") }),
      );
      const originalAdapter = configuredAdapter.createConfiguredFinanceModelAdapter;
      vi.spyOn(configuredAdapter, "createConfiguredFinanceModelAdapter").mockImplementation(
        (cfg, options) =>
          originalAdapter(cfg, {
            ...options,
            availabilityStateDirectory: path.join(workspace, "private-next-cooldowns"),
          }),
      );
      const originalRealtimeOptions =
        realtimeRegistry.resolveFinanceRealtimeSourceRegistryOptionsFromEnv;
      const originalCollectionOptions =
        collectionRegistry.resolveFinanceMarketCollectionRegistryOptionsFromEnv;
      vi.spyOn(
        realtimeRegistry,
        "resolveFinanceRealtimeSourceRegistryOptionsFromEnv",
      ).mockImplementation(() => originalRealtimeOptions({}));
      vi.spyOn(
        collectionRegistry,
        "resolveFinanceMarketCollectionRegistryOptionsFromEnv",
      ).mockImplementation(() => originalCollectionOptions({}));
      vi.spyOn(realtimeRegistry, "createFinanceRealtimeSourceRegistry").mockImplementation(() =>
        ["primary_market_data", "cross_check_market_data"].map((role) => {
          const adapter = prepared.realtime(
            role as "primary_market_data" | "cross_check_market_data",
          );
          return {
            ...adapter,
            collect: async (
              request: realtimeRegistry.FinanceRealtimeSourceRequest,
              signal: AbortSignal,
            ) => {
              const body = await adapter.collect(request, signal);
              return {
                ...body,
                observedAt: request.asOf,
                fields: body.fields.map((field) => ({ ...field, sourceTimestamp: request.asOf })),
              };
            },
          };
        }),
      );
      vi.spyOn(collectionRegistry, "createFinanceMarketCollectionRegistry").mockImplementation(
        () => [
          {
            ...prepared.collection,
            collect: async (request, signal) =>
              (await prepared.collection.collect(request, signal)).map((item) => ({
                ...item,
                observedAt: request.asOf,
              })),
          },
        ],
      );
      const requests = new Map<string, QualityHarnessModelRequest>();
      const originalPrompt = prompt.buildQualityHarnessModelPromptWithCoverage;
      vi.spyOn(prompt, "buildQualityHarnessModelPromptWithCoverage").mockImplementation(
        (request) => {
          const built = originalPrompt(request);
          requests.set(built.prompt, structuredClone(request));
          return built;
        },
      );
      const originalRunner = researchRunner.runFinanceResearchRun;
      vi.spyOn(researchRunner, "runFinanceResearchRun").mockImplementation(async (options) => {
        nextRunnerInputs.push(structuredClone(options.input));
        return originalRunner(options);
      });
      if (history === "present") {
        const originalScope = priceContext.readFinanceActiveStrategyResearchScope;
        vi.spyOn(priceContext, "readFinanceActiveStrategyResearchScope").mockImplementation(
          async (input) => {
            const output = await originalScope(input);
            strategyScopeReads.push({
              input: structuredClone(input),
              output: structuredClone(output),
            });
            return output;
          },
        );
        const originalQuant = quantTools.createQuantMathTool;
        vi.spyOn(quantTools, "createQuantMathTool").mockImplementation(() => {
          const tool = originalQuant();
          return {
            ...tool,
            execute: async (...args: Parameters<typeof tool.execute>) => {
              const call = {
                toolCallId: args[0],
                input: structuredClone(args[1]),
                inputSha256: createHash("sha256").update(JSON.stringify(args[1])).digest("hex"),
                output: undefined as unknown,
              };
              nextMathCalls.push(call);
              const output = await tool.execute(...args);
              call.output = structuredClone(output);
              return output;
            },
          };
        });
        const originalPriceEvidence = priceContext.buildFinanceActiveStrategyResearchEvidence;
        vi.spyOn(priceContext, "buildFinanceActiveStrategyResearchEvidence").mockImplementation(
          async (input) => {
            const output = await originalPriceEvidence(input);
            priceHydrationReads.push({
              input: structuredClone(input),
              output: structuredClone(output),
            });
            return output;
          },
        );
      }
      externalFetch.mockImplementation(async (url, init) => {
        const requestedUrl =
          typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
        if (
          requestedUrl !== "https://fixture.invalid/v1/chat/completions" ||
          typeof init?.body !== "string" ||
          !init.signal
        ) {
          forbiddenNetworkCalls++;
          throw new Error("external_io_forbidden");
        }
        const body = JSON.parse(init.body) as {
          model: string;
          messages: Array<{ content: string }>;
        };
        const actualPrompt = body.messages[0]?.content;
        const request = actualPrompt ? requests.get(actualPrompt) : undefined;
        if (!request || !actualPrompt) {
          throw new Error("original next CLI model prompt not recorded");
        }
        nextModelInputs.push(structuredClone(request));
        nextHttpInputs.push({ model: body.model, stage: request.stage, prompt: actualPrompt });
        const response = await prepared.scriptedOutput(request, init.signal);
        return new Response(
          JSON.stringify({
            id: `private-next-http-${nextHttpInputs.length}`,
            choices: [{ finish_reason: "stop", message: { content: JSON.stringify(response) } }],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
          }),
          { status: 200 },
        );
      });
      const options = parseFinanceResearchCliArgs(argv.slice(3));
      expect(options.financeStateDir).toBe(directory);
      expect(options.ask).toBe(ask);
      // Keep the original ISO as-of frozen while the native throttle/deadline clock advances.
      const nextClock = Date.now();
      const started = performance.now();
      vi.spyOn(Date, "now").mockImplementation(
        () => nextClock + Math.floor(performance.now() - started),
      );
      nextCliOutput = await runFinanceResearchCli(options);
      const written = nextCliOutput.written;
      if (
        !written ||
        typeof written !== "object" ||
        !("datedPath" in written) ||
        typeof written.datedPath !== "string" ||
        !("sha256" in written) ||
        typeof written.sha256 !== "string"
      ) {
        throw new Error("original next CLI archive pin not returned");
      }
      const writtenBytes = fs.readFileSync(written.datedPath);
      nextWrittenReadback = {
        path: written.datedPath,
        sha256: createHash("sha256").update(writtenBytes).digest("hex"),
        bytes: writtenBytes.length,
        raw: writtenBytes.toString("utf8"),
      };
      expect(nextWrittenReadback.sha256).toBe(written.sha256);
      expect(JSON.parse(nextWrittenReadback.raw)).toEqual(nextCliOutput.receipt);
      expect(fs.readFileSync(frozenContext)).toEqual(contextBytes);
      saveHandoff("before_assertions");
      if (history === "present") {
        if (!nextControllerHandoffReadback) {
          throw new Error("actual controller handoff readback missing");
        }
        const actualHandoff = {
          ...JSON.parse(nextControllerHandoffReadback.raw),
          producer: {
            path: nextControllerHandoffReadback.path,
            sha256: nextControllerHandoffReadback.sha256,
            bytes: nextControllerHandoffReadback.bytes,
          },
        };
        expect(nextRunnerInputs[0]?.controllerHandoff).toEqual(actualHandoff);
        expect(nextCliOutput.receipt.controllerHandoff).toEqual(actualHandoff);
        expect(JSON.parse(nextWrittenReadback.raw).controllerHandoff).toEqual(actualHandoff);
        expect(
          compactFinanceResearchSummary({ ...nextCliOutput.receipt, ...nextCliOutput })
            .controllerHandoff,
        ).toEqual(actualHandoff);
        const strategyRead = strategyScopeReads[0];
        if (!strategyRead) {
          throw new Error("original active-rule scope read not observed");
        }
        const activeRuleEvidence = strategyRead.output.evidence.find(
          (item) => item.id === "finance-controller:active-strategies",
        );
        if (!activeRuleEvidence) {
          throw new Error("actual active-rule evidence missing");
        }
        const actualRuleUse = {
          source: strategyRead.output.source,
          accountScope: {
            accountId: nextCliOutput.receipt.plan.portfolioContext!.accountId,
            venue: nextCliOutput.receipt.plan.portfolioContext!.venue,
            asOf: nextCliOutput.receipt.plan.asOf,
          },
          evidence: {
            id: activeRuleEvidence.id,
            sha256: createHash("sha256").update(activeRuleEvidence.text).digest("hex"),
          },
          parentRunId: actualHandoff.sourceScope.runId,
        };
        expect(strategyRead.input).toMatchObject({
          directory,
          asOf: actualRuleUse.accountScope.asOf,
          strategyIds: nextCliOutput.receipt.plan.portfolioContext!.activeStrategyIds,
        });
        expect(nextRunnerInputs[0]?.controllerRuleUse).toEqual(actualRuleUse);
        expect(nextCliOutput.receipt.controllerRuleUse).toEqual(actualRuleUse);
        expect(JSON.parse(nextWrittenReadback.raw).controllerRuleUse).toEqual(actualRuleUse);
        expect(
          compactFinanceResearchSummary({ ...nextCliOutput.receipt, ...nextCliOutput })
            .controllerRuleUse,
        ).toEqual(actualRuleUse);
        expect(
          nextRunnerInputs[0]?.controllerEvidence?.find((item) => item.id === activeRuleEvidence.id)
            ?.text,
        ).toBe(activeRuleEvidence.text);
        const hydration = priceHydrationReads.find(
          (read) => read.input.historyFormat === "daily_calculation",
        );
        expect(hydration?.input.directory).toBe(directory);
        expect(hydration?.input.asOf).toBe(nextCliOutput.receipt.plan.asOf);
        const price = hydration?.output.find((item) => item.id === "finance-controller:eod:SPY");
        if (!price) {
          throw new Error("original controller price hydration not observed");
        }
        const projection = JSON.parse(price.text) as {
          instrument: string;
          headRef: string;
          closes: Array<[string, number]>;
        };
        expect(projection.instrument).toBe("SPY");
        expect(projection.headRef).toBe(barReadback?.headRef);
        expect(price.timestamp).toBe(nextCliOutput.receipt.plan.asOf);
        expect(nextMathCalls[0]?.input).toEqual({
          action: "max_drawdown",
          series: projection.closes.map((row) => row[1]),
          seriesMode: "levels",
        });
        expect(nextMathCalls[0]?.output).toBeDefined();
        expect(
          nextCliOutput.receipt.moduleExecution?.nodes.find(
            (node) => node.moduleId === "quant_math",
          )?.status,
        ).toBe("succeeded");
      }
      expect(nextCliOutput.receipt.status).not.toBe("candidate");
      expect(nextCliOutput.receipt.portfolioPlan).toBeUndefined();
      expect(nextRunnerInputs[0]?.portfolioContext).toMatchObject(producer.plan.portfolioContext!);
      expect(nextRunnerInputs[0]?.asOf).toBe(nextAsOf);
      expect(
        nextRunnerInputs[0]?.controllerEvidence?.some(
          (item) => item.text.includes(sourceSha256) && item.text.includes(specificGap),
        ),
      ).toBe(true);
      expect(
        nextHttpInputs.some(
          (item) => item.prompt.includes(sourceSha256) && item.prompt.includes(specificGap),
        ),
      ).toBe(true);
      saveHandoff("before_assertions");
      return {
        ...success,
        exitCode: 1,
        status: "failed" as const,
        ok: false,
        stdout: JSON.stringify(
          compactFinanceResearchSummary({ ...nextCliOutput.receipt, ...nextCliOutput }),
        ),
        stderr: "",
      };
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
        ask,
      ]),
    ).resolves.toBe(1);
    expect(mocks.runCycle).toHaveBeenCalledTimes(1);
    expect(nextFile).toBeDefined();
    expect(fs.readFileSync(filename, "utf8")).toBe(bytes);
    expect(forbiddenNetworkCalls).toBe(0);
    expect(nextHttpInputs.length).toBeGreaterThan(0);
    expect(mocks.executeIntradayDecision).not.toHaveBeenCalled();
    expect(readFinanceSchedulerState(directory).lastRun?.researchPlanRefresh).toMatchObject({
      feedback: { status: "present", sourceSha256 },
    });
    if (history === "present") {
      expect(JSON.parse(nextControllerHandoffReadback!.raw).sourceScope.runId).toBe(
        readFinanceSchedulerState(directory).lastRun?.runId,
      );
    }
    saveHandoff("completed");
  },
);

function closeCaptureSession(closeAt = "2026-10-01T20:00:00.000Z") {
  const sourceUrlOrArtifact =
    "https://paper-api.alpaca.markets/v2/calendar?start=2026-10-01&end=2026-10-01&date_type=TRADING";
  const bound = {
    source: "alpaca_paper_market_calendar",
    sourceUrlOrArtifact,
    date: "2026-10-01",
    openAt: "2026-10-01T13:30:00.000Z",
    closeAt,
  };
  return {
    ...bound,
    openMinute: 570,
    closeMinute: closeAt.includes("17:00") ? 780 : 960,
    observedAt: closeAt,
    calendarRef: caseflowFingerprint(bound),
  };
}

async function seedCloseCaptureBar(
  instrument: string,
  startAt: string,
  feed: "iex" | "sip" = "iex",
) {
  await appendFinanceIntradayBars(directory, {
    instrument,
    intervalSeconds: 300,
    observedAt: "2026-10-01T22:00:00.000Z",
    provenance: { origin: "stub native feed", sourceUrlOrArtifact: "fixture:bars", feed },
    bars: [{ startAt, open: 10, high: 11, low: 9, close: 10, volume: 1 }],
  });
}

it("captures the last closed bar for original ledger targets with stub transport and is idempotent", async () => {
  await seedCloseCaptureBar("REMOVED", "2026-10-01T13:30:00.000Z");
  await seedCloseCaptureBar("COMPLETE", "2026-10-01T19:55:00.000Z");
  const read = vi.fn(async () => ({
    status: 200,
    body: JSON.stringify({
      bars: [{ t: "2026-10-01T19:55:00.000Z", o: 10, h: 11, l: 9, c: 10.5, v: 2 }],
    }),
  }));
  const sync = vi.fn((options: Parameters<typeof syncAlpacaIntradayBars>[0]) =>
    syncAlpacaIntradayBars({
      ...options,
      credentials: { apiKeyId: "stub", apiSecretKey: "stub" },
      read,
    }),
  );
  const now = () => new Date("2026-10-01T22:00:00.000Z");
  const options = {
    directory,
    sessionDate: "2026-10-01",
    intraday: { feed: "iex" as const, intervalSeconds: 300 as const },
    resolveMarketSession: vi.fn(async () => closeCaptureSession()),
    signal: new AbortController().signal,
    now,
    sync,
  };
  expect(await captureFinanceIntradayCloseBars(options)).toMatchObject({
    status: "completed",
    results: [
      { instrument: "COMPLETE", status: "already_complete" },
      { instrument: "REMOVED", status: "captured" },
    ],
  });
  expect(sync).toHaveBeenCalledOnce();
  expect(sync.mock.calls[0][0]).toMatchObject({
    instrument: "REMOVED",
    start: "2026-10-01T19:55:00.000Z",
    end: "2026-10-01T20:00:00.000Z",
    feed: "iex",
    intervalSeconds: 300,
  });
  const ledger = await readFinanceIntradayLedger(directory, { instrument: "REMOVED", feed: "iex" });
  expect(ledger.bars.at(-1)).toMatchObject({ startAt: "2026-10-01T19:55:00.000Z", close: 10.5 });
  expect(await captureFinanceIntradayCloseBars(options)).toMatchObject({ status: "completed" });
  expect(sync).toHaveBeenCalledOnce();
  expect(mocks.executeIntradayDecision).not.toHaveBeenCalled();
});

it.each(["unconfigured", "before_close", "holiday", "cancelled"])(
  "skips night close capture: %s",
  async (reason) => {
    const controller = new AbortController();
    if (reason === "cancelled") {
      controller.abort();
    }
    const readLedger = vi.fn();
    const sync = vi.fn();
    const result = await captureFinanceIntradayCloseBars({
      directory,
      sessionDate: "2026-10-01",
      intraday: reason === "unconfigured" ? undefined : { feed: "iex", intervalSeconds: 300 },
      resolveMarketSession: vi.fn(async () =>
        reason === "holiday"
          ? null
          : { ...closeCaptureSession(), observedAt: "2026-10-01T19:50:00.000Z" },
      ),
      signal: controller.signal,
      now: () =>
        new Date(
          reason === "before_close" ? "2026-10-01T19:59:59.000Z" : "2026-10-01T22:00:00.000Z",
        ),
      readLedger,
      sync,
    });
    expect(result.status).toBe("skipped");
    expect(readLedger).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
  },
);

it("keeps failed and provider-missing close bars visible without throwing", async () => {
  await seedCloseCaptureBar("FAILED", "2026-10-01T13:30:00.000Z");
  await seedCloseCaptureBar("MISSING", "2026-10-01T13:30:00.000Z");
  const sync = vi.fn(async (options: Parameters<typeof syncAlpacaIntradayBars>[0]) => {
    if (options.instrument === "FAILED") {
      throw new Error("provider failure");
    }
    return { instrument: options.instrument } as Awaited<ReturnType<typeof syncAlpacaIntradayBars>>;
  });
  expect(
    await captureFinanceIntradayCloseBars({
      directory,
      sessionDate: "2026-10-01",
      intraday: { feed: "iex", intervalSeconds: 300 },
      resolveMarketSession: async () => closeCaptureSession(),
      signal: new AbortController().signal,
      now: () => new Date("2026-10-01T22:00:00.000Z"),
      sync,
    }),
  ).toMatchObject({
    status: "partial",
    results: [
      { instrument: "FAILED", status: "unavailable", reason: "last_bar_sync_failed" },
      { instrument: "MISSING", status: "unavailable", reason: "last_bar_missing_after_sync" },
    ],
  });
});

it("uses the original early-close calendar and excludes another day or feed", async () => {
  await seedCloseCaptureBar("EARLY", "2026-10-01T13:30:00.000Z");
  await seedCloseCaptureBar("YESTERDAY", "2026-09-30T13:30:00.000Z");
  await seedCloseCaptureBar("OTHERFEED", "2026-10-01T13:30:00.000Z", "sip");
  const sync = vi.fn(async (options: Parameters<typeof syncAlpacaIntradayBars>[0]) => {
    await seedCloseCaptureBar(options.instrument, options.start);
    return {} as Awaited<ReturnType<typeof syncAlpacaIntradayBars>>;
  });
  const result = await captureFinanceIntradayCloseBars({
    directory,
    sessionDate: "2026-10-01",
    intraday: { feed: "iex", intervalSeconds: 300 },
    resolveMarketSession: async () => closeCaptureSession("2026-10-01T17:00:00.000Z"),
    signal: new AbortController().signal,
    now: () => new Date("2026-10-01T22:00:00.000Z"),
    sync,
  });
  expect(result).toMatchObject({
    status: "completed",
    results: [{ instrument: "EARLY", status: "captured" }],
  });
  expect(sync).toHaveBeenCalledOnce();
  expect(sync.mock.calls[0][0]).toMatchObject({
    start: "2026-10-01T16:55:00.000Z",
    end: "2026-10-01T17:00:00.000Z",
  });
});

it("records failed close capture without failing the original night settlement", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-01T22:00:00.000Z"));
  mocks.resolveCalendar.mockRejectedValueOnce(new Error("stub calendar failure"));
  await runFinanceScheduler([
    "--once",
    "night",
    "--dir",
    directory,
    "--intraday-monitor",
    "--intraday-instruments",
    "AAA",
  ]);
  expect(readFinanceSchedulerState(directory).lastRun).toMatchObject({
    ok: true,
    intradayCloseCapture: {
      status: "unavailable",
      reason: "close_capture_read_failed",
      boundary: "market_data_only_no_execution",
    },
  });
});

it("keeps calendar and ledger failures named without throwing from close capture", async () => {
  const options = {
    directory,
    sessionDate: "2026-10-01",
    intraday: { feed: "iex" as const, intervalSeconds: 300 as const },
    signal: new AbortController().signal,
    now: () => new Date("2026-10-01T22:00:00.000Z"),
  };
  expect(
    await captureFinanceIntradayCloseBars({
      ...options,
      resolveMarketSession: async () => {
        throw new Error("calendar failed");
      },
    }),
  ).toMatchObject({ status: "unavailable", reason: "close_capture_read_failed" });
  expect(
    await captureFinanceIntradayCloseBars({
      ...options,
      resolveMarketSession: async () => ({ ...closeCaptureSession(), calendarRef: "0".repeat(64) }),
    }),
  ).toMatchObject({ status: "unavailable", reason: "invalid_market_calendar" });
  expect(
    await captureFinanceIntradayCloseBars({
      ...options,
      resolveMarketSession: async () => closeCaptureSession(),
      readLedger: async () => {
        throw new Error("ledger failed");
      },
    }),
  ).toMatchObject({ status: "unavailable", reason: "close_capture_read_failed" });
});

it("publishes real account-lane busy state during the original idle broker readback", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-22T17:00:00Z"));
  mocks.syncAlpacaHistory.mockImplementation(async () => {
    expect(inspectFinanceSchedulerStatus({ directory, source: "explicit" }).progress).toMatchObject(
      { phase: "idle", accountWork: { status: "busy", activeWork: "trading" } },
    );
    return { accountId: "paper-account", accountReconciliation: { status: "reconciled" } };
  });
  mocks.delay.mockImplementationOnce(async () => {
    expect(
      inspectFinanceSchedulerStatus({ directory, source: "explicit" }).progress.accountWork,
    ).toMatchObject({
      status: "idle",
      activeWork: null,
      queuedWork: 0,
      reconciliationPending: false,
    });
    emitSchedulerSignal("SIGTERM");
  });
  await expect(
    runFinanceScheduler([
      "--loop",
      "--dir",
      directory,
      "--sync-alpaca-history",
      "--venue",
      "alpaca",
      "--no-source-heartbeat",
    ]),
  ).resolves.toBe(143);
  expect(mocks.syncAlpacaHistory).toHaveBeenCalledOnce();
  expect(mocks.executeIntradayDecision).not.toHaveBeenCalled();
});

it("does not renew the original cycle deadline when account-work observations change", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const at = new Date("2026-09-21T19:30:00Z");
  vi.setSystemTime(at);
  const policy = path.join(directory, "observation-policy.json");
  fs.writeFileSync(policy, JSON.stringify({ authorizationMode: "until_revoked" }));
  const context = path.join(directory, "observation-context.json");
  writePortfolioContext(context);
  const writes = vi.spyOn(fs, "writeFileSync");
  mocks.runCycle
    .mockImplementationOnce(async ({ argv }: { argv: readonly string[] }) => ({
      ...success,
      stdout: JSON.stringify(
        acceptedResearchCandidate(
          path.join(directory, "research-portfolio-plan-latest.json"),
          researchAsOfFromArgs(argv),
          argv,
        ),
      ),
    }))
    .mockImplementationOnce(async () => {
      vi.setSystemTime(new Date(at.getTime() + 14 * 60_000));
      return success;
    });
  mocks.delay.mockImplementationOnce(async () => emitSchedulerSignal("SIGTERM"));
  await expect(
    runFinanceScheduler([
      "--loop",
      "--dir",
      directory,
      "--place",
      "--sync-alpaca-history",
      "--venue",
      "alpaca",
      "--execution-policy",
      policy,
      "--research-portfolio-context",
      context,
      "--research-ask",
      "fixture",
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
  const observations = writes.mock.calls
    .filter(([filename]) => String(filename).endsWith("progress.json.tmp"))
    .map(([, data]) => {
      if (typeof data !== "string") {
        throw new Error("progress expected JSON text");
      }
      return JSON.parse(data) as {
        phase: string;
        cycleStage?: string;
        observedAt: string;
        accountWork?: { activeWork: string | null; queuedWork: number; observedAt: string };
      };
    });
  expect(observations).toContainEqual(
    expect.objectContaining({
      phase: "cycle",
      cycleStage: "execution",
      observedAt: at.toISOString(),
      accountWork: expect.objectContaining({
        activeWork: null,
        queuedWork: 0,
        observedAt: new Date(at.getTime() + 14 * 60_000).toISOString(),
      }),
    }),
  );
});

it.each(["matching", "changed", "foreign", "partial"])(
  "keeps original night write-to-calibration source custody: %s",
  async (variant) => {
    const filename = financeResearchScoredPath(directory);
    const bytes = Buffer.from('{"conviction":0.7,"outcome":1}\n');
    fs.writeFileSync(filename, bytes);
    const source = {
      path:
        variant === "foreign"
          ? path.join(directory, "other-book", "research-scored.jsonl")
          : filename,
      sha256:
        variant === "changed" ? "0".repeat(64) : createHash("sha256").update(bytes).digest("hex"),
      ...(variant === "partial" ? {} : { bytes: bytes.length }),
    };
    mocks.runCycle.mockResolvedValueOnce({
      ...success,
      stdout: JSON.stringify({
        ok: true,
        scoredFiled: { appended: 1, skipped: 0, ...source },
        pending: [],
        declined: [],
        issues: [],
      }),
    });
    await runFinanceScheduler(["--once", "night", "--dir", directory]);
    const record = readFinanceSchedulerState(directory).lastRun;
    if (variant === "matching") {
      expect(record).toMatchObject({
        tuningLifecycle: {
          ok: true,
          status: "completed",
          result: { sourceRead: { path: filename, sha256: source.sha256, bytes: bytes.length } },
        },
      });
    } else if (variant === "partial") {
      expect(record).toMatchObject({
        ok: false,
        nightSettlementFailure: {
          status: "invalid",
          reason: "night settlement scored source write metadata is invalid",
        },
      });
      expect(record).not.toHaveProperty("tuningLifecycle");
      expect(record).not.toHaveProperty("nightReview");
    } else {
      expect(record).toMatchObject({
        tuningLifecycle: { ok: false, status: "failed", result: null },
      });
    }
    expect(fs.readFileSync(filename)).toEqual(bytes);
    expect(fs.existsSync(financeTuningProposalsPath(directory))).toBe(false);
  },
);

it.each(["matching", "legacy", "partial", "bad_hash", "count_conflict", "foreign_path"])(
  "preserves original sample read custody without changing tuning admission: %s",
  async (variant) => {
    const filename = path.join(directory, "research-samples.jsonl");
    const bytes = Buffer.from('{"instrument":"SPY","direction":"none"}\n');
    fs.writeFileSync(filename, bytes);
    const pin = {
      path:
        variant === "foreign_path"
          ? path.join(directory, "other-book", "research-samples.jsonl")
          : filename,
      status: "available",
      ...(variant === "legacy"
        ? {}
        : {
            sha256:
              variant === "bad_hash"
                ? "invalid-hash"
                : createHash("sha256").update(bytes).digest("hex"),
            ...(variant === "partial" ? {} : { bytes: bytes.length }),
            parsedCount: variant === "count_conflict" ? 2 : 1,
          }),
    };
    mocks.runCycle.mockResolvedValueOnce({
      ...success,
      stdout: JSON.stringify({
        ok: true,
        sampleSource: pin,
        sampleCount: 1,
        scoredFiled: { appended: 0, skipped: 0 },
        pending: [],
        declined: [],
        issues: [],
      }),
    });
    await runFinanceScheduler(["--once", "night", "--dir", directory]);
    const record = readFinanceSchedulerState(directory).lastRun;
    if (variant === "matching") {
      expect(record).toMatchObject({
        nightSampleSourceRead: pin,
        tuningLifecycle: { ok: true, status: "no_new_scored_outcomes", result: null },
      });
    } else if (variant === "legacy") {
      expect(record).not.toHaveProperty("nightSampleSourceRead");
      expect(record).toMatchObject({
        tuningLifecycle: { ok: true, status: "no_new_scored_outcomes", result: null },
      });
    } else {
      expect(record).toMatchObject({
        ok: false,
        nightSettlementFailure: {
          status: "invalid",
          reason: "night settlement sample source read metadata is invalid",
        },
      });
      expect(record).not.toHaveProperty("nightSampleSourceRead");
      expect(record).not.toHaveProperty("tuningLifecycle");
      expect(record).not.toHaveProperty("nightReview");
    }
    expect(fs.readFileSync(filename)).toEqual(bytes);
    expect(fs.existsSync(financeTuningProposalsPath(directory))).toBe(false);
  },
);

it.each([false, true])(
  "keeps the due account read between slow monitor handoffs, failed=%s",
  async (failed) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.parse("2026-09-22T17:00:00Z");
    vi.setSystemTime(start);
    await activateIntradayRule();
    const order: string[] = [];
    mocks.syncAlpacaHistory.mockImplementation(async () => {
      order.push("account");
      if (failed) {
        throw new Error("fetch failed");
      }
      return { accountId: "paper-account", accountReconciliation: { status: "blocked" } };
    });
    mocks.runIntradayMonitorTick.mockImplementation(async ({ instrument }) => {
      order.push(instrument);
      vi.setSystemTime(Date.now() + 241_000);
      return { status: "no_signal" };
    });
    mocks.delay.mockImplementationOnce(async () => emitSchedulerSignal("SIGTERM"));
    await expect(
      runFinanceScheduler([
        "--loop",
        "--dir",
        directory,
        "--intraday-monitor",
        "--intraday-instruments",
        "SPY,QQQ",
        "--sync-alpaca-history",
        "--venue",
        "alpaca",
        "--no-source-heartbeat",
      ]),
    ).resolves.toBe(143);
    expect(order).toEqual(["account", "SPY", "account", "QQQ"]);
    expect(mocks.executeIntradayDecision).not.toHaveBeenCalled();
    expect(mocks.historicalMaintenance).not.toHaveBeenCalled();
  },
);

it("recovers a stale universe through the original free selector after failed night settlement", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-22T14:30:00.000Z"));
  const old = { generatedAt: "2026-09-21T14:00:00.000Z", selected: ["OLD"] };
  seedSelectedUniverse(old);
  const fresh = { generatedAt: new Date().toISOString(), selected: ["NEW"] };
  mocks.readUniverse.mockImplementation(() => {
    throw new Error("stale session");
  });
  mocks.runCycle.mockImplementationOnce(async ({ argv }) => {
    expect(argv.join(" ")).toContain("lcx-finance-universe-select.ts");
    expect(argv).not.toContain("--place");
    writeUniverseSnapshot(fresh);
    mocks.readUniverse.mockReturnValue(fresh);
    return { ...success, stdout: JSON.stringify({ snapshotPersisted: true, ...fresh }) };
  });
  const context = {
    root: { directory, source: "explicit" as const },
    options: parseFinanceSchedulerArgs(["--loop", "--intraday-monitor", "--dir", directory]),
    signal: new AbortController().signal,
  };
  fs.mkdirSync(path.join(directory, FINANCE_SCHEDULER_LOCK));
  const receipt = await recoverFinanceUniverseIfNeeded(context);
  expect(receipt).toMatchObject({ status: "selected", selectedCount: 1 });
  expect(mocks.runCycle).toHaveBeenCalledOnce();
  expect(mocks.executeIntradayDecision).not.toHaveBeenCalled();
  await recoverFinanceUniverseIfNeeded(context);
  expect(mocks.runCycle).toHaveBeenCalledOnce();
});

it.each(["failed", "started"])(
  "does not repeat universe recovery for a %s attempt in this session",
  async (status) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-22T14:30:00.000Z"));
    mocks.readUniverse.mockImplementation(() => {
      throw new Error("unavailable");
    });
    appendStartedUniverseReceipt("blocked-selection", "2026-09-22T14:00:00.000Z");
    const filename = path.join(directory, "finance-universe-selection-runs.jsonl");
    fs.writeFileSync(
      filename,
      fs.readFileSync(filename, "utf8").replace('"status":"started"', `"status":"${status}"`),
    );
    await recoverFinanceUniverseIfNeeded({
      root: { directory, source: "explicit" },
      options: parseFinanceSchedulerArgs(["--loop", "--intraday-monitor", "--dir", directory]),
      signal: new AbortController().signal,
    });
    expect(mocks.runCycle).not.toHaveBeenCalled();
  },
);

it("refreshes the free universe after night history failure without declaring settlement success", async () => {
  mocks.runCycle.mockResolvedValueOnce({
    ...success,
    ok: false,
    status: "failed",
    exitCode: 1,
    stdout: JSON.stringify({ ok: false, error: "Alpaca history sync failed; cycle not started" }),
  });
  await expect(runFinanceScheduler(["--once", "night", "--dir", directory])).resolves.toBe(1);
  const calls = mocks.runCycle.mock.calls.map(([call]) => call.argv.join(" "));
  expect(calls).toHaveLength(2);
  expect(calls[1]).toContain("lcx-finance-universe-select.ts");
  const run = JSON.parse(
    fs.readFileSync(path.join(directory, "daily-cycle-runs.jsonl"), "utf8").trim(),
  );
  expect(run).toMatchObject({
    ok: false,
    status: "failed",
    universeSelection: { status: "failed" },
  });
  expect(readFinanceSchedulerState(directory).lastSucceeded.night).toBeUndefined();
});

it("loads the recovered universe on the next original resident tick without replaying a failed cycle", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-22T14:30:00.000Z"));
  await activateIntradayRule();
  writeFinanceSchedulerState(directory, {
    lastFired: { day: "2026-09-22", night: "2026-09-21" },
    lastSucceeded: {},
    lastStatus: { day: "failed", night: "failed" },
  });
  const fresh = { generatedAt: new Date().toISOString(), selected: ["AAA", "BBB"] };
  mocks.readUniverse.mockImplementation(() => {
    throw new Error("stale session");
  });
  mocks.runCycle.mockImplementationOnce(async () => {
    writeUniverseSnapshot(fresh);
    mocks.readUniverse.mockReturnValue(fresh);
    return { ...success, stdout: JSON.stringify({ snapshotPersisted: true, ...fresh }) };
  });
  mocks.runIntradayMonitorTick.mockResolvedValue({ status: "no_signal" });
  mocks.delay
    .mockImplementationOnce(async () => {})
    .mockImplementationOnce(async () => emitSchedulerSignal("SIGTERM"));
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
    "AAA",
    "BBB",
  ]);
  expect(mocks.executeIntradayDecision).not.toHaveBeenCalled();
  expect(readFinanceSchedulerState(directory).lastSucceeded.night).toBeUndefined();
});

it("does not start universe recovery after cancellation", async () => {
  const controller = new AbortController();
  controller.abort();
  await recoverFinanceUniverseIfNeeded({
    root: { directory, source: "explicit" },
    options: parseFinanceSchedulerArgs(["--loop", "--intraday-monitor", "--dir", directory]),
    signal: controller.signal,
  });
  expect(mocks.runCycle).not.toHaveBeenCalled();
});

it("rejects a late selector result after cancellation and does not bind its snapshot", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-22T14:30:00.000Z"));
  fs.mkdirSync(path.join(directory, FINANCE_SCHEDULER_LOCK));
  const controller = new AbortController();
  const fresh = { generatedAt: new Date().toISOString(), selected: ["LATE"] };
  mocks.readUniverse.mockImplementation(() => {
    throw new Error("missing source");
  });
  mocks.runCycle.mockImplementationOnce(async () => {
    writeUniverseSnapshot(fresh);
    mocks.readUniverse.mockReturnValue(fresh);
    controller.abort();
    return { ...success, stdout: JSON.stringify({ snapshotPersisted: true, ...fresh }) };
  });
  const receipt = await recoverFinanceUniverseIfNeeded({
    root: { directory, source: "explicit" },
    options: parseFinanceSchedulerArgs(["--loop", "--intraday-monitor", "--dir", directory]),
    signal: controller.signal,
  });
  expect(receipt).toMatchObject({
    status: "failed",
    error: "selector cancelled before snapshot acceptance",
  });
  expect(fs.existsSync(path.join(directory, FINANCE_UNIVERSE_SELECTION_SNAPSHOT_FILENAME))).toBe(
    false,
  );
  expect(mocks.executeIntradayDecision).not.toHaveBeenCalled();
});

it("loads a newly identified method's native parameters into the original resident monitor", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-21T14:30:00.000Z"));
  await activateIntradayRule(
    { frozenRule: { openingRangeBars: 8, rewardRisk: 3 } },
    "research_native_variant",
  );
  const snapshot = { generatedAt: "2026-09-21T14:00:00.000Z", selected: ["AAA"] };
  seedSelectedUniverse(snapshot);
  mocks.readUniverse.mockReturnValue(snapshot);
  mocks.runIntradayMonitorTick.mockResolvedValue({ status: "no_signal" });
  mocks.delay.mockImplementationOnce(async () => {
    emitSchedulerSignal("SIGTERM");
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
  expect(mocks.runIntradayMonitorTick).toHaveBeenCalledWith(
    expect.objectContaining({
      openingRangeBars: 8,
      rewardRisk: 3,
      strategyContract: expect.objectContaining({ ruleId: "research_native_variant" }),
    }),
  );
  await expect(
    resolveActiveIntradayRule(directory, {
      openingRangeBars: 6,
      rewardRisk: 2,
      intervalSeconds: 300,
      feed: "sip",
    }),
  ).rejects.toThrow("incompatible");
  expect(mocks.executeIntradayDecision).not.toHaveBeenCalled();
});

it.each([3, 100])(
  "dispatches a due cycle between slow monitor operations and resumes deferred discovery (%s candidates)",
  async (candidateCount) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-22T19:29:00.000Z"));
    await activateIntradayRule();
    const snapshot = {
      generatedAt: "2026-09-22T19:00:00.000Z",
      selected: [
        "SPY",
        ...Array.from({ length: candidateCount - 1 }, (_, index) => `SYMBOL${index}`),
      ],
    };
    seedSelectedUniverse(snapshot);
    mocks.readUniverse.mockImplementation(() =>
      JSON.parse(
        fs.readFileSync(path.join(directory, FINANCE_UNIVERSE_SELECTION_SNAPSHOT_FILENAME), "utf8"),
      ),
    );
    const events: string[] = [];
    mocks.runIntradayMonitorTick.mockImplementation(async ({ instrument }) => {
      events.push(`monitor:${instrument}`);
      if (events.length === 1) {
        vi.setSystemTime(new Date("2026-09-22T19:30:01.000Z"));
      }
      return { status: "no_signal" };
    });
    mocks.runCycle.mockImplementation(async () => {
      events.push("cycle");
      return success;
    });
    mocks.delay
      .mockImplementationOnce(async () => {})
      .mockImplementationOnce(async () => {
        emitSchedulerSignal("SIGTERM");
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
    expect(events.slice(0, 2)).toEqual(["monitor:SPY", "cycle"]);
    expect(events.slice(2, 4)).toEqual(["monitor:SYMBOL0", "monitor:SYMBOL1"]);
    expect(mocks.runCycle).toHaveBeenCalledOnce();
    expect(mocks.executeIntradayDecision).not.toHaveBeenCalled();
  },
);

it("recovers terminal universe failures before the completed session changes without a retry storm", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  // Friday's close remains the latest completed session at Monday's open.
  vi.setSystemTime(new Date("2026-09-21T13:30:00.000Z"));
  mocks.readUniverse.mockImplementation(() => {
    throw new Error("snapshot unavailable");
  });
  fs.mkdirSync(path.join(directory, FINANCE_SCHEDULER_LOCK));
  const filename = path.join(directory, "finance-universe-selection-runs.jsonl");
  fs.appendFileSync(
    filename,
    JSON.stringify({
      schemaVersion: "lcx_finance_universe_selection_attempt_v1",
      runId: "friday-outage",
      attemptedAt: "2026-09-18T21:00:00.000Z",
      completedAt: "2026-09-18T21:01:00.000Z",
      status: "failed",
      processStatus: "failed",
      exitCode: 1,
    }) + "\n",
  );
  const context = {
    root: { directory, source: "explicit" as const },
    options: parseFinanceSchedulerArgs(["--loop", "--intraday-monitor", "--dir", directory]),
    signal: new AbortController().signal,
  };
  mocks.runCycle.mockResolvedValueOnce({
    ...success,
    ok: false,
    status: "failed",
    exitCode: 1,
    stdout: "",
  });
  expect(await recoverFinanceUniverseIfNeeded(context)).toMatchObject({ status: "failed" });
  expect(mocks.runCycle).toHaveBeenCalledOnce();
  // Recreating the in-memory context must retain the original durable cooldown.
  vi.setSystemTime(new Date("2026-09-21T14:29:59.000Z"));
  expect(await recoverFinanceUniverseIfNeeded({ ...context })).toBeUndefined();
  expect(mocks.runCycle).toHaveBeenCalledOnce();
  vi.setSystemTime(new Date("2026-09-21T14:30:00.000Z"));
  mocks.runCycle.mockImplementationOnce(async () => {
    const snapshot = { generatedAt: new Date().toISOString(), selected: ["SPY"] };
    writeUniverseSnapshot(snapshot);
    mocks.readUniverse.mockReturnValue(snapshot);
    return { ...success, stdout: JSON.stringify({ snapshotPersisted: true, ...snapshot }) };
  });
  expect(await recoverFinanceUniverseIfNeeded(context)).toMatchObject({
    status: "selected",
    selectedCount: 1,
  });
  expect(mocks.runCycle).toHaveBeenCalledTimes(2);
  expect(await recoverFinanceUniverseIfNeeded({ ...context })).toBeUndefined();
  expect(mocks.runCycle).toHaveBeenCalledTimes(2);
  expect(mocks.executeIntradayDecision).not.toHaveBeenCalled();
});
