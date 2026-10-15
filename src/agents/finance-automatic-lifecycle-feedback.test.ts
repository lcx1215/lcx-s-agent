import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../memory/sqlite.js";
import { buildFinanceAutomaticLifecycleFeedback } from "./finance-automatic-lifecycle-feedback.js";
import {
  appendFinanceIntradayDecision,
  appendFinanceIntradayOutcome,
} from "./finance-intraday-control-ledger.js";
import { appendFinanceBrokerHistory } from "./finance-position-ledger.js";
import * as positionLedger from "./finance-position-ledger.js";
import { FINANCE_SCHEDULER_LOCK, FINANCE_SCHEDULER_PID } from "./finance-scheduler-lock.js";
import { writeFinanceSchedulerState } from "./finance-scheduler-state.js";
import {
  FINANCE_DAILY_CYCLE_RUNS_FILENAME,
  financePositionLedgerPath,
  financeResearchScoredPath,
} from "./finance-state-dir.js";
import { runFinanceTuningLifecycle } from "./finance-tuning-lifecycle.js";

let directory: string;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "finance-lifecycle-feedback-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(directory, { recursive: true, force: true });
});

it("shares each verified read once per observation and sees new source on the next call", async () => {
  const observedAt = "2026-10-06T10:00:00Z";
  const appendSnapshot = (at: string, positions: readonly Record<string, unknown>[]) =>
    appendFinanceBrokerHistory(directory, {
      kind: "broker_history",
      accountId: "synthetic",
      venue: "alpaca:paper",
      query: `reconciliation:${at}`,
      cursor: "",
      payload: [{ observedAt: at, positions, openOrders: [] }],
    });
  await appendSnapshot(observedAt, []);
  const positions = vi.spyOn(positionLedger, "readFinancePositionLedger");
  const reconciliations = vi.spyOn(positionLedger, "readFinanceLatestBrokerReconciliations");
  const first = await buildFinanceAutomaticLifecycleFeedback({ directory, observedAt });
  expect(positions).toHaveBeenCalledExactlyOnceWith(directory, { asOf: observedAt });
  expect(reconciliations).toHaveBeenCalledExactlyOnceWith(directory);
  expect(first).toMatchObject({
    positionManagement: { accounts: [{ observedAt, positionCount: 0 }] },
  });
  // Latest recon semantics intentionally retain a future snapshot and classify it,
  // instead of silently switching this observational reader to an asOf query.
  const nextAt = "2026-10-06T10:01:00Z";
  await appendSnapshot(nextAt, [{ symbol: "SPY", qty: "1" }]);
  const second = await buildFinanceAutomaticLifecycleFeedback({ directory, observedAt });
  expect(positions).toHaveBeenCalledTimes(2);
  expect(reconciliations).toHaveBeenCalledTimes(2);
  expect(second).toMatchObject({
    positionManagement: {
      accounts: [{ observedAt: nextAt, positionCount: 1, freshness: "stale" }],
    },
    economicFeedback: { accounts: [{ status: "snapshot_outside_cutoff" }] },
  });
});

it("shares failed chain reads without unhandled rejections or hiding consumer gaps", async () => {
  fs.writeFileSync(financePositionLedgerPath(directory), "not a sqlite ledger");
  const positions = vi.spyOn(positionLedger, "readFinancePositionLedger");
  const reconciliations = vi.spyOn(positionLedger, "readFinanceLatestBrokerReconciliations");
  const result = await buildFinanceAutomaticLifecycleFeedback({
    directory,
    observedAt: "2026-10-06T10:00:00Z",
  });
  expect(positions).toHaveBeenCalledTimes(1);
  expect(reconciliations).toHaveBeenCalledTimes(1);
  expect(result).toMatchObject({
    status: "present",
    currentReadiness: { dataStores: { positions: { present: false } } },
    positionManagement: { status: "unavailable", needsInspection: false },
    economicFeedback: { status: "unavailable" },
  });
});

it("retains native broker hash validation when consumers share a tampered chain", async () => {
  const observedAt = "2026-10-06T10:00:00Z";
  await appendFinanceBrokerHistory(directory, {
    kind: "broker_history",
    accountId: "synthetic",
    venue: "alpaca:paper",
    query: `reconciliation:${observedAt}`,
    cursor: "",
    payload: [{ observedAt, positions: [], openOrders: [] }],
  });
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(financePositionLedgerPath(directory));
  try {
    db.exec("DROP TRIGGER finance_broker_history_no_update");
    db.prepare("UPDATE finance_broker_history SET ref=? WHERE sequence=1").run("0".repeat(64));
  } finally {
    db.close();
  }
  const recon = vi.spyOn(positionLedger, "readFinanceLatestBrokerReconciliations");
  expect(await buildFinanceAutomaticLifecycleFeedback({ directory, observedAt })).toMatchObject({
    positionManagement: { status: "unavailable", reason: "broker history chain mismatch" },
    economicFeedback: { status: "unavailable", reason: "broker history chain mismatch" },
  });
  expect(recon).toHaveBeenCalledTimes(1);
});

it("preserves file and resident until-revoked authorization metadata in lifecycle feedback", async () => {
  const observedAt = "2026-09-23T12:00:00.000Z";
  fs.writeFileSync(path.join(directory, FINANCE_SCHEDULER_PID), String(process.pid));
  const lock = path.join(directory, FINANCE_SCHEDULER_LOCK);
  fs.mkdirSync(lock);
  fs.writeFileSync(
    path.join(lock, "progress.json"),
    JSON.stringify({
      pid: process.pid,
      observedAt,
      phase: "idle",
      timeoutMs: 900000,
      placementEnabled: true,
      venue: "alpaca",
      executionPolicyAuthorizationMode: "until_revoked",
      executionPolicyExpiresAt: null,
      intradayControllerPolicyAuthorizationMode: "until_revoked",
      intradayControllerPolicyExpiresAt: null,
      intraday: { enabled: true },
    }),
  );
  const feedback = await buildFinanceAutomaticLifecycleFeedback({ directory, observedAt });
  if (feedback.status !== "present") {
    throw new Error(`expected lifecycle feedback to be present; got ${feedback.status}`);
  }
  expect(feedback.scheduler.runtime).toMatchObject({
    status: "responsive",
    executionPolicyStatus: "until_revoked",
    executionPolicyAuthorizationMode: "until_revoked",
    intradayControllerPolicyStatus: "until_revoked",
    intradayControllerPolicyAuthorizationMode: "until_revoked",
    intradayControllerPolicyExpiresAt: null,
  });
  expect(feedback.nextTask).not.toBe("inspect_finance_scheduler_runtime");
});
it("reads current reconciliation failures into the next lifecycle observation and sees recovery", async () => {
  const observedAt = "2026-10-10T04:45:00.000Z";
  fs.writeFileSync(path.join(directory, FINANCE_SCHEDULER_PID), String(process.pid));
  const lock = path.join(directory, FINANCE_SCHEDULER_LOCK);
  fs.mkdirSync(lock);
  fs.writeFileSync(
    path.join(lock, "progress.json"),
    JSON.stringify({
      pid: process.pid,
      observedAt,
      phase: "idle",
      timeoutMs: 900000,
      placementEnabled: true,
      venue: "alpaca",
      executionPolicyAuthorizationMode: "until_revoked",
      executionPolicyExpiresAt: null,
      intradayControllerPolicyAuthorizationMode: "until_revoked",
      intradayControllerPolicyExpiresAt: null,
      intraday: { enabled: true },
    }),
  );
  const filename = path.join(directory, "alpaca-order-stream-latest.json");
  const observation = {
    schemaVersion: "lcx_alpaca_order_stream_observation_v1",
    pid: process.pid,
    observedAt,
    venue: "alpaca:paper",
    reconciliation: {
      lastAttemptAt: observedAt,
      lastReadbackAt: null,
      lastSucceededAt: null,
      lastReadinessStatus: "unavailable",
      lastErrorCode: "execution_recovery_incomplete",
    },
    rawPrivateDetails: "never expose this field",
  };
  fs.writeFileSync(filename, JSON.stringify(observation));
  const failed = await buildFinanceAutomaticLifecycleFeedback({ directory, observedAt });
  expect(failed).toMatchObject({
    scheduler: {
      runtime: {
        reconciliation: {
          status: "present",
          observedAt,
          lastErrorCode: "execution_recovery_incomplete",
          needsInspection: true,
        },
      },
    },
    nextTask: "inspect_finance_scheduler_runtime",
  });
  expect(JSON.stringify(failed)).not.toContain("never expose this field");
  fs.writeFileSync(
    filename,
    JSON.stringify({
      ...observation,
      reconciliation: {
        ...observation.reconciliation,
        lastReadbackAt: observedAt,
        lastSucceededAt: observedAt,
        lastReadinessStatus: "ready",
        lastErrorCode: null,
      },
    }),
  );
  const recovered = await buildFinanceAutomaticLifecycleFeedback({ directory, observedAt });
  expect(recovered).toMatchObject({
    scheduler: { runtime: { reconciliation: { lastErrorCode: null, needsInspection: false } } },
  });
  expect(recovered).not.toMatchObject({ nextTask: "inspect_finance_scheduler_runtime" });
});

it.each([
  ["stale", "stale", "reconciliation_observation_not_current"],
  ["future", "stale", "reconciliation_observation_not_current"],
  ["wrong_pid", "unavailable", "reconciliation_owner_mismatch"],
  ["absent_owner", "unavailable", "reconciliation_owner_mismatch"],
  ["oversized", "unavailable", "reconciliation_observation_too_large"],
  ["malformed", "unavailable", "reconciliation_observation_unreadable"],
  ["unknown_error", "unavailable", "reconciliation_observation_unreadable"],
  ["wrong_venue", "unavailable", "reconciliation_observation_unreadable"],
  ["old_readback", "present", undefined],
  ["future_readback", "present", undefined],
] as const)(
  "does not treat %s reconciliation metadata as recovered",
  async (scenario, status, reason) => {
    const observedAt = "2026-10-10T04:45:00.000Z";
    if (scenario !== "absent_owner") {
      fs.writeFileSync(path.join(directory, FINANCE_SCHEDULER_PID), String(process.pid));
    }
    const lock = path.join(directory, FINANCE_SCHEDULER_LOCK);
    fs.mkdirSync(lock);
    fs.writeFileSync(
      path.join(lock, "progress.json"),
      JSON.stringify({
        pid: process.pid,
        observedAt,
        phase: "idle",
        timeoutMs: 900000,
        placementEnabled: true,
        venue: "alpaca",
        executionPolicyAuthorizationMode: "until_revoked",
        executionPolicyExpiresAt: null,
        intradayControllerPolicyAuthorizationMode: "until_revoked",
        intradayControllerPolicyExpiresAt: null,
        intraday: { enabled: true },
      }),
    );
    const observation = {
      schemaVersion: "lcx_alpaca_order_stream_observation_v1",
      pid: scenario === "wrong_pid" ? process.pid + 1 : process.pid,
      observedAt:
        scenario === "stale"
          ? "2026-10-10T04:39:59.000Z"
          : scenario === "future"
            ? "2026-10-10T04:45:01.000Z"
            : observedAt,
      venue: scenario === "wrong_venue" ? "alpaca:live" : "alpaca:paper",
      reconciliation: {
        lastAttemptAt: observedAt,
        lastReadbackAt:
          scenario === "old_readback"
            ? "2026-10-10T04:39:59.000Z"
            : scenario === "future_readback"
              ? "2026-10-10T04:45:01.000Z"
              : observedAt,
        lastSucceededAt: observedAt,
        lastReadinessStatus: "ready",
        lastErrorCode: scenario === "unknown_error" ? "raw secret provider detail" : null,
      },
      ...(scenario === "oversized" ? { irrelevant: "x".repeat(16384) } : {}),
    };
    fs.writeFileSync(
      path.join(directory, "alpaca-order-stream-latest.json"),
      scenario === "malformed" ? "{incomplete" : JSON.stringify(observation),
    );
    const feedback = await buildFinanceAutomaticLifecycleFeedback({ directory, observedAt });
    expect(feedback).toMatchObject({
      scheduler: {
        runtime: {
          reconciliation: { status, needsInspection: true, ...(reason ? { reason } : {}) },
        },
      },
      nextTask: "inspect_finance_scheduler_runtime",
    });
    expect(JSON.stringify(feedback)).not.toContain("raw secret provider detail");
  },
);

it("requests runtime inspection when file authorization is standing but resident intraday policy expired", async () => {
  const observedAt = "2026-09-23T12:00:00.000Z";
  fs.writeFileSync(path.join(directory, FINANCE_SCHEDULER_PID), String(process.pid));
  const lock = path.join(directory, FINANCE_SCHEDULER_LOCK);
  fs.mkdirSync(lock);
  fs.writeFileSync(
    path.join(lock, "progress.json"),
    JSON.stringify({
      pid: process.pid,
      observedAt,
      phase: "idle",
      timeoutMs: 900000,
      placementEnabled: true,
      venue: "alpaca",
      executionPolicyAuthorizationMode: "until_revoked",
      executionPolicyExpiresAt: null,
      intradayControllerPolicyAuthorizationMode: "until_expiry",
      intradayControllerPolicyExpiresAt: "2026-09-23T11:59:00.000Z",
      intraday: { enabled: true },
    }),
  );
  const feedback = await buildFinanceAutomaticLifecycleFeedback({ directory, observedAt });
  if (feedback.status !== "present") {
    throw new Error(`expected lifecycle feedback to be present; got ${feedback.status}`);
  }
  expect(feedback.scheduler.runtime).toMatchObject({
    executionPolicyStatus: "until_revoked",
    intradayControllerPolicyStatus: "expired",
  });
  expect(feedback.nextTask).toBe("inspect_finance_scheduler_runtime");
});
it("retains validated account work separately from the idle scheduler phase", async () => {
  const observedAt = "2026-10-09T16:00:00.000Z";
  fs.writeFileSync(path.join(directory, FINANCE_SCHEDULER_PID), String(process.pid));
  const lock = path.join(directory, FINANCE_SCHEDULER_LOCK);
  fs.mkdirSync(lock);
  const progress = {
    pid: process.pid,
    observedAt,
    phase: "idle",
    timeoutMs: 900000,
    placementEnabled: true,
    venue: "alpaca",
    accountWork: {
      schemaVersion: "lcx_finance_account_work_v1",
      observedAt,
      activeWork: "trading",
      queuedWork: 1,
      reconciliationPending: true,
    },
  };
  for (const [value, status] of [
    [progress.accountWork, "busy"],
    [undefined, "unavailable"],
    [{ ...progress.accountWork, queuedWork: -1 }, "invalid"],
    [{ ...progress.accountWork, observedAt: "2026-10-09T15:00:00.000Z" }, "stale"],
  ] as const) {
    fs.writeFileSync(
      path.join(lock, "progress.json"),
      JSON.stringify({ ...progress, accountWork: value }),
    );
    expect(await buildFinanceAutomaticLifecycleFeedback({ directory, observedAt })).toMatchObject({
      scheduler: { runtime: { phase: "idle", accountWork: { status } } },
    });
  }
});

it("projects directional calibration separately from blocked paper execution promotion", async () => {
  fs.writeFileSync(
    financeResearchScoredPath(directory),
    Array.from({ length: 5 }, () => JSON.stringify({ conviction: 0.75, outcome: 1 })).join("\n") +
      "\n",
  );
  runFinanceTuningLifecycle({
    directory,
    generatedAt: "2026-09-23T00:00:00.000Z",
  });

  await expect(
    buildFinanceAutomaticLifecycleFeedback({
      directory,
      observedAt: "2026-09-23T00:01:00.000Z",
    }),
  ).resolves.toMatchObject({
    status: "present",
    scoredOutcomeCount: 5,
    tuning: {
      proposalCount: 1,
      promotionCount: 0,
      latestPromotion: null,
    },
    paperExecutionPromotion: {
      status: "blocked",
      reason: "net_trade_economics_promotion_contract_unavailable",
      contributingReasons: ["directional_forecast_outcomes_are_not_net_trade_pnl"],
      executionThresholdPromotionEligible: false,
    },
    nextTask: "review_directional_calibration_proposal",
    boundary: expect.arrayContaining([
      "directional_calibration_is_not_execution_promotion",
      "no_execution_authority",
    ]),
  });
});

it("recovers both cycle modes from SQLite even when a large review hides file-tail history", async () => {
  writeFinanceSchedulerState(directory, {
    lastFired: { day: "2026-09-21" },
    lastStatus: { day: "failed" },
    lastSucceeded: {},
    lastRun: {
      runId: "day",
      mode: "day",
      status: "failed",
      firedAt: "2026-09-21T19:30:00Z",
      stdout: '{"ok":false}',
    },
  });
  writeFinanceSchedulerState(directory, {
    lastFired: { day: "2026-09-21", night: "2026-09-21" },
    lastStatus: { day: "failed", night: "succeeded" },
    lastSucceeded: { night: "2026-09-21" },
    lastRun: {
      runId: "night",
      mode: "night",
      status: "succeeded",
      firedAt: "2026-09-21T21:30:00Z",
      stdout: JSON.stringify({ ok: true, review: "x".repeat(300000) }),
    },
  });
  fs.unlinkSync(path.join(directory, "daily-cycle-scheduler.json"));
  const result = await buildFinanceAutomaticLifecycleFeedback({
    directory,
    observedAt: "2026-09-22T00:00:00Z",
  });
  expect(result).toMatchObject({ status: "present", nextTask: "inspect_failed_finance_cycle" });
  expect(JSON.stringify(result)).toContain('"day"');
  expect(JSON.stringify(result)).toContain('"night"');
});

it("exposes skipped execution and its research-stage cause to the harness", async () => {
  writeFinanceSchedulerState(directory, {
    lastFired: { day: "2026-09-21" },
    lastStatus: { day: "failed" },
    lastSucceeded: {},
    lastRun: {
      runId: "research-only",
      mode: "day",
      status: "failed",
      stdout: JSON.stringify({ ok: true }),
      execution: {
        outcome: "not_run",
        blockReason: "research_plan_not_accepted",
        reportedPlacements: null,
      },
    },
  });
  const result = await buildFinanceAutomaticLifecycleFeedback({ directory });
  expect(result).toMatchObject({
    status: "present",
    nextTask: "inspect_failed_finance_cycle",
    scheduler: {
      latestCycleByMode: {
        day: {
          status: "failed",
          execution: { outcome: "not_run", blockReason: "research_plan_not_accepted" },
        },
      },
    },
  });
});

it("preserves candidate-bound model veto reasons without calling them execution gate failures", async () => {
  writeFinanceSchedulerState(directory, {
    lastFired: { day: "2026-09-21" },
    lastSucceeded: {},
    lastStatus: { day: "succeeded" },
    lastRun: {
      runId: "veto-reason",
      mode: "day",
      status: "succeeded",
      stdout: JSON.stringify({
        ok: true,
        tradeDecisionReview: {
          decisions: [
            {
              candidateId: "candidate-A",
              decision: "veto",
              rationale: "The supplied thesis invalidation is already met.",
            },
          ],
        },
      }),
    },
  });
  const result = await buildFinanceAutomaticLifecycleFeedback({ directory });
  expect(result).toMatchObject({
    scheduler: {
      latestCycleByMode: {
        day: {
          modelVetoes: [
            {
              origin: "model_review",
              candidateId: "candidate-A",
              rationale: "The supplied thesis invalidation is already met.",
            },
          ],
        },
      },
    },
  });
});

it("surfaces unexecuted intraday signals before asking for more research readiness", async () => {
  await appendFinanceIntradayDecision(directory, {
    signalId: "idle-candidate",
    instrument: "SPY",
    sessionDate: "2026-09-18",
    action: "buy",
    reason: "opening_range_breakout",
    referencePrice: 100,
    referencePriceAt: "2026-09-18T14:05:00.000Z",
    datasetHeadRef: "a".repeat(64),
    strategyRule: "opening_range_breakout_long_next_bar_v1",
  });
  await appendFinanceIntradayOutcome(directory, {
    signalId: "idle-candidate",
    status: "refused",
    reasons: ["model veto"],
    executionSafetyFailure: {
      stage: "facts",
      category: "cash_changed",
      operation: "read_account_safety_facts",
    },
  });
  expect(await buildFinanceAutomaticLifecycleFeedback({ directory })).toMatchObject({
    status: "present",
    nextTask: "inspect_unexecuted_finance_candidates",
    intradayExecution: {
      candidates: 1,
      refused: 1,
      placed: 0,
      topExecutionSafetyFailures: [{ stage: "facts", category: "cash_changed", count: 1 }],
    },
  });
});

it("keeps economic unavailability local and exposes an explicit non-return boundary", async () => {
  const feedback = await buildFinanceAutomaticLifecycleFeedback({
    directory,
    observedAt: "2026-10-03T00:00:00Z",
  });
  expect(feedback.status).toBe("present");
  expect(feedback).toMatchObject({
    economicFeedback: {
      status: "absent",
      asOf: "2026-10-03T00:00:00Z",
      executionAuthority: "none",
      boundary: expect.stringContaining("not account return"),
    },
  });
});

it("keeps two broker accounts, costs unknown and ownership diagnostics separate in economic feedback", async () => {
  const observedAt = "2026-10-03T00:00:00Z";
  for (const accountId of ["account-a", "account-b"]) {
    await appendFinanceBrokerHistory(directory, {
      kind: "broker_history",
      accountId,
      venue: "alpaca:paper",
      query: `reconciliation:${observedAt}`,
      cursor: "",
      payload: [
        { observedAt, status: "unresolved", feesInterpreted: false, positions: [], openOrders: [] },
      ],
    });
  }
  const feedback = await buildFinanceAutomaticLifecycleFeedback({ directory, observedAt });
  expect(feedback).toMatchObject({
    status: "present",
    economicFeedback: {
      accounts: expect.arrayContaining([
        expect.objectContaining({
          accountId: "account-b",
          venue: "alpaca:paper",
          snapshotRef: expect.any(String),
          observedAt,
          freshness: "fresh",
          basis: "broker_fill_fifo_usd_not_strategy_attribution",
          netMatchedPnl: null,
          issues: ["history_or_cost_reconciliation_unverified"],
          positionManagementMatched: true,
          strategyAttribution: expect.objectContaining({
            attributedFillCount: 0,
            unattributedFillCount: 0,
          }),
        }),
      ]),
    },
  });
  if (!("economicFeedback" in feedback)) {
    throw new Error("feedback unexpectedly unavailable");
  }
  const economic = feedback.economicFeedback;
  expect(
    economic.accounts !== undefined
      ? economic.accounts.map((account) => account.accountId).toSorted()
      : [],
  ).toEqual(["account-a", "account-b"]);
  expect(economic).toMatchObject({ omittedAccounts: 0 });
  expect(Buffer.byteLength(JSON.stringify(economic), "utf8")).toBeLessThanOrEqual(2000);
});

it("retains exact scheduler run identity in the Central lifecycle readback", async () => {
  const runId = "7e65f908-563a-491c-b542-4c14e59aabf3";
  writeFinanceSchedulerState(directory, {
    lastFired: { night: "2026-02-02" },
    lastStatus: { night: "succeeded" },
    lastSucceeded: { night: "2026-02-02" },
    lastRun: {
      runId,
      mode: "night",
      status: "succeeded",
      firedAt: "2026-02-02T23:00:00.000Z",
      stdout: JSON.stringify({ ok: true, sampleCount: 0 }),
      execution: { outcome: "settlement", venue: "paper" },
    },
  });
  const feedback = await buildFinanceAutomaticLifecycleFeedback({
    directory,
    observedAt: "2026-02-03T00:00:00.000Z",
  });
  expect(feedback).toMatchObject({
    scheduler: {
      latestCycleByMode: {
        night: { runId, status: "succeeded", execution: { outcome: "settlement" } },
      },
    },
  });
  expect(feedback).not.toHaveProperty("accountId");
});

it("omits missing or unsafe scheduler identities without truncating or inventing one", async () => {
  const values: unknown[] = [
    undefined,
    "",
    " native-id ",
    "native\nid",
    "a".repeat(129),
    123,
    { runId: "nested" },
  ];
  for (const [index, runId] of values.entries()) {
    const privateDirectory = path.join(directory, `invalid-${index}`);
    fs.mkdirSync(privateDirectory);
    fs.writeFileSync(
      path.join(privateDirectory, FINANCE_DAILY_CYCLE_RUNS_FILENAME),
      JSON.stringify({
        runId,
        mode: "night",
        status: "failed",
        firedAt: "2026-02-02T23:00:00.000Z",
        stdout: JSON.stringify({ ok: false }),
        execution: { outcome: "settlement", venue: "paper" },
      }) + "\n",
    );
    const feedback = await buildFinanceAutomaticLifecycleFeedback({
      directory: privateDirectory,
      observedAt: "2026-02-03T00:00:00.000Z",
    });
    expect(feedback).toMatchObject({
      scheduler: { latestCycleByMode: { night: { status: "failed" } } },
    });
    expect(feedback).not.toHaveProperty("scheduler.latestCycleByMode.night.runId");
  }
});

it("independently rereads the tuning ledger bytes with matching pins and visible partial or absent input", async () => {
  const filename = financeResearchScoredPath(directory);
  const bytes = Buffer.from('{"conviction":0.75,"outcome":1}\ninvalid-row\n');
  fs.writeFileSync(filename, bytes);
  const lifecycle = runFinanceTuningLifecycle({ directory, generatedAt: "2026-09-23T00:00:00Z" });
  const first = await buildFinanceAutomaticLifecycleFeedback({
    directory,
    observedAt: "2026-09-23T00:01:00Z",
  });
  expect(first).toMatchObject({
    scoredOutcomeCount: 1,
    tuning: { sourceRead: lifecycle.sourceRead },
  });
  expect(lifecycle.sourceRead).toMatchObject({
    sha256: createHash("sha256").update(bytes).digest("hex"),
    ignoredRowCount: 1,
  });
  fs.appendFileSync(filename, '{"conviction":0.8,"outcome":0}\n');
  const changed = runFinanceTuningLifecycle({ directory, generatedAt: "2026-09-23T00:02:00Z" });
  const next = await buildFinanceAutomaticLifecycleFeedback({
    directory,
    observedAt: "2026-09-23T00:03:00Z",
  });
  expect(changed.sourceRead.sha256).not.toBe(lifecycle.sourceRead.sha256);
  expect(next).toMatchObject({
    scoredOutcomeCount: 2,
    tuning: { sourceRead: changed.sourceRead },
    paperExecutionPromotion: { status: "blocked", executionThresholdPromotionEligible: false },
  });
  fs.rmSync(filename);
  const missing = await buildFinanceAutomaticLifecycleFeedback({
    directory,
    observedAt: "2026-09-23T00:04:00Z",
  });
  expect(missing).toMatchObject({
    scoredOutcomeCount: 0,
    tuning: {
      sourceRead: { status: "absent", path: filename, includedSampleCount: 0, ignoredRowCount: 0 },
    },
  });
  const proofDir = process.env.LCX_TUNING_SCORED_READ_PROOF_DIR;
  if (proofDir) {
    fs.mkdirSync(proofDir, { recursive: true });
    fs.writeFileSync(
      path.join(proofDir, "native-scored-readback.json"),
      JSON.stringify(
        {
          originalSourceBytesHex: bytes.toString("hex"),
          lifecycle,
          first,
          changed,
          next,
          missing,
          boundary: "original_independent_readers_private_ledger_no_account_or_source_truth",
        },
        null,
        2,
      ) + "\n",
    );
  }
});

it.each(["failure", "pending", "recovered", "unsafe_failure"])(
  "consumes original idle diagnostic $status in the lifecycle %s",
  async (status) => {
    const observedAt = "2026-10-15T00:00:00.000Z";
    fs.writeFileSync(path.join(directory, FINANCE_SCHEDULER_PID), String(process.pid));
    const lock = path.join(directory, FINANCE_SCHEDULER_LOCK);
    fs.mkdirSync(lock);
    fs.writeFileSync(
      path.join(lock, "progress.json"),
      JSON.stringify({
        pid: process.pid,
        observedAt,
        phase: "idle",
        timeoutMs: 900000,
        placementEnabled: true,
        venue: "alpaca",
        executionPolicyAuthorizationMode: "until_revoked",
        executionPolicyExpiresAt: null,
        intradayControllerPolicyAuthorizationMode: "until_revoked",
        intradayControllerPolicyExpiresAt: null,
        intraday: { enabled: true },
      }),
    );
    const lastFailure = {
      stage: "broker_reconciliation",
      code: status === "unsafe_failure" ? "SECRET_INVALID" : "ECONNRESET",
      elapsedMs: 100,
      request: { endpoint: "activities", phase: "body", code: "ECONNRESET", elapsedMs: 100 },
    };
    fs.writeFileSync(
      path.join(directory, "alpaca-order-stream-latest.json"),
      JSON.stringify({
        schemaVersion: "lcx_alpaca_order_stream_observation_v1",
        pid: process.pid,
        venue: "alpaca:paper",
        observedAt,
        reconciliation: {
          lastSource: "idle",
          lastAttemptAt: observedAt,
          lastReadbackAt: status === "recovered" ? observedAt : null,
          lastSucceededAt: status === "recovered" ? observedAt : null,
          lastReadinessStatus:
            status === "recovered" ? "ready" : status === "pending" ? "pending" : "unavailable",
          lastErrorCode:
            status === "recovered" || status === "pending" ? null : "account_read_failed",
          lastFailure: status === "recovered" || status === "pending" ? null : lastFailure,
        },
      }),
    );
    const feedback = await buildFinanceAutomaticLifecycleFeedback({ directory, observedAt });
    if (status === "unsafe_failure") {
      expect(feedback).toMatchObject({
        scheduler: {
          runtime: { reconciliation: { status: "unavailable", needsInspection: true } },
        },
      });
      expect(JSON.stringify(feedback)).not.toContain("SECRET_INVALID");
    } else {
      expect(feedback).toMatchObject({
        scheduler: {
          runtime: {
            reconciliation: {
              status: "present",
              lastSource: "idle",
              needsInspection: status !== "recovered",
            },
          },
        },
      });
      if (status === "failure") {
        expect(feedback).toMatchObject({
          scheduler: {
            runtime: { reconciliation: { lastErrorCode: "account_read_failed", lastFailure } },
          },
        });
      }
    }
  },
);
