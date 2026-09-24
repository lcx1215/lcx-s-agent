import fs from "node:fs/promises";
import path from "node:path";
import {
  FINANCE_DIRECTIONAL_CALIBRATION_BLOCK_REASON,
  FINANCE_PAPER_EXECUTION_BLOCK_REASON,
  readFinancePaperPromotions,
} from "./finance-paper-promotion.js";
import { readFinanceRuleReadinessState } from "./finance-rule-readiness-state.js";
import { financeSchedulerPidPresent, readFinanceSchedulerPid } from "./finance-scheduler-lock.js";
import {
  inspectFinanceSchedulerProgress,
  readFinanceSchedulerState,
} from "./finance-scheduler-state.js";
import { FINANCE_DAILY_CYCLE_RUNS_FILENAME, resolveFinanceStateDir } from "./finance-state-dir.js";
import { readFinanceStrategyRuleLedger } from "./finance-strategy-rule-ledger.js";
import {
  readFinanceScoredFloorSamples,
  readFinanceTuningProposals,
} from "./finance-tuning-lifecycle.js";

export const FINANCE_AUTOMATIC_LIFECYCLE_FEEDBACK_SCHEMA_VERSION =
  "lcx_finance_automatic_lifecycle_feedback_v2" as const;

const FAILED_CYCLE_STATUSES = new Set(["failed", "timed_out", "spawn_error", "cancelled"]);

function boundedText(value: unknown, maxChars: number): string | null {
  return typeof value === "string" ? value.slice(0, maxChars) : null;
}

function compactExecutionOutcome(
  record: Record<string, unknown>,
  output: Record<string, unknown>,
  execution: Record<string, unknown>,
  readinessBlocked: boolean,
): string | null {
  if (readinessBlocked) {
    return "blocked_by_readiness";
  }
  const recorded = boundedText(execution.outcome, 48);
  if (recorded !== "blocked_by_readiness") {
    return recorded;
  }
  // A long-lived Scheduler may write an older readiness-derived summary while the child cycle
  // already uses the explicit gate. When its cycle payload succeeded, derive the outcome from
  // the child evidence instead of repeating the stale summary.
  if (output.ok !== true) {
    return "failed_or_unknown";
  }
  if (record.mode === "night") {
    return "settlement";
  }
  if (execution.placementEnabled !== true) {
    return "preview_only";
  }
  const refusals = Array.isArray(output.refusals) ? output.refusals : [];
  const placements = Array.isArray(output.placed) ? output.placed.length : null;
  const intents = Array.isArray(output.drift)
    ? output.drift.filter(
        (row: unknown) =>
          row !== null &&
          typeof row === "object" &&
          "action" in row &&
          ["buy", "sell"].includes(String(row.action)),
      ).length
    : null;
  if (refusals.length > 0) {
    return "blocked_or_partial";
  }
  if (placements !== null && placements > 0) {
    return "placement_reported";
  }
  return intents === 0 ? "no_trade" : "not_executed";
}

function readSchedulerRuntime(directory: string, observedAt: string) {
  let pid: number | null = null;
  try {
    pid = readFinanceSchedulerPid(directory);
  } catch (error) {
    return {
      status: "unreadable",
      pidPresent: false,
      reason: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
    };
  }
  const processPresent = pid !== null && financeSchedulerPidPresent(pid);
  const progress = inspectFinanceSchedulerProgress(
    directory,
    pid,
    processPresent,
    Number.isFinite(Date.parse(observedAt)) ? Date.parse(observedAt) : Date.now(),
  );
  const fields = progress as Record<string, unknown>;
  return {
    status: progress.status,
    pidPresent: pid !== null,
    ...(typeof fields.phase === "string" ? { phase: fields.phase } : {}),
    ...(typeof fields.placementEnabled === "boolean"
      ? { placementEnabled: fields.placementEnabled }
      : {}),
    ...(typeof fields.venue === "string" ? { venue: fields.venue } : {}),
    ...(typeof fields.executionPolicyStatus === "string"
      ? { executionPolicyStatus: fields.executionPolicyStatus }
      : {}),
    ...(typeof fields.executionPolicyExpiresAt === "string" ||
    fields.executionPolicyExpiresAt === null
      ? { executionPolicyExpiresAt: fields.executionPolicyExpiresAt }
      : {}),
  };
}

function compactCycleRun(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  let output: Record<string, unknown> = {};
  if (typeof record.stdout === "string") {
    try {
      const parsed: unknown = JSON.parse(record.stdout);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        output = parsed as Record<string, unknown>;
      }
    } catch {
      // The stable receipt fields remain useful when a child emitted non-JSON output.
    }
  }
  const readiness =
    output.readiness !== null && typeof output.readiness === "object"
      ? (output.readiness as Record<string, unknown>)
      : null;
  const rules = Array.isArray(readiness?.rules) ? readiness.rules : [];
  const blockedRules = rules.flatMap((rule) => {
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
      return [];
    }
    const item = rule as Record<string, unknown>;
    if (item.ready !== false) {
      return [];
    }
    return [
      {
        ruleId: boundedText(item.ruleId, 80),
        durationMet: item.durationMet ?? null,
        elapsedDays: item.elapsedDays ?? null,
        uncovered: Array.isArray(item.uncovered) ? item.uncovered.slice(0, 8) : [],
        barWindowNote: typeof item.barWindowNote === "string" ? item.barWindowNote : null,
      },
    ];
  });
  // Do not infer an execution refusal from strategy readiness alone: the cycle can report
  // incomplete adversity evidence while still passing its explicit execution prerequisites.
  const legacyReadinessBlock =
    output.ok === false &&
    typeof output.error === "string" &&
    output.error.includes(
      "active strategy rule is not paper-ready under the declared readiness evidence",
    );
  const readinessBlocked =
    output.failureKind === "execution_readiness_gate" || legacyReadinessBlock;
  const eodRefresh =
    output.eodRefresh !== null &&
    typeof output.eodRefresh === "object" &&
    !Array.isArray(output.eodRefresh)
      ? (output.eodRefresh as Record<string, unknown>)
      : null;
  const eodBars = Array.isArray(eodRefresh?.barsFiled)
    ? eodRefresh.barsFiled.filter(
        (bar): bar is Record<string, unknown> =>
          bar !== null && typeof bar === "object" && !Array.isArray(bar),
      )
    : [];
  const marketDates = eodBars
    .map((bar) => bar.marketDate)
    .filter(
      (date): date is string => typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(date),
    );
  const sourceObservedAt = eodBars
    .map((bar) => bar.sourceObservedAt)
    .filter(
      (value): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)),
    )
    .toSorted()
    .at(-1);
  const eodIssues = Array.isArray(eodRefresh?.dataIssues) ? eodRefresh.dataIssues.length : 0;
  const eodWarnings = Array.isArray(output.eodRefreshWarnings)
    ? output.eodRefreshWarnings.length
    : 0;
  const hasEodRefresh = eodRefresh !== null || eodWarnings > 0;
  const rawExecution =
    record.execution !== null &&
    typeof record.execution === "object" &&
    !Array.isArray(record.execution)
      ? (record.execution as Record<string, unknown>)
      : null;
  return {
    firedAt: boundedText(record.firedAt, 40),
    status: boundedText(record.status, 32),
    execution: rawExecution
      ? {
          outcome: compactExecutionOutcome(record, output, rawExecution, readinessBlocked),
          ...(readinessBlocked ? { blockReason: "paper_readiness_not_met" } : {}),
          ...(typeof rawExecution.reportedPlacements === "number"
            ? { reportedPlacements: rawExecution.reportedPlacements }
            : {}),
        }
      : null,
    ...(typeof output.error === "string" && !readinessBlocked
      ? { failureReason: output.error.slice(0, 100) }
      : {}),
    ...(readiness
      ? {
          readiness: {
            ready:
              typeof readiness.ready === "boolean"
                ? readiness.ready
                : rules.length === 0
                  ? null
                  : rules.every(
                      (rule) =>
                        rule !== null &&
                        typeof rule === "object" &&
                        !Array.isArray(rule) &&
                        (rule as Record<string, unknown>).ready === true,
                    ),
            ...(blockedRules.length > 0
              ? { blockedRuleIds: blockedRules.slice(0, 4).map((rule) => rule.ruleId) }
              : {}),
          },
        }
      : {}),
    ...(hasEodRefresh
      ? {
          eodRefresh: {
            instruments: eodBars.length,
            newestMarketDate: marketDates.toSorted().at(-1) ?? null,
            newBars: eodBars.reduce(
              (count, bar) => count + (typeof bar.newBarCount === "number" ? bar.newBarCount : 0),
              0,
            ),
            sourceObservedAt: sourceObservedAt ?? null,
            issueCount: eodIssues + eodWarnings,
          },
        }
      : {}),
  };
}

async function readLatestCycleByMode(directory: string) {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(path.join(directory, FINANCE_DAILY_CYCLE_RUNS_FILENAME), "r");
    const stat = await handle.stat();
    const byteLength = Math.min(stat.size, 256 * 1024);
    const buffer = Buffer.alloc(byteLength);
    await handle.read(buffer, 0, byteLength, stat.size - byteLength);
    let raw = buffer.toString("utf8");
    if (stat.size > byteLength) {
      const firstCompleteLine = raw.indexOf("\n");
      raw = firstCompleteLine < 0 ? "" : raw.slice(firstCompleteLine + 1);
    }
    const latest: Record<string, ReturnType<typeof compactCycleRun>> = {};
    for (const line of raw.split("\n").toReversed()) {
      if (!line.trim()) {
        continue;
      }
      try {
        const record = JSON.parse(line) as Record<string, unknown>;
        if ((record.mode === "day" || record.mode === "night") && !(record.mode in latest)) {
          latest[record.mode] = compactCycleRun(record);
        }
        if (latest.day && latest.night) {
          break;
        }
      } catch {
        // A truncated final line does not hide earlier complete receipts.
      }
    }
    return latest;
  } catch {
    return {};
  } finally {
    await handle?.close().catch(() => undefined);
  }
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
    const [scheduler, latestCycleByMode] = await Promise.all([
      Promise.resolve(readFinanceSchedulerState(state.directory)),
      readLatestCycleByMode(state.directory),
    ]);
    const schedulerRuntime = readSchedulerRuntime(state.directory, observedAt);
    let currentReadiness: Record<string, unknown>;
    try {
      const snapshot = await readFinanceRuleReadinessState({
        directory: state.directory,
        asOf: observedAt,
        rules: rules.ledger.rules,
      });
      const activeReadinessRules = snapshot.readiness.rules.filter(
        (rule) => rule.state === "active",
      );
      const activeRulesById = new Map(
        rules.ledger.rules
          .filter((rule) => rule.state === "active")
          .map((rule) => [rule.ruleId, rule]),
      );
      currentReadiness = {
        status: "present",
        thresholdsDeclared: snapshot.thresholdsDeclared,
        ...(snapshot.thresholdsError
          ? { thresholdsError: snapshot.thresholdsError.slice(0, 120) }
          : {}),
        declaredThresholds: snapshot.readiness.declaredThresholds,
        ruleCount: snapshot.readiness.ruleCount,
        draftRuleCount: snapshot.readiness.rules.filter((rule) => rule.state === "draft").length,
        activeRuleCount: activeReadinessRules.length,
        unreadyActiveRuleCount: activeReadinessRules.filter((rule) => rule.ready !== true).length,
        barCount: snapshot.readiness.barCount,
        conflictCount: snapshot.readiness.barConflicts.length,
        dataStores: {
          bars: {
            kind: "sqlite",
            present: snapshot.dataStores.bars.present,
            records: snapshot.dataStores.bars.recordCount,
            instruments: snapshot.dataStores.bars.instrumentCount,
            latest: snapshot.dataStores.bars.newestMarketDate,
          },
          positions: {
            kind: "sqlite",
            present: snapshot.dataStores.positions.present,
            records: snapshot.dataStores.positions.recordCount,
            marks: snapshot.dataStores.positions.markCount,
            latest: snapshot.dataStores.positions.newestMarkAt,
          },
        },
        rules: snapshot.readiness.rules
          .filter((rule) => rule.state === "active")
          .slice(0, 3)
          .map((rule) => ({
            id: rule.ruleId.slice(0, 80),
            state: rule.state,
            ready: rule.ready,
            durationMet: rule.durationMet,
            observations: rule.observationCount,
            instruments: activeRulesById.get(rule.ruleId)?.instruments.slice(0, 8) ?? [],
            ...(rule.uncovered.length > 0 ? { uncovered: rule.uncovered.slice(0, 3) } : {}),
            ...(rule.barConflicts.length > 0 ? { conflicts: rule.barConflicts.length } : {}),
          })),
      };
    } catch (error) {
      currentReadiness = {
        status: "unavailable",
        asOf: observedAt,
        reason: error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240),
      };
    }
    const latestProposal = proposals.at(-1) ?? null;
    const latestPromotion = promotions.at(-1) ?? null;
    const failedCycleModes = ["day", "night"].filter((mode) =>
      FAILED_CYCLE_STATUSES.has(
        String(latestCycleByMode[mode]?.status ?? scheduler.lastStatus[mode]),
      ),
    );
    const schedulerHasHistory =
      Object.keys(scheduler.lastFired).length > 0 || Object.keys(latestCycleByMode).length > 0;
    const runtimePlacementEnabled =
      "placementEnabled" in schedulerRuntime ? schedulerRuntime.placementEnabled : undefined;
    const runtimePolicyStatus =
      "executionPolicyStatus" in schedulerRuntime
        ? schedulerRuntime.executionPolicyStatus
        : undefined;
    const runtimeVenue = "venue" in schedulerRuntime ? schedulerRuntime.venue : undefined;
    const schedulerRuntimeNeedsInspection = schedulerRuntime.pidPresent
      ? schedulerRuntime.status !== "responsive" ||
        runtimePlacementEnabled !== true ||
        (runtimeVenue === "paper"
          ? false
          : runtimeVenue !== "alpaca" || runtimePolicyStatus !== "current")
      : schedulerHasHistory;
    const nextTask =
      failedCycleModes.length > 0 || scheduler.lastRun?.ok === false
        ? "inspect_failed_finance_cycle"
        : schedulerRuntimeNeedsInspection
          ? "inspect_finance_scheduler_runtime"
          : currentReadiness.status !== "present" ||
              Number(currentReadiness.unreadyActiveRuleCount) > 0
            ? "inspect_finance_readiness"
            : latestProposal && latestProposal.proposalId !== latestPromotion?.proposalId
              ? "review_directional_calibration_proposal"
              : latestPromotion === null
                ? "prepare_reconciled_net_trade_economics_evidence"
                : "monitor_net_trade_economics_promotion";
    return Object.freeze({
      schemaVersion: FINANCE_AUTOMATIC_LIFECYCLE_FEEDBACK_SCHEMA_VERSION,
      status: "present",
      observedAt,
      directorySource: state.source,
      scheduler: {
        lastStatus: scheduler.lastStatus,
        latestCycleByMode,
        failedCycleModes,
        runtime: schedulerRuntime,
      },
      currentReadiness,
      scoredOutcomeCount: samples.length,
      tuning: {
        proposalCount: proposals.length,
        latestProposal: latestProposal
          ? {
              proposalId: boundedText(latestProposal.proposalId, 96),
              proposed: latestProposal.proposed,
              direction: latestProposal.direction,
              sampleCount: latestProposal.sampleCount,
            }
          : null,
        promotionCount: promotions.length,
        latestPromotion: latestPromotion
          ? {
              proposalId: boundedText(latestPromotion.proposalId, 96),
              promoted: latestPromotion.promoted,
              sampleCount: latestPromotion.sampleCount,
              authority: latestPromotion.authority,
            }
          : null,
      },
      paperExecutionPromotion: {
        status: "blocked",
        reason: FINANCE_PAPER_EXECUTION_BLOCK_REASON,
        contributingReasons: [FINANCE_DIRECTIONAL_CALIBRATION_BLOCK_REASON],
        executionThresholdPromotionEligible: false,
      },
      activeRules: rules.ledger.rules
        .filter((rule) => rule.state === "active")
        .map((rule) => ({ ruleId: rule.ruleId, form: rule.form, instruments: rule.instruments })),
      nextTask,
      boundary: [
        "read_only_feedback",
        "directional_calibration_is_not_execution_promotion",
        "no_execution_authority",
      ],
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
