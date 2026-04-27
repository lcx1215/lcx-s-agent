import { describe, expect, it } from "vitest";
import {
  parseFeishuFinanceDoctrineTeacherReviewArtifact,
  renderFeishuFinanceDoctrineTeacherReviewArtifact,
} from "./lobster-brain-registry.js";

describe("finance doctrine teacher review artifact", () => {
  it("round-trips the bounded teacher-review artifact contract", () => {
    const rendered = renderFeishuFinanceDoctrineTeacherReviewArtifact({
      reviewedAt: "2026-04-16T13:45:00.000Z",
      sourceTeacherFeedbackArtifact:
        "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-feedback.md",
      reviews: [
        {
          feedbackId:
            "finance-teacher-feedback-2026-04-16-feishu-finance-doctrine-calibration-190000-000z-control-room-msg-1-missing_causal_chain",
          sourceArtifact:
            "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-calibration-190000-000Z-control-room-msg-1.md",
          reviewOutcome: "elevated_for_governance_review",
        },
      ],
    });

    expect(parseFeishuFinanceDoctrineTeacherReviewArtifact(rendered)).toEqual({
      reviewedAt: "2026-04-16T13:45:00.000Z",
      sourceTeacherFeedbackArtifact:
        "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-feedback.md",
      reviews: [
        {
          feedbackId:
            "finance-teacher-feedback-2026-04-16-feishu-finance-doctrine-calibration-190000-000z-control-room-msg-1-missing_causal_chain",
          sourceArtifact:
            "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-calibration-190000-000Z-control-room-msg-1.md",
          reviewOutcome: "elevated_for_governance_review",
        },
      ],
    });
  });

  it("fails closed on invalid review outcomes", () => {
    expect(
      parseFeishuFinanceDoctrineTeacherReviewArtifact(`\
# Feishu Finance Doctrine Teacher Review

- **Reviewed At**: 2026-04-16T13:45:00.000Z
- **Source Teacher Feedback Artifact**: memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-feedback.md

## Reviews
### Review 1
- **Feedback ID**: feedback-1
- **Source Artifact**: memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-calibration-190000-000Z-control-room-msg-1.md
- **Review Outcome**: pending
`),
    ).toEqual({
      reviewedAt: "2026-04-16T13:45:00.000Z",
      sourceTeacherFeedbackArtifact:
        "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-feedback.md",
      reviews: [],
    });
  });
});
