import { z } from "zod";

const Hash = z.string().regex(/^[a-f0-9]{64}$/u);
const Amount = z.number().finite().nullable();
const ReconciliationGap = {
  reconciliationRef: Hash.optional(),
  reconciliationAt: z.string().datetime().optional(),
  reconciliationStatus: z.literal("unresolved").optional(),
  latestCashDifference: Amount.optional(),
  latestFeeCash: Amount.optional(),
};
/** Compact host facts shared by the original daily, intraday and central judgment paths. */
export const FinanceAccountEconomicFeedbackSchema = z
  .object({
    ...ReconciliationGap,
    accountId: z.string().min(1).max(240),
    venue: z.literal("alpaca:paper"),
    asOf: z.string().datetime(),
    status: z.enum(["observed", "partial", "unavailable"]),
    sourceRef: Hash.optional(),
    openingRef: Hash.optional(),
    closingRef: Hash.optional(),
    from: z.string().datetime().optional(),
    through: z.string().datetime().optional(),
    accountEquityChange: Amount.optional(),
    inheritedGrossPnl: Amount.optional(),
    inheritedExitDecisionGrossPnl: Amount.optional(),
    newDecisionGrossPnl: Amount.optional(),
    unlinkedGrossPnl: Amount.optional(),
    unallocatedPnl: Amount.optional(),
    historicalCashFees: Amount.optional(),
    historicalAssetFeeValue: Amount.optional(),
    periodConfirmedCashFees: Amount.optional(),
    periodFeeTimingUnknownCount: z.number().int().nonnegative().optional(),
    pendingFees: z.literal("unknown"),
    modelBill: z.null(),
    reason: z.string().max(160).optional(),
  })
  .strict();
export type FinanceAccountEconomicFeedback = z.infer<typeof FinanceAccountEconomicFeedbackSchema>;
const Source = z.object({
  accountId: z.string(),
  venue: z.literal("alpaca:paper"),
  sourceRef: Hash,
  observedAt: z.string().datetime(),
  postRepair: z.object({
    attribution: z.object({
      ...ReconciliationGap,
      status: z.enum(["gross_price_contributions_attributed", "partially_attributed"]),
      openingRef: Hash,
      closingRef: Hash,
      from: z.string().datetime(),
      through: z.string().datetime(),
      accountEquityChange: Amount,
      unallocatedPnl: Amount,
      inheritedExitsByNewDecision: z.object({ grossPnl: Amount }).optional(),
      cohorts: z.object({
        inheritedPositions: z.object({ grossPnl: Amount }),
        newDecisions: z.object({ grossPnl: Amount }),
        unlinkedPostAnchorEntries: z.object({ grossPnl: Amount }),
      }),
      fees: z.object({
        historicalReportedCashFees: Amount,
        historicalAssetFeeValuation: z.object({ usdValue: Amount }).nullable(),
        periodConfirmedReportedCashFees: Amount,
        periodTimeAmbiguousActivityIds: z.array(z.string()),
      }),
    }),
  }),
});

export function projectFinanceAccountEconomicFeedback(
  source: unknown,
  accountId: string,
  asOf: string,
): FinanceAccountEconomicFeedback {
  const base = {
    accountId,
    venue: "alpaca:paper" as const,
    asOf,
    pendingFees: "unknown" as const,
    modelBill: null,
  };
  const parsed = Source.safeParse(source);
  if (
    !parsed.success ||
    parsed.data.accountId !== accountId ||
    !Number.isFinite(Date.parse(asOf)) ||
    Date.parse(parsed.data.observedAt) > Date.parse(asOf) ||
    Date.parse(parsed.data.postRepair.attribution.through) > Date.parse(asOf) ||
    (parsed.data.postRepair.attribution.reconciliationAt !== undefined &&
      Date.parse(parsed.data.postRepair.attribution.reconciliationAt) > Date.parse(asOf)) ||
    Date.parse(parsed.data.postRepair.attribution.from) >
      Date.parse(parsed.data.postRepair.attribution.through)
  ) {
    return {
      ...base,
      status: "unavailable",
      reason: "account_economic_evidence_missing_invalid_or_outside_scope",
    };
  }
  const a = parsed.data.postRepair.attribution;
  return FinanceAccountEconomicFeedbackSchema.parse({
    ...base,
    status:
      a.status === "partially_attributed" || a.reconciliationStatus === "unresolved"
        ? "partial"
        : "observed",
    reconciliationRef: a.reconciliationRef,
    reconciliationAt: a.reconciliationAt,
    reconciliationStatus: a.reconciliationStatus,
    latestCashDifference: a.latestCashDifference,
    latestFeeCash: a.latestFeeCash,
    sourceRef: parsed.data.sourceRef,
    openingRef: a.openingRef,
    closingRef: a.closingRef,
    from: a.from,
    through: a.through,
    accountEquityChange: a.accountEquityChange,
    inheritedGrossPnl: a.cohorts.inheritedPositions.grossPnl,
    inheritedExitDecisionGrossPnl: a.inheritedExitsByNewDecision?.grossPnl ?? null,
    newDecisionGrossPnl: a.cohorts.newDecisions.grossPnl,
    unlinkedGrossPnl: a.cohorts.unlinkedPostAnchorEntries.grossPnl,
    unallocatedPnl: a.unallocatedPnl,
    historicalCashFees: a.fees.historicalReportedCashFees,
    historicalAssetFeeValue: a.fees.historicalAssetFeeValuation?.usdValue ?? null,
    periodConfirmedCashFees: a.fees.periodConfirmedReportedCashFees,
    periodFeeTimingUnknownCount: a.fees.periodTimeAmbiguousActivityIds.length,
  });
}

export async function readFinanceAccountEconomicFeedback(
  directory: string,
  accountId: string,
  asOf: string,
): Promise<FinanceAccountEconomicFeedback> {
  // Avoid importing the original control-ledger graph while its receipt schemas initialize.
  const { readFinancePaperEconomicWindow } = await import("./finance-paper-economic-window.js");
  const source = await readFinancePaperEconomicWindow(directory, accountId, asOf);
  return projectFinanceAccountEconomicFeedback(source, accountId, asOf);
}
