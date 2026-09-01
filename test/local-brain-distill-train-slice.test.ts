import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { buildLocalBrainTrainingPrompt } from "../scripts/operator/local-brain-training-contract.js";

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
  const teacherReview = sourceKind === "brain_distillation_review";
  const sampleNumber = /([0-9]+)$/u.exec(sourcePath)?.[1] ?? "1";
  return `${JSON.stringify({
    prompt: teacherReview
      ? buildLocalBrainTrainingPrompt({
          userAsk: `研究组合风险，暂未提供带时间戳数据，样本序号 ${sampleNumber}`,
        })
      : `prompt ${sourcePath}`,
    completion: JSON.stringify({
      task_family: sourceKind,
      primary_modules: teacherReview
        ? ["portfolio_risk_gates", "review_panel", "finance_data_gateway"]
        : ["review_panel"],
      supporting_modules: teacherReview
        ? ["data_provenance_quality", "control_room_summary"]
        : ["control_room_summary"],
      required_tools: teacherReview ? ["source_registry"] : ["review_panel"],
      missing_data: teacherReview
        ? ["position_weights_and_return_series", "fresh_market_data_snapshot"]
        : [],
      risk_boundaries: teacherReview
        ? ["research_only", "no_unverified_current_market_data"]
        : ["research_only"],
      next_step: "route_to_review",
      rejected_context: teacherReview ? ["old_lark_conversation_history"] : [],
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
        "user_or_task: 研究组合风险和当前数据缺口（portfolio_risk_gates）",
        'source_summary: {"primaryModules":["portfolio_risk_gates"]}',
      ].join("\n"),
      completion: JSON.stringify({
        task_family: "portfolio_risk",
        primary_modules: ["portfolio_risk_gates", "review_panel", "finance_data_gateway"],
        supporting_modules: ["data_provenance_quality"],
        required_tools: ["source_registry"],
        missing_data: ["position_weights_and_return_series", "fresh_market_data_snapshot"],
        risk_boundaries: ["research_only", "no_unverified_current_market_data"],
        next_step: "route_to_review",
        rejected_context: ["old_lark_conversation_history"],
      }),
      meta: { sourceKind: "brain_distillation_review", sourcePath: "legacy" },
    };
    await fs.writeFile(path.join(dataDir, "train.jsonl"), `${JSON.stringify(legacy)}\n`, "utf8");
    await fs.writeFile(path.join(dataDir, "valid.jsonl"), `${JSON.stringify(legacy)}\n`, "utf8");
    await fs.writeFile(path.join(dataDir, "test.jsonl"), `${JSON.stringify(legacy)}\n`, "utf8");

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
        "1",
        "--json",
      ],
      { cwd: repoRoot, env: { ...process.env, HOME: fixtureRoot } },
    );
    const manifest = JSON.parse(stdout) as {
      promptContract: {
        rewriteScope: string;
        rowsRewritten: number;
        sourceKindAndSourceSummaryInModelPrompt: boolean;
        rowsRewrittenFromLegacyPrompt: number;
        validRowsRewrittenFromLegacyPrompt: number;
        testRowsRewrittenFromLegacyPrompt: number;
      };
    };
    expect(manifest.promptContract).toMatchObject({
      rewriteScope: "all_rows_with_recoverable_user_or_task",
      rowsRewritten: 1,
      sourceKindAndSourceSummaryInModelPrompt: false,
      rowsRewrittenFromLegacyPrompt: 1,
      validRowsRewrittenFromLegacyPrompt: 1,
      testRowsRewrittenFromLegacyPrompt: 1,
    });
    const rows = await parseJsonl(path.join(outDir, "train.jsonl"));
    expect(rows[0]?.prompt).not.toContain("source_summary:");
    expect(rows[0]?.prompt).toContain(
      "user_or_task: 研究组合风险和当前数据缺口（<withheld_contract_id>）",
    );
    expect(rows[0]?.meta?.promptContractRewritten).toBe(true);
    for (const split of ["valid", "test"]) {
      const splitRows = await parseJsonl(path.join(outDir, `${split}.jsonl`));
      expect(splitRows[0]?.prompt).not.toContain("source_summary:");
      expect(splitRows[0]?.meta?.promptContractRewritten).toBe(true);
    }
  });

  it("rewrites v2 prompts that still carry a hyphenated acceptance label", async () => {
    const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-contract-label-slice-"));
    const dataDir = path.join(fixtureRoot, "dataset");
    const outDir = path.join(fixtureRoot, "slice");
    await fs.mkdir(dataDir, { recursive: true });
    const acceptanceLabel = "lark-live-visible-fixed-agent-architecture-20260514";
    const cleanPrompt = buildLocalBrainTrainingPrompt({
      userAsk: `live验收：请只回复 ${acceptanceLabel}，并说明这是重启后的真实链路。`,
    });
    const staleV2Prompt = cleanPrompt.replace("<withheld_contract_id>", acceptanceLabel);
    const row = {
      prompt: staleV2Prompt,
      completion: JSON.stringify({
        task_family: "ops_audit",
        primary_modules: ["ops_audit"],
        supporting_modules: [],
        required_tools: [],
        missing_data: [],
        risk_boundaries: ["research_only"],
        next_step: "route_to_review",
        rejected_context: [],
      }),
      meta: { sourceKind: "curated_seed", sourcePath: "stale-v2" },
    };
    await fs.writeFile(path.join(dataDir, "train.jsonl"), `${JSON.stringify(row)}\n`, "utf8");
    await fs.writeFile(path.join(dataDir, "valid.jsonl"), `${JSON.stringify(row)}\n`, "utf8");
    await fs.writeFile(path.join(dataDir, "test.jsonl"), `${JSON.stringify(row)}\n`, "utf8");

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
        "1",
        "--json",
      ],
      { cwd: repoRoot, env: { ...process.env, HOME: fixtureRoot } },
    );
    const manifest = JSON.parse(stdout) as {
      promptContract: {
        rewriteScope: string;
        rowsRewritten: number;
        rowsRewrittenFromLegacyPrompt: number;
        validRowsRewrittenFromLegacyPrompt: number;
        testRowsRewrittenFromLegacyPrompt: number;
      };
    };
    expect(manifest.promptContract).toMatchObject({
      rewriteScope: "all_rows_with_recoverable_user_or_task",
      rowsRewritten: 1,
      rowsRewrittenFromLegacyPrompt: 1,
      validRowsRewrittenFromLegacyPrompt: 1,
      testRowsRewrittenFromLegacyPrompt: 1,
    });
    for (const split of ["train", "valid", "test"]) {
      const splitRows = await parseJsonl(path.join(outDir, `${split}.jsonl`));
      expect(splitRows[0]?.prompt).not.toContain(acceptanceLabel);
      expect(splitRows[0]?.prompt).toContain("<withheld_contract_id>");
      expect(splitRows[0]?.meta?.promptContractRewritten).toBe(true);
    }
  });

  it("deduplicates normalized source pairs before optional repeat ablations", async () => {
    const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-source-dedup-slice-"));
    const dataDir = path.join(fixtureRoot, "dataset");
    const outDir = path.join(fixtureRoot, "slice");
    await fs.mkdir(dataDir, { recursive: true });
    const duplicate = {
      prompt: "prompt same",
      completion: JSON.stringify({
        task_family: "curated_seed",
        primary_modules: ["review_panel"],
        supporting_modules: [],
        required_tools: [],
        missing_data: [],
        risk_boundaries: ["research_only"],
        next_step: "route_to_review",
        rejected_context: [],
      }),
      meta: { sourceKind: "curated_seed", sourcePath: "same-1" },
    };
    const duplicateWithWhitespace = {
      ...duplicate,
      prompt: "  prompt   same  ",
      meta: { sourceKind: "curated_seed", sourcePath: "same-2" },
    };
    const unique = {
      ...duplicate,
      prompt: "prompt unique",
      meta: { sourceKind: "curated_seed", sourcePath: "unique" },
    };
    await fs.writeFile(
      path.join(dataDir, "train.jsonl"),
      [duplicate, duplicateWithWhitespace, unique]
        .map((row) => `${JSON.stringify(row)}\n`)
        .join(""),
      "utf8",
    );
    await fs.writeFile(path.join(dataDir, "valid.jsonl"), `${JSON.stringify(unique)}\n`, "utf8");
    await fs.writeFile(path.join(dataDir, "test.jsonl"), `${JSON.stringify(unique)}\n`, "utf8");

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
      counts: { trainWritten: number };
      repetition: { duplicateRows: number; duplicateRate: number };
      dedup: {
        sourceDuplicateRowsSkipped: number;
        sourceDuplicateGroupsSkipped: number;
        explicitRepeatFlagsRemainAvailable: boolean;
      };
    };
    expect(manifest.counts.trainWritten).toBe(2);
    expect(manifest.repetition).toMatchObject({ duplicateRows: 0, duplicateRate: 0 });
    expect(manifest.dedup).toMatchObject({
      sourceDuplicateRowsSkipped: 1,
      sourceDuplicateGroupsSkipped: 1,
      explicitRepeatFlagsRemainAvailable: false,
    });
    await expect(parseJsonl(path.join(outDir, "train.jsonl"))).resolves.toHaveLength(2);
  });

  it("rejects provenance-only rows that cannot recover a natural user task", async () => {
    const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-contract-reject-slice-"));
    const dataDir = path.join(fixtureRoot, "dataset");
    const outDir = path.join(fixtureRoot, "slice");
    await fs.mkdir(dataDir, { recursive: true });
    const unrecoverable = {
      prompt: [
        "old static contract",
        "",
        "source_kind: brain_distillation_review",
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
      meta: { sourceKind: "brain_distillation_review", sourcePath: "unrecoverable" },
    };
    for (const split of ["train", "valid", "test"]) {
      await fs.writeFile(
        path.join(dataDir, `${split}.jsonl`),
        `${JSON.stringify(unrecoverable)}\n`,
      );
    }

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
        "1",
        "--json",
      ],
      { cwd: repoRoot, env: { ...process.env, HOME: fixtureRoot } },
    );
    const manifest = JSON.parse(stdout) as {
      counts: { trainWritten: number; validCopied: number; testCopied: number };
      promptContract: {
        rowsRejected: number;
        validRowsRejected: number;
        testRowsRejected: number;
        sourceContextLeakFree: boolean;
        rejectionReasons: Record<string, number>;
      };
    };
    expect(manifest.counts).toMatchObject({ trainWritten: 0, validCopied: 0, testCopied: 0 });
    expect(manifest.promptContract).toMatchObject({
      rowsRejected: 1,
      validRowsRejected: 1,
      testRowsRejected: 1,
      sourceContextLeakFree: true,
      rejectionReasons: { legacy_source_context_without_user_or_task: 1 },
    });
    await expect(parseJsonl(path.join(outDir, "train.jsonl"))).resolves.toHaveLength(0);
    await expect(parseJsonl(path.join(outDir, "valid.jsonl"))).resolves.toHaveLength(0);
    await expect(parseJsonl(path.join(outDir, "test.jsonl"))).resolves.toHaveLength(0);
  });

  it("does not select parse-invalid teacher rows into the curriculum slice", async () => {
    const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-teacher-gate-slice-"));
    const dataDir = path.join(fixtureRoot, "dataset");
    const outDir = path.join(fixtureRoot, "slice");
    await fs.mkdir(dataDir, { recursive: true });
    const invalid = JSON.parse(line("brain_distillation_review", "review-invalid")) as {
      completion: string;
    };
    invalid.completion = "{not-json";
    await fs.writeFile(
      path.join(dataDir, "train.jsonl"),
      `${JSON.stringify(invalid)}\n${line("brain_distillation_review", "review-valid")}`,
      "utf8",
    );
    await fs.writeFile(path.join(dataDir, "valid.jsonl"), "", "utf8");
    await fs.writeFile(path.join(dataDir, "test.jsonl"), "", "utf8");

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
        "--json",
      ],
      { cwd: repoRoot, env: { ...process.env, HOME: fixtureRoot } },
    );
    const manifest = JSON.parse(stdout) as {
      counts: { reviewSelected: number; reviewQuarantined: number };
      curriculumGate: {
        eligibleReviewCandidates: number;
        quarantinedReviewCandidates: number;
      };
    };
    expect(manifest.counts.reviewSelected).toBe(1);
    expect(manifest.counts.reviewQuarantined).toBe(0);
    expect(manifest.curriculumGate).toMatchObject({
      eligibleReviewCandidates: 1,
      quarantinedReviewCandidates: 1,
    });
    expect(
      (await parseJsonl(path.join(outDir, "train.jsonl"))).filter(
        (entry) => entry.meta?.sourceKind === "brain_distillation_review",
      ),
    ).toHaveLength(1);
  });
});
