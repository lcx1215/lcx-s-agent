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
    };
    expect(manifest.counts).toMatchObject({
      trainWritten: 12,
      reviewSelected: 2,
      curatedWritten: 6,
    });

    const trainExamples = await parseJsonl(path.join(outDir, "train.jsonl"));
    expect(trainExamples).toHaveLength(12);
    expect(trainExamples.every((entry) => entry.meta?.curriculumSlice === true)).toBe(true);
    expect(
      trainExamples.filter((entry) => entry.meta?.sourceKind === "brain_distillation_review"),
    ).toHaveLength(2);
    await expect(parseJsonl(path.join(outDir, "valid.jsonl"))).resolves.toHaveLength(1);
    await expect(parseJsonl(path.join(outDir, "test.jsonl"))).resolves.toHaveLength(1);
  });
});
