import { describe, expect, it } from "vitest";
import {
  composeFinancePortfolioTargets,
  type FinancePortfolioPlan,
} from "./finance-portfolio-composition.js";
import {
  buildFinanceResearchPortfolioPlan,
  parseFinanceResearchAllocationProposal,
  resolveFinanceResearchPortfolioOutcome,
} from "./finance-research-portfolio-plan.js";

const context = {
  accountId: "paper-account",
  venue: "alpaca" as const,
  validityMinutes: 1_440,
  conflictPolicy: "block" as const,
  activeStrategyIds: ["trend", "defensive"],
};

describe("research allocation to portfolio plan", () => {
  it("withholds one strategy without forcing funding, liquidation targets or stance conflicts", () => {
    const plan = buildFinanceResearchPortfolioPlan({
      asOf: "2026-09-22T20:00:00.000Z",
      context,
      proposal: {
        allocations: [
          { strategyId: "trend", budgetFraction: 0.3, evidenceIds: ["e1"] },
          { strategyId: "defensive", budgetFraction: 0, evidenceIds: ["gap"] },
        ],
      },
      supportedEvidenceIds: new Set(["e1", "gap"]),
      researchReceiptId: "quality:partial",
    });
    const funded = {
      strategyId: "trend",
      basis: "price_strategy" as const,
      evidenceReceiptId: "strategy:trend",
      targets: [{ instrument: "SPY", weight: 0.5, stance: "accumulate" as const }],
    };
    const withheld = {
      strategyId: "defensive",
      basis: "price_strategy" as const,
      evidenceReceiptId: "strategy:defensive",
      targets: [
        { instrument: "SPY", weight: 1, stance: "reduce" as const },
        { instrument: "TLT", weight: 0, stance: "reduce" as const },
      ],
    };
    const composition = composeFinancePortfolioTargets(plan, [funded]);
    expect(composeFinancePortfolioTargets(plan, [funded, withheld])).toEqual(composition);
    expect(composition.targets).toEqual([
      expect.objectContaining({ instrument: "SPY", weight: 0.15, conflict: false, blocked: false }),
    ]);
    expect(composition.withheldStrategies).toEqual([
      { strategyId: "defensive", budgetFraction: 0, evidenceIds: ["gap"] },
    ]);
    expect(composition.unallocatedCashWeight).toBe(0.85);
    expect(() => composeFinancePortfolioTargets(plan, [])).toThrow("current candidate");
  });

  it("requires supported evidence for an explicit zero allocation", () => {
    expect(() =>
      buildFinanceResearchPortfolioPlan({
        asOf: "2026-09-22T20:00:00.000Z",
        context,
        proposal: {
          allocations: [
            { strategyId: "trend", budgetFraction: 0.3, evidenceIds: ["e1"] },
            { strategyId: "defensive", budgetFraction: 0, evidenceIds: ["invented"] },
          ],
        },
        supportedEvidenceIds: new Set(["e1"]),
        researchReceiptId: "quality:partial",
      }),
    ).toThrow("unsupported evidence");
  });

  it("keeps an all-zero proposal separate from the explicit no-allocation outcome", () => {
    expect(() =>
      parseFinanceResearchAllocationProposal({
        portfolioAllocationProposal: {
          allocations: [
            { strategyId: "trend", budgetFraction: 0, evidenceIds: ["e1"] },
            { strategyId: "defensive", budgetFraction: 0, evidenceIds: ["e1"] },
          ],
        },
      }),
    ).toThrow("explicit no_allocation");
  });

  it("binds dynamic model allocations to controller context and supported evidence", () => {
    const proposal = parseFinanceResearchAllocationProposal({
      portfolioAllocationProposal: {
        allocations: [
          {
            strategyId: "trend",
            budgetFraction: 0.37,
            evidenceIds: ["market-regime"],
          },
          {
            strategyId: "defensive",
            budgetFraction: 0.22,
            evidenceIds: ["risk-review"],
          },
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
          { strategyId: "trend", budgetFraction: 0.37, evidenceIds: ["market-regime"] },
          { strategyId: "defensive", budgetFraction: 0.22, evidenceIds: ["risk-review"] },
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

  it("keeps supported evidence attached to each strategy and instrument contribution", () => {
    const plan = buildFinanceResearchPortfolioPlan({
      asOf: "2026-09-22T20:00:00.000Z",
      context,
      proposal: {
        allocations: [
          { strategyId: "trend", budgetFraction: 0.37, evidenceIds: ["market-regime"] },
          { strategyId: "defensive", budgetFraction: 0.22, evidenceIds: ["risk-review"] },
        ],
      },
      supportedEvidenceIds: new Set(["market-regime", "risk-review"]),
      researchReceiptId: "quality:run-1",
    });
    const composition = composeFinancePortfolioTargets(plan, [
      {
        strategyId: "trend",
        basis: "price_strategy",
        evidenceReceiptId: "strategy:trend",
        targets: [
          { instrument: "AAPL", weight: 0.5, stance: "accumulate" },
          { instrument: "MSFT", weight: 0.25, stance: "accumulate" },
        ],
      },
      {
        strategyId: "defensive",
        basis: "price_strategy",
        evidenceReceiptId: "strategy:defensive",
        targets: [{ instrument: "AAPL", weight: 0.4, stance: "neutral" }],
      },
    ]);

    expect(plan.allocations).toEqual([
      { strategyId: "trend", budgetFraction: 0.37, evidenceIds: ["market-regime"] },
      { strategyId: "defensive", budgetFraction: 0.22, evidenceIds: ["risk-review"] },
    ]);
    expect(composition.targets).toEqual([
      expect.objectContaining({
        instrument: "AAPL",
        contributions: [
          expect.objectContaining({ strategyId: "trend", evidenceIds: ["market-regime"] }),
          expect.objectContaining({ strategyId: "defensive", evidenceIds: ["risk-review"] }),
        ],
      }),
      expect.objectContaining({
        instrument: "MSFT",
        contributions: [
          expect.objectContaining({ strategyId: "trend", evidenceIds: ["market-regime"] }),
        ],
      }),
    ]);
    expect(composition.targets.map((target) => target.weight)).toEqual([0.273, 0.0925]);
    expect(composition.unallocatedCashWeight).toBeCloseTo(0.6345);
  });

  it("rejects per-strategy evidence not declared by plan provenance", () => {
    const plan = buildFinanceResearchPortfolioPlan({
      asOf: "2026-09-22T20:00:00.000Z",
      context,
      proposal: {
        allocations: [
          { strategyId: "trend", budgetFraction: 0.37, evidenceIds: ["market-regime"] },
          { strategyId: "defensive", budgetFraction: 0.22, evidenceIds: ["risk-review"] },
        ],
      },
      supportedEvidenceIds: new Set(["market-regime", "risk-review"]),
      researchReceiptId: "quality:run-1",
    });
    const invalidPlan: FinancePortfolioPlan = {
      ...plan,
      allocations: [
        { ...plan.allocations[0], evidenceIds: ["invented-evidence"] },
        plan.allocations[1],
      ],
    };

    expect(() =>
      composeFinancePortfolioTargets(invalidPlan, [
        {
          strategyId: "trend",
          basis: "price_strategy",
          evidenceReceiptId: "strategy:trend",
          targets: [{ instrument: "AAPL", weight: 0.5, stance: "accumulate" }],
        },
        {
          strategyId: "defensive",
          basis: "price_strategy",
          evidenceReceiptId: "strategy:defensive",
          targets: [{ instrument: "MSFT", weight: 0.4, stance: "neutral" }],
        },
      ]),
    ).toThrow("allocation evidence IDs must be included in plan provenance");
  });

  it("rejects duplicate evidence IDs within a strategy allocation", () => {
    expect(() =>
      parseFinanceResearchAllocationProposal({
        portfolioAllocationProposal: {
          allocations: [
            { strategyId: "trend", budgetFraction: 0.37, evidenceIds: ["e1", "e1"] },
            { strategyId: "defensive", budgetFraction: 0.22, evidenceIds: ["e2"] },
          ],
        },
      }),
    ).toThrow("allocation evidence IDs must be unique");
  });

  it("composes legacy plans without per-allocation evidence exactly as before", () => {
    const plan: FinancePortfolioPlan = {
      asOf: "2026-09-22T20:00:00.000Z",
      validUntil: "2026-09-23T20:00:00.000Z",
      venue: "alpaca",
      accountId: "paper-account",
      conflictPolicy: "block",
      allocations: [
        { strategyId: "trend", budgetFraction: 0.37 },
        { strategyId: "defensive", budgetFraction: 0.22 },
      ],
      candidates: [],
      provenance: {
        kind: "finance_research_allocation",
        receiptId: "quality:run-legacy",
        evidenceIds: ["legacy-unioned-evidence"],
      },
    };
    const candidates = [
      {
        strategyId: "trend",
        basis: "price_strategy" as const,
        evidenceReceiptId: "strategy:trend",
        targets: [{ instrument: "AAPL", weight: 0.5, stance: "accumulate" as const }],
      },
      {
        strategyId: "defensive",
        basis: "price_strategy" as const,
        evidenceReceiptId: "strategy:defensive",
        targets: [{ instrument: "AAPL", weight: 0.4, stance: "neutral" as const }],
      },
    ];
    const legacyComposition = composeFinancePortfolioTargets(plan, candidates);
    const withoutOptionalField = composeFinancePortfolioTargets(
      {
        ...plan,
        allocations: plan.allocations.map(({ strategyId, budgetFraction }) => ({
          strategyId,
          budgetFraction,
        })),
      },
      candidates,
    );

    expect(legacyComposition).toEqual(withoutOptionalField);
    expect(legacyComposition.targets[0]?.contributions[0]).not.toHaveProperty("evidenceIds");
  });

  it("resolves an explicit supported no-allocation outcome without compiling a plan", () => {
    expect(
      resolveFinanceResearchPortfolioOutcome({
        asOf: "2026-09-22T20:00:00.000Z",
        context,
        supportingAnalysis: {
          portfolioAllocationProposal: {
            decision: "no_allocation",
            reason: "Neither strategy has sufficient support for positive exposure.",
            evidenceIds: ["market-regime"],
          },
        },
        supportedEvidenceIds: new Set(["market-regime"]),
        researchReceiptId: "quality:run-1",
      }),
    ).toEqual({
      kind: "no_allocation",
      reason: "Neither strategy has sufficient support for positive exposure.",
      evidenceIds: ["market-regime"],
    });
  });

  it.each([
    {
      name: "missing proposal",
      supportingAnalysis: {},
    },
    {
      name: "blank reason",
      supportingAnalysis: {
        portfolioAllocationProposal: {
          decision: "no_allocation",
          reason: "  ",
          evidenceIds: ["e1"],
        },
      },
    },
    {
      name: "mixed allocation and abstention fields",
      supportingAnalysis: {
        portfolioAllocationProposal: {
          decision: "no_allocation",
          reason: "No supported allocation.",
          evidenceIds: ["e1"],
          allocations: [{ strategyId: "trend", budgetFraction: 0.1, evidenceIds: ["e1"] }],
        },
      },
    },
  ])("does not infer no allocation from $name", ({ supportingAnalysis }) => {
    expect(() =>
      resolveFinanceResearchPortfolioOutcome({
        asOf: "2026-09-22T20:00:00.000Z",
        context,
        supportingAnalysis,
        supportedEvidenceIds: new Set(["e1"]),
        researchReceiptId: "quality:run-1",
      }),
    ).toThrow();
  });

  it("rejects no-allocation citations that do not come from supported claims", () => {
    expect(() =>
      resolveFinanceResearchPortfolioOutcome({
        asOf: "2026-09-22T20:00:00.000Z",
        context,
        supportingAnalysis: {
          portfolioAllocationProposal: {
            decision: "no_allocation",
            reason: "The cited claim says there is no evidence for exposure.",
            evidenceIds: ["unsupported"],
          },
        },
        supportedEvidenceIds: new Set(["supported"]),
        researchReceiptId: "quality:run-1",
      }),
    ).toThrow("no-allocation proposal cites unsupported evidence");
  });

  it.each([
    {
      name: "invalid as-of",
      asOf: "not-a-timestamp",
      context,
      error: "asOf must be an ISO timestamp",
    },
    {
      name: "duplicate controller strategy IDs",
      asOf: "2026-09-22T20:00:00.000Z",
      context: { ...context, activeStrategyIds: ["trend", "trend"] },
      error: "duplicate active strategy ids",
    },
    {
      name: "invalid controller context",
      asOf: "2026-09-22T20:00:00.000Z",
      context: { ...context, venue: "live" as typeof context.venue },
      error: "Invalid option",
    },
  ])("keeps controller validation on no-allocation: $name", ({ asOf, context, error }) => {
    expect(() =>
      resolveFinanceResearchPortfolioOutcome({
        asOf,
        context,
        supportingAnalysis: {
          portfolioAllocationProposal: {
            decision: "no_allocation",
            reason: "No supported positive exposure was established.",
            evidenceIds: ["e1"],
          },
        },
        supportedEvidenceIds: new Set(["e1"]),
        researchReceiptId: "quality:run-1",
      }),
    ).toThrow(error);
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
