import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");

type DistillLine = {
  prompt?: string;
  completion: string;
  meta?: {
    sourceKind?: string;
    curriculumSlice?: boolean;
    promptContractRewritten?: boolean;
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
    prompt: `prompt ${sourcePath}`,
    completion: JSON.stringify({
      task_family: sourceKind,
      primary_modules: ["review_panel"],
      supporting_modules: ["control_room_summary"],
      required_tools: ["review_panel"],
      missing_data: [],
      risk_boundaries: ["research_only"],
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
        "scripts/dev/local-brain-distill-train-slice.ts",
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
      repetition: { duplicateRows: number; duplicateRate: number };
    };
    expect(manifest.counts).toMatchObject({
      trainWritten: 12,
      reviewSelected: 2,
      curatedWritten: 6,
    });
    expect(manifest.writtenSourceKinds).toMatchObject({
      curated_seed: 6,
      brain_distillation_review: 2,
    });
    expect(manifest.sampleTrust.writtenTrustTierCounts).toMatchObject({
      gold_curated: 6,
      teacher_distillation_review: 2,
      workflow_receipt: 4,
    });
    expect(manifest.sampleTrust.teacherDistillationIsTrainingMaterialNotPromotionProof).toBe(true);
    expect(manifest.teacherReviewQuality.sourceTrain.total).toBe(5);
    expect(manifest.teacherReviewQuality.writtenSlice.total).toBe(2);
    expect(manifest.teacherReviewQuality.writtenSlice.dedup.uniqueContent).toBe(2);
    expect(manifest.repetition.duplicateRows).toBeGreaterThan(0);

    const trainExamples = await parseJsonl(path.join(outDir, "train.jsonl"));
    expect(trainExamples).toHaveLength(12);
    expect(trainExamples.every((entry) => entry.meta?.curriculumSlice === true)).toBe(true);
    expect(
      trainExamples.filter((entry) => entry.meta?.sourceKind === "brain_distillation_review"),
    ).toHaveLength(2);
    await expect(parseJsonl(path.join(outDir, "valid.jsonl"))).resolves.toHaveLength(1);
    await expect(parseJsonl(path.join(outDir, "test.jsonl"))).resolves.toHaveLength(1);
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
        "scripts/dev/local-brain-distill-train-slice.ts",
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

  it("rewrites legacy source-bearing prompts through the shared contract", async () => {
    const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-contract-slice-"));
    const dataDir = path.join(fixtureRoot, "dataset");
    const outDir = path.join(fixtureRoot, "slice");
    await fs.mkdir(dataDir, { recursive: true });
    const legacy = {
      prompt: [
        "old static contract",
        "",
        "source_kind: brain_distillation_review",
        "user_or_task: 研究 portfolio_risk_gates",
        'source_summary: {"primaryModules":["portfolio_risk_gates"]}',
      ].join("\n"),
      completion: JSON.stringify({
        task_family: "portfolio_risk",
        primary_modules: ["portfolio_risk_gates"],
        supporting_modules: [],
        required_tools: ["review_panel"],
        missing_data: [],
        risk_boundaries: ["research_only"],
        next_step: "route_to_review",
        rejected_context: [],
      }),
      meta: { sourceKind: "brain_distillation_review", sourcePath: "legacy" },
    };
    await fs.writeFile(path.join(dataDir, "train.jsonl"), `${JSON.stringify(legacy)}\n`, "utf8");
    await fs.writeFile(path.join(dataDir, "valid.jsonl"), line("curated_seed", "valid"), "utf8");
    await fs.writeFile(path.join(dataDir, "test.jsonl"), line("curated_seed", "test"), "utf8");

    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/dev/local-brain-distill-train-slice.ts",
        "--data",
        dataDir,
        "--out",
        outDir,
        "--max-review-examples",
        "1",
        "--json",
      ],
      { cwd: repoRoot, env: { ...process.env, HOME: fixtureRoot } },
    );
    const manifest = JSON.parse(stdout) as {
      promptContract: {
        sourceKindAndSourceSummaryInModelPrompt: boolean;
        rowsRewrittenFromLegacyPrompt: number;
      };
    };
    expect(manifest.promptContract).toMatchObject({
      sourceKindAndSourceSummaryInModelPrompt: true,
      rowsRewrittenFromLegacyPrompt: 1,
    });
    const rows = await parseJsonl(path.join(outDir, "train.jsonl"));
    expect(rows[0]?.prompt).not.toContain("source_summary:");
    expect(rows[0]?.prompt).toContain("user_or_task: 研究 <withheld_contract_id>");
    expect(rows[0]?.meta?.promptContractRewritten).toBe(true);
  });
});
