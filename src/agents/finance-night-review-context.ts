import fs from "node:fs/promises";
import path from "node:path";
import type { FinanceCommitteeEvidence } from "./finance-agent-committee.js";
import { readFinanceBrokerProfitFeedback } from "./finance-broker-profit-feedback.js";
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
    fill: receipt.fill ?? null,
  };
}

export async function buildFinanceNightReviewEvidence(params: {
  directory: string;
  asOf: string;
  etDate: string;
  settlement: FinanceNightSettlementSummary;
}): Promise<readonly FinanceCommitteeEvidence[]> {
  const [positions, strategyRules, decisions, brokerProfit] = await Promise.all([
    readFinancePositionLedger(params.directory, { asOf: params.asOf }),
    readFinanceStrategyRuleLedger(params.directory, { asOf: params.asOf }),
    readFinanceIntradayDecisions(params.directory, { sessionDate: params.etDate }),
    readFinanceBrokerProfitFeedback(params.directory, params.asOf),
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
  const brokerSummary: FinanceCommitteeEvidence = {
    id: `finance-night:broker-profit:${params.etDate}`,
    source: "finance-broker-profit-summary",
    timestamp: params.asOf,
    text: JSON.stringify({
      boundary:
        "broker_paper_not_local_simulation; net excludes tax/fx; fill ownership is not strategy PnL",
      status: brokerProfit.status,
      ...(brokerProfit.status === "unavailable" ? { reason: brokerProfit.reason } : {}),
      accounts:
        "accounts" in brokerProfit
          ? brokerProfit.accounts?.map((account) => ({
              status: account.status,
              ...("netMatchedPnl" in account
                ? {
                    netMatchedPnl: account.netMatchedPnl,
                    buyFills: account.buyFills,
                    sellFills: account.sellFills,
                    matchedLotCount: account.matchedLotCount,
                    feeActivityCount: account.feeActivityCount,
                    unallocatedFeeActivityCount: account.unallocatedFeeActivityCount,
                    attributedFillCount: account.strategyAttribution.attributedFillCount,
                    unattributedFillCount: account.strategyAttribution.unattributedFillCount,
                    observedAt: account.observedAt,
                    freshness: account.freshness,
                  }
                : {}),
            }))
          : [],
    }),
  };
  return Object.freeze([
    Object.freeze({
      id: `finance-night:settlement:${params.etDate}`,
      source: "finance-night-settlement",
      timestamp: params.asOf,
      text: JSON.stringify({
        schemaVersion: FINANCE_NIGHT_REVIEW_CONTEXT_SCHEMA_VERSION,
        etDate: params.etDate,
        profitReview: {
          objective:
            "Improve realized profit after costs within the existing strategy and risk budget.",
          questions: [
            "Which executed opportunities made or lost money after costs? Separate gross gains, net gains and unrealized marks.",
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
        receiptCount: positions.receiptRecordCount,
        positions: positions.ledger.positions,
        pnlBasis: "ledger_projection_not_broker_reconciled_net_profit",
        costsReconciled: false,
        brokerProfit,
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
