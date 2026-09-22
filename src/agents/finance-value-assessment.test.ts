import { describe, expect, it, vi } from "vitest";
import { normalizeFinanceOperatingStatements } from "./finance-operating-evidence.js";
import {
  buildFinanceValuePortfolioCandidate,
  composeFinancePortfolioTargets,
  validateFinancePortfolioPlan,
  type FinancePortfolioPlan,
} from "./finance-portfolio-composition.js";
import {
  assessFinanceBusinessValue,
  calculateFinanceValueScenarios,
  isReadyFinanceValueAssessment,
  type FinanceOperatingFacts,
  type FinanceValueProposal,
} from "./finance-value-assessment.js";
const at = "2026-09-22T00:00:00.000Z";
const facts: FinanceOperatingFacts = {
  instrument: "ACME",
  currency: "USD",
  periodEnd: "2025-12-31",
  publishedAt: "2026-02-01",
  revenue: 1000,
  netIncome: 120,
  operatingCashFlow: 150,
  capitalExpenditure: 50,
  cash: 200,
  debt: 100,
  dilutedShares: 10,
  sourceIds: ["statements"],
};
const proposal: FinanceValueProposal = {
  applicable: true,
  method: "constant_debt_equity_cash_flow",
  businessAssessment: "Cash conversion is supported by the supplied operating statement.",
  debtAndReinvestmentAssumptions:
    "Debt and shares remain constant; reinvestment is covered by projected capex.",
  sourceIds: ["statements"],
  scenarios: [
    {
      name: "bear",
      growth: [0, 0, 0, 0, 0],
      discountRate: 0.12,
      terminalGrowth: 0,
      rationale: "No growth and a larger discount for business uncertainty.",
      sourceIds: ["statements"],
    },
    {
      name: "base",
      growth: [0.05, 0.05, 0.05, 0.05, 0.05],
      discountRate: 0.1,
      terminalGrowth: 0.02,
      rationale: "Moderate reinvestment sustains the explicit growth assumption.",
      sourceIds: ["statements"],
    },
    {
      name: "bull",
      growth: [0.1, 0.1, 0.1, 0.1, 0.1],
      discountRate: 0.09,
      terminalGrowth: 0.03,
      rationale: "Stronger cash conversion with lower execution uncertainty.",
      sourceIds: ["statements"],
    },
  ],
};
const review = {
  verdict: "pass",
  rationale:
    "The estimates remain conditional; explicit downside covers the challenged normalization.",
  sourceIds: ["statements"],
  challenges: [
    {
      issue: "Can cash conversion survive a cyclical slowdown?",
      material: true,
      resolved: true,
      resolution:
        "The bear case assumes zero growth and a higher discount; no guaranteed value is claimed.",
      sourceIds: ["statements"],
    },
  ],
};
const evidence = [
  {
    sourceId: "statements",
    description: "synthetic annual statements",
    detail: JSON.stringify(facts),
    sourceUrlOrArtifact: "fixture://statements",
  },
];
async function assessment(price = 100, operatingFacts = facts) {
  const invokeModel = vi
    .fn()
    .mockResolvedValueOnce(JSON.stringify(proposal))
    .mockResolvedValueOnce(JSON.stringify(review));
  const result = await assessFinanceBusinessValue({
    instrument: "ACME",
    asOf: at,
    referencePrice: price,
    facts: operatingFacts,
    evidence,
    invokeModel,
  });
  return { result, invokeModel };
}
describe("operating facts -> valuation -> opposing review -> portfolio", () => {
  it("reproduces a perpetual zero-growth cash-flow value without chart inputs", () => {
    const result = calculateFinanceValueScenarios(facts, proposal, 100);
    expect(result.range.low).toBeCloseTo(10 / 0.12, 9);
    expect(result.scenarios[0].impliedAnnualGrowth).toBeGreaterThan(0);
  });
  it("same price but different cash generation changes value; same business different price changes implied expectations", async () => {
    const strong = await assessment(100);
    const weak = await assessment(100, { ...facts, operatingCashFlow: 100 });
    const expensive = await assessment(300);
    expect(strong.result.status).toBe("ready");
    expect(strong.result.valuation!.range.base).toBeCloseTo(2 * weak.result.valuation!.range.base);
    expect(expensive.result.valuation!.range).toEqual(strong.result.valuation!.range);
    expect(expensive.result.valuation!.scenarios[1].impliedAnnualGrowth!).toBeGreaterThan(
      strong.result.valuation!.scenarios[1].impliedAnnualGrowth!,
    );
    expect(expensive.result.valuation!.pricePosition).toBe("above_range");
    expect(strong.invokeModel).toHaveBeenCalledTimes(2);
    expect(strong.invokeModel.mock.calls[1][0]).toContain("opposing valuation reviewer");
    expect(isReadyFinanceValueAssessment(strong.result)).toBe(true);
    expect(isReadyFinanceValueAssessment({ ...strong.result, referencePrice: 1 })).toBe(false);
  });
  it("does not call a model when statements are missing, stale or unpublished", async () => {
    for (const f of [
      undefined,
      { ...facts, publishedAt: "2027-01-01" },
      { ...facts, periodEnd: "2020-01-01" },
    ]) {
      const invokeModel = vi.fn();
      const result = await assessFinanceBusinessValue({
        instrument: "ACME",
        asOf: at,
        referencePrice: 100,
        facts: f,
        evidence,
        invokeModel,
      });
      expect(result.status).toBe("unavailable");
      expect(invokeModel).not.toHaveBeenCalled();
    }
  });
  it("an unresolved material challenge blocks even when reviewer says pass", async () => {
    const invokeModel = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify(proposal))
      .mockResolvedValueOnce(
        JSON.stringify({ ...review, challenges: [{ ...review.challenges[0], resolved: false }] }),
      );
    const result = await assessFinanceBusinessValue({
      instrument: "ACME",
      asOf: at,
      referencePrice: 100,
      facts,
      evidence,
      invokeModel,
    });
    expect(result.status).toBe("rejected");
    expect(() =>
      buildFinanceValuePortfolioCandidate({
        strategyId: "value",
        targetWeight: 0.5,
        direction: "buy",
        assessment: result,
      }),
    ).toThrow();
  });
  it("does not accept invented assumption sources, unsupported methods or failed reviewer", async () => {
    for (const p of [
      { ...proposal, sourceIds: ["invented"] },
      { ...proposal, applicable: false },
      {
        ...proposal,
        scenarios: proposal.scenarios.map((s) => ({ ...s, terminalGrowth: s.discountRate })),
      },
    ]) {
      const invokeModel = vi.fn(async () => JSON.stringify(p));
      expect(
        (
          await assessFinanceBusinessValue({
            instrument: "ACME",
            asOf: at,
            referencePrice: 100,
            facts,
            evidence,
            invokeModel,
          })
        ).status,
      ).toBe("rejected");
      expect(invokeModel).toHaveBeenCalledOnce();
    }
    const invokeModel = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify(proposal))
      .mockRejectedValueOnce(new Error("review unavailable"));
    expect(
      (
        await assessFinanceBusinessValue({
          instrument: "ACME",
          asOf: at,
          referencePrice: 100,
          facts,
          evidence,
          invokeModel,
        })
      ).reasons,
    ).toContain("review unavailable");
  });
  it("combines explicit sleeves without spending retained cash and preserves conflicting evidence", async () => {
    const value = buildFinanceValuePortfolioCandidate({
      strategyId: "value",
      targetWeight: 0.5,
      direction: "buy",
      assessment: (await assessment()).result,
    });
    const trend = {
      strategyId: "trend",
      basis: "price_strategy" as const,
      evidenceReceiptId: "trend-receipt",
      targets: [{ instrument: "ACME", weight: 0, stance: "reduce" as const }],
    };
    const plan: FinancePortfolioPlan = {
      asOf: at,
      validUntil: "2026-09-23T00:00:00.000Z",
      venue: "paper",
      accountId: "fixture",
      conflictPolicy: "block",
      allocations: [
        { strategyId: "value", budgetFraction: 0.4 },
        { strategyId: "trend", budgetFraction: 0.4 },
      ],
      candidates: [value],
    };
    validateFinancePortfolioPlan(plan, at, "paper");
    const result = composeFinancePortfolioTargets(plan, [value, trend]);
    expect(result.targets[0]).toMatchObject({ weight: 0.2, conflict: true, blocked: true });
    expect(result.unallocatedCashWeight).toBeCloseTo(0.8);
    expect(result.targets[0].contributions).toHaveLength(2);
    expect(
      composeFinancePortfolioTargets({ ...plan, conflictPolicy: "budget_weighted" }, [value, trend])
        .targets[0].blocked,
    ).toBe(false);
    expect(() => composeFinancePortfolioTargets(plan, [trend])).toThrow("every budget");
    expect(() =>
      composeFinancePortfolioTargets(plan, [{ ...value, valueAssessment: undefined }, trend]),
    ).toThrow("matching recent");
    expect(() =>
      validateFinancePortfolioPlan(
        { ...plan, allocations: plan.allocations.map((a) => ({ ...a, budgetFraction: 0.6 })) },
        at,
        "paper",
      ),
    ).toThrow("equity");
    expect(() => validateFinancePortfolioPlan(plan, "2026-09-24T00:00:00Z", "paper")).toThrow(
      "stale",
    );
  });
  it("never joins mismatched or future financial statements", () => {
    const common = {
      symbol: "ACME",
      date: "2025-12-31",
      reportedCurrency: "USD",
      period: "FY",
      filingDate: "2026-02-01",
    };
    const rows = [
      {
        sourceId: "fmp_income_statement_annual",
        data: { ...common, revenue: 1000, netIncome: 120, weightedAverageShsOutDil: 10 },
      },
      {
        sourceId: "fmp_cash_flow_statement_annual",
        data: { ...common, operatingCashFlow: 150, capitalExpenditure: -50 },
      },
      {
        sourceId: "fmp_balance_sheet_statement_annual",
        data: { ...common, cashAndCashEquivalents: 200, totalDebt: 100 },
      },
    ];
    expect(normalizeFinanceOperatingStatements("ACME", at, rows)).toMatchObject({
      operatingCashFlow: 150,
      capitalExpenditure: 50,
      dilutedShares: 10,
    });
    expect(
      normalizeFinanceOperatingStatements(
        "ACME",
        at,
        rows.map((r, i) => (i === 1 ? { ...r, data: { ...r.data, date: "2024-12-31" } } : r)),
      ),
    ).toBeUndefined();
    expect(normalizeFinanceOperatingStatements("ACME", "2026-01-01", rows)).toBeUndefined();
  });
});

describe("real research entry consumes value artifacts", () => {
  it("hands reviewed valuation through the mandate into a sized portfolio candidate", async () => {
    const { runFinanceResearchTurn } =
      await import("../../scripts/operator/lcx-finance-research-turn.js");
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "value-turn-"));
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    let finalPrompt = "";
    const invokeModel = vi.fn(async (prompt: string) => {
      if (prompt.startsWith("ROLE: business")) {
        return JSON.stringify(proposal);
      }
      if (prompt.startsWith("ROLE: opposing")) {
        return JSON.stringify(review);
      }
      finalPrompt = prompt;
      const receiptId = prompt.match(/"valueAssessmentId": "([a-f0-9]+)"/)?.[1];
      return JSON.stringify({
        conclusionId: "fixture-value",
        instrument: "ACME",
        assetClass: "us_equity",
        direction: "buy",
        conviction: 0.7,
        thesis:
          "Conditional base-case cash conversion supports the estimate; downside is explicit.",
        horizonDays: 730,
        invalidationCondition: "Cash conversion breaks the stated scenario assumptions",
        valueAssessmentId: receiptId,
        evidence: [{ sourceId: "statements" }, { sourceId: "quote" }],
      });
    });
    try {
      const result = await runFinanceResearchTurn(
        ["--instrument", "ACME", "--run-authorization", "fixture"],
        {
          invokeModel,
          gatherEvidence: async () => ({
            operatingFacts: facts,
            evidence: [
              ...evidence,
              {
                sourceId: "quote",
                description: "synthetic quote",
                detail: "price=100",
                sourceUrlOrArtifact: "fixture://quote",
              },
            ],
            market: { referencePrice: 100, referencePriceAt: new Date().toISOString() },
          }),
          positionSummary: "known flat synthetic book",
          reflection: "",
          portfolioTarget: { strategyId: "value", targetWeight: 0.4 },
          control: {
            stateDirectory: directory,
            riskContext: { drawdownFraction: 0, averagingDown: false, revengeSizing: false },
          },
        },
      );
      expect(result, JSON.stringify(result)).toMatchObject({
        status: "shadow",
        portfolioCandidate: {
          strategyId: "value",
          targets: [{ instrument: "ACME", weight: 0.4 }],
          valueAssessment: { status: "ready" },
        },
      });
      expect(finalPrompt).toContain("impliedAnnualGrowth");
      expect(finalPrompt).toContain("Cash conversion is supported");
      expect(invokeModel).toHaveBeenCalledTimes(3);
    } finally {
      stdout.mockRestore();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
  it("cancellation stops the harness and is never a passing review", async () => {
    const controller = new AbortController();
    controller.abort();
    const invokeModel = vi.fn();
    const result = await assessFinanceBusinessValue({
      instrument: "ACME",
      asOf: at,
      referencePrice: 100,
      facts,
      evidence,
      invokeModel,
      signal: controller.signal,
    });
    expect(result.status).toBe("rejected");
    expect(invokeModel).not.toHaveBeenCalled();
    expect(result.harness[0].status).toBe("failed");
  });
});

it("the shared execution gate rejects uncited, unreviewed and falsely independent value claims", async () => {
  const { runFinanceResearchExecutionBridge } =
    await import("./finance-research-execution-bridge.js");
  const report = (await assessment()).result;
  const quote = {
    sourceId: "quote",
    description: "quote",
    detail: "100",
    sourceUrlOrArtifact: "fixture://quote",
  };
  const conclusion = {
    conclusionId: "gate-fixture",
    instrument: "ACME",
    assetClass: "us_equity",
    direction: "buy",
    conviction: 0.7,
    thesis:
      "Operating evidence supports a conditional valuation rather than a chart extrapolation.",
    horizonDays: 730,
    invalidationCondition: "cash conversion breaks the assumptions",
    evidence: [{ sourceId: "statements" }, { sourceId: "quote" }],
  };
  const input = {
    instrument: "ACME",
    assetClass: "us_equity" as const,
    researchBasis: "business_value" as const,
    evidence: [...evidence, quote],
    valueAssessment: report,
    market: { referencePrice: 100, referencePriceAt: at },
    equity: 100000,
    runAuthorizationId: "fixture",
  };
  const missing = await runFinanceResearchExecutionBridge({
    ...input,
    modelText: JSON.stringify(conclusion),
  });
  expect(missing).toMatchObject({
    status: "refused",
    refusals: [expect.stringContaining("consume the current valuation")],
  });
  const unreviewed = await runFinanceResearchExecutionBridge({
    ...input,
    valueAssessment: undefined,
    modelText: JSON.stringify({ ...conclusion, valueAssessmentId: report.receiptId }),
  });
  expect(unreviewed).toMatchObject({
    status: "refused",
    refusals: [expect.stringContaining("passing opposing review")],
  });
  const sameReport = await runFinanceResearchExecutionBridge({
    ...input,
    evidence: input.evidence.map((e) => ({ ...e, independenceKey: "one-issuer-report" })),
    modelText: JSON.stringify({ ...conclusion, valueAssessmentId: report.receiptId }),
  });
  expect(sameReport).toMatchObject({
    status: "refused",
    refusals: [expect.stringContaining("independent evidence roots")],
  });
});
