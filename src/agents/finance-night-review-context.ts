import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { FinanceCommitteeEvidence } from "./finance-agent-committee.js";
import { readFinanceBarLedger } from "./finance-bar-ledger.js";
import { readFinanceBrokerProfitFeedback } from "./finance-broker-profit-feedback.js";
import { brokerSymbol } from "./finance-broker-reconciliation.js";
import { caseflowFingerprint } from "./finance-caseflow.js";
import { financeEtClock, latestCompletedWeekdaySessionDate } from "./finance-cycle-schedule.js";
import { readFinanceDailyDecisionHistory } from "./finance-daily-decision-history.js";
import {
  readFinanceIntradayDecisions,
  readFinanceIntradayAccountHistory,
  readFinanceIntradayOutcomes,
  type FinanceIntradayOutcomeRecord,
} from "./finance-intraday-control-ledger.js";
import { readFinancePaperEconomicWindow } from "./finance-paper-economic-window.js";
import {
  projectFinancePositions,
  readFinanceLatestBrokerReconciliations,
  readFinancePositionLedger,
  withFinanceBrokerHistorySnapshot,
} from "./finance-position-ledger.js";
import { buildFinanceMonthlyTrendDerivedEvidence } from "./finance-research-evidence.js";
import type { FinanceActiveStrategyResearchSource } from "./finance-research-portfolio-plan.js";
import { readFinanceSchedulerDatabaseResearchRuns } from "./finance-scheduler-ledger.js";
import { readFinanceStrategyRuleLedger } from "./finance-strategy-rule-ledger.js";
import { QUALITY_HARNESS_MAX_EVIDENCE_TEXT_LENGTH } from "./quality-harness-contract.js";

export const FINANCE_NIGHT_REVIEW_CONTEXT_SCHEMA_VERSION =
  "lcx_finance_night_review_context_v1" as const;
export const FINANCE_NIGHT_RESEARCH_SCOPE_SCHEMA_VERSION =
  "lcx_finance_night_research_scope_v1" as const;
export const FINANCE_NIGHT_RESEARCH_SCOPE_EVIDENCE_ID = "finance-night:research-scope" as const;
export const FINANCE_NIGHT_RESEARCH_SCOPE_EVIDENCE_SOURCE = "finance-night-research-scope" as const;
export const FINANCE_NIGHT_RESEARCH_SCOPE_MAX_INSTRUMENTS = 14;

function financeControllerHistoryMonths(
  activeRules: readonly Readonly<{
    body?: unknown;
  }>[],
): number {
  return Math.max(
    12,
    ...activeRules.map((rule) => {
      const frozen =
        rule.body && typeof rule.body === "object" && "frozenRule" in rule.body
          ? rule.body.frozenRule
          : undefined;
      const lookback =
        frozen && typeof frozen === "object" && "lookbackMonths" in frozen
          ? frozen.lookbackMonths
          : undefined;
      return typeof lookback === "number" &&
        Number.isInteger(lookback) &&
        lookback > 0 &&
        lookback <= 120
        ? lookback
        : 0;
    }),
  );
}

export type FinanceNightResearchInstrument = Readonly<{
  instrument: string;
  assetClass: "us_equity" | "crypto";
  reasons: readonly ("held_position" | "active_strategy")[];
}>;

export type FinanceNightResearchScope = Readonly<{
  schemaVersion: typeof FINANCE_NIGHT_RESEARCH_SCOPE_SCHEMA_VERSION;
  asOf: string;
  activeStrategyIds: readonly string[];
  instruments: readonly FinanceNightResearchInstrument[];
  holdingBasis?: FinanceNightResearchHoldingBasis;
  coverage?: Readonly<{
    totalInstrumentCount: number;
    deferredInstruments: readonly FinanceNightResearchInstrument[];
    selectionMethod: "held_priority_et_date_rotation_v1";
  }>;
}>;

export function parseControllerResearchScope(
  evidence: readonly FinanceCommitteeEvidence[],
  asOf: string,
): FinanceNightResearchScope {
  assertFinanceNightResearchAsOf(asOf);
  const matching = evidence.filter(
    (item) =>
      item.id === FINANCE_NIGHT_RESEARCH_SCOPE_EVIDENCE_ID ||
      item.source === FINANCE_NIGHT_RESEARCH_SCOPE_EVIDENCE_SOURCE,
  );
  if (
    matching.length !== 1 ||
    matching[0]?.id !== FINANCE_NIGHT_RESEARCH_SCOPE_EVIDENCE_ID ||
    matching[0]?.source !== FINANCE_NIGHT_RESEARCH_SCOPE_EVIDENCE_SOURCE
  ) {
    throw new Error("--controller-research-scope requires exactly one canonical night scope item");
  }
  if (matching[0].timestamp !== asOf) {
    throw new Error("controller night research scope evidence timestamp does not match --as-of");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(matching[0].text);
  } catch {
    throw new Error("controller night research scope is not valid JSON");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("controller night research scope must be an object");
  }
  const scope = raw as Record<string, unknown>;
  if (
    scope.schemaVersion !== FINANCE_NIGHT_RESEARCH_SCOPE_SCHEMA_VERSION ||
    scope.asOf !== asOf ||
    !Array.isArray(scope.activeStrategyIds) ||
    scope.activeStrategyIds.some((id) => typeof id !== "string" || !id.trim()) ||
    new Set(scope.activeStrategyIds).size !== scope.activeStrategyIds.length ||
    !Array.isArray(scope.instruments) ||
    scope.instruments.length === 0 ||
    scope.instruments.length > FINANCE_NIGHT_RESEARCH_SCOPE_MAX_INSTRUMENTS
  ) {
    throw new Error("controller night research scope is invalid or does not match --as-of");
  }
  const seen = new Set<string>();
  const isSupportedIdentity = (instrument: string, assetClass: unknown) =>
    assetClass === "crypto"
      ? /^[A-Z0-9]{2,12}\/USD$/u.test(instrument)
      : assetClass === "us_equity"
        ? /^[A-Z]{1,5}(?:\.[A-Z])?$/u.test(instrument)
        : false;
  const instruments = scope.instruments.map((value, index) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`controller night research scope instrument ${index} must be an object`);
    }
    const item = value as Record<string, unknown>;
    if (
      typeof item.instrument !== "string" ||
      typeof item.assetClass !== "string" ||
      (item.assetClass !== "us_equity" && item.assetClass !== "crypto") ||
      !Array.isArray(item.reasons) ||
      item.reasons.length === 0 ||
      item.reasons.some((reason) => reason !== "held_position" && reason !== "active_strategy")
    ) {
      throw new Error(`controller night research scope instrument ${index} is malformed`);
    }
    const instrument = item.instrument.trim().toUpperCase();
    if (!isSupportedIdentity(instrument, item.assetClass)) {
      throw new Error(
        `controller night research scope has unsupported instrument identity: ${instrument}`,
      );
    }
    const key = `${item.assetClass}:${instrument}`;
    if (!instrument || seen.has(key)) {
      throw new Error(
        `controller night research scope has empty or duplicate instrument: ${instrument}`,
      );
    }
    seen.add(key);
    return Object.freeze({
      instrument,
      assetClass: item.assetClass,
      reasons: Object.freeze(
        [...item.reasons].toSorted((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
      ) as FinanceNightResearchInstrument["reasons"],
    }) as FinanceNightResearchInstrument;
  });
  let coverage: FinanceNightResearchScope["coverage"];
  if (scope.coverage !== undefined) {
    if (
      typeof scope.coverage !== "object" ||
      scope.coverage === null ||
      Array.isArray(scope.coverage)
    ) {
      throw new Error("controller night research scope coverage is malformed");
    }
    const rawCoverage = scope.coverage as Record<string, unknown>;
    if (
      !Number.isSafeInteger(rawCoverage.totalInstrumentCount) ||
      (rawCoverage.totalInstrumentCount as number) <= instruments.length ||
      rawCoverage.selectionMethod !== "held_priority_et_date_rotation_v1" ||
      !Array.isArray(rawCoverage.deferredInstruments) ||
      rawCoverage.deferredInstruments.length === 0 ||
      (rawCoverage.totalInstrumentCount as number) !==
        instruments.length + rawCoverage.deferredInstruments.length
    ) {
      throw new Error("controller night research scope coverage is invalid");
    }
    const deferredInstruments = rawCoverage.deferredInstruments.map((value, index) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(
          `controller night research scope deferred instrument ${index} is malformed`,
        );
      }
      const item = value as Record<string, unknown>;
      if (
        typeof item.instrument !== "string" ||
        typeof item.assetClass !== "string" ||
        (item.assetClass !== "us_equity" && item.assetClass !== "crypto") ||
        !Array.isArray(item.reasons) ||
        item.reasons.length === 0 ||
        item.reasons.some((reason) => reason !== "held_position" && reason !== "active_strategy") ||
        new Set(item.reasons).size !== item.reasons.length
      ) {
        throw new Error(
          `controller night research scope deferred instrument ${index} is malformed`,
        );
      }
      const instrument = item.instrument.trim().toUpperCase();
      if (!isSupportedIdentity(instrument, item.assetClass)) {
        throw new Error(
          `controller night research scope has unsupported instrument identity: ${instrument}`,
        );
      }
      const key = `${item.assetClass}:${instrument}`;
      if (!instrument || seen.has(key)) {
        throw new Error(
          `controller night research scope has empty or duplicate instrument: ${instrument}`,
        );
      }
      seen.add(key);
      return Object.freeze({
        instrument,
        assetClass: item.assetClass,
        reasons: Object.freeze(
          [...item.reasons].toSorted((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
        ) as FinanceNightResearchInstrument["reasons"],
      }) as FinanceNightResearchInstrument;
    });
    coverage = Object.freeze({
      totalInstrumentCount: rawCoverage.totalInstrumentCount as number,
      deferredInstruments: Object.freeze(deferredInstruments),
      selectionMethod: "held_priority_et_date_rotation_v1",
    });
  }
  return Object.freeze({
    schemaVersion: FINANCE_NIGHT_RESEARCH_SCOPE_SCHEMA_VERSION,
    asOf,
    activeStrategyIds: Object.freeze([...(scope.activeStrategyIds as string[])]),
    instruments: Object.freeze(instruments),
    ...(scope.holdingBasis === undefined
      ? {}
      : { holdingBasis: financeNightResearchHoldingBasisSchema.parse(scope.holdingBasis) }),
    ...(coverage ? { coverage } : {}),
  });
}

export const financeNightResearchHoldingBasisSchema = z
  .object({
    source: z.enum(["broker_reconciliation", "execution_receipts"]),
    snapshotRefs: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(3),
    issues: z.array(z.string().min(1).max(256)).max(8),
    omittedAccounts: z.number().int().nonnegative(),
    executionAuthority: z.literal("none"),
  })
  .strict();
export type FinanceNightResearchHoldingBasis = z.infer<
  typeof financeNightResearchHoldingBasisSchema
>;

export function assertFinanceNightResearchAsOf(asOf: string): void {
  const asOfMs = Date.parse(asOf);
  if (!Number.isFinite(asOfMs) || asOfMs > Date.now()) {
    throw new Error("night research scope requires a valid non-future asOf");
  }
}

function rotateByEtDate<T>(items: readonly T[], asOf: string, pageSize: number): T[] {
  if (items.length < 2) {
    return [...items];
  }
  const etDate = financeEtClock(new Date(asOf)).date;
  const dateOrdinal = Math.floor(Date.parse(`${etDate}T00:00:00.000Z`) / 86_400_000);
  const offset = (((dateOrdinal * pageSize) % items.length) + items.length) % items.length;
  return [...items.slice(offset), ...items.slice(0, offset)];
}

function financeNightResearchAssetClass(instrument: string): "us_equity" | "crypto" {
  const normalized = instrument.trim().toUpperCase();
  if (/^[A-Z0-9]{2,12}\/USD$/u.test(normalized)) {
    return "crypto";
  }
  if (/^[A-Z]{1,5}(?:\.[A-Z])?$/u.test(normalized)) {
    return "us_equity";
  }
  throw new Error(`night research scope contains unsupported instrument identity: ${instrument}`);
}

function buildFinanceNightResearchScope(params: {
  asOf: string;
  positions: readonly Readonly<{ instrument: string; quantity: number }>[];
  activeRules: readonly Readonly<{ ruleId: string; instruments: readonly string[] }>[];
  holdingBasis?: FinanceNightResearchHoldingBasis;
}): FinanceNightResearchScope {
  assertFinanceNightResearchAsOf(params.asOf);
  const instruments = new Map<
    string,
    {
      instrument: string;
      assetClass: "us_equity" | "crypto";
      reasons: Set<"held_position" | "active_strategy">;
    }
  >();
  const add = (rawInstrument: string, reason: "held_position" | "active_strategy") => {
    const instrument = rawInstrument.trim().toUpperCase();
    const assetClass = financeNightResearchAssetClass(instrument);
    const key = `${assetClass}:${instrument}`;
    const existing = instruments.get(key) ?? { instrument, assetClass, reasons: new Set() };
    existing.reasons.add(reason);
    instruments.set(key, existing);
  };
  for (const position of params.positions) {
    if (position.quantity !== 0) {
      add(position.instrument, "held_position");
    }
  }
  for (const rule of params.activeRules) {
    for (const instrument of rule.instruments) {
      add(instrument, "active_strategy");
    }
  }
  if (instruments.size === 0) {
    throw new Error("night research scope has no held positions or active strategy instruments");
  }
  const allInstruments = [...instruments.values()].map((item) =>
    Object.freeze({
      instrument: item.instrument,
      assetClass: item.assetClass,
      reasons: Object.freeze([...item.reasons].toSorted()),
    }),
  );
  const selected =
    allInstruments.length <= FINANCE_NIGHT_RESEARCH_SCOPE_MAX_INSTRUMENTS
      ? allInstruments
      : (() => {
          const held = allInstruments.filter((item) => item.reasons.includes("held_position"));
          const activeOnly = allInstruments
            .filter((item) => !item.reasons.includes("held_position"))
            .toSorted((left, right) => left.instrument.localeCompare(right.instrument));
          const heldBudget =
            FINANCE_NIGHT_RESEARCH_SCOPE_MAX_INSTRUMENTS - (activeOnly.length > 0 ? 1 : 0);
          const heldPageSize = Math.min(held.length, heldBudget);
          const selectedHeld = rotateByEtDate(
            held.toSorted((left, right) => left.instrument.localeCompare(right.instrument)),
            params.asOf,
            heldPageSize,
          ).slice(0, heldPageSize);
          const remaining = FINANCE_NIGHT_RESEARCH_SCOPE_MAX_INSTRUMENTS - selectedHeld.length;
          const selectedActive = rotateByEtDate(activeOnly, params.asOf, remaining).slice(
            0,
            remaining,
          );
          return [...selectedHeld, ...selectedActive];
        })();
  const selectedKeys = new Set(selected.map((item) => `${item.assetClass}:${item.instrument}`));
  const deferredInstruments = allInstruments.filter(
    (item) => !selectedKeys.has(`${item.assetClass}:${item.instrument}`),
  );
  return Object.freeze({
    schemaVersion: FINANCE_NIGHT_RESEARCH_SCOPE_SCHEMA_VERSION,
    asOf: params.asOf,
    activeStrategyIds: Object.freeze(params.activeRules.map((rule) => rule.ruleId)),
    instruments: Object.freeze(selected),
    ...(params.holdingBasis ? { holdingBasis: params.holdingBasis } : {}),
    ...(deferredInstruments.length > 0
      ? {
          coverage: Object.freeze({
            totalInstrumentCount: allInstruments.length,
            deferredInstruments: Object.freeze(deferredInstruments),
            selectionMethod: "held_priority_et_date_rotation_v1" as const,
          }),
        }
      : {}),
  });
}

function projectFinanceNightPositionsAtAsOf(params: {
  positionRead: Awaited<ReturnType<typeof readFinancePositionLedger>>;
  asOf: string;
}) {
  const cutoff = Date.parse(params.asOf);
  const receipts = params.positionRead.receipts.filter(
    (receipt) =>
      Date.parse(receipt.recordedAt) <= cutoff && Date.parse(receipt.fill.filledAt) <= cutoff,
  );
  return Object.freeze({
    receipts,
    ledger: projectFinancePositions({ receipts, marks: params.positionRead.marks }),
  });
}

/** Broker holdings define research inventory; receipt lots still define LCX attribution. */
function projectFinanceNightResearchHoldings(params: {
  positionRead: Awaited<ReturnType<typeof readFinancePositionLedger>>;
  brokerRead: Awaited<ReturnType<typeof readFinanceLatestBrokerReconciliations>>;
  asOf: string;
}) {
  const records = params.brokerRead.records.filter((record) => record.venue === "alpaca:paper");
  if (!records.length && params.brokerRead.omittedAccounts === 0) {
    return { positions: projectFinanceNightPositionsAtAsOf(params).ledger.positions };
  }
  const replacedAccounts = new Set<string>();
  const brokerPositions: { instrument: string; quantity: number }[] = [];
  const issues: string[] = [];
  const snapshotRefs: string[] = [];
  for (const record of records) {
    const snapshot = record.snapshot as Record<string, unknown> | undefined;
    // A cash-only mismatch does not invalidate observed quantities or authorize execution.
    const cashOnlyMismatch =
      snapshot?.status === "unresolved" &&
      Array.isArray(snapshot.issues) &&
      snapshot.issues.length === 1 &&
      snapshot.issues[0] === "cash_difference";
    const age =
      snapshot && typeof snapshot.observedAt === "string"
        ? Date.parse(params.asOf) - Date.parse(snapshot.observedAt)
        : Number.NaN;
    if (
      !snapshot ||
      record.superseded ||
      !Number.isFinite(age) ||
      age < 0 ||
      age > 300_000 ||
      (snapshot.status !== "reconciled" && !cashOnlyMismatch) ||
      !Array.isArray(snapshot.differences) ||
      snapshot.differences.length ||
      !Array.isArray(snapshot.positions)
    ) {
      issues.push(`broker_holdings_unavailable:${record.accountId}`);
      continue;
    }
    try {
      const seen = new Set<string>();
      const positions = snapshot.positions.map((value: unknown) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          throw new Error("invalid position");
        }
        const raw = value as Record<string, unknown>;
        const instrument = brokerSymbol(raw.symbol);
        financeNightResearchAssetClass(instrument);
        const quantity =
          typeof raw.qty === "number"
            ? raw.qty
            : typeof raw.qty === "string" && raw.qty.trim()
              ? Number(raw.qty)
              : Number.NaN;
        if (!Number.isFinite(quantity) || quantity < 0 || seen.has(instrument)) {
          throw new Error("invalid quantity");
        }
        seen.add(instrument);
        return { instrument, quantity };
      });
      replacedAccounts.add(record.accountId);
      snapshotRefs.push(record.ref);
      brokerPositions.push(...positions);
      if (cashOnlyMismatch) {
        issues.push(`broker_cash_unreconciled:${record.accountId}`);
      }
    } catch {
      issues.push(`broker_holdings_invalid:${record.accountId}`);
    }
  }
  const receiptFallback = params.positionRead.receipts.filter(
    (receipt) =>
      !(
        receipt.venue === "alpaca:paper" &&
        receipt.accountId &&
        replacedAccounts.has(receipt.accountId)
      ),
  );
  const remaining = projectFinanceNightPositionsAtAsOf({
    positionRead: { ...params.positionRead, receipts: receiptFallback },
    asOf: params.asOf,
  }).ledger.positions;
  return {
    positions: [...brokerPositions, ...remaining],
    holdingBasis: financeNightResearchHoldingBasisSchema.parse({
      source: replacedAccounts.size ? "broker_reconciliation" : "execution_receipts",
      snapshotRefs,
      issues,
      omittedAccounts: params.brokerRead.omittedAccounts,
      executionAuthority: "none",
    }),
  };
}

/** Rebuild the exact night scope from the current controller ledgers at the supplied cutoff. */
export async function readFinanceNightReviewResearchScope(params: {
  directory: string;
  asOf: string;
}): Promise<FinanceNightResearchScope> {
  const [positions, strategyRules, brokerRead] = await Promise.all([
    readFinancePositionLedger(params.directory, { asOf: params.asOf }),
    readFinanceStrategyRuleLedger(params.directory, { asOf: params.asOf }),
    readFinanceLatestBrokerReconciliations(params.directory, { asOf: params.asOf }),
  ]);
  const activeRules = strategyRules.ledger.rules
    .filter((rule) => rule.state === "active")
    .map((rule) => ({ ruleId: rule.ruleId, instruments: rule.instruments }));
  const holdings = projectFinanceNightResearchHoldings({
    positionRead: positions,
    brokerRead,
    asOf: params.asOf,
  });
  return buildFinanceNightResearchScope({
    asOf: params.asOf,
    ...holdings,
    activeRules,
  });
}

type FinanceNightIntradayDecisionEvidence = Readonly<{
  recordedAt: string;
  signalId: string;
  instrument: string;
  action: string;
  reason: string;
  referencePrice: number;
  referencePriceAt: string;
  outcome: FinanceIntradayOutcomeRecord | null;
}>;

function boundedEvidenceText(value: string, maxCharacters: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  const characters = Array.from(normalized);
  return characters.length <= maxCharacters
    ? normalized
    : `${characters.slice(0, maxCharacters).join("")}…`;
}

function countEvidenceLabels(values: readonly string[], limit = 24) {
  const counts = new Map<string, number>();
  for (const value of values) {
    const label = boundedEvidenceText(value, 80) || "unknown";
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const sorted = [...counts].toSorted(
    (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
  );
  return {
    values: sorted.slice(0, limit).map(([value, count]) => ({ value, count })),
    omittedCategoryCount: Math.max(0, sorted.length - limit),
  };
}

function compactFinanceNightIntradayDecision(decision: FinanceNightIntradayDecisionEvidence) {
  const outcome = decision.outcome;
  const review = outcome?.tradeDecisionReview;
  const reviewedDecision = review?.decision;
  return {
    recordedAt: decision.recordedAt,
    signalId: boundedEvidenceText(decision.signalId, 128),
    instrument: boundedEvidenceText(decision.instrument, 24),
    action: boundedEvidenceText(decision.action, 24),
    reason: boundedEvidenceText(decision.reason, 80),
    referencePrice: decision.referencePrice,
    referencePriceAt: decision.referencePriceAt,
    outcome: outcome
      ? {
          status: outcome.status,
          ...(outcome.receiptId === undefined
            ? {}
            : { receiptId: boundedEvidenceText(outcome.receiptId, 128) }),
          reasons: outcome.reasons.slice(0, 8).map((reason) => boundedEvidenceText(reason, 120)),
          omittedReasonCount: Math.max(0, outcome.reasons.length - 8),
          ...(outcome.executionSafetyFailure
            ? { executionSafetyFailure: outcome.executionSafetyFailure }
            : {}),
          ...(review
            ? {
                tradeDecisionReview: {
                  status: review.status,
                  attempted: review.attempted,
                  ...(review.modelCalls === undefined ? {} : { modelCalls: review.modelCalls }),
                  provider: boundedEvidenceText(review.provider, 80),
                  modelId: boundedEvidenceText(review.modelId, 120),
                  latencyMs: review.latencyMs,
                  providerCallObserved: review.providerCallObserved,
                  adapterAttested: review.adapterAttested,
                  ...(review.failureCode ? { failureCode: review.failureCode } : {}),
                  ...(review.toolEvidence === undefined
                    ? {}
                    : {
                        toolEvidence: review.toolEvidence.slice(-2).map((item) => ({
                          action: item.action,
                          candidateId: item.candidateId,
                          asOf: item.asOf,
                          status: item.status,
                          sourceRef: item.sourceRef,
                          requestSha256: item.requestSha256,
                          resultSha256: item.resultSha256,
                          summary: item.summary,
                          boundary: item.boundary,
                        })),
                        omittedToolEvidenceCount: Math.max(0, review.toolEvidence.length - 2),
                      }),
                  ...(review.modelCallEvidence === undefined
                    ? {}
                    : {
                        modelCallEvidence: review.modelCallEvidence.slice(-2).map((call) => ({
                          attempt: call.attempt,
                          callId: call.callId,
                          payloadSha256: call.payloadSha256,
                          ...(call.outputSha256 === undefined
                            ? {}
                            : { outputSha256: call.outputSha256 }),
                          resultKind: call.resultKind,
                          attestation: call.attestation,
                          ...(call.toolEvidenceSha256 === undefined
                            ? {}
                            : { toolEvidenceSha256: call.toolEvidenceSha256 }),
                          ...(call.evidenceRequests === undefined
                            ? {}
                            : { evidenceRequests: call.evidenceRequests }),
                          ...(call.hypothesis === undefined ? {} : { hypothesis: call.hypothesis }),
                        })),
                        omittedModelCallEvidenceCount: Math.max(
                          0,
                          review.modelCallEvidence.length - 2,
                        ),
                      }),
                  ...(reviewedDecision
                    ? {
                        decision: {
                          candidateId: boundedEvidenceText(reviewedDecision.candidateId, 128),
                          decision: reviewedDecision.decision,
                          rationale: boundedEvidenceText(reviewedDecision.rationale, 240),
                          expectationGapPresent: reviewedDecision.expectationGap !== undefined,
                        },
                      }
                    : {}),
                },
              }
            : {}),
        }
      : null,
  };
}

/** Preserve whole-session counts and a bounded latest sample without embedding repeated account requests. */
export function summarizeFinanceNightIntradayEvidence(
  params: {
    asOf: string;
    sessionDate: string;
    decisions: readonly FinanceNightIntradayDecisionEvidence[];
  },
  maxTextBytes: number,
): string {
  if (!Number.isSafeInteger(maxTextBytes) || maxTextBytes <= 0) {
    throw new Error("night intraday evidence budget must be a positive integer");
  }
  const decisions = params.decisions;
  const outcomeReasons = decisions.flatMap((decision) => decision.outcome?.reasons ?? []);
  const safetyFailures = decisions.flatMap((decision) => {
    const failure = decision.outcome?.executionSafetyFailure;
    return failure
      ? [
          [
            failure.stage,
            failure.category,
            failure.operation ?? "",
            failure.provider?.reason ?? "",
            failure.provider?.stage ?? "",
          ].join(":"),
        ]
      : [];
  });
  const reviewStatuses = decisions.map(
    (decision) => decision.outcome?.tradeDecisionReview?.status ?? "not_reviewed",
  );
  const reviews = decisions.flatMap((decision) =>
    decision.outcome?.tradeDecisionReview ? [decision.outcome.tradeDecisionReview] : [],
  );
  const recordedReviewEvidence = {
    reviewsWithToolEvidence: reviews.filter((review) => (review.toolEvidence?.length ?? 0) > 0)
      .length,
    completedToolEvidenceCount: reviews.reduce(
      (count, review) =>
        count + (review.toolEvidence?.filter((item) => item.status === "completed").length ?? 0),
      0,
    ),
    unavailableToolEvidenceCount: reviews.reduce(
      (count, review) =>
        count + (review.toolEvidence?.filter((item) => item.status === "unavailable").length ?? 0),
      0,
    ),
    reviewsWithModelCallEvidence: reviews.filter(
      (review) => (review.modelCallEvidence?.length ?? 0) > 0,
    ).length,
    modelCallEvidenceCount: reviews.reduce(
      (count, review) => count + (review.modelCallEvidence?.length ?? 0),
      0,
    ),
  };
  const distributions = {
    byInstrument: countEvidenceLabels(decisions.map((decision) => decision.instrument)),
    byAction: countEvidenceLabels(decisions.map((decision) => decision.action)),
    byDecisionReason: countEvidenceLabels(decisions.map((decision) => decision.reason)),
    byOutcomeStatus: countEvidenceLabels(
      decisions.map((decision) => decision.outcome?.status ?? "missing_outcome"),
    ),
    byOutcomeReason: countEvidenceLabels(outcomeReasons),
    bySafetyFailure: countEvidenceLabels(safetyFailures),
    byReviewStatus: countEvidenceLabels(reviewStatuses),
  };

  let includedCount = Math.min(100, decisions.length);
  while (true) {
    const recent = includedCount === 0 ? [] : decisions.slice(-includedCount);
    const text = JSON.stringify({
      schemaVersion: "lcx_finance_night_intraday_evidence_v1",
      sessionDate: params.sessionDate,
      asOf: params.asOf,
      coverage: {
        totalDecisionCount: decisions.length,
        includedDecisionCount: recent.length,
        omittedDecisionCount: decisions.length - recent.length,
        samplePolicy: "latest_append_sequence_up_to_100",
        recordedReviewEvidence,
      },
      distributions,
      decisions: recent.map(compactFinanceNightIntradayDecision),
    });
    if (Buffer.byteLength(text, "utf8") <= maxTextBytes) {
      return text;
    }
    if (includedCount === 0) {
      throw new Error("night intraday evidence summary exceeds its assigned byte budget");
    }
    includedCount = Math.floor(includedCount / 2);
  }
}

const IntradaySummaryCount = z.number().int().nonnegative();
const IntradaySummaryDistribution = z
  .object({
    values: z.array(z.object({ value: z.string(), count: IntradaySummaryCount }).passthrough()),
    omittedCategoryCount: IntradaySummaryCount,
  })
  .passthrough();
const IntradaySummary = z
  .object({
    schemaVersion: z.literal("lcx_finance_night_intraday_evidence_v1"),
    sessionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    asOf: z.string().datetime({ offset: true }),
    coverage: z
      .object({
        totalDecisionCount: IntradaySummaryCount,
        includedDecisionCount: IntradaySummaryCount,
        omittedDecisionCount: IntradaySummaryCount,
        samplePolicy: z.literal("latest_append_sequence_up_to_100"),
        recordedReviewEvidence: z.record(z.string(), IntradaySummaryCount),
      })
      .passthrough(),
    distributions: z
      .object({
        byInstrument: IntradaySummaryDistribution,
        byAction: IntradaySummaryDistribution,
        byDecisionReason: IntradaySummaryDistribution,
        byOutcomeStatus: IntradaySummaryDistribution,
        byOutcomeReason: IntradaySummaryDistribution,
        bySafetyFailure: IntradaySummaryDistribution,
        byReviewStatus: IntradaySummaryDistribution,
      })
      .passthrough(),
    decisions: z
      .array(
        z
          .object({
            recordedAt: z.string().datetime({ offset: true }),
            signalId: z.string().min(1),
            instrument: z.string().min(1),
            action: z.string().min(1),
            reason: z.string(),
            referencePrice: z.number().finite(),
            referencePriceAt: z.string().datetime({ offset: true }),
            outcome: z
              .object({
                status: z.enum(["placed", "refused", "uncertain"]),
                reasons: z.array(z.string()),
              })
              .passthrough()
              .nullable(),
          })
          .passthrough(),
      )
      .max(100),
  })
  .strict();

/** Reproject an already bounded source, preserving its original whole-session counts and rows. */
export function narrowFinanceNightIntradayEvidence(
  text: string,
  maxTextBytes: number,
  source: Readonly<{ evidenceId: string; sourcePointer: string }>,
): string {
  if (!Number.isSafeInteger(maxTextBytes) || maxTextBytes <= 0) {
    throw new Error("night intraday evidence budget must be a positive integer");
  }
  const summary = IntradaySummary.parse(JSON.parse(text));
  if (source.evidenceId !== `finance-night:intraday:${summary.sessionDate}`) {
    throw new Error("night intraday evidence source identity is inconsistent");
  }
  const { totalDecisionCount, includedDecisionCount, omittedDecisionCount } = summary.coverage;
  if (
    includedDecisionCount !== summary.decisions.length ||
    totalDecisionCount !== includedDecisionCount + omittedDecisionCount
  ) {
    throw new Error("night intraday evidence coverage is inconsistent");
  }
  for (const key of [
    "byInstrument",
    "byAction",
    "byDecisionReason",
    "byOutcomeStatus",
    "byReviewStatus",
  ] as const) {
    const distribution = summary.distributions[key];
    const count = distribution.values.reduce((sum, row) => sum + row.count, 0);
    if (
      count > totalDecisionCount ||
      (distribution.omittedCategoryCount === 0 && count !== totalDecisionCount)
    ) {
      throw new Error("night intraday evidence distribution is inconsistent");
    }
  }
  let included = includedDecisionCount;
  while (true) {
    const projected = JSON.stringify({
      ...summary,
      coverage: {
        ...summary.coverage,
        includedDecisionCount: included,
        omittedDecisionCount: totalDecisionCount - included,
      },
      decisions: included === 0 ? [] : summary.decisions.slice(-included),
      projection: {
        kind: "bounded_existing_summary_rows",
        originalEvidenceId: source.evidenceId,
        originalTextSha256: createHash("sha256").update(text).digest("hex"),
        sourcePointer: source.sourcePointer,
        originalIncludedDecisionCount: includedDecisionCount,
        additionallyOmittedDecisionCount: includedDecisionCount - included,
        fullSourceReadClaimed: false,
      },
    });
    if (Buffer.byteLength(projected, "utf8") <= maxTextBytes) {
      return projected;
    }
    if (included === 0) {
      throw new Error("night intraday evidence summary exceeds its assigned byte budget");
    }
    included = Math.floor(included / 2);
  }
}

export type FinanceNightSettlementSummary = Readonly<{
  scoredFiled: Readonly<{
    appended: number;
    skipped: number;
    sourceWrite?: Readonly<{ path: string; sha256: string; bytes: number }>;
  }>;
  reflection: unknown;
  pending: readonly unknown[];
  declined: readonly unknown[];
  issues: readonly unknown[];
}>;

function compactReceipt(
  receipt: Awaited<ReturnType<typeof readFinancePositionLedger>>["receipts"][number],
) {
  return {
    receiptId: receipt.receiptId,
    intentId: receipt.intentId,
    runAuthorizationId: receipt.runAuthorizationId,
    adapterId: receipt.adapterId,
    adapterKind: receipt.adapterKind,
    venue: receipt.venue,
    instrument: receipt.instrument,
    side: receipt.side,
    quantity: receipt.quantity,
    referencePrice: receipt.referencePrice,
    referencePriceAt: receipt.referencePriceAt,
    recordedAt: receipt.recordedAt,
    fill: receipt.fill ?? null,
    ...(receipt.researchLineage === undefined
      ? {}
      : {
          researchLineageSummary: {
            planReceiptId: receipt.researchLineage.portfolioPlan.provenance?.receiptId ?? null,
            planAsOf: receipt.researchLineage.portfolioPlan.asOf,
            targetWeight: receipt.researchLineage.targetWeight,
            contributions: receipt.researchLineage.contributions.map((contribution) => ({
              strategyId: contribution.strategyId,
              evidenceReceiptId: contribution.evidenceReceiptId,
              stance: contribution.stance,
              accountWeight: contribution.accountWeight,
            })),
          },
        }),
  };
}

/** Read the same controller book used by execution; never infer activation from an ID. */
async function readFinanceActiveStrategyResearchEvidenceAndSource(params: {
  directory: string;
  asOf: string;
  /** When supplied, every requested id must name a rule active at `asOf`. */
  strategyIds?: readonly string[];
  /** Internal calculation projection. The default remains the bounded model-facing summary. */
  historyFormat?: "model_summary" | "daily_calculation";
  /** Internal subset used when hydrating an already supplied controller evidence packet. */
  instrumentIds?: readonly string[];
}): Promise<{
  evidence: readonly FinanceCommitteeEvidence[];
  source: FinanceActiveStrategyResearchSource;
}> {
  const snapshot = await readFinanceStrategyRuleLedger(params.directory, { asOf: params.asOf });
  const allActiveRules = snapshot.ledger.rules.filter((rule) => rule.state === "active");
  const requestedIds = params.strategyIds;
  if (requestedIds) {
    const requested = new Set(requestedIds);
    if (requested.size !== requestedIds.length || requestedIds.some((id) => !id.trim())) {
      throw new Error("portfolio activeStrategyIds must be unique nonempty controller rule ids");
    }
    const activeById = new Map(allActiveRules.map((rule) => [rule.ruleId, rule]));
    const unavailable = requestedIds.filter((id) => !activeById.has(id));
    if (unavailable.length > 0) {
      throw new Error(
        `portfolio strategies are not active in the controller ledger at asOf: ${unavailable.join(", ")}`,
      );
    }
  }
  const activeRules = requestedIds
    ? requestedIds.map((id) => allActiveRules.find((rule) => rule.ruleId === id)!)
    : allActiveRules;
  const declaredInstruments = [
    ...new Set(
      activeRules.flatMap((rule) => rule.instruments.map((item) => item.trim().toUpperCase())),
    ),
  ];
  const instruments = params.instrumentIds
    ? [...new Set(params.instrumentIds)]
    : declaredInstruments;
  if (
    params.instrumentIds &&
    instruments.some((instrument) => !declaredInstruments.includes(instrument))
  ) {
    throw new Error("controller history instrument subset is outside the active strategy scope");
  }
  if (requestedIds && instruments.length === 0) {
    throw new Error("controller active strategies declare no research instruments");
  }
  if (instruments.length > 14) {
    throw new Error("active strategy history exceeds controller evidence budget");
  }
  const months = financeControllerHistoryMonths(activeRules);
  const start = new Date(params.asOf);
  // The prior anchor can close before today's day-of-month. Retain its whole
  // calendar month rather than silently dropping a valid 12-month comparison.
  start.setUTCDate(1);
  start.setUTCMonth(start.getUTCMonth() - months - 1);
  const fromDate = start.toISOString().slice(0, 10);
  const toDate = latestCompletedWeekdaySessionDate(params.asOf);
  const book =
    instruments.length > 0
      ? await readFinanceBarLedger(params.directory, { instruments, asOf: params.asOf })
      : undefined;
  const histories = book
    ? instruments.map((instrument) => {
        const rawWindow = book.bars.filter(
          (bar) => bar.instrument === instrument && bar.date >= fromDate && bar.date <= toDate,
        );
        // This is a close-only projection: differing OHLC records with the same close
        // must not manufacture extra return observations. Conflicting closes remain.
        const window = [
          ...new Map(rawWindow.map((bar) => [JSON.stringify([bar.date, bar.close]), bar])).values(),
        ];
        const bars = window.slice(-400);
        const monthEndDates = new Map<string, string>();
        // The daily display cap must not shorten the declared method horizon.
        for (const bar of window) {
          const month = bar.date.slice(0, 7);
          const prior = monthEndDates.get(month);
          if (!prior || bar.date > prior) {
            monthEndDates.set(month, bar.date);
          }
        }
        const monthlyCloseObservations = [...monthEndDates.entries()]
          .toSorted(([left], [right]) => left.localeCompare(right))
          .map(([month, sessionDate]) => ({
            month,
            sessionDate,
            closeValues: [
              ...new Set(window.filter((bar) => bar.date === sessionDate).map((bar) => bar.close)),
            ].toSorted((left, right) => left - right),
          }));
        const divergentDates = book.divergentDates.filter((key) => {
          const date = key.slice(key.lastIndexOf("@") + 1);
          return key.startsWith(`${instrument}@`) && date >= fromDate && date <= toDate;
        });
        const historyPayload =
          params.historyFormat === "daily_calculation"
            ? {
                instrument,
                headRef: book.headRef,
                fromDate,
                toDate,
                windowBarCount: window.length,
                rawBarCount: rawWindow.length,
                collapsedRepeatedCloses: rawWindow.length - window.length,
                suppliedBarCount: bars.length,
                omittedByLimit: window.length - bars.length,
                divergentDates,
                closes: bars.map((bar) => [bar.date, bar.close]),
                monthlyCloseObservations,
              }
            : {
                instrument,
                headRef: book.headRef,
                fromDate,
                toDate,
                windowBarCount: window.length,
                rawBarCount: rawWindow.length,
                collapsedRepeatedCloses: rawWindow.length - window.length,
                uniqueSessionDates: new Set(window.map((bar) => bar.date)).size,
                suppliedBarCount: window.length,
                omittedByLimit: 0,
                divergentDates,
                divergentCloseObservations: divergentDates.map((key) => {
                  const sessionDate = key.slice(key.lastIndexOf("@") + 1);
                  return {
                    sessionDate,
                    closeValues: [
                      ...new Set(
                        window.filter((bar) => bar.date === sessionDate).map((bar) => bar.close),
                      ),
                    ].toSorted((left, right) => left - right),
                  };
                }),
                boundary:
                  "stored historical observations summarized to the last session in the requested window per calendar month; conflicts remain explicit; not a daily-volatility input, execution quote or independently verified adjusted total return series",
                columns: ["month", "sessionDate", "closeValues"],
                monthlyCloseObservations,
              };
        const evidence: FinanceCommitteeEvidence = {
          id: `finance-controller:eod:${instrument}`,
          source: "finance-bar-ledger",
          timestamp: params.asOf,
          text: JSON.stringify(historyPayload),
        };
        return {
          evidence,
          // Keep daily rows out of model context while the existing numerical engine
          // still receives its actual inputs. The durable book and headRef retain them.
          calculationInput: {
            ...evidence,
            text: JSON.stringify({
              instrument,
              divergentDates,
              suppliedBarCount: window.length,
              closes: window.map((bar) => [bar.date, bar.close]),
            }),
          },
        };
      })
    : [];
  const selectedRules = activeRules.map((rule) => ({
    ruleId: rule.ruleId,
    form: rule.form,
    formVersion: rule.formVersion,
    instruments: rule.instruments,
    emits: rule.emits,
    schedule: rule.schedule,
    declaredAt: rule.declaredAt,
    body: rule.body,
    declarationClaimBoundary:
      "body (including openRisks) contains owner claims as of declaredAt; it is not current runtime policy or readiness",
    currentRuntimePolicyAndReadiness: "unknown_without_separately_timestamped_current_evidence",
    activeObservedAt: rule.activeObservedAt,
    provenance: rule.provenance,
  }));
  const activeStrategyEvidence: FinanceCommitteeEvidence = {
    id: "finance-controller:active-strategies",
    source: "finance-strategy-rule-ledger",
    timestamp: params.asOf,
    text: JSON.stringify({
      boundary:
        "controller state only; activation does not prove readiness, performance or Live authority",
      scope: requestedIds ? "portfolio_allocation_subset" : "all_controller_active_rules",
      allControllerActiveRuleIds: allActiveRules.map((rule) => rule.ruleId),
      ...(requestedIds ? { allocationStrategyIds: requestedIds } : {}),
      ruleScope:
        (requestedIds
          ? "This allocation review does not enumerate every active controller rule. Other active rule IDs above remain outside this portfolio allocation scope; their parameters and readiness require their own controller evidence. "
          : "Review all controller rules active at this asOf. ") +
        "Review these declared rule bodies; generic method-kit examples do not replace the active rule parameters.",
      activeRules: selectedRules,
    }),
  };
  const evidence = [
    activeStrategyEvidence,
    ...histories.map((history) => history.evidence),
    ...buildFinanceMonthlyTrendDerivedEvidence(
      [activeStrategyEvidence, ...histories.map((history) => history.calculationInput)],
      params.asOf,
    ),
  ];
  return {
    evidence,
    source: {
      directory: path.resolve(params.directory),
      asOf: params.asOf,
      storedHeadRef: snapshot.headRef,
      projectedHeadRef: snapshot.ledger.headRef,
      storedRecordCount: snapshot.recordCount,
      projectedRecordCount: snapshot.ledger.recordCount,
      selectedRuleIds: activeRules.map((rule) => rule.ruleId),
      selectedRulesSha256: caseflowFingerprint(selectedRules),
    },
  };
}

/** Compatibility evidence surface; the same read also supplies exact owner provenance. */
export async function buildFinanceActiveStrategyResearchEvidence(
  params: Parameters<typeof readFinanceActiveStrategyResearchEvidenceAndSource>[0],
): Promise<readonly FinanceCommitteeEvidence[]> {
  return (await readFinanceActiveStrategyResearchEvidenceAndSource(params)).evidence;
}

/** Resolve exact active rule instruments together with their controller evidence. */
export async function readFinanceActiveStrategyResearchScope(params: {
  directory: string;
  asOf: string;
  strategyIds: readonly string[];
}): Promise<
  Readonly<{
    instruments: readonly string[];
    intradayInstruments: readonly string[];
    historyMonths: number;
    evidence: readonly FinanceCommitteeEvidence[];
    source: FinanceActiveStrategyResearchSource;
  }>
> {
  const { evidence, source } = await readFinanceActiveStrategyResearchEvidenceAndSource(params);
  const activeStrategyEvidence = evidence.find(
    (item) => item.id === "finance-controller:active-strategies",
  );
  if (!activeStrategyEvidence) {
    throw new Error("controller active strategy evidence is missing");
  }
  const payload = JSON.parse(activeStrategyEvidence.text) as {
    activeRules?: readonly {
      instruments?: readonly unknown[];
      schedule?: { kind?: unknown };
      body?: unknown;
    }[];
  };
  const normalizeRuleInstruments = (rule: { instruments?: readonly unknown[] }) =>
    (rule.instruments ?? []).flatMap((instrument) =>
      typeof instrument === "string" && instrument.trim() ? [instrument.trim().toUpperCase()] : [],
    );
  const activeRules = payload.activeRules ?? [];
  const instruments = [...new Set(activeRules.flatMap(normalizeRuleInstruments))];
  const intradayInstruments = [
    ...new Set(
      activeRules.flatMap((rule) =>
        rule.schedule?.kind === "intraday" ? normalizeRuleInstruments(rule) : [],
      ),
    ),
  ];
  const historyMonths = financeControllerHistoryMonths(activeRules);
  return Object.freeze({
    instruments: Object.freeze(instruments),
    intradayInstruments: Object.freeze(intradayInstruments),
    historyMonths,
    evidence,
    source,
  });
}

type BrokerProfitFeedback = Awaited<ReturnType<typeof readFinanceBrokerProfitFeedback>>;
type BrokerReconciliationRead = Awaited<ReturnType<typeof readFinanceLatestBrokerReconciliations>>;

function projectFinanceBrokerAccountResearchSummary(params: {
  asOf: string;
  brokerProfit: BrokerProfitFeedback;
  brokerReconciliations: BrokerReconciliationRead;
  includeAccountFields?: boolean;
  accountPerformance?: readonly Awaited<ReturnType<typeof readFinancePaperEconomicWindow>>[];
}) {
  return {
    ...(params.includeAccountFields
      ? {
          executionAuthority: "none",
          dataBasis: "canonical_local_broker_reconciliation_snapshots",
          missingFields: params.brokerReconciliations.records.length ? [] : ["positionSnapshots"],
        }
      : {}),
    ...(params.accountPerformance ? { accountPerformance: params.accountPerformance } : {}),
    attributionScope: "account_totals_not_instrument_or_strategy_totals",
    instrumentAttribution:
      "not_provided; do not assign account fill counts or fees to the requested instrument",
    boundary:
      "broker_paper_not_local_simulation; net excludes tax/fx; fill ownership is not strategy PnL",
    positionSnapshots: params.brokerReconciliations.records.map((record) => {
      const snapshot: unknown = record.snapshot;
      const snapshotObject =
        typeof snapshot === "object" && snapshot !== null && !Array.isArray(snapshot)
          ? (snapshot as Record<string, unknown>)
          : undefined;
      const observedAt =
        typeof snapshotObject?.observedAt === "string" ? snapshotObject.observedAt : undefined;
      const observedAtMs = observedAt ? Date.parse(observedAt) : Number.NaN;
      if (!snapshotObject || !observedAt || !Number.isFinite(observedAtMs)) {
        return {
          accountId: record.accountId,
          venue: record.venue,
          snapshotRef: record.ref,
          freshness: "invalid_timestamp",
          ...(params.includeAccountFields
            ? { missingFields: ["observedAt", "usable_account_snapshot"] }
            : {}),
        };
      }
      if (observedAtMs > Date.parse(params.asOf)) {
        return {
          accountId: record.accountId,
          venue: record.venue,
          snapshotRef: record.ref,
          freshness: "outside_cutoff",
          ...(params.includeAccountFields
            ? { missingFields: ["usable_account_snapshot_at_asOf"] }
            : {}),
        };
      }
      const snapshotPositions = Array.isArray(snapshotObject.positions)
        ? snapshotObject.positions.flatMap((value) => {
            if (typeof value !== "object" || value === null || Array.isArray(value)) {
              return [];
            }
            const position = value as Record<string, unknown>;
            const rawQuantity = position.qty;
            const quantity =
              typeof rawQuantity === "number"
                ? rawQuantity
                : typeof rawQuantity === "string" && rawQuantity.trim()
                  ? Number(rawQuantity)
                  : Number.NaN;
            const rawMarketValue = position.market_value;
            const marketValue =
              typeof rawMarketValue === "number"
                ? rawMarketValue
                : typeof rawMarketValue === "string" && rawMarketValue.trim()
                  ? Number(rawMarketValue)
                  : Number.NaN;
            return typeof position.symbol === "string" && Number.isFinite(quantity)
              ? [
                  {
                    symbol: position.symbol,
                    quantity,
                    ...(params.includeAccountFields
                      ? { marketValue: Number.isFinite(marketValue) ? marketValue : null }
                      : {}),
                  },
                ]
              : [];
          })
        : [];
      const protection =
        typeof snapshotObject.protection === "object" &&
        snapshotObject.protection !== null &&
        !Array.isArray(snapshotObject.protection)
          ? (snapshotObject.protection as Record<string, unknown>)
          : undefined;
      const rawCash = snapshotObject.brokerCash;
      const cash =
        typeof rawCash === "number"
          ? rawCash
          : typeof rawCash === "string" && rawCash.trim()
            ? Number(rawCash)
            : Number.NaN;
      const rawObservation = snapshotObject.accountObservation;
      const observation =
        typeof rawObservation === "object" &&
        rawObservation !== null &&
        !Array.isArray(rawObservation)
          ? (rawObservation as Record<string, unknown>)
          : undefined;
      const accountObservedAtMs =
        typeof observation?.observedAt === "string"
          ? Date.parse(observation.observedAt)
          : Number.NaN;
      const accountObservationValid =
        record.venue === "alpaca:paper" &&
        observation?.accountId === record.accountId &&
        observation.currency === "USD" &&
        observation.source === "https://paper-api.alpaca.markets/v2/account" &&
        Number.isFinite(accountObservedAtMs) &&
        accountObservedAtMs <= observedAtMs &&
        accountObservedAtMs <= Date.parse(params.asOf) &&
        Date.parse(params.asOf) - accountObservedAtMs <= 300_000 &&
        typeof observation.cash === "number" &&
        Number.isFinite(observation.cash) &&
        observation.cash === cash;
      const observedNumber = (value: unknown): number | null =>
        accountObservationValid && typeof value === "number" && Number.isFinite(value)
          ? value
          : null;
      const equity = observedNumber(observation?.equity);
      const buyingPower = observedNumber(observation?.buyingPower);
      const portfolioValue = observedNumber(observation?.portfolioValue);
      const missingFields = [
        ...(!Number.isFinite(cash) ? ["brokerCash"] : []),
        ...(equity === null ? ["equity"] : []),
        ...(buyingPower === null ? ["buyingPower"] : []),
        ...(portfolioValue === null ? ["portfolioValue"] : []),
        ...(!Array.isArray(snapshotObject.positions) ? ["positions"] : []),
        ...(Array.isArray(snapshotObject.positions) &&
        snapshotPositions.length !== snapshotObject.positions.length
          ? ["positions.invalid_entries"]
          : []),
        ...(params.includeAccountFields &&
        snapshotPositions.some((position) => position.marketValue === null)
          ? ["positions.market_value"]
          : []),
        ...(!Array.isArray(protection?.coverage) ? ["protectionCoverage"] : []),
      ];
      return {
        accountId: record.accountId,
        venue: record.venue,
        snapshotRef: record.ref,
        observedAt,
        ...(params.includeAccountFields
          ? {
              brokerCash: Number.isFinite(cash) ? cash : null,
              equity,
              buyingPower,
              portfolioValue,
              accountBalanceDiagnostics: {
                balanceAsOf: accountObservationValid
                  ? (z.iso.date().safeParse(observation?.balanceAsOf).data ?? null)
                  : null,
                accruedFees: observedNumber(observation?.accruedFees),
                pendingRegTafFees: observedNumber(observation?.pendingRegTafFees),
                intradayAdjustments: observedNumber(observation?.intradayAdjustments),
                boundary:
                  "vendor_account_observations_only; balanceAsOf_is_not_capture_time; no_cash_offset_or_fee_attribution",
              },
              accountObservationSource: accountObservationValid ? observation.source : null,
              accountObservationObservedAt:
                accountObservationValid && typeof observation.observedAt === "string"
                  ? observation.observedAt
                  : null,
              missingFields,
            }
          : {}),
        freshness:
          !record.superseded && Date.parse(params.asOf) - observedAtMs <= 300_000
            ? "fresh"
            : "stale",
        positions: snapshotPositions,
        protectionCoverage: Array.isArray(protection?.coverage)
          ? protection.coverage.flatMap((value) => {
              if (typeof value !== "object" || value === null || Array.isArray(value)) {
                return [];
              }
              const item = value as Record<string, unknown>;
              return typeof item.instrument === "string"
                ? [
                    {
                      instrument: item.instrument,
                      positionQuantity: item.positionQuantity,
                      recognizedStopQuantity: item.recognizedStopQuantity,
                      uncoveredQuantity: item.uncoveredQuantity,
                      status: item.status,
                    },
                  ]
                : [];
            })
          : [],
      };
    }),
    omittedPositionSnapshotAccounts: params.brokerReconciliations.omittedAccounts,
    status: params.brokerProfit.status,
    ...(params.brokerProfit.status === "unavailable" ? { reason: params.brokerProfit.reason } : {}),
    accounts:
      "accounts" in params.brokerProfit
        ? params.brokerProfit.accounts?.map((account) => ({
            ...(params.includeAccountFields
              ? {
                  accountId: params.brokerReconciliations.records.find(
                    (record) => record.ref === account.snapshotRef,
                  )?.accountId,
                  venue: params.brokerReconciliations.records.find(
                    (record) => record.ref === account.snapshotRef,
                  )?.venue,
                  snapshotRef: account.snapshotRef,
                }
              : {}),
            status: account.status,
            ...("netMatchedPnl" in account
              ? {
                  netMatchedPnl: account.netMatchedPnl,
                  methodPerformance: {
                    ...account.methodPerformance,
                    methods: account.methodPerformance.methods.slice(0, 3),
                    omittedMethods: Math.max(0, account.methodPerformance.methods.length - 3),
                  },
                  buyFills: account.buyFills,
                  sellFills: account.sellFills,
                  matchedLotCount: account.matchedLotCount,
                  feeActivityCount: account.feeActivityCount,
                  unallocatedFeeActivityCount: account.unallocatedFeeActivityCount,
                  attributedFillCount: account.strategyAttribution.attributedFillCount,
                  unattributedFillCount: account.strategyAttribution.unattributedFillCount,
                  decisionSourceLineage: account.strategyAttribution.decisionSourceLineage,
                  observedAt: account.observedAt,
                  freshness: account.freshness,
                }
              : {}),
          }))
        : [],
  };
}

/** Resume coverage from original immutable research receipts, never an adoption acknowledgement. */
export async function readFinanceScheduledIntradayHistory(params: {
  directory: string;
  asOf: string;
  accountId: string;
  researchWorkspaceDir?: string;
}) {
  const read = (cursor?: string) =>
    readFinanceIntradayAccountHistory(params.directory, {
      accountId: params.accountId,
      asOf: params.asOf,
      ...(cursor ? { cursor } : {}),
    });
  if (!params.researchWorkspaceDir) {
    return read();
  }
  const object = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  try {
    const index = readFinanceSchedulerDatabaseResearchRuns(params.directory);
    const runs = index.runs.map((entry) => object(entry.run));
    for (const run of runs) {
      if (
        typeof run.completedAt !== "string" ||
        !Number.isFinite(Date.parse(run.completedAt)) ||
        Date.parse(run.completedAt) >= Date.parse(params.asOf)
      ) {
        continue;
      }
      const mode = run.mode;
      const phase = object(
        mode === "day" ? run.researchPlanRefresh : mode === "night" ? run.nightReview : undefined,
      );
      const process = object(phase.processResult);
      if (
        typeof process.stdout !== "string" ||
        Buffer.byteLength(process.stdout, "utf8") > 2_097_152
      ) {
        continue;
      }
      if (process.outputTruncated === true) {
        throw new Error("scheduled_history_summary_truncated");
      }
      let summary: Record<string, unknown>;
      try {
        summary = object(JSON.parse(process.stdout));
      } catch {
        if (phase.ok === true) {
          throw new Error("scheduled_history_success_summary_unreadable");
        }
        continue;
      }
      const written = object(summary.written);
      if (
        typeof written.datedPath !== "string" ||
        typeof written.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(written.sha256)
      ) {
        continue;
      }
      const root = await fs.realpath(
        path.join(params.researchWorkspaceDir, "state", "finance-research-runs"),
      );
      const filename = await fs.realpath(written.datedPath);
      const relative = path.relative(root, filename);
      if (
        !/^\d{4}-\d{2}-\d{2}[/\\]\d{4}-\d{2}-\d{2}T[\d-]+Z(?:__[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})?__finance-research-run\.json$/u.test(
          relative,
        )
      ) {
        throw new Error("scheduled_history_receipt_outside_archive");
      }
      const handle = await fs.open(filename, "r");
      let bytes: Buffer;
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > 8_388_608) {
          throw new Error("scheduled_history_receipt_oversize");
        }
        const buffer = Buffer.alloc(stat.size + 1);
        let length = 0;
        while (length < buffer.length) {
          const result = await handle.read(buffer, length, buffer.length - length, null);
          if (result.bytesRead === 0) {
            break;
          }
          length += result.bytesRead;
        }
        bytes = buffer.subarray(0, length);
      } finally {
        await handle.close();
      }
      if (
        bytes.length > 8_388_608 ||
        createHash("sha256").update(bytes).digest("hex") !== written.sha256
      ) {
        throw new Error("scheduled_history_receipt_hash_mismatch");
      }
      const receipt = object(JSON.parse(bytes.toString("utf8")));
      const plan = object(receipt.plan);
      const expectedAsOf = mode === "day" ? run.firedAt : object(phase.acceptance).expectedAsOf;
      if (
        receipt.schemaVersion !== "lcx_finance_research_run_v1" ||
        receipt.boundary !== "finance_research_run_research_only" ||
        typeof plan.asOf !== "string" ||
        !Number.isFinite(Date.parse(plan.asOf)) ||
        plan.asOf !== expectedAsOf ||
        Date.parse(plan.asOf) > Date.parse(run.completedAt)
      ) {
        throw new Error("scheduled_history_receipt_scope_mismatch");
      }
      const evidence = object(receipt.batch).committeeEvidence;
      if (!Array.isArray(evidence)) {
        continue;
      }
      const histories: {
        history: Record<string, unknown>;
        evidenceId: string;
        evidenceSha256: string;
      }[] = [];
      for (const raw of evidence) {
        const item = object(raw);
        if (typeof item.text !== "string") {
          continue;
        }
        const evidenceId = typeof item.id === "string" ? item.id : "";
        const evidenceSha256 = createHash("sha256").update(item.text).digest("hex");
        if (
          mode === "day" &&
          item.id === "finance-controller:broker-account-summary" &&
          item.source === "finance-broker-profit-summary"
        ) {
          histories.push({
            history: object(object(JSON.parse(item.text)).intradayExecutionHistory),
            evidenceId,
            evidenceSha256,
          });
        } else if (
          mode === "night" &&
          typeof run.etDate === "string" &&
          item.id === `finance-night:execution-history:${run.etDate}` &&
          item.source === "finance-daily-execution-history"
        ) {
          const accounts = object(JSON.parse(item.text)).accounts;
          if (Array.isArray(accounts)) {
            for (const account of accounts) {
              const value = object(account),
                history = object(value.intradayHistory);
              if (value.accountId !== history.accountId) {
                throw new Error("scheduled_history_account_scope_mismatch");
              }
              histories.push({ history, evidenceId, evidenceSha256 });
            }
          }
        }
      }
      const matching = histories.filter(
        (entry) =>
          entry.history.accountId === params.accountId && entry.history.venue === "alpaca:paper",
      );
      if (matching.length === 0) {
        continue;
      }
      if (
        matching.length !== 1 ||
        matching[0].history.status !== "observed" ||
        matching[0].history.asOf !== plan.asOf ||
        !Array.isArray(matching[0].history.entries)
      ) {
        throw new Error("scheduled_history_projection_unverified");
      }
      const { history, evidenceId, evidenceSha256 } = matching[0];
      const review = object(receipt.intradayFeedbackReview);
      const responses = Array.isArray(review.entries) ? review.entries.map(object) : [];
      const expectedEntries = (history.entries as unknown[]).map(object);
      const pendingCount = expectedEntries.filter((entry) => {
        const matchingResponses = responses.filter(
          (response) =>
            response.outcomeRef === entry.outcomeRef &&
            response.decisionRef === entry.decisionRef &&
            response.accountId === params.accountId,
        );
        if (
          review.schemaVersion !== "finance_research_intraday_feedback_review_v1" ||
          review.researchAccepted !== true ||
          review.boundary !==
            "reported_research_response_not_configuration_publication_execution_or_adoption" ||
          matchingResponses.length !== 1
        ) {
          return true;
        }
        const response = matchingResponses[0];
        return (
          typeof response.disposition !== "string" ||
          !["considered", "deferred", "rejected"].includes(response.disposition) ||
          response.responseSource !== "quality_final_artifact" ||
          typeof response.reason !== "string" ||
          !response.reason.trim() ||
          !Array.isArray(response.evidence) ||
          !response.evidence.some((rawSource) => {
            const source = object(rawSource);
            return source.id === evidenceId && source.sha256 === evidenceSha256;
          })
        );
      }).length;
      const accepted = phase.ok === true;
      const canAdvance = accepted && pendingCount === 0;
      let cursor = canAdvance ? (history.resumeCursor ?? history.nextCursor) : history.pageCursor;
      let legacyProgressReplay = false;
      if (canAdvance && cursor === null) {
        legacyProgressReplay = true;
        cursor = undefined;
      } else if (typeof cursor === "string") {
        const prior = object(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
        if (prior.v === undefined && typeof prior.scope === "string") {
          // A verified old host receipt may trigger conservative replay, never
          // authentication or advancement of its unsigned progress fields.
          legacyProgressReplay = true;
          cursor = undefined;
        }
      }
      if (!legacyProgressReplay && cursor !== null && typeof cursor !== "string") {
        return {
          ...(await read()),
          continuation: {
            status: "initial_window",
            reason: "prior_receipt_has_no_continuation",
            sourceReceiptSha256: written.sha256,
          },
        };
      }
      const current = await read(typeof cursor === "string" ? cursor : undefined);
      return {
        ...current,
        continuation: {
          status:
            current.status !== "observed"
              ? "unavailable"
              : legacyProgressReplay
                ? "legacy_progress_replayed_untrusted"
                : canAdvance
                  ? history.nextCursor === null
                    ? "historical_window_complete"
                    : "resumed"
                  : accepted
                    ? "retrying_unaddressed_feedback_page"
                    : "retrying_failed_research_page",
          ...(legacyProgressReplay
            ? { reason: "unsigned_or_missing_resume_progress_not_trusted" }
            : {}),
          pendingFeedbackCount: pendingCount,
          reasonsRetainedIn: "original_hashed_research_receipt",
          sourceRunId: run.runId,
          sourceMode: mode,
          sourceReceiptSha256: written.sha256,
          boundary: "history_input_coverage_not_model_adoption_or_execution_authority",
        },
      };
    }
    if (index.olderRunsMayExist) {
      throw new Error("scheduled_history_scoped_receipt_outside_bounded_window");
    }
    return {
      ...(await read()),
      continuation: { status: "initial_window", reason: "no_prior_scoped_receipt" },
    };
  } catch (error) {
    const gap =
      error instanceof Error && /^scheduled_history_[a-z_]+$/u.test(error.message)
        ? error.message
        : "scheduled_history_original_read_failed";
    return {
      continuationGap: gap,
      status: "unavailable" as const,
      accountId: params.accountId,
      venue: "alpaca:paper" as const,
      asOf: params.asOf,
      entries: [],
      reason: "scheduled_history_continuation_unverified",
      boundary: "history_input_coverage_not_model_adoption_or_execution_authority",
    };
  }
}

/** Local canonical observations only: no broker call, allocation or execution authority. */
export async function buildFinanceBrokerAccountResearchEvidence(
  params: Parameters<typeof buildFinanceBrokerAccountResearchEvidenceSnapshot>[0],
) {
  return withFinanceBrokerHistorySnapshot(params.directory, () =>
    buildFinanceBrokerAccountResearchEvidenceSnapshot(params),
  );
}

async function buildFinanceBrokerAccountResearchEvidenceSnapshot(params: {
  directory: string;
  asOf: string;
  /** Both fields select one canonical book; omit both for the legacy night aggregate. */
  accountId?: string;
  /** Canonical ledger venue, e.g. alpaca:paper. No alias or Paper/Live fallback is applied. */
  venue?: string;
  /** Callers may retain an existing evidence identity, including the night review identity. */
  evidenceId?: string;
  researchWorkspaceDir?: string;
}): Promise<FinanceCommitteeEvidence> {
  if (!Number.isFinite(Date.parse(params.asOf)) || Date.parse(params.asOf) > Date.now()) {
    throw new Error("account research evidence requires a valid non-future asOf");
  }
  const scoped = params.accountId !== undefined || params.venue !== undefined;
  if (scoped && (!params.accountId?.trim() || !params.venue?.trim())) {
    throw new Error("account research evidence requires both accountId and venue");
  }
  const readReconciliations = async (): Promise<BrokerReconciliationRead> => {
    if (!scoped) {
      return readFinanceLatestBrokerReconciliations(params.directory, { asOf: params.asOf });
    }
    return readFinanceLatestBrokerReconciliations(params.directory, {
      asOf: params.asOf,
      scope: { accountId: params.accountId ?? "", venue: params.venue ?? "" },
    });
  };
  const reconciliationRead = readReconciliations();
  const [brokerProfit, brokerReconciliations] = await Promise.all([
    readFinanceBrokerProfitFeedback(params.directory, params.asOf, {
      reconciliationObservation: {
        directory: params.directory,
        asOf: params.asOf,
        read: () => reconciliationRead,
      },
    }),
    reconciliationRead,
  ]);
  const accountPerformance = await Promise.all(
    [
      ...new Set(
        brokerReconciliations.records
          .filter(
            (r) => r.venue === "alpaca:paper" && (!scoped || r.accountId === params.accountId),
          )
          .map((r) => r.accountId),
      ),
    ]
      .slice(0, 2)
      .map((accountId) => readFinancePaperEconomicWindow(params.directory, accountId, params.asOf)),
  );
  const projected = projectFinanceBrokerAccountResearchSummary({
    asOf: params.asOf,
    brokerProfit,
    brokerReconciliations,
    includeAccountFields: true,
    accountPerformance,
  });
  const accountProfit =
    projected.accounts?.filter(
      (account) => account.accountId === params.accountId && account.venue === params.venue,
    ) ?? [];
  const accountSnapshot = projected.positionSnapshots[0];
  const usableCurrentAccountFacts =
    accountSnapshot?.freshness === "fresh" &&
    accountSnapshot.missingFields !== undefined &&
    !accountSnapshot.missingFields.some((field) =>
      ["brokerCash", "positions", "positions.invalid_entries"].includes(field),
    );
  const summary = scoped
    ? {
        ...projected,
        accountScope: { accountId: params.accountId, venue: params.venue },
        ...(params.venue === "alpaca:paper"
          ? {
              executionHistory: readFinanceDailyDecisionHistory({
                directory: params.directory,
                accountId: params.accountId,
                asOf: params.asOf,
              }),
              intradayExecutionHistory: await readFinanceScheduledIntradayHistory({
                directory: params.directory,
                accountId: params.accountId ?? "",
                asOf: params.asOf,
                researchWorkspaceDir: params.researchWorkspaceDir,
              }),
            }
          : {}),
        currentAccountFactsStatus: usableCurrentAccountFacts ? "observed" : "unknown",
        positionSnapshots: projected.positionSnapshots.map((snapshot) =>
          usableCurrentAccountFacts
            ? snapshot
            : {
                accountId: snapshot.accountId,
                venue: snapshot.venue,
                snapshotRef: snapshot.snapshotRef,
                observedAt: "observedAt" in snapshot ? snapshot.observedAt : undefined,
                freshness: snapshot.freshness,
                missingFields: [...(snapshot.missingFields ?? []), "usable_current_account_facts"],
                brokerCash: null,
                equity: null,
                buyingPower: null,
                portfolioValue: null,
                accountObservationSource: null,
                accountObservationObservedAt: null,
                positions: null,
                protectionCoverage: null,
              },
        ),
        accounts: accountProfit,
        status: accountProfit.length ? "present" : "unavailable",
        missingFields: [
          ...(projected.missingFields ?? []),
          ...(accountProfit.length ? [] : ["profit_summary_for_account"]),
        ],
      }
    : projected;
  return Object.freeze({
    id: params.evidenceId ?? "finance-controller:broker-account-summary",
    source: "finance-broker-profit-summary",
    timestamp: params.asOf,
    text: JSON.stringify(summary),
  });
}

export async function buildFinanceNightReviewEvidence(params: {
  directory: string;
  asOf: string;
  etDate: string;
  settlement: FinanceNightSettlementSummary;
  /** Include a fail-closed typed scope only for scheduler night research runs. */
  includeResearchScope?: boolean;
  researchWorkspaceDir?: string;
  preferredAccountId?: string;
}): Promise<readonly FinanceCommitteeEvidence[]> {
  const positionRead = readFinancePositionLedger(params.directory, { asOf: params.asOf });
  const reconciliationRead = readFinanceLatestBrokerReconciliations(params.directory);
  const [positions, strategyRules, decisions, brokerProfit, brokerReconciliations, scopedHoldings] =
    await Promise.all([
      positionRead,
      readFinanceStrategyRuleLedger(params.directory, { asOf: params.asOf }),
      readFinanceIntradayDecisions(params.directory, {
        sessionDate: params.etDate,
        asOf: params.asOf,
      }),
      readFinanceBrokerProfitFeedback(params.directory, params.asOf, {
        positionObservation: {
          directory: params.directory,
          asOf: params.asOf,
          read: () => positionRead,
        },
        reconciliationObservation: {
          directory: params.directory,
          asOf: params.asOf,
          read: () => reconciliationRead,
        },
      }),
      reconciliationRead,
      readFinanceLatestBrokerReconciliations(params.directory, { asOf: params.asOf }),
    ]);
  const outcomesBySignal = await readFinanceIntradayOutcomes(
    params.directory,
    decisions.map((decision) => decision.input.signalId),
    { asOf: params.asOf },
  );
  const outcomes = decisions.map((decision) => ({
    recordedAt: decision.recordedAt,
    signalId: decision.input.signalId,
    instrument: decision.input.instrument,
    action: decision.input.action,
    reason: decision.input.reason,
    referencePrice: decision.input.referencePrice,
    referencePriceAt: decision.input.referencePriceAt,
    outcome: outcomesBySignal.get(decision.input.signalId) ?? null,
  }));
  const activeRules = strategyRules.ledger.rules
    .filter((rule) => rule.state === "active")
    .map((rule) => ({
      ruleId: rule.ruleId,
      form: rule.form,
      formVersion: rule.formVersion,
      instruments: rule.instruments,
      emits: rule.emits,
      schedule: rule.schedule,
      declaredAt: rule.declaredAt,
      body: rule.body,
      declarationClaimBoundary:
        "body (including openRisks) contains owner claims as of declaredAt; it is not current runtime policy or readiness",
      currentRuntimePolicyAndReadiness: "unknown_without_separately_timestamped_current_evidence",
      activeObservedAt: rule.activeObservedAt,
      provenance: rule.provenance,
    }));
  const positionsAtAsOf = projectFinanceNightPositionsAtAsOf({
    positionRead: positions,
    asOf: params.asOf,
  });
  // Risk inventory belongs to a broker account, never to the combined simulation ledger.
  const accountInventories = scopedHoldings.records
    .filter((record) => record.venue === "alpaca:paper")
    .map((record) => {
      const inventory = projectFinanceNightResearchHoldings({
        positionRead: { ...positions, receipts: [] },
        brokerRead: { ...scopedHoldings, records: [record] },
        asOf: params.asOf,
      });
      const usable = inventory.holdingBasis?.source === "broker_reconciliation";
      return {
        accountId: record.accountId,
        venue: record.venue,
        snapshotRef: record.ref,
        status: usable ? "observed" : "unknown",
        positions: usable ? inventory.positions : null,
        issues: inventory.holdingBasis?.issues ?? [],
      };
    });
  const projectionGroups = new Map<string, typeof positionsAtAsOf.receipts>();
  for (const receipt of positionsAtAsOf.receipts) {
    const key = JSON.stringify([receipt.adapterKind, receipt.venue, receipt.accountId ?? null]);
    projectionGroups.set(key, [...(projectionGroups.get(key) ?? []), receipt]);
  }
  const localExecutionProjections = [...projectionGroups.values()].map((receipts) => ({
    adapterKind: receipts[0].adapterKind,
    venue: receipts[0].venue,
    accountId: receipts[0].accountId ?? null,
    basis: "receipt_lots_not_broker_account_inventory",
    ...projectFinancePositions({ receipts, marks: positions.marks }),
  }));
  const researchScope = params.includeResearchScope
    ? buildFinanceNightResearchScope({
        asOf: params.asOf,
        ...projectFinanceNightResearchHoldings({
          positionRead: positions,
          brokerRead: scopedHoldings ?? brokerReconciliations,
          asOf: params.asOf,
        }),
        activeRules,
      })
    : undefined;
  const controllerEodEvidence =
    params.includeResearchScope && activeRules.length > 0
      ? (
          await buildFinanceActiveStrategyResearchEvidence({
            directory: params.directory,
            asOf: params.asOf,
            strategyIds: activeRules.map((rule) => rule.ruleId),
            ...(researchScope
              ? {
                  instrumentIds: researchScope.instruments
                    .filter((item) => item.reasons.includes("active_strategy"))
                    .map((item) => item.instrument),
                }
              : {}),
          })
        ).filter((item) => item.id.startsWith("finance-controller:eod:"))
      : [];
  const asOfMs = Date.parse(params.asOf);
  const dayReceipts = positions.receipts
    .filter(
      (receipt) =>
        Date.parse(receipt.recordedAt) <= asOfMs &&
        Date.parse(receipt.fill.filledAt) <= asOfMs &&
        financeEtClock(new Date(receipt.recordedAt)).date === params.etDate,
    )
    .slice(-100)
    .map(compactReceipt);
  const historyAccounts = [
    ...new Set(
      brokerReconciliations.records
        .filter((record) => record.venue === "alpaca:paper")
        .map((record) => record.accountId),
    ),
  ].toSorted(
    (left, right) =>
      Number(right === params.preferredAccountId) - Number(left === params.preferredAccountId),
  );
  const accountPerformance = await Promise.all(
    historyAccounts.slice(0, 2).map(async (accountId) => ({
      ...(await readFinancePaperEconomicWindow(params.directory, accountId, params.asOf)),
      accountId,
    })),
  );
  const brokerSummary: FinanceCommitteeEvidence = {
    id: `finance-night:broker-profit:${params.etDate}`,
    source: "finance-broker-profit-summary",
    timestamp: params.asOf,
    text: JSON.stringify(
      projectFinanceBrokerAccountResearchSummary({
        asOf: params.asOf,
        brokerProfit,
        brokerReconciliations,
        accountPerformance,
      }),
    ),
  };
  const evidence = Object.freeze([
    Object.freeze({
      id: `finance-night:settlement:${params.etDate}`,
      source: "finance-night-settlement",
      timestamp: params.asOf,
      text: JSON.stringify({
        schemaVersion: FINANCE_NIGHT_REVIEW_CONTEXT_SCHEMA_VERSION,
        etDate: params.etDate,
        profitReview: {
          objective:
            "Improve net wealth growth after costs over the declared horizon and capital scope within the existing strategy and risk budget. Report realized and unrealized results separately; internal evaluation checks decision quality, not achieved profit.",
          questions: [
            "Use accountPerformance for whole-account close returns, SPY/QQQ dividend-adjusted comparisons and cash. Separate inherited holdings from new decisions; never subtract posted fees twice. Unknown costs or attribution remain unknown. Explain a concrete retain/change/research consequence now, without waiting twenty sessions.",
            "Which reconciled account holdings lack an active strategy or protective coverage? Review their management autonomously from current evidence; historical ownership gaps must not remove an instrument from research or be fabricated as an LCX entry.",
            "Which executed opportunities made or lost money after costs? Separate gross gains, net gains and unrealized marks.",
            "Use methodPerformance to review the exact entry rule declaration and activation cohort. Distinguish partial matched lots from fully closed entries and explain which mechanism supports retaining, reducing or researching an alternative within existing authority. A different symbol alone does not answer adverse evidence for the same rule version; neither one loss nor one win establishes method validity. Missing fees or attribution remain explicit gaps.",
            "Were profitable opportunities refused or delayed? Use subsequent market data and the original executable constraints; a refusal alone proves no missed profit.",
            "Did exits truncate winners? Compare the declared exit with a pre-specified alternative over the same horizon, including adverse excursion and costs.",
            "When could holding or adding to a winner improve net returns within the total position loss budget? Do not infer an edge from a recent win alone.",
            "How many average net wins does the largest net loss erase? Report sample size and missing cost or round-trip evidence.",
          ],
          requiredProposalFields: [
            "evidenceIds",
            "hypothesis",
            "validationConditions",
            "riskBudgetImpact",
          ],
          boundaries: [
            "Zero trades is not success; trade count and gross win rate are not profit objectives.",
            "Use actual fills for execution analysis. Reference quotes are not fills; local simulation and broker Paper are separate evidence.",
            "No known costs means net profit is unknown, not zero-cost profit. Per-trade return ratios are not currency PnL.",
            "Per-instrument aggregate PnL is not a per-trade loss or win distribution. Round-trip or matched-lot evidence is required for those statistics; otherwise keep them unknown.",
            "Missing counterfactual prices or fills must remain unknown; do not invent missed profits or claim an exit was premature.",
            "Propose testable candidates only; this review cannot change execution permissions, stops, leverage or risk budgets.",
          ],
        },
        scoredFiled: params.settlement.scoredFiled,
        reflection: params.settlement.reflection,
        pending: params.settlement.pending,
        declined: params.settlement.declined,
        issues: params.settlement.issues,
      }),
    }),
    Object.freeze(brokerSummary),
    Object.freeze({
      id: `finance-night:portfolio:${params.etDate}`,
      source: "finance-position-ledger",
      timestamp: params.asOf,
      text: JSON.stringify({
        headRef: positions.headRef,
        receiptCount: positionsAtAsOf.receipts.length,
        ...(positionsAtAsOf.ledger.maintenancePnlStatus
          ? {
              maintenancePnlStatus: positionsAtAsOf.ledger.maintenancePnlStatus,
              unattributedMaintenanceReceiptIds:
                positionsAtAsOf.ledger.unattributedMaintenanceReceiptIds,
              realizedPnlScope: "LCX_entry_lots_only_excludes_historical_position_maintenance",
            }
          : {}),
        positions: accountInventories.length === 1 ? accountInventories[0].positions : null,
        positionMeaning:
          "broker_account_inventory_only; see accountInventories for exact account and venue",
        currentAccountInventoryStatus:
          accountInventories.length === 1 ? accountInventories[0].status : "unknown",
        accountInventories,
        localExecutionProjections,
        localProjectionMeaning: "simulation and LCX attribution lots are not account risk exposure",
        paperFillCount: positionsAtAsOf.receipts.filter(
          (receipt) => receipt.adapterKind === "paper",
        ).length,
        venueFillCount: positionsAtAsOf.receipts.filter(
          (receipt) => receipt.adapterKind === "venue",
        ).length,
        pnlBasis: "account_pnl_unavailable; local_execution_projections_are_attribution_only",
        costsReconciled: false,
        brokerProfit,
        realizedPnl: null,
        unrealizedPnl: null,
        accountPnlStatus: "unknown_requires_broker_cost_and_account_reconciliation",
        instrumentsWithoutMark: positionsAtAsOf.ledger.instrumentsWithoutMark,
        instrumentsWithoutMarkScope: "local_execution_projections_only",
        dayReceipts,
      }),
    }),
    Object.freeze({
      id: `finance-night:rules:${params.etDate}`,
      source: "finance-strategy-rule-ledger",
      timestamp: params.asOf,
      text: JSON.stringify({ headRef: strategyRules.headRef, activeRules }),
    }),
    Object.freeze({
      id: `finance-night:intraday:${params.etDate}`,
      source: "finance-intraday-control-ledger",
      timestamp: params.asOf,
      text: "",
    }),
    ...(researchScope
      ? [
          Object.freeze({
            id: FINANCE_NIGHT_RESEARCH_SCOPE_EVIDENCE_ID,
            source: FINANCE_NIGHT_RESEARCH_SCOPE_EVIDENCE_SOURCE,
            timestamp: params.asOf,
            text: JSON.stringify(researchScope),
          }),
        ]
      : []),
    ...controllerEodEvidence,
    ...(params.includeResearchScope
      ? [
          {
            id: `finance-night:execution-history:${params.etDate}`,
            source: "finance-daily-execution-history",
            timestamp: params.asOf,
            text: JSON.stringify({
              executionAuthority: "none",
              accountCoverage: {
                observedAccountCount: historyAccounts.length,
                includedAccountCount: Math.min(historyAccounts.length, 2),
                omittedAccountIds: historyAccounts.slice(2),
                sourceOmittedAccountCount: brokerReconciliations.omittedAccounts,
                preferredAccountStatus: !params.preferredAccountId
                  ? "not_requested"
                  : historyAccounts.includes(params.preferredAccountId)
                    ? "included"
                    : "not_observed",
              },
              accounts: await Promise.all(
                historyAccounts.slice(0, 2).map(async (accountId) => ({
                  accountId,
                  intradayHistory: await readFinanceScheduledIntradayHistory({
                    directory: params.directory,
                    accountId,
                    asOf: params.asOf,
                    researchWorkspaceDir: params.researchWorkspaceDir,
                  }),
                  history: readFinanceDailyDecisionHistory({
                    directory: params.directory,
                    accountId,
                    asOf: params.asOf,
                  }),
                })),
              ),
            }),
          },
        ]
      : []),
  ]);
  const intradayIndex = evidence.findIndex(
    (item) => item.id === `finance-night:intraday:${params.etDate}`,
  );
  const otherEvidenceBytes = evidence.reduce(
    (total, item, index) =>
      total + (index === intradayIndex ? 0 : Buffer.byteLength(item.text, "utf8")),
    0,
  );
  const totalBudgetBytes = 250_000;
  const intradayBudgetBytes = totalBudgetBytes - otherEvidenceBytes;
  if (intradayIndex < 0 || intradayBudgetBytes <= 0) {
    throw new Error("night review evidence exceeds the bounded controller packet budget");
  }
  const intradayText = summarizeFinanceNightIntradayEvidence(
    { asOf: params.asOf, sessionDate: params.etDate, decisions: outcomes },
    // A byte ceiling is also safe for the downstream character ceiling, including Unicode.
    Math.min(intradayBudgetBytes, QUALITY_HARNESS_MAX_EVIDENCE_TEXT_LENGTH),
  );
  const boundedEvidence = evidence.map((item, index) =>
    index === intradayIndex ? Object.freeze({ ...item, text: intradayText }) : item,
  );
  const totalEvidenceBytes = boundedEvidence.reduce(
    (total, item) => total + Buffer.byteLength(item.text, "utf8"),
    0,
  );
  if (totalEvidenceBytes > totalBudgetBytes) {
    throw new Error("night review evidence exceeds the bounded controller packet budget");
  }
  return Object.freeze(boundedEvidence);
}

export async function writeFinanceNightReviewEvidence(
  filename: string,
  evidence: readonly FinanceCommitteeEvidence[],
): Promise<string> {
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, filename);
  return filename;
}
