import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { caseflowFingerprint } from "./finance-caseflow.js";
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
          .object({
            strategyId: z.string().min(1),
            budgetFraction: z.number().min(0).max(1),
            evidenceIds: z.array(z.string().min(1)).min(1).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(20),
    candidates: z.array(candidateSchema).max(20),
    provenance: z
      .object({
        kind: z.literal("finance_research_allocation"),
        receiptId: z.string().min(1),
        evidenceIds: z.array(z.string().min(1)).min(1),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((plan, context) => {
    const planEvidenceIds = new Set(plan.provenance?.evidenceIds ?? []);
    for (const [index, allocation] of plan.allocations.entries()) {
      if (allocation.evidenceIds === undefined) {
        continue;
      }
      if (new Set(allocation.evidenceIds).size !== allocation.evidenceIds.length) {
        context.addIssue({
          code: "custom",
          path: ["allocations", index, "evidenceIds"],
          message: "allocation evidence IDs must be unique",
        });
      }
      if (
        !plan.provenance ||
        allocation.evidenceIds.some((evidenceId) => !planEvidenceIds.has(evidenceId))
      ) {
        context.addIssue({
          code: "custom",
          path: ["allocations", index, "evidenceIds"],
          message: "allocation evidence IDs must be included in plan provenance",
        });
      }
    }
  });
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

export const FINANCE_RESEARCH_PORTFOLIO_PLAN_FILENAME = "research-portfolio-plan-latest.json";

/** Read the original research owner output; absence preserves legacy configuration. */
export async function readFinanceResearchPortfolioPlan(
  directory: string,
): Promise<FinancePortfolioPlan | undefined> {
  let text: string;
  try {
    text = await fs.readFile(
      path.join(directory, FINANCE_RESEARCH_PORTFOLIO_PLAN_FILENAME),
      "utf8",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw new Error("finance portfolio plan unreadable", { cause: error });
  }
  return financePortfolioPlanSchema.parse(JSON.parse(text));
}

export const FinanceStrategyCapitalBudgetSchema = z
  .object({
    planRef: z.string().regex(/^[a-f0-9]{64}$/u),
    strategyId: z.string().min(1),
    asOf: z.string().datetime(),
    validUntil: z.string().datetime(),
    budgetFraction: z.number().finite().min(0).max(1),
    allocatedNotional: z.number().finite().nonnegative(),
    committedNotional: z.number().finite().nonnegative(),
    availableNotional: z.number().finite().nonnegative(),
  })
  .strict();
export type FinanceStrategyCapitalBudget = z.infer<typeof FinanceStrategyCapitalBudgetSchema>;

/** Research allocations constrain existing entry caps; they never enlarge authority. */
export function financeStrategyCapitalBudget(params: {
  plan: FinancePortfolioPlan;
  asOf: string;
  accountId: string;
  venue: string;
  strategyId: string;
  equity: number;
  committedNotional: number;
}): FinanceStrategyCapitalBudget {
  validateFinancePortfolioPlan(params.plan, params.asOf, params.venue);
  if (
    params.plan.accountId !== params.accountId ||
    !Number.isFinite(params.equity) ||
    params.equity <= 0 ||
    !Number.isFinite(params.committedNotional) ||
    params.committedNotional < 0
  ) {
    throw new Error("strategy capital account or valuation invalid");
  }
  const allocation = params.plan.allocations.find((a) => a.strategyId === params.strategyId);
  if (!allocation) {
    throw new Error("strategy capital allocation missing");
  }
  const allocatedNotional = params.equity * allocation.budgetFraction;
  return FinanceStrategyCapitalBudgetSchema.parse({
    planRef: caseflowFingerprint(params.plan),
    strategyId: params.strategyId,
    asOf: params.plan.asOf,
    validUntil: params.plan.validUntil,
    budgetFraction: allocation.budgetFraction,
    allocatedNotional,
    committedNotional: params.committedNotional,
    availableNotional: Math.max(0, allocatedNotional - params.committedNotional),
  });
}

/** Each strategy owns a fraction of equity; unused cash stays cash, never renormalized. */
export function composeFinancePortfolioTargets(
  plan: FinancePortfolioPlan,
  candidates: readonly FinancePortfolioCandidate[],
) {
  validateFinancePortfolioPlan(plan, plan.asOf, plan.venue);
  const ids = candidates.map((c) => c.strategyId);
  const funded = plan.allocations.filter((allocation) => allocation.budgetFraction > 0);
  if (
    new Set(ids).size !== ids.length ||
    ids.some((id) => !plan.allocations.some((allocation) => allocation.strategyId === id)) ||
    funded.some((allocation) => !ids.includes(allocation.strategyId))
  ) {
    throw new Error(
      "every budget with positive capital needs exactly one current candidate; missing/duplicate strategy cannot silently redistribute capital",
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
      evidenceIds?: readonly string[];
    }[]
  >();
  for (const candidate of candidates) {
    candidateSchema.parse(candidate);
    const allocation = plan.allocations.find((a) => a.strategyId === candidate.strategyId)!;
    // Withholding capital does not create a zero-weight liquidation target or a
    // conflicting stance. Existing holdings remain subject to account risk checks.
    if (allocation.budgetFraction === 0) {
      continue;
    }
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
    const budgetFraction = allocation.budgetFraction;
    for (const target of candidate.targets) {
      const entries = byInstrument.get(target.instrument) ?? [];
      entries.push({
        strategyId: candidate.strategyId,
        budgetFraction,
        sleeveWeight: target.weight,
        accountWeight: budgetFraction * target.weight,
        stance: target.stance,
        evidenceReceiptId: candidate.evidenceReceiptId,
        ...(allocation.evidenceIds === undefined ? {} : { evidenceIds: allocation.evidenceIds }),
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
    validUntil: plan.validUntil,
    conflictPolicy: plan.conflictPolicy,
    ...(plan.provenance === undefined ? {} : { provenance: plan.provenance }),
    withheldStrategies: plan.allocations.filter((allocation) => allocation.budgetFraction === 0),
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
