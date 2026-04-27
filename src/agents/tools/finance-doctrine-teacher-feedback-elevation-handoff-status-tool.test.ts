import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildFeishuFinanceDoctrineTeacherElevationHandoffsFilename,
  parseFeishuFinanceDoctrineTeacherElevationHandoffArtifact,
  renderFeishuFinanceDoctrineTeacherElevationHandoffArtifact,
} from "../../hooks/bundled/lobster-brain-registry.js";
import { makeTempWorkspace } from "../../test-helpers/workspace.js";
import { createFinanceDoctrineTeacherFeedbackElevationHandoffStatusTool } from "./finance-doctrine-teacher-feedback-elevation-handoff-status-tool.js";

describe("finance_doctrine_teacher_feedback_elevation_handoff_status tool", () => {
  let workspaceDir: string | undefined;

  afterEach(async () => {
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      workspaceDir = undefined;
    }
  });

  async function seedElevationHandoff(
    status: "open" | "superseded" | "converted_to_candidate_input" = "open",
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

  it("records a bounded conversion action for one open teacher-elevation handoff", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-teacher-elevation-status-");
    const { dateKey, handoffId } = await seedElevationHandoff("open");
    const tool = createFinanceDoctrineTeacherFeedbackElevationHandoffStatusTool({ workspaceDir });

    const result = await tool.execute("finance-doctrine-teacher-elevation-status", {
      dateKey,
      handoffId,
      status: "converted_to_candidate_input",
    });

    expect(result.details).toEqual({
      ok: true,
      updated: true,
      dateKey,
      handoffId,
      feedbackId: "feedback-1",
      previousStatus: "open",
      handoffStatus: "converted_to_candidate_input",
      teacherElevationHandoffPath:
        "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-elevation-handoffs.md",
      action:
        "This records teacher-elevation conversion state only. It does not create finance candidates automatically, does not promote doctrine, and does not mutate doctrine cards automatically.",
    });

    const parsed = parseFeishuFinanceDoctrineTeacherElevationHandoffArtifact(
      await fs.readFile(
        path.join(
          workspaceDir,
          "memory",
          "feishu-work-receipts",
          buildFeishuFinanceDoctrineTeacherElevationHandoffsFilename(dateKey),
        ),
        "utf8",
      ),
    );
    expect(parsed?.handoffs).toEqual([
      expect.objectContaining({
        handoffId,
        status: "converted_to_candidate_input",
      }),
    ]);
  });

  it("fails closed on unknown handoff ids", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-teacher-elevation-status-");
    const { dateKey, handoffId } = await seedElevationHandoff("open");
    const tool = createFinanceDoctrineTeacherFeedbackElevationHandoffStatusTool({ workspaceDir });

    const result = await tool.execute("finance-doctrine-teacher-elevation-status-missing", {
      dateKey,
      handoffId: "handoff-does-not-exist",
      status: "superseded",
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
        "Use finance_promotion_candidates with this dateKey to inspect current teacher-elevation handoff ids before retrying finance_doctrine_teacher_feedback_elevation_handoff_status.",
    });
  });

  it("fails closed on invalid conversion transitions", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-teacher-elevation-status-");
    const { dateKey, handoffId } = await seedElevationHandoff("converted_to_candidate_input");
    const tool = createFinanceDoctrineTeacherFeedbackElevationHandoffStatusTool({ workspaceDir });

    const result = await tool.execute("finance-doctrine-teacher-elevation-status-transition", {
      dateKey,
      handoffId,
      status: "superseded",
    });

    expect(result.details).toEqual({
      ok: false,
      updated: false,
      reason: "invalid_teacher_elevation_handoff_status_transition",
      dateKey,
      handoffId,
      currentStatus: "converted_to_candidate_input",
      requestedStatus: "superseded",
      teacherElevationHandoffPath:
        "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-elevation-handoffs.md",
      action:
        "Only teacher-elevation handoffs still in open status can be marked converted_to_candidate_input, rejected_after_handoff_review, or superseded.",
    });
  });

  it("fails closed on handoff linkage mismatch", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-teacher-elevation-status-");
    const receiptsDir = path.join(workspaceDir, "memory", "feishu-work-receipts");
    await fs.mkdir(receiptsDir, { recursive: true });
    const dateKey = "2026-04-16";
    const handoffId = "finance-teacher-elevation-handoff-2026-04-16-feedback-1";
    await fs.writeFile(
      path.join(receiptsDir, buildFeishuFinanceDoctrineTeacherElevationHandoffsFilename(dateKey)),
      renderFeishuFinanceDoctrineTeacherElevationHandoffArtifact({
        handedOffAt: "2026-04-16T22:30:00.000Z",
        sourceTeacherFeedbackArtifact:
          "memory/feishu-work-receipts/2026-04-15-feishu-finance-doctrine-teacher-feedback.md",
        sourceTeacherReviewArtifact:
          "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-review.md",
        handoffs: [
          {
            handoffId,
            feedbackId: "feedback-1",
            critiqueType: "missing_causal_chain",
            critiqueText: "critique text",
            suggestedCandidateText: "suggested candidate",
            evidenceNeeded: "evidence",
            riskOfAdopting: "risk",
            targetGovernancePath:
              "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-promotion-candidates.md",
            operatorNextAction: "next action",
            status: "open",
          },
        ],
      }),
      "utf8",
    );
    const tool = createFinanceDoctrineTeacherFeedbackElevationHandoffStatusTool({ workspaceDir });

    const result = await tool.execute("finance-doctrine-teacher-elevation-status-link-mismatch", {
      dateKey,
      handoffId,
      status: "superseded",
    });

    expect(result.details).toEqual({
      ok: false,
      updated: false,
      reason: "teacher_elevation_handoff_linkage_mismatch",
      dateKey,
      handoffId,
      teacherElevationHandoffPath:
        "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-elevation-handoffs.md",
      teacherFeedbackPath:
        "memory/feishu-work-receipts/2026-04-15-feishu-finance-doctrine-teacher-feedback.md",
      teacherReviewPath:
        "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-review.md",
      action:
        "Repair the teacher-elevation handoff linkage before retrying finance_doctrine_teacher_feedback_elevation_handoff_status.",
    });
  });
});
