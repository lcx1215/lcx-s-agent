import { z } from "zod";
import {
  isReadyFinanceValueAssessment,
  type FinanceValueAssessment,
} from "./finance-value-assessment.js";

const targetSchema = z
  .object({
    instrument: z.string().regex(/^[A-Z][A-Z0-9.-]{0,14}$/),
    weight: z.number().min(0).max(1),
    stance: z.enum(["accumulate", "reduce", "neutral"]),
  })
  .strict();
const candidateSchema = z
  .object({
    strategyId: z.string().min(1),
    basis: z.enum(["business_value", "price_strategy"]),
    evidenceReceiptId: z.string().min(1),
    targets: z.array(targetSchema).min(1).max(100),
    valueAssessment: z.custom<FinanceValueAssessment>(isReadyFinanceValueAssessment).optional(),
  })
  .strict();
export type FinancePortfolioCandidate = z.infer<typeof candidateSchema>;
export const financePortfolioPlanSchema = z
  .object({
    // A controller-owned run input, not a new strategy registry or execution authorization.
    asOf: z.string().datetime(),
    validUntil: z.string().datetime(),
    venue: z.enum(["paper", "alpaca"]),
    accountId: z.string().min(1),
    conflictPolicy: z.enum(["block", "budget_weighted"]),
    allocations: z
      .array(
        z
          .object({ strategyId: z.string().min(1), budgetFraction: z.number().positive().max(1) })
          .strict(),
      )
      .min(1)
      .max(20),
    candidates: z.array(candidateSchema).max(20),
  })
  .strict();
export type FinancePortfolioPlan = z.infer<typeof financePortfolioPlanSchema>;

export function validateFinancePortfolioPlan(
  plan: FinancePortfolioPlan,
  asOf: string,
  venue: string,
) {
  financePortfolioPlanSchema.parse(plan);
  if (
    !Number.isFinite(Date.parse(asOf)) ||
    Date.parse(plan.asOf) > Date.parse(asOf) ||
    Date.parse(plan.validUntil) < Date.parse(asOf) ||
    plan.venue !== venue
  ) {
    throw new Error("portfolio plan is stale, future-dated or belongs to another venue");
  }
  if (
    new Set(plan.allocations.map((a) => a.strategyId)).size !== plan.allocations.length ||
    plan.allocations.reduce((sum, a) => sum + a.budgetFraction, 0) > 1 + 1e-12
  ) {
    throw new Error("portfolio budgets must be unique and cannot exceed account equity");
  }
}

/** Each strategy owns a fraction of equity; unused cash stays cash, never renormalized. */
export function composeFinancePortfolioTargets(
  plan: FinancePortfolioPlan,
  candidates: readonly FinancePortfolioCandidate[],
) {
  validateFinancePortfolioPlan(plan, plan.asOf, plan.venue);
  const ids = candidates.map((c) => c.strategyId);
  if (
    new Set(ids).size !== ids.length ||
    ids.length !== plan.allocations.length ||
    plan.allocations.some((a) => !ids.includes(a.strategyId))
  ) {
    throw new Error(
      "every budget needs exactly one current candidate; missing/duplicate strategy cannot silently redistribute capital",
    );
  }
  const byInstrument = new Map<
    string,
    {
      strategyId: string;
      budgetFraction: number;
      sleeveWeight: number;
      accountWeight: number;
      stance: string;
      evidenceReceiptId: string;
    }[]
  >();
  for (const candidate of candidates) {
    candidateSchema.parse(candidate);
    if (
      candidate.basis === "business_value" &&
      (!isReadyFinanceValueAssessment(candidate.valueAssessment) ||
        candidate.evidenceReceiptId !== candidate.valueAssessment.receiptId ||
        Date.parse(candidate.valueAssessment.asOf) > Date.parse(plan.asOf) ||
        Date.parse(plan.asOf) - Date.parse(candidate.valueAssessment.asOf) > 86400_000 ||
        candidate.targets.some((t) => t.instrument !== candidate.valueAssessment!.instrument))
    ) {
      throw new Error(
        `strategy ${candidate.strategyId}: business-value targets require the matching recent reviewed valuation receipt`,
      );
    }
    if (
      new Set(candidate.targets.map((t) => t.instrument)).size !== candidate.targets.length ||
      candidate.targets.reduce((sum, t) => sum + t.weight, 0) > 1 + 1e-12
    ) {
      throw new Error(
        `strategy ${candidate.strategyId}: duplicate targets or leverage not supported`,
      );
    }
    const budgetFraction = plan.allocations.find(
      (a) => a.strategyId === candidate.strategyId,
    )!.budgetFraction;
    for (const target of candidate.targets) {
      const entries = byInstrument.get(target.instrument) ?? [];
      entries.push({
        strategyId: candidate.strategyId,
        budgetFraction,
        sleeveWeight: target.weight,
        accountWeight: budgetFraction * target.weight,
        stance: target.stance,
        evidenceReceiptId: candidate.evidenceReceiptId,
      });
      byInstrument.set(target.instrument, entries);
    }
  }
  const targets = [...byInstrument]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([instrument, contributions]) => {
      const stances = new Set(contributions.map((c) => c.stance));
      const conflict = stances.has("accumulate") && stances.has("reduce");
      return {
        instrument,
        weight: contributions.reduce((sum, c) => sum + c.accountWeight, 0),
        conflict,
        blocked: conflict && plan.conflictPolicy === "block",
        contributions,
      };
    });
  return {
    accountId: plan.accountId,
    venue: plan.venue,
    asOf: plan.asOf,
    conflictPolicy: plan.conflictPolicy,
    targets,
    unallocatedCashWeight: 1 - targets.reduce((sum, t) => sum + t.weight, 0),
  };
}

/** Explicit controller sizing; a passing estimate does not choose its own account budget. */
export function buildFinanceValuePortfolioCandidate(input: {
  strategyId: string;
  targetWeight: number;
  direction: "buy" | "sell";
  assessment: FinanceValueAssessment;
}): FinancePortfolioCandidate {
  if (!isReadyFinanceValueAssessment(input.assessment)) {
    throw new Error("valuation review not ready");
  }
  return candidateSchema.parse({
    strategyId: input.strategyId,
    basis: "business_value",
    evidenceReceiptId: input.assessment.receiptId,
    valueAssessment: input.assessment,
    targets: [
      {
        instrument: input.assessment.instrument,
        weight: input.targetWeight,
        stance: input.direction === "buy" ? "accumulate" : "reduce",
      },
    ],
  });
}
