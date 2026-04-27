import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildFeishuFinanceDoctrineTeacherCandidateInputReviewFilename,
  buildFeishuFinanceDoctrineTeacherCandidateInputsFilename,
  parseFeishuFinanceDoctrineTeacherCandidateInputReviewArtifact,
  renderFeishuFinanceDoctrineTeacherCandidateInputArtifact,
} from "../../hooks/bundled/lobster-brain-registry.js";
import { makeTempWorkspace } from "../../test-helpers/workspace.js";
import { createFinanceDoctrineTeacherFeedbackCandidateInputReviewTool } from "./finance-doctrine-teacher-feedback-candidate-input-review-tool.js";

describe("finance_doctrine_teacher_feedback_candidate_input_review tool", () => {
  let workspaceDir: string | undefined;

  afterEach(async () => {
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      workspaceDir = undefined;
    }
  });

  async function seedCandidateInput() {
    const receiptsDir = path.join(workspaceDir!, "memory", "feishu-work-receipts");
    await fs.mkdir(receiptsDir, { recursive: true });
    const dateKey = "2026-04-16";
    const candidateInputId =
      "finance-teacher-candidate-input-2026-04-16-finance-teacher-elevation-handoff-2026-04-16-feedback-1";
    await fs.writeFile(
      path.join(receiptsDir, buildFeishuFinanceDoctrineTeacherCandidateInputsFilename(dateKey)),
      renderFeishuFinanceDoctrineTeacherCandidateInputArtifact({
        createdAt: "2026-04-16T23:10:00.000Z",
        sourceTeacherElevationHandoffArtifact:
          "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-elevation-handoffs.md",
        sourceTeacherFeedbackArtifact:
          "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-feedback.md",
        sourceTeacherReviewArtifact:
          "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-review.md",
        candidateInputs: [
          {
            candidateInputId,
            handoffId: "finance-teacher-elevation-handoff-2026-04-16-feedback-1",
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
              "Review this converted teacher critique against the same-day finance governance candidate flow before any later governance action.",
          },
        ],
      }),
      "utf8",
    );
    return { dateKey, candidateInputId };
  }

  it("records a bounded consumption outcome for one teacher candidate-input artifact", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-teacher-candidate-input-review-");
    const { dateKey, candidateInputId } = await seedCandidateInput();
    const tool = createFinanceDoctrineTeacherFeedbackCandidateInputReviewTool({ workspaceDir });

    const result = await tool.execute("finance-teacher-candidate-input-review", {
      dateKey,
      candidateInputId,
      outcome: "consumed_into_candidate_flow",
    });

    expect(result.details).toEqual({
      ok: true,
      updated: true,
      dateKey,
      candidateInputId,
      handoffId: "finance-teacher-elevation-handoff-2026-04-16-feedback-1",
      feedbackId: "feedback-1",
      targetGovernancePath:
        "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-promotion-candidates.md",
      reviewOutcome: "consumed_into_candidate_flow",
      teacherCandidateInputPath:
        "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-candidate-inputs.md",
      teacherCandidateInputReviewPath:
        "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-candidate-input-review.md",
      action:
        "This records bounded teacher candidate-input consumption state only. It does not create promotion candidates automatically, does not promote doctrine, and does not mutate doctrine cards automatically.",
    });

    const parsed = parseFeishuFinanceDoctrineTeacherCandidateInputReviewArtifact(
      await fs.readFile(
        path.join(
          workspaceDir,
          "memory",
          "feishu-work-receipts",
          buildFeishuFinanceDoctrineTeacherCandidateInputReviewFilename(dateKey),
        ),
        "utf8",
      ),
    );
    expect(parsed?.reviews).toEqual([
      expect.objectContaining({
        candidateInputId,
        reviewOutcome: "consumed_into_candidate_flow",
      }),
    ]);
  });

  it("fails closed on unknown candidateInputId values", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-teacher-candidate-input-review-");
    const { dateKey, candidateInputId } = await seedCandidateInput();
    const tool = createFinanceDoctrineTeacherFeedbackCandidateInputReviewTool({ workspaceDir });

    const result = await tool.execute("finance-teacher-candidate-input-review-missing", {
      dateKey,
      candidateInputId: "candidate-input-does-not-exist",
      outcome: "superseded",
    });

    expect(result.details).toEqual({
      ok: false,
      updated: false,
      reason: "teacher_candidate_input_not_found",
      dateKey,
      candidateInputId: "candidate-input-does-not-exist",
      teacherCandidateInputPath:
        "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-candidate-inputs.md",
      availableCandidateInputIds: [candidateInputId],
      action:
        "Use finance_promotion_candidates with this dateKey to inspect current teacher candidate-input ids before retrying finance_doctrine_teacher_feedback_candidate_input_review.",
    });
  });

  it("fails closed on invalid review transitions", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-teacher-candidate-input-review-");
    const { dateKey, candidateInputId } = await seedCandidateInput();
    const receiptsDir = path.join(workspaceDir, "memory", "feishu-work-receipts");
    await fs.writeFile(
      path.join(
        receiptsDir,
        buildFeishuFinanceDoctrineTeacherCandidateInputReviewFilename(dateKey),
      ),
      `# Feishu Finance Doctrine Teacher Candidate Input Review

- **Reviewed At**: 2026-04-16T23:40:00.000Z
- **Source Teacher Candidate Input Artifact**: memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-candidate-inputs.md

## Reviews
### Review 1
- **Candidate Input ID**: ${candidateInputId}
- **Handoff ID**: finance-teacher-elevation-handoff-2026-04-16-feedback-1
- **Feedback ID**: feedback-1
- **Target Governance Path**: memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-promotion-candidates.md
- **Review Outcome**: consumed_into_candidate_flow
`,
      "utf8",
    );
    const tool = createFinanceDoctrineTeacherFeedbackCandidateInputReviewTool({ workspaceDir });

    const result = await tool.execute("finance-teacher-candidate-input-review-transition", {
      dateKey,
      candidateInputId,
      outcome: "superseded",
    });

    expect(result.details).toEqual({
      ok: false,
      updated: false,
      reason: "invalid_teacher_candidate_input_review_transition",
      dateKey,
      candidateInputId,
      currentOutcome: "consumed_into_candidate_flow",
      requestedOutcome: "superseded",
      teacherCandidateInputPath:
        "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-candidate-inputs.md",
      teacherCandidateInputReviewPath:
        "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-candidate-input-review.md",
      action:
        "Teacher candidate-input artifacts can only move once from pending into consumed_into_candidate_flow, rejected_before_candidate_flow, or superseded.",
    });
  });
});
