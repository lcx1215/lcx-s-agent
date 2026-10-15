import { describe, expect, it } from "vitest";
import { buildPipelineResult } from "../../scripts/operator/lcx-commercial-answer-pipeline.js";
import { probeOriginalFinanceAnswer } from "../../test/fixtures/lcx-waterflow-finance-probe.js";
import { composeFinanceAnswer, type FinanceModelCaller } from "./finance-answer-composer.js";

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
    const composed = await composeFinanceAnswer({
      ask,
      model: "moonshot/kimi-k2.5",
      callModel: modelReplying(
        "半导体研究要点:当前缺少经网关校验的实时数据,先说明缺口。结构叙事:AI算力需求驱动。" +
          "论点与反论点:需求强但估值高;若利率上行或库存周期反转则证伪。催化剂:财报与指引。" +
          "风险与失效路径:关注库存、资本开支、出口管制。组合影响:仅作研究,不构成加减仓建议。" +
          "下一步:补齐实时数据网关快照再定量。",
      ),
    });
    const audited = buildPipelineResult(ask, composed.candidateAnswer);
    expect(audited.terminalDecision).toBe("adopt_visible_answer");
    expect(audited.ok).toBe(true);
  });

  it("rejects a composed answer that carries a direct trade instruction", async () => {
    const ask = "分析一下半导体板块最近的风险";
    const composed = await composeFinanceAnswer({
      ask,
      model: "moonshot/kimi-k2.5",
      callModel: modelReplying("现在直接满仓买入 NVDA,加仓到 50% 仓位。"),
    });
    const audited = buildPipelineResult(ask, composed.candidateAnswer);
    expect(audited.terminalDecision).toBe("return_failed_reason");
    expect(audited.ok).toBe(false);
  });
});

describe("original source -> gateway -> composer -> terminal audit", () => {
  it("passes the actual source value through model input and the same snapshot to the original terminal owner", async () => {
    const probe = await probeOriginalFinanceAnswer();
    expect(probe.fetchCalls).toBe(1);
    expect(probe.snapshot.qualityStatus).toBe("ready");
    expect(probe.modelInputs).toHaveLength(1);
    expect(probe.modelInputs[0].systemContext).toContain("last_price = 100 USD");
    expect(probe.modelInputs[0].systemContext).toContain("2026-07-01T20:00:00.000Z");
    expect(probe.audited.consumedEvidence).toMatchObject(probe.composed.handoffEvidence);
    expect(probe.audited.consumedEvidence).toMatchObject({
      groundingRequired: true,
      semanticAdoption: "not_proven",
    });
    expect(probe.audited.answerGrounding).toMatchObject({ verdict: "verified", blocking: false });
    expect(probe.audited.terminalDecision).toBe("adopt_visible_answer");
  });

  it.each(["missing_source", "copied_source", "conflicting_source", "invented_number"] as const)(
    "keeps %s visible in the original terminal failure instead of treating matching hashes as adoption",
    async (fault) => {
      const probe = await probeOriginalFinanceAnswer({ fault });
      expect(probe.audited.consumedEvidence).toMatchObject(probe.composed.handoffEvidence);
      expect(probe.audited.terminalDecision).toBe("return_failed_reason");
      expect(probe.audited.answerGrounding.blocking).toBe(true);
      expect(probe.audited.failedReasons.join(" ")).toContain("answer figure grounding");
      expect(probe.audited.consumedEvidence.sourceAssessment).toMatchObject({
        status: probe.snapshot.qualityStatus,
        missingEvidence: probe.snapshot.missingEvidence,
        conflictingFields: probe.snapshot.conflicts.map((conflict) => conflict.fieldName),
        requiredNextSteps: probe.snapshot.requiredNextSteps,
      });
      if (fault === "invented_number") {
        expect(probe.snapshot.qualityStatus).toBe("ready");
        expect(probe.composed.grounding.verdict).toBe("ungrounded");
      } else {
        expect(probe.snapshot.qualityStatus).not.toBe("ready");
        expect(
          [
            ...probe.snapshot.missingEvidence,
            ...probe.snapshot.conflicts,
            ...probe.snapshot.freshnessWarnings,
          ].length,
        ).toBeGreaterThan(0);
        expect(probe.composed.dataPosture).not.toBe("grounded_ready");
      }
    },
  );

  it("detects an old candidate paired with changed source data at the actual consumer", async () => {
    const old = await probeOriginalFinanceAnswer();
    const changed = await probeOriginalFinanceAnswer({ price: 101 });
    expect(changed.modelInputs[0].systemContext).toContain("last_price = 101 USD");
    expect(changed.audited.terminalDecision).toBe("adopt_visible_answer");
    const mismatched = buildPipelineResult(old.audited.ask, old.composed.candidateAnswer, {
      snapshot: changed.snapshot,
      requireGrounding: true,
    });
    expect(mismatched.consumedEvidence.candidateSha256).toBe(
      old.composed.handoffEvidence.candidateSha256,
    );
    expect(mismatched.consumedEvidence.snapshotSha256).not.toBe(
      old.composed.handoffEvidence.snapshotSha256,
    );
    expect(mismatched.answerGrounding.verdict).toBe("ungrounded");
    expect(mismatched.terminalDecision).toBe("return_failed_reason");
  });
});
