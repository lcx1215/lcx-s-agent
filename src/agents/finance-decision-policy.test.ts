import { describe, expect, it } from "vitest";
import { evaluateFinanceDecisionPolicy } from "./finance-decision-policy.js";

describe("finance decision policy", () => {
  it("keeps the legacy research-only mode unable to adopt direct trade language", () => {
    const result = evaluateFinanceDecisionPolicy({
      ask: "NVDA 现在能买吗？",
      answer: "可以买一点，仓位别太大。",
    });

    expect(result.allowed).toBe(false);
    expect(result.candidateLanguageAllowed).toBe(false);
    expect(result.failedReasons).toContain("direct_trade_or_position_action_language");
    expect(result.executionAuthority).toBe("none");
  });

  it("accepts a strategy candidate only when the decision packet is reviewable", () => {
    const result = evaluateFinanceDecisionPolicy({
      mode: "strategy_candidate",
      ask: "给我一个低频组合策略",
      answer:
        "策略候选：在利率上行场景下降低成长暴露。如果实际利率继续上行则触发防守条件；依据来源和截至时间戳需要逐项核验。风险是回撤和相关性失效，持有周期按季度复核。仅供审阅，不自动下单，执行前需要人工确认。",
    });

    expect(result.allowed).toBe(true);
    expect(result.requiredEvidence).toEqual([]);
  });

  it("allows a conditional buy candidate without granting execution authority", () => {
    const result = evaluateFinanceDecisionPolicy({
      mode: "conditional_trade_candidate",
      ask: "NVDA 现在适合买吗？",
      answer:
        "候选买入 NVDA：只有在财报指引未破坏 thesis 且估值回到风险预算内时才触发，依据是截至 2026-09-07 的财报和报价数据来源。持有周期 1-3 个月；主要风险是估值压缩和回撤，失效条件是指引下修。仅供审阅，执行前需要人工确认，不自动下单。",
    });

    expect(result.allowed).toBe(true);
    expect(result.candidateLanguageAllowed).toBe(true);
    expect(result.executionAuthority).toBe("none");
  });

  it("rejects an unqualified buy answer even in the relaxed candidate mode", () => {
    const result = evaluateFinanceDecisionPolicy({
      mode: "conditional_trade_candidate",
      ask: "NVDA 现在适合买吗？",
      answer: "可以买一点。",
    });

    expect(result.allowed).toBe(false);
    expect(result.failedReasons).toContain("finance_candidate_contract_incomplete");
    expect(result.requiredEvidence).toEqual(
      expect.arrayContaining([
        "source_and_timestamped_evidence",
        "risk_and_invalidation",
        "human_review_and_no_automatic_execution_boundary",
      ]),
    );
  });
});
