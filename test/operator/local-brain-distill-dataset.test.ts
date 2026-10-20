import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  buildGeneratedExamples,
  generatedProvenanceSummary,
  splitExamples,
  type DistillExample,
} from "../../scripts/operator/local-brain-distill-dataset.js";
import {
  GENERALIZATION_CASE_SCHEMA_VERSION,
  GENERALIZATION_GENERATOR_VERSION,
  isFeatureSignatureHeldOut,
} from "../../scripts/operator/local-brain-generalization-generator.js";

// A minimal real-receipt-style example so splitExamples has a non-generated
// pool to draw test/valid from (those slices must stay on real data).
function receipt(i: number): DistillExample {
  return {
    prompt: `receipt prompt ${i}`,
    completion: JSON.stringify({ task_family: "x", primary_modules: [] }),
    meta: { sourcePath: `external-work-receipts/${i}.md`, sourceKind: "external_work_receipt" },
  };
}

it("preserves one host-generated contract through dataset JSONL and the original slice without inventing legacy provenance", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-dataset-generator-provenance-"));
  try {
    const [row] = buildGeneratedExamples(1, 17, 0.2);
    expect(row.meta).toMatchObject({
      caseSchemaVersion: GENERALIZATION_CASE_SCHEMA_VERSION,
      generatorVersion: GENERALIZATION_GENERATOR_VERSION,
      id: expect.any(String),
      featureSignature: expect.any(String),
      sourceKind: "generalization_generator",
    });
    expect(row.meta.sourcePath).toBe(`generalization-generator/${row.meta.id}.json`);
    expect(isFeatureSignatureHeldOut(row.meta.featureSignature!, 0.2)).toBe(false);
    const legacy: DistillExample = {
      ...row,
      meta: { sourceKind: "generalization_generator", sourcePath: "legacy.json" },
    };
    expect(generatedProvenanceSummary([row, legacy])).toMatchObject({
      caseSchemaVersions: { [GENERALIZATION_CASE_SCHEMA_VERSION]: 1, not_recorded: 1 },
      generatorVersions: { [GENERALIZATION_GENERATOR_VERSION]: 1, not_recorded: 1 },
      incompleteProvenanceRows: 1,
    });
    expect(legacy.meta).not.toHaveProperty("caseSchemaVersion");
    const data = path.join(directory, "data");
    const slice = path.join(directory, "slice");
    await fs.mkdir(data);
    for (const split of ["train", "valid", "test"]) {
      await fs.writeFile(path.join(data, `${split}.jsonl`), JSON.stringify(row) + "\n");
    }
    await promisify(execFile)(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/operator/local-brain-distill-train-slice.ts",
        "--data",
        data,
        "--out",
        slice,
        "--json",
      ],
      { cwd: path.resolve(import.meta.dirname, "../..") },
    );
    const retained = JSON.parse(
      (await fs.readFile(path.join(slice, "train.jsonl"), "utf8")).trim(),
    );
    for (const key of [
      "caseSchemaVersion",
      "generatorVersion",
      "featureSignature",
      "id",
    ] as const) {
      expect(retained.meta[key]).toBe(row.meta[key]);
    }
    expect(retained.prompt).toBe(row.prompt);
    expect(retained.completion).toBe(row.completion);
    expect(await fs.readFile(path.join(slice, "valid.jsonl"), "utf8")).toBe(
      JSON.stringify(row) + "\n",
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

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
