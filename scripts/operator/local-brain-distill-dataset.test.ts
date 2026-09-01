import { describe, expect, it } from "vitest";
import {
  buildGeneratedExamples,
  deriveSemanticCurriculumFields,
  splitExamples,
  type DistillExample,
} from "./local-brain-distill-dataset.js";

// A minimal real-receipt-style example so splitExamples has a non-generated
// pool to draw test/valid from (those slices must stay on real data).
function receipt(i: number): DistillExample {
  return {
    prompt: `receipt prompt ${i}`,
    completion: JSON.stringify({ task_family: "x", primary_modules: [] }),
    meta: { sourcePath: `feishu-work-receipts/${i}.md`, sourceKind: "feishu_work_receipt" },
  };
}

describe("buildGeneratedExamples (infinite-stream mix)", () => {
  it("only admits rows that pass their own scorer, tagged as synthetic", () => {
    const generated = buildGeneratedExamples(200, 7, 0.2);
    expect(generated.length).toBe(200);
    for (const ex of generated) {
      expect(ex.meta.sourceKind).toBe("generalization_generator");
      expect(ex.meta.sourcePath.startsWith("generalization-generator/")).toBe(true);
      // Completion is a single compact JSON line (MLX-LM row shape).
      expect(ex.completion.includes("\n")).toBe(false);
    }
  });

  it("is reproducible for a fixed seed", () => {
    const a = buildGeneratedExamples(50, 3, 0.2).map((e) => e.completion);
    const b = buildGeneratedExamples(50, 3, 0.2).map((e) => e.completion);
    expect(a).toEqual(b);
  });
});

describe("semantic curriculum normalization", () => {
  it("derives shared data and provenance gates from task wording only", () => {
    const fields = deriveSemanticCurriculumFields(
      "我持有 QQQ 和 NVDA，暂未提供带时间戳的价格数据，先做研究规划，不要交易建议。",
    );

    expect(fields.primaryModules).toEqual(
      expect.arrayContaining([
        "us_equity_market_structure",
        "company_fundamentals_value",
        "portfolio_risk_gates",
        "finance_data_gateway",
        "data_provenance_quality",
      ]),
    );
    expect(fields.missingData).toEqual(
      expect.arrayContaining(["latest_company_fundamental_inputs", "fresh_market_data_snapshot"]),
    );
    expect(fields.riskBoundaries).toContain("research_only");
    expect(JSON.stringify(fields)).not.toMatch(/case|eval|answer|source_summary/iu);
  });
});

describe("splitExamples keeps synthetic rows out of eval", () => {
  it("routes every generated row to train, never test/valid", () => {
    const receipts = Array.from({ length: 120 }, (_, i) => receipt(i));
    const generated = buildGeneratedExamples(80, 11, 0.2);
    const splits = splitExamples([...receipts, ...generated]);

    const isGenerated = (e: DistillExample) => e.meta.sourceKind === "generalization_generator";
    // Every unique synthetic row stays in train; duplicate pairs are removed
    // before split assignment so they cannot inflate the curriculum.
    expect(splits.train.filter(isGenerated).length).toBeLessThanOrEqual(80);
    expect(splits.train.filter(isGenerated).length).toBeGreaterThan(0);
    // Zero synthetic rows leak into the eval slices.
    expect(splits.test.filter(isGenerated).length).toBe(0);
    expect(splits.valid.filter(isGenerated).length).toBe(0);
    // Eval slices still populated from the real receipt pool.
    expect(splits.test.length).toBeGreaterThan(0);
    expect(splits.valid.length).toBeGreaterThan(0);
  });

  it("mixing zero generated rows leaves the split identical to receipts-only", () => {
    const receipts = Array.from({ length: 60 }, (_, i) => receipt(i));
    const withNone = splitExamples([...receipts, ...buildGeneratedExamples(0, 1, 0.2)]);
    const baseline = splitExamples(receipts);
    expect(withNone.train.length).toBe(baseline.train.length);
    expect(withNone.test.length).toBe(baseline.test.length);
    expect(withNone.valid.length).toBe(baseline.valid.length);
  });

  it("removes exact prompt/completion duplicates before assigning splits", () => {
    const duplicate = receipt(1);
    const splits = splitExamples([
      duplicate,
      { ...duplicate, meta: { ...duplicate.meta, sourcePath: "feishu-work-receipts/alias.md" } },
    ]);

    expect(splits.train.length + splits.valid.length + splits.test.length).toBe(1);
  });
});
