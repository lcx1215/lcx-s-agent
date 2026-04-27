import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildFeishuFinanceDoctrineTeacherCandidateInputsFilename,
  buildFeishuFinanceDoctrineTeacherElevationHandoffsFilename,
  parseFeishuFinanceDoctrineTeacherCandidateInputArtifact,
  renderFeishuFinanceDoctrineTeacherElevationHandoffArtifact,
} from "../../hooks/bundled/lobster-brain-registry.js";
import { makeTempWorkspace } from "../../test-helpers/workspace.js";
import { createFinanceDoctrineTeacherFeedbackCandidateInputTool } from "./finance-doctrine-teacher-feedback-candidate-input-tool.js";

describe("finance_doctrine_teacher_feedback_candidate_input tool", () => {
  let workspaceDir: string | undefined;

  afterEach(async () => {
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      workspaceDir = undefined;
    }
  });

  async function seedElevationHandoff(
    status: "open" | "converted_to_candidate_input" | "superseded" = "converted_to_candidate_input",
  ) {
    const receiptsDir = path.join(workspaceDir!, "memory", "feishu-work-receipts");
    await fs.mkdir(receiptsDir, { recursive: true });
    const dateKey = "2026-04-16";
    const handoffId = "finance-teacher-elevation-handoff-2026-04-16-feedback-1";
    await fs.writeFile(
      path.join(receiptsDir, buildFeishuFinanceDoctrineTeacherElevationHandoffsFilename(dateKey)),
      renderFeishuFinanceDoctrineTeacherElevationHandoffArtifact({
        handedOffAt: "2026-04-16T22:30:00.000Z",
        sourceTeacherFeedbackArtifact:
          "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-feedback.md",
        sourceTeacherReviewArtifact:
          "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-review.md",
        handoffs: [
          {
            handoffId,
            feedbackId: "feedback-1",
            critiqueType: "missing_causal_chain",
            critiqueText: "The calibration artifact omits the rates-to-index causal chain.",
            suggestedCandidateText:
              "teacher critique: make the rates-to-index transmission explicit before leaning on conviction",
            evidenceNeeded:
              "Need repeated calibration artifacts showing the same omitted chain weakens later review quality.",
            riskOfAdopting: "Could overcorrect into boilerplate macro narration.",
            targetGovernancePath:
              "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-promotion-candidates.md",
            operatorNextAction:
              "Review this elevated teacher critique against the same-day finance governance candidate flow and convert it into explicit candidate input manually only if the scope and evidence hold.",
            status,
          },
        ],
      }),
      "utf8",
    );
    return { dateKey, handoffId };
  }

  it("creates a durable finance candidate-input artifact from a converted teacher handoff", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-teacher-candidate-input-");
    const { dateKey, handoffId } = await seedElevationHandoff("converted_to_candidate_input");
    const tool = createFinanceDoctrineTeacherFeedbackCandidateInputTool({ workspaceDir });

    const result = await tool.execute("finance-teacher-candidate-input", {
      dateKey,
      handoffId,
    });

    expect(result.details).toEqual({
      ok: true,
      updated: true,
      dateKey,
      handoffId,
      feedbackId: "feedback-1",
      candidateInputId:
        "finance-teacher-candidate-input-2026-04-16-finance-teacher-elevation-handoff-2026-04-16-feedback-1",
      teacherElevationHandoffPath:
        "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-elevation-handoffs.md",
      teacherCandidateInputPath:
        "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-candidate-inputs.md",
      targetGovernancePath:
        "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-promotion-candidates.md",
      action:
        "This creates a bounded finance governance candidate-input artifact only. It does not create promotion candidates automatically, does not promote doctrine, and does not mutate doctrine cards automatically.",
    });

    const parsed = parseFeishuFinanceDoctrineTeacherCandidateInputArtifact(
      await fs.readFile(
        path.join(
          workspaceDir,
          "memory",
          "feishu-work-receipts",
          buildFeishuFinanceDoctrineTeacherCandidateInputsFilename(dateKey),
        ),
        "utf8",
      ),
    );
    expect(parsed?.candidateInputs).toEqual([
      expect.objectContaining({
        handoffId,
        feedbackId: "feedback-1",
      }),
    ]);
  });

  it("fails closed on non-converted teacher handoffs", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-teacher-candidate-input-");
    const { dateKey, handoffId } = await seedElevationHandoff("open");
    const tool = createFinanceDoctrineTeacherFeedbackCandidateInputTool({ workspaceDir });

    const result = await tool.execute("finance-teacher-candidate-input-open", {
      dateKey,
      handoffId,
    });

    expect(result.details).toEqual({
      ok: false,
      updated: false,
      reason: "teacher_elevation_handoff_not_converted",
      dateKey,
      handoffId,
      handoffStatus: "open",
      teacherElevationHandoffPath:
        "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-elevation-handoffs.md",
      targetGovernancePath:
        "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-promotion-candidates.md",
      action:
        "Only teacher-elevation handoffs already marked converted_to_candidate_input can create a finance candidate-input artifact.",
    });
  });

  it("fails closed on unknown handoff ids", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-teacher-candidate-input-");
    const { dateKey, handoffId } = await seedElevationHandoff("converted_to_candidate_input");
    const tool = createFinanceDoctrineTeacherFeedbackCandidateInputTool({ workspaceDir });

    const result = await tool.execute("finance-teacher-candidate-input-missing", {
      dateKey,
      handoffId: "handoff-does-not-exist",
    });

    expect(result.details).toEqual({
      ok: false,
      updated: false,
      reason: "teacher_elevation_handoff_not_found",
      dateKey,
      handoffId: "handoff-does-not-exist",
      teacherElevationHandoffPath:
        "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-elevation-handoffs.md",
      availableHandoffIds: [handoffId],
      action:
        "Use finance_promotion_candidates with this dateKey to inspect current teacher-elevation handoff ids before retrying finance_doctrine_teacher_feedback_candidate_input.",
    });
  });
});
