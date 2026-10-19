import { expect, it } from "vitest";
import { projectFinanceAccountEconomicFeedback } from "./finance-account-economic-feedback.js";
const asOf = "2026-10-15T07:00:00.000Z";
function source() {
  return {
    accountId: "paper",
    venue: "alpaca:paper",
    sourceRef: "a".repeat(64),
    observedAt: asOf,
    postRepair: {
      attribution: {
        status: "gross_price_contributions_attributed",
        openingRef: "b".repeat(64),
        closingRef: "c".repeat(64),
        from: "2026-10-15T05:18:54.810Z",
        through: asOf,
        accountEquityChange: 61.25,
        unallocatedPnl: 0,
        cohorts: {
          inheritedPositions: { grossPnl: 61.25 },
          newDecisions: { grossPnl: 0 },
          unlinkedPostAnchorEntries: { grossPnl: 0 },
        },
        fees: {
          historicalReportedCashFees: 4.05,
          historicalAssetFeeValuation: { usdValue: 0.08052845 },
          periodConfirmedReportedCashFees: 0,
          periodTimeAmbiguousActivityIds: [],
        },
        evidence: "large details".repeat(10000),
      },
    },
  };
}
it("carries attributed economics, separate recorded costs and unknown bills within a compact request", () => {
  const result = projectFinanceAccountEconomicFeedback(source(), "paper", asOf);
  expect(result).toMatchObject({
    status: "observed",
    inheritedGrossPnl: 61.25,
    newDecisionGrossPnl: 0,
    historicalCashFees: 4.05,
    historicalAssetFeeValue: 0.08052845,
    pendingFees: "unknown",
    modelBill: null,
    openingRef: "b".repeat(64),
    closingRef: "c".repeat(64),
  });
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(1500);
  expect(result).not.toHaveProperty("evidence");
});
it("preserves partial unknown amounts instead of inventing zero", () => {
  const s = source();
  const result = projectFinanceAccountEconomicFeedback(
    {
      ...s,
      postRepair: {
        attribution: {
          ...s.postRepair.attribution,
          status: "partially_attributed",
          cohorts: { ...s.postRepair.attribution.cohorts, inheritedPositions: { grossPnl: null } },
        },
      },
    },
    "paper",
    asOf,
  );
  expect(result).toMatchObject({ status: "partial", inheritedGrossPnl: null, modelBill: null });
});
it.each(["foreign", "future", "missing"])(
  "keeps %s economics unavailable and costs unknown",
  (mode) => {
    const result = projectFinanceAccountEconomicFeedback(
      mode === "missing" ? {} : source(),
      mode === "foreign" ? "other" : "paper",
      mode === "future" ? "2026-10-15T06:00:00.000Z" : asOf,
    );
    expect(result).toMatchObject({
      status: "unavailable",
      pendingFees: "unknown",
      modelBill: null,
    });
    expect(result).not.toHaveProperty("inheritedGrossPnl");
  },
);
