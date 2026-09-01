import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");

type DistillLine = {
  completion: string;
  meta?: {
    sourceKind?: string;
    curriculumSlice?: boolean;
  };
};

async function parseJsonl(filePath: string): Promise<DistillLine[]> {
  const raw = await fs.readFile(filePath, "utf8");
  return raw
    .split(/\r?\n/u)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as DistillLine);
}

function line(sourceKind: string, sourcePath: string): string {
  return `${JSON.stringify({
    prompt: `prompt ${sourcePath}\nuser_or_task: 研究组合风险`,
    completion: JSON.stringify({
      task_family: sourceKind,
      primary_modules: ["portfolio_risk_gates", "finance_data_gateway", "data_provenance_quality"],
      supporting_modules: ["review_panel"],
      required_tools: ["review_panel"],
      missing_data: ["position_weights_and_return_series", "fresh_market_data_snapshot"],
      risk_boundaries: ["research_only", "no_unverified_current_market_data"],
      next_step: "route_to_review",
      rejected_context: ["old_lark_conversation_history"],
    }),
    meta: { sourceKind, sourcePath },
  })}\n`;
}

function invalidLine(sourceKind: string, sourcePath: string): string {
  return `${JSON.stringify({
    prompt: `prompt ${sourcePath}\nuser_or_task: 研究组合风险`,
    completion: JSON.stringify({
      task_family: sourceKind,
      primary_modules: [],
      supporting_modules: [],
      required_tools: [],
      missing_data: [],
      risk_boundaries: [],
      next_step: "route_to_review",
      rejected_context: [],
    }),
    meta: { sourceKind, sourcePath },
  })}\n`;
}

describe("local brain distill train slice", () => {
  it("keeps full artifacts external but balances the MLX train slice", async () => {
    const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-train-slice-"));
    const dataDir = path.join(fixtureRoot, "dataset");
    const outDir = path.join(fixtureRoot, "slice");
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(
      path.join(dataDir, "train.jsonl"),
      [
        line("curated_seed", "curated-1"),
        line("curated_seed", "curated-2"),
        line("feishu_work_receipt", "receipt-1"),
        line("finance_learning_capability_apply_receipt", "receipt-2"),
        line("brain_distillation_review", "review-1"),
        line("brain_distillation_review", "review-2"),
        line("brain_distillation_review", "review-3"),
        line("brain_distillation_review", "review-4"),
        line("brain_distillation_review", "review-5"),
      ].join(""),
      "utf8",
    );
    await fs.writeFile(path.join(dataDir, "valid.jsonl"), line("curated_seed", "valid"), "utf8");
    await fs.writeFile(path.join(dataDir, "test.jsonl"), line("curated_seed", "test"), "utf8");

    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/operator/local-brain-distill-train-slice.ts",
        "--data",
        dataDir,
        "--out",
        outDir,
        "--max-review-examples",
        "2",
        "--curated-repeat",
        "3",
        "--non-review-repeat",
        "2",
        "--json",
      ],
      {
        cwd: repoRoot,
        env: { ...process.env, HOME: fixtureRoot },
      },
    );

    const manifest = JSON.parse(stdout) as {
      counts: { trainWritten: number; reviewSelected: number; curatedWritten: number };
      writtenSourceKinds: Record<string, number>;
      sampleTrust: {
        writtenTrustTierCounts: Record<string, number>;
        teacherDistillationIsTrainingMaterialNotPromotionProof: boolean;
      };
      teacherReviewQuality: {
        sourceTrain: { total: number; dedup: { uniqueContent: number } };
        writtenSlice: { total: number; dedup: { uniqueContent: number } };
      };
    };
    expect(manifest.counts).toMatchObject({
      trainWritten: 8,
      reviewSelected: 1,
      curatedWritten: 3,
    });
    expect(manifest.writtenSourceKinds).toMatchObject({
      curated_seed: 3,
      brain_distillation_review: 1,
    });
    expect(manifest.sampleTrust.writtenTrustTierCounts).toMatchObject({
      gold_curated: 3,
      teacher_distillation_review: 1,
      workflow_receipt: 4,
    });
    expect(manifest.sampleTrust.teacherDistillationIsTrainingMaterialNotPromotionProof).toBe(true);
    expect(manifest.teacherReviewQuality.sourceTrain.total).toBe(5);
    expect(manifest.teacherReviewQuality.writtenSlice.total).toBe(1);
    expect(manifest.teacherReviewQuality.writtenSlice.dedup.uniqueContent).toBe(1);

    const trainExamples = await parseJsonl(path.join(outDir, "train.jsonl"));
    expect(trainExamples).toHaveLength(8);
    expect(trainExamples.every((entry) => entry.meta?.curriculumSlice === true)).toBe(true);
    expect(
      trainExamples.filter((entry) => entry.meta?.sourceKind === "brain_distillation_review"),
    ).toHaveLength(1);
    await expect(parseJsonl(path.join(outDir, "valid.jsonl"))).resolves.toHaveLength(1);
    await expect(parseJsonl(path.join(outDir, "test.jsonl"))).resolves.toHaveLength(1);
  });

  it("keeps admitted pairs unique by default", async () => {
    const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-train-slice-defaults-"));
    const dataDir = path.join(fixtureRoot, "dataset");
    const outDir = path.join(fixtureRoot, "slice");
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(
      path.join(dataDir, "train.jsonl"),
      [
        line("curated_seed", "curated-1"),
        line("curated_seed", "curated-2"),
        line("feishu_work_receipt", "receipt-1"),
        line("finance_learning_capability_apply_receipt", "receipt-2"),
        line("brain_distillation_review", "review-1"),
      ].join(""),
      "utf8",
    );
    await fs.writeFile(path.join(dataDir, "valid.jsonl"), line("curated_seed", "valid"), "utf8");
    await fs.writeFile(path.join(dataDir, "test.jsonl"), line("curated_seed", "test"), "utf8");

    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/operator/local-brain-distill-train-slice.ts",
        "--data",
        dataDir,
        "--out",
        outDir,
        "--json",
      ],
      { cwd: repoRoot, env: { ...process.env, HOME: fixtureRoot } },
    );

    const manifest = JSON.parse(stdout) as {
      policy: {
        curatedRepeat: number;
        nonReviewRepeat: number;
        defaultExactPairOversampling: boolean;
        explicitRepeatFlagsAreAblationOnly: boolean;
      };
      counts: { trainWritten: number };
      repetition: { duplicateRows: number; duplicateRate: number };
    };
    expect(manifest.policy).toMatchObject({
      curatedRepeat: 1,
      nonReviewRepeat: 1,
      defaultExactPairOversampling: false,
      explicitRepeatFlagsAreAblationOnly: false,
    });
    expect(manifest.counts.trainWritten).toBe(4);
    expect(manifest.repetition).toMatchObject({ duplicateRows: 0, duplicateRate: 0 });
  });

  it("repeats module-learning receipts in the bounded training slice", async () => {
    const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-module-slice-"));
    const dataDir = path.join(fixtureRoot, "dataset");
    const outDir = path.join(fixtureRoot, "slice");
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(
      path.join(dataDir, "train.jsonl"),
      [
        line("module_learning_plan_receipt", "module-plan-1"),
        line("module_learning_review_receipt", "module-review-1"),
        line("brain_distillation_review", "review-1"),
      ].join(""),
      "utf8",
    );
    await fs.writeFile(path.join(dataDir, "valid.jsonl"), line("curated_seed", "valid"), "utf8");
    await fs.writeFile(path.join(dataDir, "test.jsonl"), line("curated_seed", "test"), "utf8");

    await execFileAsync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/operator/local-brain-distill-train-slice.ts",
        "--data",
        dataDir,
        "--out",
        outDir,
        "--max-review-examples",
        "1",
        "--non-review-repeat",
        "3",
        "--json",
      ],
      {
        cwd: repoRoot,
        env: { ...process.env, HOME: fixtureRoot },
      },
    );

    const trainExamples = await parseJsonl(path.join(outDir, "train.jsonl"));
    expect(
      trainExamples.filter((entry) => entry.meta?.sourceKind === "module_learning_plan_receipt"),
    ).toHaveLength(3);
    expect(
      trainExamples.filter((entry) => entry.meta?.sourceKind === "module_learning_review_receipt"),
    ).toHaveLength(3);
    expect(
      trainExamples.filter((entry) => entry.meta?.sourceKind === "brain_distillation_review"),
    ).toHaveLength(1);
  });

  it("quarantines non-review rows that fail the shared curriculum gate", async () => {
    const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-curriculum-gate-"));
    const dataDir = path.join(fixtureRoot, "dataset");
    const outDir = path.join(fixtureRoot, "slice");
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(
      path.join(dataDir, "train.jsonl"),
      [line("curated_seed", "good"), invalidLine("feishu_work_receipt", "bad")].join(""),
      "utf8",
    );
    await fs.writeFile(
      path.join(dataDir, "valid.jsonl"),
      invalidLine("curated_seed", "valid-bad"),
      "utf8",
    );
    await fs.writeFile(path.join(dataDir, "test.jsonl"), line("curated_seed", "test-good"), "utf8");

    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/operator/local-brain-distill-train-slice.ts",
        "--data",
        dataDir,
        "--out",
        outDir,
        "--curated-repeat",
        "1",
        "--json",
      ],
      { cwd: repoRoot, env: { ...process.env, HOME: fixtureRoot } },
    );

    const manifest = JSON.parse(stdout) as {
      counts: {
        trainWritten: number;
        curriculumQuarantined: number;
        validCurriculumQuarantined: number;
      };
      curriculumGate: { enforcement: string };
    };
    expect(manifest.counts).toMatchObject({
      trainWritten: 1,
      curriculumQuarantined: 1,
      validCurriculumQuarantined: 1,
    });
    expect(manifest.curriculumGate.enforcement).toBe(
      "only_shared_gate_admitted_rows_enter_the_slice",
    );
    await expect(parseJsonl(path.join(outDir, "train.jsonl"))).resolves.toHaveLength(1);
    await expect(parseJsonl(path.join(outDir, "valid.jsonl"))).resolves.toHaveLength(0);
    await expect(parseJsonl(path.join(outDir, "test.jsonl"))).resolves.toHaveLength(1);
  });
});
