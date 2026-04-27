import { describe, expect, it } from "vitest";
import {
  parseFeishuFinanceDoctrineTeacherElevationHandoffArtifact,
  renderFeishuFinanceDoctrineTeacherElevationHandoffArtifact,
} from "./lobster-brain-registry.js";

describe("finance doctrine teacher elevation handoff artifact", () => {
  it("round-trips the bounded teacher-elevation handoff artifact contract", () => {
    const rendered = renderFeishuFinanceDoctrineTeacherElevationHandoffArtifact({
      handedOffAt: "2026-04-16T22:30:00.000Z",
      sourceTeacherFeedbackArtifact:
        "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-feedback.md",
      sourceTeacherReviewArtifact:
        "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-review.md",
      handoffs: [
        {
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
            "Review this elevated teacher critique against the same-day finance governance candidate flow and convert it into explicit candidate input manually only if the scope and evidence hold.",
          status: "open",
        },
      ],
    });

    expect(parseFeishuFinanceDoctrineTeacherElevationHandoffArtifact(rendered)).toEqual({
      handedOffAt: "2026-04-16T22:30:00.000Z",
      sourceTeacherFeedbackArtifact:
        "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-feedback.md",
      sourceTeacherReviewArtifact:
        "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-review.md",
      handoffs: [
        {
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
            "Review this elevated teacher critique against the same-day finance governance candidate flow and convert it into explicit candidate input manually only if the scope and evidence hold.",
          status: "open",
        },
      ],
    });
  });

  it("fails closed on invalid handoff statuses", () => {
    expect(
      parseFeishuFinanceDoctrineTeacherElevationHandoffArtifact(`\
# Feishu Finance Doctrine Teacher Elevation Handoffs

- **Handed Off At**: 2026-04-16T22:30:00.000Z
- **Source Teacher Feedback Artifact**: memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-feedback.md
- **Source Teacher Review Artifact**: memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-review.md

## Handoffs
### Handoff 1
- **Handoff ID**: handoff-1
- **Feedback ID**: feedback-1
- **Critique Type**: missing_causal_chain
- **Critique Text**: critique text
- **Suggested Candidate Text**: suggested candidate
- **Evidence Needed**: evidence
- **Risk Of Adopting**: risk
- **Target Governance Path**: memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-promotion-candidates.md
- **Operator Next Action**: next action
- **Status**: pending
`),
    ).toEqual({
      handedOffAt: "2026-04-16T22:30:00.000Z",
      sourceTeacherFeedbackArtifact:
        "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-feedback.md",
      sourceTeacherReviewArtifact:
        "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-review.md",
      handoffs: [],
    });
  });
});
