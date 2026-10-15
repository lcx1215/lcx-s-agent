import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { readFinanceAccountEconomicFeedback } from "./finance-account-economic-feedback.js";
import { isSafeFinanceReadFailure } from "./finance-alpaca-safety-transport.js";
import { readFinanceBrokerProfitFeedback } from "./finance-broker-profit-feedback.js";
import { FINANCE_EXECUTION_SAFETY_CONTROLLER_FAILURE_CATEGORIES } from "./finance-execution-safety.js";
import { readFinanceIntradayExecutionCoverage } from "./finance-intraday-control-ledger.js";
import {
  FINANCE_DIRECTIONAL_CALIBRATION_BLOCK_REASON,
  FINANCE_PAPER_EXECUTION_BLOCK_REASON,
  readFinancePaperPromotions,
} from "./finance-paper-promotion.js";
import {
  readFinanceLatestBrokerReconciliations,
  readFinancePositionLedger,
} from "./finance-position-ledger.js";
import { readFinancePositionManagementFeedback } from "./finance-position-management-feedback.js";
import { readFinanceRuleReadinessState } from "./finance-rule-readiness-state.js";
import { readFinanceSchedulerDatabaseRuns } from "./finance-scheduler-ledger.js";
import { financeSchedulerPidPresent, readFinanceSchedulerPid } from "./finance-scheduler-lock.js";
import {
  inspectFinanceSchedulerProgress,
  readFinanceSchedulerState,
} from "./finance-scheduler-state.js";
import { FINANCE_DAILY_CYCLE_RUNS_FILENAME, resolveFinanceStateDir } from "./finance-state-dir.js";
import { validateFinanceStrategyImplementation } from "./finance-strategy-implementation.js";
import { readFinanceStrategyRuleLedger } from "./finance-strategy-rule-ledger.js";
import {
  readFinanceScoredFloorSamplesWithSource,
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
  if (execution.outcome === "not_run") {
    return "not_run";
  }
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

const safeReadCode = z.string().refine((code) => isSafeFinanceReadFailure({ code }));
const cleanupStatus = z.enum(["confirmed", "unconfirmed"]).optional();
const readFailure = z
  .object({
    code: safeReadCode,
    cleanupStatus,
    stage: z
      .enum([
        "execution_recovery",
        "broker_reconciliation",
        "safety_claims",
        "terminal_order",
        "safety_facts",
      ])
      .optional(),
    elapsedMs: z.number().finite().nonnegative().optional(),
    request: z
      .object({
        endpoint: z.enum(["account", "positions", "activities", "orders", "other"]),
        phase: z.enum(["request", "body"]),
        code: safeReadCode,
        elapsedMs: z.number().finite().nonnegative(),
        cleanupStatus,
      })
      .strict()
      .optional(),
  })
  .strict();

const schedulerReconciliationObservationSchema = z.object({
  schemaVersion: z.literal("lcx_alpaca_order_stream_observation_v1"),
  pid: z.number().int().positive(),
  venue: z.literal("alpaca:paper"),
  observedAt: z.string().datetime({ offset: true }),
  reconciliation: z.object({
    lastSource: z.enum(["idle", "stream"]).nullable().optional(),
    lastFailure: readFailure.nullable().optional(),
    lastAttemptAt: z.string().datetime({ offset: true }).nullable(),
    lastReadbackAt: z.string().datetime({ offset: true }).nullable(),
    lastSucceededAt: z.string().datetime({ offset: true }).nullable(),
    lastReadinessStatus: z
      .enum([
        "ready",
        "restricted",
        "blocked",
        "reconciled",
        "unresolved",
        "unavailable",
        "pending",
      ])
      .nullable(),
    lastErrorCode: z
      .enum([
        ...FINANCE_EXECUTION_SAFETY_CONTROLLER_FAILURE_CATEGORIES,
        "progress_observation_failed",
        "reconciliation_failed",
        "account_read_failed",
        "stream_unavailable",
      ])
      .nullable(),
  }),
});

async function readSchedulerReconciliation(
  directory: string,
  pid: number | null,
  processPresent: boolean,
  observedAt: string,
) {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(path.join(directory, "alpaca-order-stream-latest.json"), "r");
    const buffer = Buffer.alloc(16 * 1024 + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 16 * 1024) {
      return {
        status: "unavailable",
        needsInspection: true,
        reason: "reconciliation_observation_too_large",
      };
    }
    const record = schedulerReconciliationObservationSchema.parse(
      JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")),
    );
    if (!processPresent || record.pid !== pid) {
      return {
        status: "unavailable",
        needsInspection: true,
        reason: "reconciliation_owner_mismatch",
      };
    }
    const now = Date.parse(observedAt),
      ageMs = now - Date.parse(record.observedAt);
    if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > 300000) {
      return {
        status: "stale",
        observedAt: record.observedAt,
        needsInspection: true,
        reason: "reconciliation_observation_not_current",
      };
    }
    const readbackAgeMs =
      record.reconciliation.lastReadbackAt === null
        ? Infinity
        : now - Date.parse(record.reconciliation.lastReadbackAt);
    return {
      status: "present",
      observedAt: record.observedAt,
      ...record.reconciliation,
      needsInspection:
        record.reconciliation.lastErrorCode !== null ||
        !["ready", "reconciled"].includes(record.reconciliation.lastReadinessStatus ?? "") ||
        readbackAgeMs < 0 ||
        readbackAgeMs > 300000,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    return {
      status: "unavailable",
      needsInspection: true,
      reason: "reconciliation_observation_unreadable",
    };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readSchedulerRuntime(directory: string, observedAt: string) {
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
  const reconciliation = await readSchedulerReconciliation(
    directory,
    pid,
    processPresent,
    observedAt,
  );
  return {
    status: progress.status,
    pidPresent: pid !== null,
    ...(reconciliation ? { reconciliation } : {}),
    ...(typeof fields.phase === "string" ? { phase: fields.phase } : {}),
    ...("accountWork" in progress ? { accountWork: progress.accountWork } : {}),
    ...(typeof fields.placementEnabled === "boolean"
      ? { placementEnabled: fields.placementEnabled }
      : {}),
    ...(typeof fields.venue === "string" ? { venue: fields.venue } : {}),
    ...(typeof fields.executionPolicyStatus === "string"
      ? { executionPolicyStatus: fields.executionPolicyStatus }
      : {}),
    ...(typeof fields.executionPolicyAuthorizationMode === "string"
      ? { executionPolicyAuthorizationMode: fields.executionPolicyAuthorizationMode }
      : {}),
    ...(typeof fields.executionPolicyExpiresAt === "string" ||
    fields.executionPolicyExpiresAt === null
      ? { executionPolicyExpiresAt: fields.executionPolicyExpiresAt }
      : {}),
    ...(typeof fields.intradayControllerPolicyStatus === "string"
      ? { intradayControllerPolicyStatus: fields.intradayControllerPolicyStatus }
      : {}),
    ...(typeof fields.intradayControllerPolicyAuthorizationMode === "string"
      ? {
          intradayControllerPolicyAuthorizationMode:
            fields.intradayControllerPolicyAuthorizationMode,
        }
      : {}),
    ...(typeof fields.intradayControllerPolicyExpiresAt === "string" ||
    fields.intradayControllerPolicyExpiresAt === null
      ? { intradayControllerPolicyExpiresAt: fields.intradayControllerPolicyExpiresAt }
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
  const review = output.tradeDecisionReview;
  const decisions =
    review && typeof review === "object" && !Array.isArray(review)
      ? (review as Record<string, unknown>).decisions
      : undefined;
  const modelVetoes = Array.isArray(decisions)
    ? decisions
        .flatMap((decision) => {
          if (
            !decision ||
            typeof decision !== "object" ||
            Array.isArray(decision) ||
            decision.decision !== "veto"
          ) {
            return [];
          }
          return [
            {
              origin: "model_review" as const,
              candidateId: boundedText(decision.candidateId, 160),
              rationale: boundedText(decision.rationale, 800),
            },
          ];
        })
        .slice(0, 8)
    : [];
  const runId =
    typeof record.runId === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(record.runId)
      ? record.runId
      : undefined;
  return {
    ...(runId !== undefined ? { runId } : {}),
    firedAt: boundedText(record.firedAt, 40),
    ...(modelVetoes.length > 0 ? { modelVetoes } : {}),
    status: boundedText(record.status, 32),
    execution: rawExecution
      ? {
          outcome: compactExecutionOutcome(record, output, rawExecution, readinessBlocked),
          ...(rawExecution.outcome === "not_run" &&
          rawExecution.blockReason === "research_plan_not_accepted"
            ? { blockReason: "research_plan_not_accepted" }
            : readinessBlocked
              ? { blockReason: "paper_readiness_not_met" }
              : {}),
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
  const stored = readFinanceSchedulerDatabaseRuns(directory);
  if (stored !== undefined) {
    return Object.fromEntries(
      Object.entries(stored).map(([mode, run]) => [mode, compactCycleRun(run)]),
    );
  }
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
  // Each reader verifies the original chain once for this call. Lazy promises preserve
  // the consumers' own failure handling and expire with this observation.
  let positions: ReturnType<typeof readFinancePositionLedger> | undefined;
  let reconciliations: ReturnType<typeof readFinanceLatestBrokerReconciliations> | undefined;
  const positionObservation = {
    directory: state.directory,
    asOf: observedAt,
    read: () => (positions ??= readFinancePositionLedger(state.directory, { asOf: observedAt })),
  };
  const reconciliationObservation = {
    directory: state.directory,
    asOf: observedAt,
    read: () => (reconciliations ??= readFinanceLatestBrokerReconciliations(state.directory)),
  };
  try {
    const [rules, proposals, promotions, scored] = await Promise.all([
      readFinanceStrategyRuleLedger(state.directory, { asOf: observedAt }),
      Promise.resolve(readFinanceTuningProposals(state.directory)),
      Promise.resolve(readFinancePaperPromotions(state.directory)),
      Promise.resolve(readFinanceScoredFloorSamplesWithSource(state.directory)),
    ]);
    const [scheduler, latestCycleByMode] = await Promise.all([
      Promise.resolve(readFinanceSchedulerState(state.directory)),
      readLatestCycleByMode(state.directory),
    ]);
    const schedulerRuntime = await readSchedulerRuntime(state.directory, observedAt);
    let currentReadiness: Record<string, unknown>;
    try {
      const snapshot = await readFinanceRuleReadinessState({
        directory: state.directory,
        asOf: observedAt,
        rules: rules.ledger.rules,
        positionObservation,
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
    const intradayExecution = await readFinanceIntradayExecutionCoverage(
      state.directory,
      observedAt,
    );
    const positionManagement = await readFinancePositionManagementFeedback({
      directory: state.directory,
      observedAt,
      rules: rules.ledger.rules,
      reconciliationObservation,
    });
    const profitFeedback = await readFinanceBrokerProfitFeedback(state.directory, observedAt, {
      positionObservation,
      reconciliationObservation,
    });
    const accountEconomics = new Map(
      await Promise.all(
        (profitFeedback.accounts ?? [])
          .filter((a) => a.venue === "alpaca:paper")
          .slice(0, 2)
          .map(
            async (account) =>
              [
                account.accountId,
                await readFinanceAccountEconomicFeedback(
                  state.directory,
                  account.accountId,
                  observedAt,
                ),
              ] as const,
          ),
      ),
    );
    const economicFeedback =
      profitFeedback.accounts !== undefined
        ? {
            status: profitFeedback.status,
            asOf: observedAt,
            executionAuthority: "none",
            boundary:
              "accountEconomics: marked account attribution; methodPerformance: exact entry-rule FIFO cohort, not alpha; accounts never aggregated",
            accounts: profitFeedback.accounts.slice(0, 2).map((account) => {
              if (!("basis" in account)) {
                return { ...account, accountEconomics: accountEconomics.get(account.accountId) };
              }
              const { instruments, strategyAttribution, issues } = account;
              const summary = {
                accountId: account.accountId,
                venue: account.venue,
                snapshotRef: account.snapshotRef,
                observedAt: account.observedAt,
                freshness: account.freshness,
                status: account.status,
                basis: account.basis,
                accountEconomics: accountEconomics.get(account.accountId),
                grossMatchedPnl: account.grossMatchedPnl,
                netMatchedPnl: account.netMatchedPnl,
                matchedLotCount: account.matchedLotCount,
                openLotCount: account.openLotCount,
                omittedAccountDetails: true,
                methodPerformance: {
                  matchedLotCount: account.methodPerformance.matchedLotCount,
                  unattributedMatchedLotCount:
                    account.methodPerformance.unattributedMatchedLotCount,
                  methods: account.methodPerformance.methods
                    .toSorted((a, b) => b.lastExitAt.localeCompare(a.lastExitAt))
                    .slice(0, 1)
                    .map((method) => ({
                      ruleId: method.ruleId,
                      declarationRef: method.declarationRef,
                      activationRef: method.activationRef,
                      matchedLotCount: method.matchedLotCount,
                      fullyClosedEntryCount: method.fullyClosedEntryCount,
                      grossMatchedPnl: method.grossMatchedPnl,
                      netMatchedPnl: method.netMatchedPnl,
                      costStatus: method.costStatus,
                    })),
                  omittedMethods: Math.max(0, account.methodPerformance.methods.length - 1),
                },
                positionManagementMatched: (positionManagement.accounts ?? []).some(
                  (position) =>
                    position.accountId === account.accountId &&
                    position.venue === account.venue &&
                    position.snapshotRef === account.snapshotRef,
                ),
                issues: issues.slice(0, 4),
                omittedIssues: Math.max(0, issues.length - 4),
                omittedInstruments: instruments.length,
                strategyAttribution: {
                  attributedFillCount: strategyAttribution.attributedFillCount,
                  unattributedFillCount: strategyAttribution.unattributedFillCount,
                  strategies: strategyAttribution.strategies.slice(0, 3),
                  omittedStrategies: Math.max(0, strategyAttribution.strategies.length - 3),
                },
              };
              if (summary.accountEconomics && summary.accountEconomics.status !== "unavailable") {
                // Keep current account consequences and one exact method cohort in the same 2KB budget.
                return {
                  accountId: summary.accountId,
                  venue: summary.venue,
                  status: summary.status,
                  accountEconomics: summary.accountEconomics,
                  netMatchedPnl: summary.netMatchedPnl,
                  methodPerformance: {
                    methods: summary.methodPerformance.methods,
                    omittedMethods: summary.methodPerformance.omittedMethods,
                  },
                  omittedAccountDetails: true,
                };
              }
              return summary;
            }),
            omittedAccounts:
              (profitFeedback.omittedAccounts ?? 0) +
              Math.max(0, profitFeedback.accounts.length - 2),
          }
        : {
            status: "unavailable",
            asOf: observedAt,
            executionAuthority: "none",
            reason: boundedText(profitFeedback.reason, 160),
          };
    if (economicFeedback.accounts !== undefined) {
      while (
        Buffer.byteLength(JSON.stringify(economicFeedback), "utf8") > 2000 &&
        economicFeedback.accounts.length > 0
      ) {
        economicFeedback.accounts.pop();
        economicFeedback.omittedAccounts = (economicFeedback.omittedAccounts ?? 0) + 1;
      }
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
    const runtimeIntradayPolicyStatus =
      "intradayControllerPolicyStatus" in schedulerRuntime
        ? schedulerRuntime.intradayControllerPolicyStatus
        : undefined;
    const runtimeEffectivePolicyStatus =
      typeof runtimeIntradayPolicyStatus === "string" &&
      runtimeIntradayPolicyStatus !== "not_applicable"
        ? runtimeIntradayPolicyStatus
        : runtimePolicyStatus;
    const runtimeVenue = "venue" in schedulerRuntime ? schedulerRuntime.venue : undefined;
    const schedulerRuntimeNeedsInspection =
      ("reconciliation" in schedulerRuntime &&
        schedulerRuntime.reconciliation?.needsInspection === true) ||
      (schedulerRuntime.pidPresent
        ? schedulerRuntime.status !== "responsive" ||
          runtimePlacementEnabled !== true ||
          (runtimeVenue === "paper"
            ? false
            : runtimeVenue !== "alpaca" ||
              (runtimeEffectivePolicyStatus !== "current" &&
                runtimeEffectivePolicyStatus !== "until_revoked"))
        : schedulerHasHistory);
    const methodDevelopment = rules.ledger.rules
      .filter(
        (rule) => rule.state === "draft" && rule.provenance?.origin === "verified_finance_research",
      )
      .toSorted((a, b) => b.startObservedAt.localeCompare(a.startObservedAt))
      .slice(0, 3)
      .map((rule) => {
        let implementation: { status: string; owner?: string; reason?: string };
        try {
          const validated = validateFinanceStrategyImplementation(rule);
          implementation = { status: "native_contract_validated", owner: validated.owner };
        } catch (error) {
          implementation = {
            status: "implementation_or_contract_missing",
            reason:
              error instanceof Error
                ? error.message.slice(0, 240)
                : "native_contract_validation_failed",
          };
        }
        return {
          ruleId: rule.ruleId,
          form: rule.form,
          formVersion: rule.formVersion,
          declarationRef: rule.transitions.find((record) => record.body.kind === "declared")?.ref,
          implementation,
          nextStep:
            implementation.status === "native_contract_validated"
              ? "original_operator_activation_then_original_execution_gates"
              : "implement_or_repair_original_form_owner_and_run_scoped_validation",
          executionAuthority: "none",
        };
      });

    const nextTask = positionManagement.needsInspection
      ? "inspect_finance_position_management"
      : failedCycleModes.length > 0 || scheduler.lastRun?.ok === false
        ? "inspect_failed_finance_cycle"
        : schedulerRuntimeNeedsInspection
          ? "inspect_finance_scheduler_runtime"
          : intradayExecution.status === "present" &&
              (intradayExecution.uncertain > 0 || intradayExecution.missingOutcome > 0)
            ? "inspect_unexecuted_finance_candidates"
            : "strategyReassessments" in intradayExecution &&
                intradayExecution.strategyReassessments?.length
              ? "inspect_finance_strategy_applicability"
              : intradayExecution.status === "present" && intradayExecution.needsExecutionInspection
                ? "inspect_unexecuted_finance_candidates"
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
      intradayExecution,
      positionManagement,
      economicFeedback,
      methodDevelopment,
      scoredOutcomeCount: scored.samples.length,
      tuning: {
        sourceRead: scored.sourceRead,
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
