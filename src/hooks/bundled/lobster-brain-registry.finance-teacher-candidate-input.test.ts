import { describe, expect, it } from "vitest";
import {
  parseExternalFinanceDoctrineTeacherCandidateInputArtifact,
  renderExternalFinanceDoctrineTeacherCandidateInputArtifact,
} from "./lobster-brain-registry.js";

describe("finance doctrine teacher candidate input artifact", () => {
  it("round-trips the bounded teacher candidate-input artifact contract", () => {
    const rendered = renderExternalFinanceDoctrineTeacherCandidateInputArtifact({
      createdAt: "2026-04-16T23:10:00.000Z",
      sourceTeacherElevationHandoffArtifact:
        "memory/external-work-receipts/2026-04-16-external-finance-doctrine-teacher-elevation-handoffs.md",
      sourceTeacherFeedbackArtifact:
        "memory/external-work-receipts/2026-04-16-external-finance-doctrine-teacher-feedback.md",
      sourceTeacherReviewArtifact:
        "memory/external-work-receipts/2026-04-16-external-finance-doctrine-teacher-review.md",
      candidateInputs: [
        {
          candidateInputId: "finance-teacher-candidate-input-2026-04-16-feedback-1",
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
            "memory/external-work-receipts/2026-04-16-external-finance-doctrine-promotion-candidates.md",
          operatorNextAction:
            "Review this converted teacher critique against the same-day finance governance candidate flow before any later governance action.",
        },
      ],
    });

    expect(parseExternalFinanceDoctrineTeacherCandidateInputArtifact(rendered)).toEqual({
      createdAt: "2026-04-16T23:10:00.000Z",
      sourceTeacherElevationHandoffArtifact:
        "memory/external-work-receipts/2026-04-16-external-finance-doctrine-teacher-elevation-handoffs.md",
      sourceTeacherFeedbackArtifact:
        "memory/external-work-receipts/2026-04-16-external-finance-doctrine-teacher-feedback.md",
      sourceTeacherReviewArtifact:
        "memory/external-work-receipts/2026-04-16-external-finance-doctrine-teacher-review.md",
      candidateInputs: [
        {
          candidateInputId: "finance-teacher-candidate-input-2026-04-16-feedback-1",
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
            "memory/external-work-receipts/2026-04-16-external-finance-doctrine-promotion-candidates.md",
          operatorNextAction:
            "Review this converted teacher critique against the same-day finance governance candidate flow before any later governance action.",
        },
      ],
    });
  });
});
