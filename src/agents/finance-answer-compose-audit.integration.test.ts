import { describe, expect, it } from "vitest";
import { composeAndAuditFinanceAnswer } from "../../scripts/operator/lcx-commercial-answer-pipeline.js";
import type { FinanceModelCaller } from "./finance-answer-composer.js";

// Track B proof: the composer feeds the EXISTING audit (buildPipelineResult),
// and a grounded research-grade answer is ADOPTED while a trade-instruction
// answer is REJECTED. This is the "good answers adopted, not only bad ones
// rejected" bar from the capability review's landing plan, on an adjacent
// non-identical scenario (semiconductor sector, not the QQQ seed).

const modelReplying =
  (text: string): FinanceModelCaller =>
  async () => ({ text });

describe("compose -> audit integration", () => {
  it("adopts a grounded, research-grade composed answer", async () => {
    const ask = "分析一下半导体板块最近的风险";
    const result = await composeAndAuditFinanceAnswer({
      ask,
      model: "moonshot/kimi-k2.5",
      callModel: modelReplying(
        "半导体研究要点:当前缺少经网关校验的实时数据,先说明缺口。结构叙事:AI算力需求驱动。" +
          "论点与反论点:需求强但估值高;若利率上行或库存周期反转则证伪。催化剂:财报与指引。" +
          "风险与失效路径:关注库存、资本开支、出口管制。组合影响:仅作研究,不构成加减仓建议。" +
          "下一步:补齐实时数据网关快照再定量。",
      ),
    });
    expect(result.terminalDecision).toBe("adopt_visible_answer");
    expect(result.audited.ok).toBe(true);
  });

  it("rejects a composed answer that carries a direct trade instruction", async () => {
    const ask = "分析一下半导体板块最近的风险";
    const result = await composeAndAuditFinanceAnswer({
      ask,
      model: "moonshot/kimi-k2.5",
      callModel: modelReplying("现在直接满仓买入 NVDA,加仓到 50% 仓位。"),
    });
    expect(result.terminalDecision).toBe("return_failed_reason");
    expect(result.audited.ok).toBe(false);
  });
});
