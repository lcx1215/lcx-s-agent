import { z } from "zod";
import {
  financePortfolioPlanSchema,
  type FinancePortfolioPlan,
} from "./finance-portfolio-composition.js";

export const financeResearchPortfolioContextSchema = z
  .object({
    accountId: z.string().min(1),
    venue: z.enum(["paper", "alpaca"]),
    validityMinutes: z.number().positive(),
    conflictPolicy: z.enum(["block", "budget_weighted"]),
    activeStrategyIds: z.array(z.string().min(1)).min(1).max(20),
    /** Exact controller-owned instruments whose evidence is required for capital planning. */
    requiredInstruments: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .refine((instrument) => instrument === instrument.toUpperCase()),
      )
      .min(1)
      .max(100)
      .optional(),
  })
  .strict()
  .superRefine((context, refinement) => {
    if (
      context.requiredInstruments !== undefined &&
      new Set(context.requiredInstruments).size !== context.requiredInstruments.length
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["requiredInstruments"],
        message: "required instruments must be unique",
      });
    }
  });

export type FinanceResearchPortfolioContext = z.infer<typeof financeResearchPortfolioContextSchema>;

const allocationProposalSchema = z
  .object({
    allocations: z
      .array(
        z
          .object({
            strategyId: z.string().min(1),
            budgetFraction: z.number().min(0).max(1),
            evidenceIds: z
              .array(z.string().min(1))
              .min(1)
              .superRefine((evidenceIds, context) => {
                if (new Set(evidenceIds).size !== evidenceIds.length) {
                  context.addIssue({
                    code: "custom",
                    message: "allocation evidence IDs must be unique",
                  });
                }
              }),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict()
  .refine((proposal) => proposal.allocations.some((allocation) => allocation.budgetFraction > 0), {
    message: "an all-zero proposal must use the explicit no_allocation outcome",
  });

export type FinanceResearchAllocationProposal = z.infer<typeof allocationProposalSchema>;

const portfolioAbstentionFieldsSchema = z
  .object({
    reason: z.string().trim().min(1).max(1_000),
    evidenceIds: z.array(z.string().trim().min(1)).min(1).max(100),
  })
  .strict();

function requireUniqueAbstentionEvidenceIds(
  abstention: { evidenceIds: readonly string[] },
  context: z.RefinementCtx,
) {
  if (new Set(abstention.evidenceIds).size !== abstention.evidenceIds.length) {
    context.addIssue({ code: "custom", message: "no-allocation evidence IDs must be unique" });
  }
}

export const financeResearchPortfolioAbstentionSchema = portfolioAbstentionFieldsSchema.superRefine(
  requireUniqueAbstentionEvidenceIds,
);

const noAllocationProposalSchema = portfolioAbstentionFieldsSchema
  .extend({ decision: z.literal("no_allocation") })
  .strict()
  .superRefine(requireUniqueAbstentionEvidenceIds);

export type FinanceResearchPortfolioAbstention = z.infer<
  typeof financeResearchPortfolioAbstentionSchema
>;

export type FinanceResearchPortfolioOutcome =
  | Readonly<{ kind: "plan"; plan: FinancePortfolioPlan }>
  | Readonly<{
      kind: "no_allocation";
      reason: string;
      evidenceIds: readonly string[];
    }>;

/**
 * Read the model proposal from the quality artifact without granting it plan authority.
 * The caller-supplied context owns account, venue, validity and eligible strategy ids.
 */
export function parseFinanceResearchAllocationProposal(
  supportingAnalysis: Readonly<Record<string, unknown>> | undefined,
): FinanceResearchAllocationProposal {
  if (!supportingAnalysis || !("portfolioAllocationProposal" in supportingAnalysis)) {
    throw new Error("quality artifact is missing supportingAnalysis.portfolioAllocationProposal");
  }
  return allocationProposalSchema.parse(supportingAnalysis.portfolioAllocationProposal);
}

/**
 * Compile a reviewed allocation proposal into the existing controller-owned portfolio plan.
 *
 * The model may choose fractions only for the exact active strategy set supplied by the
 * controller. Every allocation must cite a supported claim evidence id; capital left below 1
 * remains cash. No target instrument or execution authority is created here.
 */
export function buildFinanceResearchPortfolioPlan(params: {
  asOf: string;
  context: FinanceResearchPortfolioContext;
  proposal: FinanceResearchAllocationProposal;
  supportedEvidenceIds: ReadonlySet<string>;
  researchReceiptId: string;
}): FinancePortfolioPlan {
  const context = financeResearchPortfolioContextSchema.parse(params.context);
  const proposal = allocationProposalSchema.parse(params.proposal);
  const asOfMs = Date.parse(params.asOf);
  if (!Number.isFinite(asOfMs)) {
    throw new Error("research portfolio plan asOf must be an ISO timestamp");
  }
  const active = new Set(context.activeStrategyIds);
  if (active.size !== context.activeStrategyIds.length) {
    throw new Error("research portfolio context has duplicate active strategy ids");
  }
  const proposed = new Set(proposal.allocations.map((allocation) => allocation.strategyId));
  if (
    proposed.size !== proposal.allocations.length ||
    proposed.size !== active.size ||
    [...active].some((strategyId) => !proposed.has(strategyId))
  ) {
    throw new Error("allocation proposal must cover each active strategy exactly once");
  }
  const evidenceIds = [
    ...new Set(proposal.allocations.flatMap((allocation) => allocation.evidenceIds)),
  ];
  const unknownEvidence = evidenceIds.filter(
    (evidenceId) => !params.supportedEvidenceIds.has(evidenceId),
  );
  if (unknownEvidence.length > 0) {
    throw new Error(
      `allocation proposal cites unsupported evidence: ${unknownEvidence.join(", ")}`,
    );
  }
  if (
    proposal.allocations.reduce((sum, allocation) => sum + allocation.budgetFraction, 0) >
    1 + 1e-12
  ) {
    throw new Error("allocation proposal exceeds account equity");
  }
  return financePortfolioPlanSchema.parse({
    asOf: params.asOf,
    validUntil: new Date(asOfMs + context.validityMinutes * 60_000).toISOString(),
    venue: context.venue,
    accountId: context.accountId,
    conflictPolicy: context.conflictPolicy,
    allocations: proposal.allocations.map(({ strategyId, budgetFraction, evidenceIds }) => ({
      strategyId,
      budgetFraction,
      evidenceIds,
    })),
    candidates: [],
    provenance: {
      kind: "finance_research_allocation",
      receiptId: params.researchReceiptId,
      evidenceIds,
    },
  });
}

/** Resolve an explicit quality-reviewed portfolio outcome without inventing a budget. */
export function resolveFinanceResearchPortfolioOutcome(params: {
  asOf: string;
  context: FinanceResearchPortfolioContext;
  supportingAnalysis: Readonly<Record<string, unknown>> | undefined;
  supportedEvidenceIds: ReadonlySet<string>;
  researchReceiptId: string;
}): FinanceResearchPortfolioOutcome {
  const context = financeResearchPortfolioContextSchema.parse(params.context);
  const asOfMs = Date.parse(params.asOf);
  if (!Number.isFinite(asOfMs)) {
    throw new Error("research portfolio plan asOf must be an ISO timestamp");
  }
  if (new Set(context.activeStrategyIds).size !== context.activeStrategyIds.length) {
    throw new Error("research portfolio context has duplicate active strategy ids");
  }
  const rawProposal = params.supportingAnalysis?.portfolioAllocationProposal;
  if (
    typeof rawProposal === "object" &&
    rawProposal !== null &&
    !Array.isArray(rawProposal) &&
    "decision" in rawProposal &&
    rawProposal.decision === "no_allocation"
  ) {
    const abstention = noAllocationProposalSchema.parse(rawProposal);
    const unsupportedEvidenceIds = abstention.evidenceIds.filter(
      (evidenceId) => !params.supportedEvidenceIds.has(evidenceId),
    );
    if (unsupportedEvidenceIds.length > 0) {
      throw new Error(
        `no-allocation proposal cites unsupported evidence: ${unsupportedEvidenceIds.join(", ")}`,
      );
    }
    return Object.freeze({
      kind: "no_allocation",
      reason: abstention.reason,
      evidenceIds: Object.freeze([...abstention.evidenceIds]),
    });
  }

  const proposal = parseFinanceResearchAllocationProposal(params.supportingAnalysis);
  const plan = buildFinanceResearchPortfolioPlan({
    asOf: params.asOf,
    context,
    proposal,
    supportedEvidenceIds: params.supportedEvidenceIds,
    researchReceiptId: params.researchReceiptId,
  });
  return Object.freeze({ kind: "plan", plan });
}
