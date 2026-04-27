import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildFeishuFinanceDoctrineTeacherFeedbackFilename,
  buildFeishuFinanceDoctrineTeacherReviewFilename,
  parseFeishuFinanceDoctrineTeacherReviewArtifact,
  renderFeishuFinanceDoctrineTeacherFeedbackArtifact,
  renderFeishuFinanceDoctrineTeacherReviewArtifact,
} from "../../hooks/bundled/lobster-brain-registry.js";
import { makeTempWorkspace } from "../../test-helpers/workspace.js";
import { createFinanceDoctrineTeacherFeedbackReviewTool } from "./finance-doctrine-teacher-feedback-review-tool.js";

describe("finance_doctrine_teacher_feedback_review tool", () => {
  let workspaceDir: string | undefined;

  afterEach(async () => {
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      workspaceDir = undefined;
    }
  });

  async function seedTeacherFeedback(params?: { sourceArtifact?: string }) {
    const receiptsDir = path.join(workspaceDir!, "memory", "feishu-work-receipts");
    await fs.mkdir(receiptsDir, { recursive: true });
    const dateKey = "2026-04-16";
    const sourceArtifact =
      params?.sourceArtifact ??
      "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-calibration-190000-000Z-control-room-msg-1.md";
    const feedbackId =
      "finance-teacher-feedback-2026-04-16-feishu-finance-doctrine-calibration-190000-000z-control-room-msg-1-missing_causal_chain";
    await fs.writeFile(
      path.join(receiptsDir, buildFeishuFinanceDoctrineTeacherFeedbackFilename(dateKey)),
      renderFeishuFinanceDoctrineTeacherFeedbackArtifact({
        generatedAt: "2026-04-16T13:00:00.000Z",
        teacherTask: "finance_calibration_audit",
        feedbacks: [
          {
            feedbackId,
            sourceArtifact,
            teacherModel: "openai/gpt-5.2",
            critiqueType: "missing_causal_chain",
            critiqueText:
              "The calibration note does not make the causal link from rates to index pressure explicit.",
            suggestedCandidateText:
              "teacher critique: holdings_thesis_revalidation calibration should make rate-pressure transmission explicit before leaning on conviction",
            evidenceNeeded:
              "Need repeated receipts showing omitted transmission logic weakens later finance doctrine review quality.",
            riskOfAdopting:
              "Could turn every note into boilerplate macro narration instead of keeping the doctrine narrow.",
            recommendedNextAction:
              "Review adjacent calibration artifacts and only elevate if the missing transmission chain repeats.",
          },
        ],
      }),
      "utf8",
    );
    return { dateKey, feedbackId, sourceArtifact };
  }

  it("writes bounded teacher review state for one retained teacher critique", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-teacher-review-");
    const { dateKey, feedbackId, sourceArtifact } = await seedTeacherFeedback();
    const tool = createFinanceDoctrineTeacherFeedbackReviewTool({ workspaceDir });

    const result = await tool.execute("finance-doctrine-teacher-feedback-review", {
      dateKey,
      feedbackId,
      outcome: "elevated_for_governance_review",
    });

    expect(result.details).toEqual({
      ok: true,
      updated: true,
      dateKey,
      feedbackId,
      sourceArtifact,
      reviewOutcome: "elevated_for_governance_review",
      teacherFeedbackPath:
        "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-feedback.md",
      teacherReviewPath:
        "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-review.md",
      action:
        "This records bounded teacher review state only. It does not adopt knowledge, does not promote doctrine, and does not mutate doctrine cards automatically.",
    });

    const parsed = parseFeishuFinanceDoctrineTeacherReviewArtifact(
      await fs.readFile(
        path.join(
          workspaceDir,
          "memory",
          "feishu-work-receipts",
          buildFeishuFinanceDoctrineTeacherReviewFilename(dateKey),
        ),
        "utf8",
      ),
    );
    expect(parsed?.sourceTeacherFeedbackArtifact).toBe(
      "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-feedback.md",
    );
    expect(parsed?.reviews).toEqual([
      {
        feedbackId,
        sourceArtifact,
        reviewOutcome: "elevated_for_governance_review",
      },
    ]);
  });

  it("fails closed on unknown feedback ids", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-teacher-review-");
    const { dateKey, feedbackId } = await seedTeacherFeedback();
    const tool = createFinanceDoctrineTeacherFeedbackReviewTool({ workspaceDir });

    const result = await tool.execute("finance-doctrine-teacher-feedback-review-missing", {
      dateKey,
      feedbackId: "feedback-does-not-exist",
      outcome: "deferred",
    });

    expect(result.details).toEqual({
      ok: false,
      updated: false,
      reason: "feedback_not_found",
      dateKey,
      feedbackId: "feedback-does-not-exist",
      teacherFeedbackPath:
        "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-feedback.md",
      availableFeedbackIds: [feedbackId],
      action:
        "Use finance_promotion_candidates with this dateKey to inspect current teacher feedback ids before retrying finance_doctrine_teacher_feedback_review.",
    });
  });

  it("fails closed on invalid review transitions", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-teacher-review-");
    const { dateKey, feedbackId, sourceArtifact } = await seedTeacherFeedback();
    const receiptsDir = path.join(workspaceDir, "memory", "feishu-work-receipts");
    await fs.writeFile(
      path.join(receiptsDir, buildFeishuFinanceDoctrineTeacherReviewFilename(dateKey)),
      renderFeishuFinanceDoctrineTeacherReviewArtifact({
        reviewedAt: "2026-04-16T13:45:00.000Z",
        sourceTeacherFeedbackArtifact:
          "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-feedback.md",
        reviews: [
          {
            feedbackId,
            sourceArtifact,
            reviewOutcome: "deferred",
          },
        ],
      }),
      "utf8",
    );
    const tool = createFinanceDoctrineTeacherFeedbackReviewTool({ workspaceDir });

    const result = await tool.execute("finance-doctrine-teacher-feedback-review-transition", {
      dateKey,
      feedbackId,
      outcome: "rejected",
    });

    expect(result.details).toEqual({
      ok: false,
      updated: false,
      reason: "invalid_teacher_review_transition",
      dateKey,
      feedbackId,
      sourceArtifact,
      currentOutcome: "deferred",
      requestedOutcome: "rejected",
      teacherFeedbackPath:
        "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-feedback.md",
      teacherReviewPath:
        "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-review.md",
      action:
        "Teacher feedback entries can only move once from pending into deferred, rejected, or elevated_for_governance_review.",
    });
  });

  it("fails closed on mismatched source artifact linkage", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-teacher-review-");
    const { dateKey, feedbackId } = await seedTeacherFeedback({
      sourceArtifact:
        "memory/feishu-work-receipts/2026-04-15-feishu-finance-doctrine-calibration-190000-000Z-control-room-msg-1.md",
    });
    const tool = createFinanceDoctrineTeacherFeedbackReviewTool({ workspaceDir });

    const result = await tool.execute("finance-doctrine-teacher-feedback-review-link-mismatch", {
      dateKey,
      feedbackId,
      outcome: "deferred",
    });

    expect(result.details).toEqual({
      ok: false,
      updated: false,
      reason: "source_artifact_link_mismatch",
      dateKey,
      feedbackId,
      sourceArtifact:
        "memory/feishu-work-receipts/2026-04-15-feishu-finance-doctrine-calibration-190000-000Z-control-room-msg-1.md",
      teacherFeedbackPath:
        "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-feedback.md",
      action:
        "Repair the teacher feedback source-artifact linkage before retrying finance_doctrine_teacher_feedback_review.",
    });
  });
});
