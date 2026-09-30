import { describe, expect, it } from "vitest";
import { planFinanceBrainOrchestration } from "./finance-brain-orchestration.js";
import type { FinanceBrainModuleId } from "./finance-brain-orchestration.js";
import { validateFinanceWorkflowOutput } from "./finance-model-workflow.js";
import {
  financeProducerInputContract,
  describeFinanceProducerInputError,
  parseFinanceDomainProducerInputs,
  selectedFinanceProducerModuleIds,
} from "./finance-module-producer-input.js";
import { FINANCE_FRAMEWORK_DOMAIN_PRODUCER_SPECS } from "./tools/finance-framework-domain-producer-tools.js";

const validCategoriesByDomain: Record<string, string[]> = {
  macro_rates_inflation: ["macro_rates_evidence", "inflation_evidence"],
  etf_regime: ["equity_market_evidence", "liquidity_evidence"],
  options_volatility: ["options_volatility_evidence"],
  company_fundamentals_value: ["fundamentals_evidence", "valuation_evidence"],
  commodities_oil_gold: ["commodity_evidence"],
  fx_dollar: ["fx_dollar_evidence", "macro_rates_evidence"],
  credit_liquidity: ["credit_evidence", "liquidity_evidence"],
  event_driven: ["event_catalyst_evidence", "portfolio_risk_evidence"],
  portfolio_risk_gates: ["portfolio_risk_evidence", "implementation_evidence"],
  causal_map: ["causal_chain_evidence"],
};

function plan() {
  return planFinanceBrainOrchestration({
    text: "review event catalyst",
    highStakesConclusion: true,
    moduleSelection: { moduleIds: ["event_driven"], rationale: "event review" },
  });
}

function input(sourceArtifacts = ["evidence-1"]) {
  return {
    domain: "event_driven",
    sourceArtifacts,
    evidenceCategories: ["event_catalyst_evidence", "portfolio_risk_evidence"],
    evidenceSummary:
      "Timestamped catalyst evidence and portfolio impact evidence support this event review.",
    baseCase: "the event is absorbed without a regime break",
    bullCase: "the catalyst improves forward expectations",
    bearCase: "the event damages liquidity and risk appetite",
    keyCausalChain: "event surprise -> expectation change -> repricing",
    upstreamDrivers: ["timestamped event surprise"],
    downstreamAssetImpacts: ["conditional repricing"],
    confidenceOrConviction: "medium",
    whatChangesMyMind: "the cited event is corrected or contradicted",
    noActionReason: "research evidence grants no execution authority",
    riskGateNotes: "position and liquidity gates remain required",
    allowedActionAuthority: "research_only",
  };
}

type TestProducerInput = ReturnType<typeof input> & { domain: string };

function planForDomain(domain: FinanceBrainModuleId) {
  return planFinanceBrainOrchestration({
    text: `review ${domain} finance evidence`,
    highStakesConclusion: true,
    moduleSelection: { moduleIds: [domain], rationale: `${domain} producer contract test` },
  });
}

function validInputsForPlan(
  planValue: ReturnType<typeof planFinanceBrainOrchestration>,
): Record<string, TestProducerInput> {
  return Object.fromEntries(
    selectedFinanceProducerModuleIds(planValue).map((domain) => [
      domain,
      {
        ...input(),
        domain,
        evidenceCategories: validCategoriesByDomain[domain],
        evidenceSummary: `${domain} evidence has concrete, source-backed details for its domain-specific review.`,
      },
    ]),
  ) as Record<string, TestProducerInput>;
}

describe("finance module producer input", () => {
  it("publishes a bounded contract for selected producer-backed modules", () => {
    const contract = financeProducerInputContract(plan(), ["evidence-1"]);
    expect(contract).toMatchObject({
      selectedModuleIds: ["event_driven", "causal_map"],
      sourceArtifactIds: ["evidence-1"],
      evidenceGateByModule: {
        event_driven: {
          requiredAllCategories: ["event_catalyst_evidence", "portfolio_risk_evidence"],
          requiredAnyCategoryGroups: [],
        },
        causal_map: {
          requiredAllCategories: ["causal_chain_evidence"],
          causalLinks: expect.stringContaining("mechanism"),
        },
      },
      allowedActionAuthority: "research_only",
      jsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["event_driven", "causal_map"],
        $defs: {
          producerInput: {
            properties: {
              sourceArtifacts: { type: "array" },
              allowedActionAuthority: { const: "research_only" },
            },
          },
        },
      },
    });
    expect(contract.jsonSchema.properties.causal_map?.allOf).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          properties: expect.objectContaining({
            evidenceCategories: expect.objectContaining({
              items: expect.objectContaining({
                enum: expect.arrayContaining(["causal_chain_evidence"]),
              }),
              allOf: expect.arrayContaining([
                expect.objectContaining({
                  contains: { const: "causal_chain_evidence" },
                  minContains: 1,
                }),
              ]),
            }),
          }),
        }),
      ]),
    );
  });

  it("accepts exact selected modules with grounded evidence", () => {
    const value = {
      event_driven: input(),
      causal_map: {
        ...input(),
        domain: "causal_map",
        evidenceCategories: ["causal_chain_evidence"],
      },
    };
    expect(
      parseFinanceDomainProducerInputs({
        value,
        plan: plan(),
        evidenceIds: new Set(["evidence-1"]),
      }),
    ).toEqual(value);
    const request = {
      agentId: "research_draft",
      stage: "draft",
      evidence: [{ id: "evidence-1" }],
      sharedContext: {
        userConstraints: {
          financeOrchestration: plan(),
          financeFrameworkProducerContract: financeProducerInputContract(plan(), ["evidence-1"]),
        },
      },
    };
    const output = (producerInputs: unknown) => ({
      kind: "artifact",
      artifact: {
        answer: "A bounded event hypothesis.",
        claims: [
          { id: "c1", text: "Event observation", status: "supported", evidenceIds: ["evidence-1"] },
        ],
        supportingAnalysis: { financeFrameworkProducerInputs: producerInputs },
      },
    });
    expect(validateFinanceWorkflowOutput("research_draft", output(value), request)).toBe(true);
    expect(validateFinanceWorkflowOutput("research_draft", output(input()), request)).toBe(false);
    const scopedRequest = {
      ...request,
      evidence: [...request.evidence, { id: "finance-model:SPY" }],
      sharedContext: {
        userConstraints: {
          ...request.sharedContext.userConstraints,
          financeProducerPreparationOnly: true,
        },
      },
    };
    const provisional = output(value);
    provisional.artifact.claims[0].text = "SPY provisional interpretation";
    expect(validateFinanceWorkflowOutput("research_draft", provisional, scopedRequest)).toBe(true);
    expect(
      validateFinanceWorkflowOutput("research_draft", provisional, {
        ...scopedRequest,
        sharedContext: request.sharedContext,
      }),
    ).toBe(false);
    expect(
      validateFinanceWorkflowOutput("formatting", provisional, {
        ...scopedRequest,
        agentId: "formatting",
        stage: "format",
      }),
    ).toBe(false);
    provisional.artifact.claims[0].evidenceIds = ["invented"];
    expect(validateFinanceWorkflowOutput("research_draft", provisional, scopedRequest)).toBe(false);
    expect(
      validateFinanceWorkflowOutput("research_draft", output({ event_driven: input() }), request),
    ).toBe(false);
  });

  it("rejects missing, unselected, or uncited producer material", () => {
    expect(() =>
      parseFinanceDomainProducerInputs({
        value: { event_driven: input() },
        plan: plan(),
        evidenceIds: new Set(["evidence-1"]),
      }),
    ).toThrow();
    expect(() =>
      parseFinanceDomainProducerInputs({
        value: {
          event_driven: input(["invented"]),
          causal_map: {
            ...input(),
            domain: "causal_map",
            evidenceCategories: ["causal_chain_evidence"],
          },
        },
        plan: plan(),
        evidenceIds: new Set(["evidence-1"]),
      }),
    ).toThrow("unknown evidence");
  });

  it.each(FINANCE_FRAMEWORK_DOMAIN_PRODUCER_SPECS.map((spec) => spec.domain))(
    "applies the shared domain evidence gate before producer execution for %s",
    (domain) => {
      const planValue = planForDomain(domain);
      const value = validInputsForPlan(planValue);
      expect(() =>
        parseFinanceDomainProducerInputs({
          value,
          plan: planValue,
          evidenceIds: new Set(["evidence-1"]),
        }),
      ).not.toThrow();

      const validInput = value[domain];
      if (!validInput) {
        throw new Error(`test plan did not select ${domain}`);
      }
      const invalid = {
        ...value,
        [domain]: { ...validInput, evidenceCategories: ["sentiment_evidence"] },
      };
      expect(() =>
        parseFinanceDomainProducerInputs({
          value: invalid,
          plan: planValue,
          evidenceIds: new Set(["evidence-1"]),
        }),
      ).toThrow("selected domain evidence gate");
    },
  );

  it("rejects generic evidence summaries and unsupported causal structure before tool execution", () => {
    const planValue = plan();
    const value = validInputsForPlan(planValue);
    const causal = value.causal_map;
    if (!causal) {
      throw new Error("test plan must select causal_map");
    }
    expect(() =>
      parseFinanceDomainProducerInputs({
        value: {
          ...value,
          causal_map: { ...causal, evidenceSummary: "market evidence" },
        },
        plan: planValue,
        evidenceIds: new Set(["evidence-1"]),
      }),
    ).toThrow("selected domain evidence gate");
    expect(() =>
      parseFinanceDomainProducerInputs({
        value: {
          ...value,
          causal_map: { ...causal, keyCausalChain: "valuation changes after the report" },
        },
        plan: planValue,
        evidenceIds: new Set(["evidence-1"]),
      }),
    ).toThrow("selected domain evidence gate");
  });
});

it("describes schema fields without echoing model-authored values or unknown keys", () => {
  let failure: unknown;
  try {
    parseFinanceDomainProducerInputs({
      value: {
        event_driven: { ...input(), upstreamDrivers: 42, secret_untrusted_key: "private text" },
        causal_map: input(),
      },
      plan: plan(),
      evidenceIds: new Set(["evidence-1"]),
    });
  } catch (error) {
    failure = error;
  }
  const detail = describeFinanceProducerInputError(failure);
  expect(detail).toContain("upstreamDrivers:invalid_type");
  expect(detail).toContain("unexpected_fields");
  expect(detail).not.toContain("secret_untrusted_key");
  expect(detail).not.toContain("private text");
});
