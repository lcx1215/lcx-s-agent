import { describe, expect, it } from "vitest";
import {
  buildFinanceResearchPortfolioPlan,
  parseFinanceResearchAllocationProposal,
} from "./finance-research-portfolio-plan.js";

const context = {
  accountId: "paper-account",
  venue: "alpaca" as const,
  validityMinutes: 1_440,
  conflictPolicy: "block" as const,
  activeStrategyIds: ["trend", "defensive"],
};

describe("research allocation to portfolio plan", () => {
  it("binds dynamic model allocations to controller context and supported evidence", () => {
    const proposal = parseFinanceResearchAllocationProposal({
      portfolioAllocationProposal: {
        allocations: [
          { strategyId: "trend", budgetFraction: 0.37, evidenceIds: ["market-regime"] },
          { strategyId: "defensive", budgetFraction: 0.22, evidenceIds: ["risk-review"] },
        ],
      },
    });
    expect(
      buildFinanceResearchPortfolioPlan({
        asOf: "2026-09-22T20:00:00.000Z",
        context,
        proposal,
        supportedEvidenceIds: new Set(["market-regime", "risk-review"]),
        researchReceiptId: "quality:run-1",
      }),
    ).toEqual(
      expect.objectContaining({
        accountId: "paper-account",
        venue: "alpaca",
        allocations: [
          { strategyId: "trend", budgetFraction: 0.37 },
          { strategyId: "defensive", budgetFraction: 0.22 },
        ],
        candidates: [],
        provenance: {
          kind: "finance_research_allocation",
          receiptId: "quality:run-1",
          evidenceIds: ["market-regime", "risk-review"],
        },
      }),
    );
  });

  it.each([
    {
      name: "unknown strategy",
      allocations: [
        { strategyId: "trend", budgetFraction: 0.4, evidenceIds: ["e1"] },
        { strategyId: "invented", budgetFraction: 0.2, evidenceIds: ["e1"] },
      ],
      error: "each active strategy exactly once",
    },
    {
      name: "unsupported evidence",
      allocations: [
        { strategyId: "trend", budgetFraction: 0.4, evidenceIds: ["invented"] },
        { strategyId: "defensive", budgetFraction: 0.2, evidenceIds: ["e1"] },
      ],
      error: "unsupported evidence",
    },
    {
      name: "over allocation",
      allocations: [
        { strategyId: "trend", budgetFraction: 0.8, evidenceIds: ["e1"] },
        { strategyId: "defensive", budgetFraction: 0.4, evidenceIds: ["e1"] },
      ],
      error: "exceeds account equity",
    },
  ])("refuses $name", ({ allocations, error }) => {
    expect(() =>
      buildFinanceResearchPortfolioPlan({
        asOf: "2026-09-22T20:00:00.000Z",
        context,
        proposal: { allocations },
        supportedEvidenceIds: new Set(["e1"]),
        researchReceiptId: "quality:run-1",
      }),
    ).toThrow(error);
  });
});
