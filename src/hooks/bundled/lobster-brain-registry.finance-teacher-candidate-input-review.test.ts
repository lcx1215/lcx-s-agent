import { describe, expect, it } from "vitest";
import {
  parseFeishuFinanceDoctrineTeacherCandidateInputReviewArtifact,
  renderFeishuFinanceDoctrineTeacherCandidateInputReviewArtifact,
} from "./lobster-brain-registry.js";

describe("finance doctrine teacher candidate input review artifact", () => {
  it("round-trips the bounded teacher candidate-input review artifact contract", () => {
    const rendered = renderFeishuFinanceDoctrineTeacherCandidateInputReviewArtifact({
      reviewedAt: "2026-04-16T23:40:00.000Z",
      sourceTeacherCandidateInputArtifact:
        "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-candidate-inputs.md",
      reviews: [
        {
          candidateInputId:
            "finance-teacher-candidate-input-2026-04-16-finance-teacher-elevation-handoff-2026-04-16-feedback-1",
          handoffId: "finance-teacher-elevation-handoff-2026-04-16-feedback-1",
          feedbackId: "feedback-1",
          targetGovernancePath:
            "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-promotion-candidates.md",
          reviewOutcome: "consumed_into_candidate_flow",
        },
      ],
    });

    expect(parseFeishuFinanceDoctrineTeacherCandidateInputReviewArtifact(rendered)).toEqual({
      reviewedAt: "2026-04-16T23:40:00.000Z",
      sourceTeacherCandidateInputArtifact:
        "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-candidate-inputs.md",
      reviews: [
        {
          candidateInputId:
            "finance-teacher-candidate-input-2026-04-16-finance-teacher-elevation-handoff-2026-04-16-feedback-1",
          handoffId: "finance-teacher-elevation-handoff-2026-04-16-feedback-1",
          feedbackId: "feedback-1",
          targetGovernancePath:
            "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-promotion-candidates.md",
          reviewOutcome: "consumed_into_candidate_flow",
        },
      ],
    });
  });
});
