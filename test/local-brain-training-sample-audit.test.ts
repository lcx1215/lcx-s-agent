import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { auditTrainingSamples } from "../scripts/dev/local-brain-training-sample-audit.js";

const completion = JSON.stringify({
  task_family: "portfolio_risk",
  primary_modules: ["portfolio_risk_gates"],
  supporting_modules: ["review_panel"],
  required_tools: ["review_panel"],
  missing_data: ["position_weights_and_return_series"],
  risk_boundaries: ["research_only"],
  next_step: "route_to_review",
  rejected_context: ["old_lark_conversation_history"],
});

function oldPrompt(userOrTask: string, sourceSummary: string): string {
  return [
    "STATIC CONTRACT",
    "",
    "source_kind: brain_distillation_review",
    `user_or_task: ${userOrTask}`,
    `source_summary: ${sourceSummary}`,
  ].join("\n");
}

describe("local brain training sample audit", () => {
  it("reports repeated skeletons, answer-bearing source leakage, teacher novelty, and trajectory coverage", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-training-sample-audit-"));
    const dataDir = path.join(root, "dataset");
    await fs.mkdir(dataDir, { recursive: true });
    const teacherRow = {
      prompt: oldPrompt(
        "请研究 portfolio_risk_gates",
        '{"candidateText":"answer-bearing plan","primaryModules":["portfolio_risk_gates"]}',
      ),
      completion,
      meta: { sourceKind: "brain_distillation_review", trajectory: "student-1" },
    };
    const duplicateRow = { ...teacherRow, meta: { sourceKind: "brain_distillation_review" } };
    const neutralRow = {
      prompt: oldPrompt("研究组合风险", "high-level receipt"),
      completion,
      meta: { sourceKind: "curated_seed" },
    };
    await fs.writeFile(
      path.join(dataDir, "train.jsonl"),
      `${JSON.stringify(teacherRow)}\n${JSON.stringify(duplicateRow)}\n${JSON.stringify(neutralRow)}\n`,
    );
    await fs.writeFile(path.join(dataDir, "valid.jsonl"), `${JSON.stringify(neutralRow)}\n`);
    await fs.writeFile(
      path.join(dataDir, "test.jsonl"),
      `${JSON.stringify({ ...neutralRow, prompt: "held-out" })}\n`,
    );

    const report = await auditTrainingSamples({ dataDir });
    const train = report.splits as Record<string, Record<string, unknown>>;
    expect(train.train.repetition).toMatchObject({ duplicateRows: 1, duplicateGroups: 1 });
    expect(train.train.leakage).toMatchObject({
      sourceSummaryOutputFieldRows: 2,
      sourceSummaryContractIdRows: 2,
      promptContractFieldRows: 0,
      userOrTaskContractFieldRows: 0,
    });
    expect(train.train.teacherNovelty).toMatchObject({
      rows: 2,
      uniquePairs: 1,
      uniqueCompletionsNotInNonTeacher: 0,
      structuredTrajectoryRows: 1,
    });
    expect(train.train.studentTrajectoryCoverage).toMatchObject({
      structuredMetaRows: 1,
      rowsWithAnyTrajectoryEvidence: 1,
    });
    expect(report.splitOverlap).toMatchObject({ trainValid: 1, trainTest: 0 });
  });
});
