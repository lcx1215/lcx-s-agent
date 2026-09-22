import { readFinancePaperPromotions } from "./finance-paper-promotion.js";
import { readFinanceSchedulerState } from "./finance-scheduler-state.js";
import { resolveFinanceStateDir } from "./finance-state-dir.js";
import { readFinanceStrategyRuleLedger } from "./finance-strategy-rule-ledger.js";
import {
  readFinanceScoredFloorSamples,
  readFinanceTuningProposals,
} from "./finance-tuning-lifecycle.js";

export const FINANCE_AUTOMATIC_LIFECYCLE_FEEDBACK_SCHEMA_VERSION =
  "lcx_finance_automatic_lifecycle_feedback_v1" as const;

function compactLastRun(value: Record<string, unknown> | undefined) {
  if (!value) {
    return null;
  }
  const tuning =
    value.tuningLifecycle !== null && typeof value.tuningLifecycle === "object"
      ? (value.tuningLifecycle as Record<string, unknown>)
      : null;
  return {
    runId: value.runId ?? null,
    mode: value.mode ?? null,
    firedAt: value.firedAt ?? null,
    status: value.status ?? null,
    ok: value.ok === true,
    execution: value.execution ?? null,
    tuning: tuning
      ? { ok: tuning.ok === true, status: tuning.status ?? null, result: tuning.result ?? null }
      : null,
    nightReview: value.nightReview ?? null,
  };
}

/** Small read-only projection injected into every Central Harness perception. */
export async function buildFinanceAutomaticLifecycleFeedback(
  params: {
    directory?: string;
    observedAt?: string;
  } = {},
) {
  const observedAt = params.observedAt ?? new Date().toISOString();
  const state = params.directory
    ? { directory: params.directory, source: "explicit" as const }
    : resolveFinanceStateDir();
  try {
    const [rules, proposals, promotions, samples] = await Promise.all([
      readFinanceStrategyRuleLedger(state.directory, { asOf: observedAt }),
      Promise.resolve(readFinanceTuningProposals(state.directory)),
      Promise.resolve(readFinancePaperPromotions(state.directory)),
      Promise.resolve(readFinanceScoredFloorSamples(state.directory)),
    ]);
    const scheduler = readFinanceSchedulerState(state.directory);
    const latestProposal = proposals.at(-1) ?? null;
    const latestPromotion = promotions.at(-1) ?? null;
    const nextTask =
      scheduler.lastRun?.ok === false
        ? "inspect_failed_finance_cycle"
        : latestProposal && latestProposal.proposalId !== latestPromotion?.proposalId
          ? "inspect_unpromoted_tuning_proposal"
          : latestPromotion === null
            ? "accumulate_scored_outcomes_for_calibration"
            : "monitor_promoted_paper_calibration";
    return Object.freeze({
      schemaVersion: FINANCE_AUTOMATIC_LIFECYCLE_FEEDBACK_SCHEMA_VERSION,
      status: "present",
      observedAt,
      directorySource: state.source,
      scheduler: {
        lastStatus: scheduler.lastStatus,
        lastSucceeded: scheduler.lastSucceeded,
        lastRun: compactLastRun(scheduler.lastRun),
      },
      scoredOutcomeCount: samples.length,
      tuning: {
        proposalCount: proposals.length,
        latestProposal,
        promotionCount: promotions.length,
        latestPromotion,
      },
      activeRules: rules.ledger.rules
        .filter((rule) => rule.state === "active")
        .map((rule) => ({ ruleId: rule.ruleId, form: rule.form, instruments: rule.instruments })),
      nextTask,
      boundary: ["read_only_feedback", "paper_promotion_only", "no_execution_authority"],
    });
  } catch (error) {
    return Object.freeze({
      schemaVersion: FINANCE_AUTOMATIC_LIFECYCLE_FEEDBACK_SCHEMA_VERSION,
      status: "unavailable",
      observedAt,
      directorySource: state.source,
      reason: error instanceof Error ? error.message : String(error),
      boundary: ["read_only_feedback", "no_execution_authority"],
    });
  }
}
