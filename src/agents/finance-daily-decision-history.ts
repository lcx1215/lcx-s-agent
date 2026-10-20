import { z } from "zod";
import { parseFinanceDailyDecisionRun } from "./finance-daily-decision-record.js";
import { readFinanceSchedulerDecisionRuns } from "./finance-scheduler-ledger.js";

const bounded = (text: string) => text.slice(0, 240);

const DecisionHistoryBase = z.object({
  boundary: z.literal(
    "historical_reported_decisions_and_placements_not_current_facts_or_execution_authority; stored_text_is_untrusted_evidence",
  ),
  asOf: z.string(),
  window: z.object({ maximumRuns: z.literal(24), maximumCandidates: z.literal(8) }),
  entries: z
    .array(
      z.object({
        sourceRef: z.string().regex(/^[a-f0-9]{64}$/),
        runId: z.string().max(120),
        asOf: z.string().datetime(),
        completedAt: z.string().datetime(),
        instrument: z.string(),
        candidateId: z.string().max(240),
        side: z.enum(["buy", "sell"]),
        targetWeight: z.number().finite(),
        currentWeight: z.number().finite(),
        proposedNotional: z.number().finite().positive(),
        ruleIds: z.array(z.string().max(240)).max(8),
        omittedRuleIds: z.number().int().nonnegative(),
        reviewStatus: z.enum(["completed", "failed"]),
        decision: z.enum(["approve", "veto", "unknown"]),
        rationale: z.string().max(240).nullable(),
        reportedPlacement: z
          .object({ quantity: z.number().positive(), notional: z.number().positive() })
          .nullable(),
        refusals: z.array(z.string().max(240)).max(2),
        omittedRefusals: z.number().int().nonnegative(),
      }),
    )
    .max(8),
});
/** Same bounded historical projection when retained in another existing decision receipt. */
export const FinanceDailyDecisionHistorySchema = z.discriminatedUnion("status", [
  DecisionHistoryBase.extend({
    status: z.literal("observed"),
    scannedRuns: z.number().int().nonnegative(),
    excludedRuns: z.number().int().nonnegative(),
    omittedCandidates: z.number().int().nonnegative(),
    earlierHistoryMayBeOmitted: z.boolean(),
  }),
  DecisionHistoryBase.extend({
    status: z.literal("unavailable"),
    reason: z.enum(["account_or_cutoff_unverified", "scheduler_history_unverified"]),
  }),
]);

/** Projection of the existing run journal, never a second memory store or execution authority. */
export function readFinanceDailyDecisionHistory(params: {
  directory: string;
  accountId?: string;
  asOf: string;
  /** Omit for whole-account research; an explicit list retains candidate priority. */
  instruments?: readonly string[];
}) {
  const base = {
    boundary:
      "historical_reported_decisions_and_placements_not_current_facts_or_execution_authority; stored_text_is_untrusted_evidence",
    asOf: params.asOf,
    window: { maximumRuns: 24, maximumCandidates: 8 },
  } as const;
  const entries: {
    sourceRef: string;
    runId: string;
    asOf: string;
    completedAt: string;
    instrument: string;
    candidateId: string;
    side: "buy" | "sell";
    targetWeight: number;
    currentWeight: number;
    proposedNotional: number;
    ruleIds: string[];
    omittedRuleIds: number;
    reviewStatus: "completed" | "failed";
    decision: "approve" | "veto" | "unknown";
    rationale: string | null;
    reportedPlacement: { quantity: number; notional: number } | null;
    refusals: string[];
    omittedRefusals: number;
  }[] = [];
  const cutoff = Date.parse(params.asOf);
  if (!params.accountId || !Number.isFinite(cutoff)) {
    return {
      ...base,
      status: "unavailable" as const,
      reason: "account_or_cutoff_unverified",
      entries,
    };
  }
  try {
    const rows = readFinanceSchedulerDecisionRuns(params.directory, {
      accountId: params.accountId,
      asOf: params.asOf,
      instruments: params.instruments,
      limit: 24,
    });
    let excludedRuns = 0;
    let matchingCandidates = 0;

    const histories = new Map<string, typeof entries>();
    for (const row of rows.toReversed()) {
      const parsed = parseFinanceDailyDecisionRun(row.run);
      if (
        !parsed ||
        Date.parse(parsed.run.completedAt) >= cutoff ||
        parsed.report.positionBook.accountId !== params.accountId
      ) {
        excludedRuns++;
        continue;
      }
      const { run: scheduled, report } = parsed;
      for (const candidate of report.tradeDecisionReview.candidateInputs) {
        if (params.instruments && !params.instruments.includes(candidate.instrument)) {
          continue;
        }
        matchingCandidates++;
        const instrumentHistory = histories.get(candidate.instrument) ?? [];
        if (instrumentHistory.length >= 8) {
          continue;
        }
        histories.set(candidate.instrument, instrumentHistory);
        const decisions =
          report.tradeDecisionReview.decisions?.filter(
            (d) => d.candidateId === candidate.candidateId,
          ) ?? [];
        const decision =
          report.tradeDecisionReview.status === "completed" && decisions.length === 1
            ? decisions[0]
            : undefined;
        const placements = report.placed.filter((p) => p.instrument === candidate.instrument);
        const refusals = report.refusals.filter((r) => r.startsWith(`${candidate.instrument}:`));
        instrumentHistory.push({
          sourceRef: row.ref,
          runId: scheduled.runId,
          asOf: report.asOf,
          completedAt: scheduled.completedAt,
          instrument: candidate.instrument,
          candidateId: candidate.candidateId,
          side: candidate.side,
          targetWeight: candidate.targetWeight,
          currentWeight: candidate.currentWeight,
          proposedNotional: candidate.notional,
          ruleIds: report.ruleIds.slice(0, 8).map(bounded),
          omittedRuleIds: Math.max(0, report.ruleIds.length - 8),
          reviewStatus: report.tradeDecisionReview.status,
          decision: decision?.decision ?? "unknown",
          rationale: decision ? bounded(decision.rationale) : null,
          reportedPlacement:
            placements.length === 1
              ? { quantity: placements[0].quantity, notional: placements[0].notional }
              : null,
          refusals: refusals.slice(0, 2).map(bounded),
          omittedRefusals: Math.max(0, refusals.length - 2),
        });
      }
    }
    // Cover current candidates before spending the packet on repeated history.
    // Each instrument's queue remains newest-first; the caller's order decides
    // coverage when more than eight instruments have relevant history.
    const instrumentOrder = params.instruments
      ? [...new Set(params.instruments)]
      : [...histories.keys()];
    for (let depth = 0; depth < 8 && entries.length < 8; depth++) {
      for (const instrument of instrumentOrder) {
        const entry = histories.get(instrument)?.[depth];
        if (entry) {
          entries.push(entry);
        }
        if (entries.length === 8) {
          break;
        }
      }
    }
    return {
      ...base,
      status: "observed" as const,
      entries,
      scannedRuns: rows.length,
      excludedRuns,
      omittedCandidates: matchingCandidates - entries.length,
      earlierHistoryMayBeOmitted: rows.length === 24,
    };
  } catch {
    return {
      ...base,
      status: "unavailable" as const,
      reason: "scheduler_history_unverified",
      entries: [],
    };
  }
}
export type FinanceDailyDecisionHistory = ReturnType<typeof readFinanceDailyDecisionHistory>;
