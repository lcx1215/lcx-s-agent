import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { buildFinanceAutomaticLifecycleFeedback } from "./finance-automatic-lifecycle-feedback.js";
import {
  appendFinanceIntradayDecision,
  appendFinanceIntradayOutcome,
} from "./finance-intraday-control-ledger.js";
import { FINANCE_SCHEDULER_LOCK, FINANCE_SCHEDULER_PID } from "./finance-scheduler-lock.js";
import { writeFinanceSchedulerState } from "./finance-scheduler-state.js";
import { financeResearchScoredPath } from "./finance-state-dir.js";
import { runFinanceTuningLifecycle } from "./finance-tuning-lifecycle.js";

let directory: string;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "finance-lifecycle-feedback-"));
});

afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

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
