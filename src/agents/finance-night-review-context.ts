import fs from "node:fs/promises";
import path from "node:path";
import type { FinanceCommitteeEvidence } from "./finance-agent-committee.js";
import { financeEtClock } from "./finance-cycle-schedule.js";
import {
  readFinanceIntradayDecisions,
  readFinanceIntradayOutcome,
} from "./finance-intraday-control-ledger.js";
import { readFinancePositionLedger } from "./finance-position-ledger.js";
import { readFinanceStrategyRuleLedger } from "./finance-strategy-rule-ledger.js";

export const FINANCE_NIGHT_REVIEW_CONTEXT_SCHEMA_VERSION =
  "lcx_finance_night_review_context_v1" as const;

export type FinanceNightSettlementSummary = Readonly<{
  scoredFiled: Readonly<{ appended: number; skipped: number }>;
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
  };
}

export async function buildFinanceNightReviewEvidence(params: {
  directory: string;
  asOf: string;
  etDate: string;
  settlement: FinanceNightSettlementSummary;
}): Promise<readonly FinanceCommitteeEvidence[]> {
  const [positions, strategyRules, decisions] = await Promise.all([
    readFinancePositionLedger(params.directory, { asOf: params.asOf }),
    readFinanceStrategyRuleLedger(params.directory, { asOf: params.asOf }),
    readFinanceIntradayDecisions(params.directory, { sessionDate: params.etDate }),
  ]);
  const outcomes = await Promise.all(
    decisions.map(async (decision) => ({
      signalId: decision.input.signalId,
      instrument: decision.input.instrument,
      action: decision.input.action,
      reason: decision.input.reason,
      referencePrice: decision.input.referencePrice,
      referencePriceAt: decision.input.referencePriceAt,
      outcome: await readFinanceIntradayOutcome(params.directory, decision.input.signalId),
    })),
  );
  const activeRules = strategyRules.ledger.rules
    .filter((rule) => rule.state === "active")
    .map((rule) => ({
      ruleId: rule.ruleId,
      form: rule.form,
      formVersion: rule.formVersion,
      instruments: rule.instruments,
      emits: rule.emits,
      schedule: rule.schedule,
      activeObservedAt: rule.activeObservedAt,
      provenance: rule.provenance,
    }));
  const dayReceipts = positions.receipts
    .filter(
      (receipt) =>
        receipt.recordedAt <= params.asOf &&
        financeEtClock(new Date(receipt.recordedAt)).date === params.etDate,
    )
    .slice(-100)
    .map(compactReceipt);
  return Object.freeze([
    Object.freeze({
      id: `finance-night:settlement:${params.etDate}`,
      source: "finance-night-settlement",
      timestamp: params.asOf,
      text: JSON.stringify({
        schemaVersion: FINANCE_NIGHT_REVIEW_CONTEXT_SCHEMA_VERSION,
        etDate: params.etDate,
        scoredFiled: params.settlement.scoredFiled,
        reflection: params.settlement.reflection,
        pending: params.settlement.pending,
        declined: params.settlement.declined,
        issues: params.settlement.issues,
      }),
    }),
    Object.freeze({
      id: `finance-night:portfolio:${params.etDate}`,
      source: "finance-position-ledger",
      timestamp: params.asOf,
      text: JSON.stringify({
        headRef: positions.headRef,
        receiptCount: positions.receiptRecordCount,
        positions: positions.ledger.positions,
        realizedPnl: positions.ledger.realizedPnl,
        unrealizedPnl: positions.ledger.unrealizedPnl,
        instrumentsWithoutMark: positions.ledger.instrumentsWithoutMark,
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
      text: JSON.stringify({ decisions: outcomes }),
    }),
  ]);
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
