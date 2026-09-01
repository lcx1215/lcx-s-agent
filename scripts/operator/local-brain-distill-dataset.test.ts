import { describe, expect, it } from "vitest";
import {
  buildGeneratedExamples,
  splitExamples,
  type DistillExample,
} from "./local-brain-distill-dataset.js";

// A minimal real-receipt-style example so splitExamples has a non-generated
// pool to draw test/valid from (those slices must stay on real data).
function receipt(i: number): DistillExample {
  return {
    prompt: `receipt prompt ${i}`,
    completion: JSON.stringify({ task_family: "x", primary_modules: [] }),
    meta: { sourcePath: `external-work-receipts/${i}.md`, sourceKind: "external_work_receipt" },
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

describe("splitExamples keeps synthetic rows out of eval", () => {
  it("routes every generated row to train, never test/valid", () => {
    const receipts = Array.from({ length: 120 }, (_, i) => receipt(i));
    const generated = buildGeneratedExamples(80, 11, 0.2);
    const splits = splitExamples([...receipts, ...generated]);

    const isGenerated = (e: DistillExample) => e.meta.sourceKind === "generalization_generator";
    // All synthetic rows in train.
    expect(splits.train.filter(isGenerated).length).toBe(80);
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
});
