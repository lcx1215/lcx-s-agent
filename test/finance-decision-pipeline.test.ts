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
      { financeDecisionMode: "conditional_trade_candidate" },
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
