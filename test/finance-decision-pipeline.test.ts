import { describe, expect, it } from "vitest";
import { buildPipelineResult } from "../scripts/operator/lcx-commercial-answer-pipeline.ts";

describe("finance decision mode integration", () => {
  it("keeps the default caller-compatible mode research-only", () => {
    const result = buildPipelineResult("NVDA 现在适合买吗？", "可以买一点，仓位别太大。");
    expect(result.terminalDecision).toBe("return_failed_reason");
    expect(result.financeDecision.mode).toBe("research_only");
    expect(result.failedReasons).toContain("direct_trade_or_position_action_language");
  });

  it("adopts a complete conditional candidate while keeping execution disabled", () => {
    const result = buildPipelineResult(
      "NVDA 现在适合买吗？",
      "候选买入 NVDA：只有在财报指引未破坏 thesis 且估值回到风险预算内时才触发，依据是截至 2026-09-07 的财报和报价数据来源。持有周期 1-3 个月；主要风险是估值压缩和回撤，失效条件是指引下修。仅供审阅，执行前需要人工确认，不自动下单。",
      {
        financeDecisionMode: "conditional_trade_candidate",
        candidateContext: {
          evidence: [{ id: "market-20260907", text: "截至 2026-09-07 的财报和报价数据。" }],
          claims: [{ status: "supported", evidenceIds: ["market-20260907"] }],
          supportingAnalysis: {
            scenarios: [{ invalidation: "财报指引下修", evidenceIds: ["market-20260907"] }],
          },
        },
      },
    );

    expect(result.terminalDecision).toBe("adopt_visible_answer");
    expect(result.financeDecision).toEqual(
      expect.objectContaining({
        mode: "conditional_trade_candidate",
        allowed: true,
        executionAuthority: "none",
      }),
    );
    expect(result.visibleAnswerGate.status).toBe("adopted");
  });
});

describe("answer figure grounding in the pipeline", () => {
  const cleanCandidate =
    "候选分析：估值回到风险预算内才成立，失效条件是指引下修。仅供审阅，不自动下单。";

  it("reports a candidate with no declaration block as unverifiable", () => {
    const result = buildPipelineResult("NVDA 现在适合买吗？", cleanCandidate, {
      financeDecisionMode: "conditional_trade_candidate",
    });
    expect(result.answerGrounding.verdict).toBe("not_verifiable");
    expect(result.answerGrounding.blocking).toBe(false);
  });

  it("adds exactly one failure when grounding is required and nothing else changes", () => {
    const base = {
      financeDecisionMode: "conditional_trade_candidate" as const,
      candidateContext: {
        evidence: [{ id: "market-20260907", text: "截至 2026-09-07 的报价数据。" }],
        claims: [{ status: "supported" as const, evidenceIds: ["market-20260907"] }],
        supportingAnalysis: {
          scenarios: [{ invalidation: "指引下修", evidenceIds: ["market-20260907"] }],
        },
      },
    };
    const without = buildPipelineResult("NVDA 现在适合买吗？", cleanCandidate, base);
    const withRequired = buildPipelineResult("NVDA 现在适合买吗？", cleanCandidate, {
      ...base,
      requireGrounding: true,
    });

    expect(without.failedReasons.join(" ")).not.toMatch(/grounding/);
    expect(withRequired.failedReasons.join(" ")).toMatch(/grounding/);
    // The opt-in must add its own reason, not reopen every other check.
    expect(withRequired.failedReasons.length).toBe(without.failedReasons.length + 1);
  });

  it("blocks the same candidate when grounding is required", () => {
    const result = buildPipelineResult("NVDA 现在适合买吗？", cleanCandidate, {
      financeDecisionMode: "conditional_trade_candidate",
      requireGrounding: true,
    });
    expect(result.terminalDecision).toBe("return_failed_reason");
    expect(result.answerGrounding.blocking).toBe(true);
    expect(result.failedReasons.join(" ")).toMatch(/grounding/);
  });

  it("accepts a candidate whose declared observation matches the snapshot", () => {
    const snapshot = {
      instrument: "NVDA",
      assetClass: "equity",
      asOf: "2026-09-19T00:00:00.000Z",
      qualityStatus: "ready",
      boundary: "research_only",
      normalizedFields: [
        {
          name: "last_price",
          value: 182.44,
          providerName: "test_provider",
          providerRole: "primary_market_data",
          sourceTimestamp: "2026-09-19T00:00:00.000Z",
        },
      ],
      conflicts: [],
      missingEvidence: [],
      freshnessWarnings: [],
    } as unknown as import("../src/agents/finance-data-gateway.js").FinanceDataGatewaySnapshot;

    const declaring =
      cleanCandidate +
      "\n\n```figures\n" +
      JSON.stringify([{ kind: "observed", name: "last_price", value: 182.44 }]) +
      "\n```";

    const result = buildPipelineResult("NVDA 现在适合买吗？", declaring, {
      financeDecisionMode: "conditional_trade_candidate",
      snapshot,
      requireGrounding: true,
    });
    expect(result.answerGrounding.verdict).toBe("verified");
    expect(result.answerGrounding.ungroundedFigures).toBe(0);
    expect(result.answerGrounding.blocking).toBe(false);
  });
});
