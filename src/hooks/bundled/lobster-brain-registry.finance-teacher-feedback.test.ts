import { describe, expect, it } from "vitest";
import {
  parseFeishuFinanceDoctrineTeacherFeedbackArtifact,
  renderFeishuFinanceDoctrineTeacherFeedbackArtifact,
} from "./lobster-brain-registry.js";

describe("finance doctrine teacher feedback artifact", () => {
  it("round-trips the bounded teacher-feedback artifact contract", () => {
    const rendered = renderFeishuFinanceDoctrineTeacherFeedbackArtifact({
      generatedAt: "2026-03-25T21:30:00.000Z",
      teacherTask: "finance_calibration_audit",
      feedbacks: [
        {
          feedbackId:
            "finance-teacher-feedback-2026-03-25-feishu-finance-doctrine-calibration-190000-000z-control-room-missing_bear_case",
          sourceArtifact:
            "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-calibration-190000-000Z-control-room.md",
          teacherModel: "openai/gpt-5.2",
          critiqueType: "missing_bear_case",
          critiqueText:
            "The calibration note never says what the bear case would have looked like in receipt terms.",
          suggestedCandidateText:
            "teacher critique: holdings_thesis_revalidation calibration often omits an explicit bear-case check before claiming no-action discipline is strong enough",
          evidenceNeeded:
            "Need repeated later receipts showing the missing bear-case pattern matters to decision quality.",
          riskOfAdopting:
            "Could overcorrect toward boilerplate bear cases that do not improve the actual research edge.",
          recommendedNextAction:
            "Review adjacent calibration artifacts and confirm this gap is repeated before promoting it.",
        },
      ],
    });

    expect(parseFeishuFinanceDoctrineTeacherFeedbackArtifact(rendered)).toEqual({
      generatedAt: "2026-03-25T21:30:00.000Z",
      teacherTask: "finance_calibration_audit",
      feedbacks: [
        {
          feedbackId:
            "finance-teacher-feedback-2026-03-25-feishu-finance-doctrine-calibration-190000-000z-control-room-missing_bear_case",
          sourceArtifact:
            "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-calibration-190000-000Z-control-room.md",
          teacherModel: "openai/gpt-5.2",
          critiqueType: "missing_bear_case",
          critiqueText:
            "The calibration note never says what the bear case would have looked like in receipt terms.",
          suggestedCandidateText:
            "teacher critique: holdings_thesis_revalidation calibration often omits an explicit bear-case check before claiming no-action discipline is strong enough",
          evidenceNeeded:
            "Need repeated later receipts showing the missing bear-case pattern matters to decision quality.",
          riskOfAdopting:
            "Could overcorrect toward boilerplate bear cases that do not improve the actual research edge.",
          recommendedNextAction:
            "Review adjacent calibration artifacts and confirm this gap is repeated before promoting it.",
        },
      ],
    });
  });

  it("fails closed on invalid critique types", () => {
    expect(
      parseFeishuFinanceDoctrineTeacherFeedbackArtifact(`\
# Feishu Finance Doctrine Teacher Feedback

- **Generated At**: 2026-03-25T21:30:00.000Z
- **Teacher Task**: finance_calibration_audit

## Feedback
### Feedback 1
- **Feedback ID**: feedback-1
- **Source Artifact**: memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-calibration-190000-000Z-control-room.md
- **Teacher Model**: openai/gpt-5.2
- **Critique Type**: stale_memory
- **Critique Text**: critique text
- **Suggested Candidate Text**: suggested candidate
- **Evidence Needed**: evidence
- **Risk Of Adopting**: risk
- **Recommended Next Action**: next action
`),
    ).toEqual({
      generatedAt: "2026-03-25T21:30:00.000Z",
      teacherTask: "finance_calibration_audit",
      feedbacks: [],
    });
  });
});
