import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildFeishuFinanceDoctrineTeacherElevationHandoffsFilename,
  parseFeishuFinanceDoctrineTeacherElevationHandoffArtifact,
  renderFeishuFinanceDoctrineTeacherFeedbackArtifact,
  renderFeishuFinanceDoctrineTeacherReviewArtifact,
} from "../../hooks/bundled/lobster-brain-registry.js";
import { makeTempWorkspace } from "../../test-helpers/workspace.js";
import { createFinanceDoctrineTeacherFeedbackElevationHandoffTool } from "./finance-doctrine-teacher-feedback-elevation-handoff-tool.js";

describe("finance_doctrine_teacher_feedback_elevation_handoff tool", () => {
  let workspaceDir: string | undefined;

  afterEach(async () => {
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      workspaceDir = undefined;
    }
  });

  async function seedTeacherArtifacts(
    reviewOutcome: "deferred" | "rejected" | "elevated_for_governance_review",
  ) {
    const receiptsDir = path.join(workspaceDir!, "memory", "feishu-work-receipts");
    await fs.mkdir(receiptsDir, { recursive: true });
    const dateKey = "2026-04-16";
    const feedbackId = "feedback-1";
    const sourceArtifact =
      "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-calibration-190000-000Z-control-room-msg-1.md";
    await fs.writeFile(
      path.join(receiptsDir, `${dateKey}-feishu-finance-doctrine-teacher-feedback.md`),
      renderFeishuFinanceDoctrineTeacherFeedbackArtifact({
        generatedAt: "2026-04-16T21:30:00.000Z",
        teacherTask: "finance_calibration_audit",
        feedbacks: [
          {
            feedbackId,
            sourceArtifact,
            teacherModel: "openai/gpt-5.2",
            critiqueType: "missing_causal_chain",
            critiqueText: "The calibration artifact omits the rates-to-index causal chain.",
            suggestedCandidateText:
              "teacher critique: make the rates-to-index transmission explicit before leaning on conviction",
            evidenceNeeded:
              "Need repeated calibration artifacts showing the same omitted chain weakens later review quality.",
            riskOfAdopting: "Could overcorrect into boilerplate macro narration.",
            recommendedNextAction: "Check adjacent calibration artifacts before promotion.",
          },
        ],
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(receiptsDir, `${dateKey}-feishu-finance-doctrine-teacher-review.md`),
      renderFeishuFinanceDoctrineTeacherReviewArtifact({
        reviewedAt: "2026-04-16T22:00:00.000Z",
        sourceTeacherFeedbackArtifact:
          "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-feedback.md",
        reviews: [
          {
            feedbackId,
            sourceArtifact,
            reviewOutcome,
          },
        ],
      }),
      "utf8",
    );
    return { dateKey, feedbackId, sourceArtifact };
  }

  it("writes a bounded teacher-elevation handoff for one elevated teacher critique", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-teacher-elevation-handoff-");
    const { dateKey, feedbackId } = await seedTeacherArtifacts("elevated_for_governance_review");
    const tool = createFinanceDoctrineTeacherFeedbackElevationHandoffTool({ workspaceDir });

    const result = await tool.execute("finance-doctrine-teacher-elevation-handoff", {
      dateKey,
      feedbackId,
    });

    expect(result.details).toEqual({
      ok: true,
      updated: true,
      dateKey,
      feedbackId,
      critiqueType: "missing_causal_chain",
      teacherFeedbackPath:
        "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-feedback.md",
      teacherReviewPath:
        "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-review.md",
      teacherElevationHandoffPath:
        "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-elevation-handoffs.md",
      targetGovernancePath:
        "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-promotion-candidates.md",
      handoffId: "finance-teacher-elevation-handoff-2026-04-16-feedback-1",
      handoffStatus: "open",
      action:
        "This writes a bounded teacher-elevation handoff only. It does not adopt knowledge, does not create finance candidates automatically, and does not mutate doctrine cards automatically.",
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
        feedbackId,
        critiqueType: "missing_causal_chain",
        status: "open",
      }),
    ]);
  });

  it("fails closed on non-elevated teacher review state", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-teacher-elevation-handoff-");
    const { dateKey, feedbackId } = await seedTeacherArtifacts("deferred");
    const tool = createFinanceDoctrineTeacherFeedbackElevationHandoffTool({ workspaceDir });

    const result = await tool.execute("finance-doctrine-teacher-elevation-handoff-not-elevated", {
      dateKey,
      feedbackId,
    });

    expect(result.details).toEqual({
      ok: false,
      updated: false,
      reason: "teacher_review_not_elevated",
      dateKey,
      feedbackId,
      reviewOutcome: "deferred",
      teacherFeedbackPath:
        "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-feedback.md",
      teacherReviewPath:
        "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-review.md",
      action:
        "Only teacher critiques already marked elevated_for_governance_review can create a finance governance elevation handoff.",
    });
  });

  it("fails closed on unknown feedback ids", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-teacher-elevation-handoff-");
    const { dateKey, feedbackId } = await seedTeacherArtifacts("elevated_for_governance_review");
    const tool = createFinanceDoctrineTeacherFeedbackElevationHandoffTool({ workspaceDir });

    const result = await tool.execute("finance-doctrine-teacher-elevation-handoff-missing", {
      dateKey,
      feedbackId: "feedback-2",
    });

    expect(result.details).toEqual({
      ok: false,
      updated: false,
      reason: "feedback_not_found",
      dateKey,
      feedbackId: "feedback-2",
      teacherFeedbackPath:
        "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-feedback.md",
      availableFeedbackIds: [feedbackId],
      action:
        "Use finance_promotion_candidates with this dateKey to inspect current teacher feedback ids before retrying finance_doctrine_teacher_feedback_elevation_handoff.",
    });
  });

  it("fails closed on teacher-feedback and teacher-review linkage mismatch", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-teacher-elevation-handoff-");
    const receiptsDir = path.join(workspaceDir, "memory", "feishu-work-receipts");
    await fs.mkdir(receiptsDir, { recursive: true });
    const dateKey = "2026-04-16";
    await fs.writeFile(
      path.join(receiptsDir, `${dateKey}-feishu-finance-doctrine-teacher-feedback.md`),
      renderFeishuFinanceDoctrineTeacherFeedbackArtifact({
        generatedAt: "2026-04-16T21:30:00.000Z",
        teacherTask: "finance_calibration_audit",
        feedbacks: [
          {
            feedbackId: "feedback-1",
            sourceArtifact:
              "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-calibration-190000-000Z-control-room-msg-1.md",
            teacherModel: "openai/gpt-5.2",
            critiqueType: "missing_causal_chain",
            critiqueText: "critique text",
            suggestedCandidateText: "suggested candidate",
            evidenceNeeded: "evidence",
            riskOfAdopting: "risk",
            recommendedNextAction: "next action",
          },
        ],
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(receiptsDir, `${dateKey}-feishu-finance-doctrine-teacher-review.md`),
      renderFeishuFinanceDoctrineTeacherReviewArtifact({
        reviewedAt: "2026-04-16T22:00:00.000Z",
        sourceTeacherFeedbackArtifact:
          "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-feedback.md",
        reviews: [
          {
            feedbackId: "feedback-1",
            sourceArtifact:
              "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-calibration-191500-000Z-control-room-msg-2.md",
            reviewOutcome: "elevated_for_governance_review",
          },
        ],
      }),
      "utf8",
    );
    const tool = createFinanceDoctrineTeacherFeedbackElevationHandoffTool({ workspaceDir });

    const result = await tool.execute("finance-doctrine-teacher-elevation-handoff-link-mismatch", {
      dateKey,
      feedbackId: "feedback-1",
    });

    expect(result.details).toEqual({
      ok: false,
      updated: false,
      reason: "linkage_mismatch",
      dateKey,
      feedbackId: "feedback-1",
      sourceArtifact:
        "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-calibration-190000-000Z-control-room-msg-1.md",
      teacherFeedbackPath:
        "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-feedback.md",
      teacherReviewPath:
        "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-review.md",
      action:
        "Repair the teacher feedback and teacher review linkage before retrying finance_doctrine_teacher_feedback_elevation_handoff.",
    });
  });
});
