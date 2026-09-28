import { describe, expect, it } from "vitest";
import { planFinanceBrainOrchestration } from "./finance-brain-orchestration.js";
import { validateFinanceWorkflowOutput } from "./finance-model-workflow.js";
import {
  financeProducerInputContract,
  parseFinanceDomainProducerInputs,
} from "./finance-module-producer-input.js";

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

describe("finance module producer input", () => {
  it("publishes a bounded contract for selected producer-backed modules", () => {
    expect(financeProducerInputContract(plan(), ["evidence-1"])).toMatchObject({
      selectedModuleIds: ["event_driven", "causal_map"],
      sourceArtifactIds: ["evidence-1"],
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
});
