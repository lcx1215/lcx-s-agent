import { createHash } from "node:crypto";
import { z } from "zod";
import type { FinanceCommitteeEvidence } from "./finance-agent-committee.js";
import { caseflowFingerprint } from "./finance-caseflow.js";
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

const controllerInputPinSchema = z
  .object({
    path: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    bytes: z.number().int().positive(),
  })
  .strict();

/** Original scheduler input provenance; never an execution or source-quality approval. */
export const financeScheduledResearchHandoffSchema = z
  .object({
    schemaVersion: z.literal("finance_scheduled_research_handoff_v1"),
    sourceScope: z
      .object({
        runId: z.string().trim().min(1),
        accountId: z.string().min(1),
        venue: z.enum(["paper", "alpaca"]),
        asOf: z.string().datetime({ offset: true }),
      })
      .strict(),
    inputs: z
      .object({
        controllerEvidence: controllerInputPinSchema,
        portfolioContext: controllerInputPinSchema,
      })
      .strict(),
  })
  .strict();

export type FinanceScheduledResearchHandoff = z.infer<typeof financeScheduledResearchHandoffSchema>;
export const financeResearchControllerHandoffSchema = financeScheduledResearchHandoffSchema.extend({
  producer: controllerInputPinSchema,
});
export type FinanceResearchControllerHandoff = z.infer<
  typeof financeResearchControllerHandoffSchema
>;

export const financeActiveStrategyResearchSourceSchema = z
  .object({
    directory: z.string().min(1),
    asOf: z.string().datetime({ offset: true }),
    storedHeadRef: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .nullable(),
    projectedHeadRef: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .nullable(),
    storedRecordCount: z.number().int().nonnegative(),
    projectedRecordCount: z.number().int().nonnegative(),
    selectedRuleIds: z.array(z.string().min(1)),
    selectedRulesSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();
export type FinanceActiveStrategyResearchSource = z.infer<
  typeof financeActiveStrategyResearchSourceSchema
>;
export const financeResearchControllerRuleUseSchema = z
  .object({
    source: financeActiveStrategyResearchSourceSchema,
    // This account selected global rules; it does not own the rule ledger.
    accountScope: z
      .object({
        accountId: z.string().min(1),
        venue: z.enum(["paper", "alpaca"]),
        asOf: z.string(),
      })
      .strict(),
    evidence: z
      .object({
        id: z.literal("finance-controller:active-strategies"),
        sha256: z.string().regex(/^[a-f0-9]{64}$/u),
      })
      .strict(),
    parentRunId: z.string().trim().min(1).optional(),
  })
  .strict();
export type FinanceResearchControllerRuleUse = z.infer<
  typeof financeResearchControllerRuleUseSchema
>;

/** Validate the actual rule packet consumed by this invocation, not its truth or profitability. */
export function assertFinanceResearchRuleUse(
  value: unknown,
  evidence: readonly FinanceCommitteeEvidence[],
  context: FinanceResearchPortfolioContext | undefined,
  asOf: string,
): FinanceResearchControllerRuleUse | undefined {
  if (value === undefined) {
    return undefined;
  }
  const use = financeResearchControllerRuleUseSchema.parse(value);
  const matches = evidence.filter((item) => item.id === use.evidence.id);
  if (
    !context ||
    use.accountScope.accountId !== context.accountId ||
    use.accountScope.venue !== context.venue ||
    Date.parse(use.accountScope.asOf) !== Date.parse(asOf) ||
    Date.parse(use.source.asOf) !== Date.parse(asOf) ||
    !use.source.projectedHeadRef ||
    !use.source.storedHeadRef ||
    use.source.projectedRecordCount === 0 ||
    use.source.projectedRecordCount > use.source.storedRecordCount ||
    new Set(use.source.selectedRuleIds).size !== use.source.selectedRuleIds.length ||
    caseflowFingerprint(use.source.selectedRuleIds) !==
      caseflowFingerprint(context.activeStrategyIds) ||
    matches.length !== 1
  ) {
    throw new Error("controller rule use account, time or selection mismatch");
  }
  const item = matches[0];
  if (
    item.source !== "finance-strategy-rule-ledger" ||
    Date.parse(item.timestamp) !== Date.parse(asOf) ||
    createHash("sha256").update(item.text, "utf8").digest("hex") !== use.evidence.sha256
  ) {
    throw new Error("controller rule use evidence hash or source mismatch");
  }
  const payload: unknown = JSON.parse(item.text);
  if (
    !payload ||
    typeof payload !== "object" ||
    !("activeRules" in payload) ||
    !Array.isArray(payload.activeRules) ||
    caseflowFingerprint(payload.activeRules) !== use.source.selectedRulesSha256 ||
    caseflowFingerprint(
      payload.activeRules.map((rule: unknown) =>
        rule && typeof rule === "object" && "ruleId" in rule ? rule.ruleId : null,
      ),
    ) !== caseflowFingerprint(use.source.selectedRuleIds)
  ) {
    throw new Error("controller rule use body or rule identity mismatch");
  }
  return use;
}

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
