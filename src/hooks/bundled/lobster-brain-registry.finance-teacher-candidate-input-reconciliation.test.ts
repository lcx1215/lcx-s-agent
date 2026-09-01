import { describe, expect, it } from "vitest";
import {
  parseExternalFinanceDoctrineTeacherCandidateInputReconciliationArtifact,
  renderExternalFinanceDoctrineTeacherCandidateInputReconciliationArtifact,
} from "./lobster-brain-registry.js";

describe("finance doctrine teacher candidate input reconciliation artifact", () => {
  it("round-trips the bounded teacher candidate-input reconciliation artifact contract", () => {
    const rendered = renderExternalFinanceDoctrineTeacherCandidateInputReconciliationArtifact({
      reconciledAt: "2026-04-16T23:55:00.000Z",
      sourceTeacherCandidateInputArtifact:
        "memory/external-work-receipts/2026-04-16-external-finance-doctrine-teacher-candidate-inputs.md",
      sourceTeacherCandidateInputReviewArtifact:
        "memory/external-work-receipts/2026-04-16-external-finance-doctrine-teacher-candidate-input-review.md",
      reconciliations: [
        {
          reconciliationId:
            "finance-teacher-candidate-input-reconciliation-2026-04-16-finance-teacher-candidate-input-2026-04-16-finance-teacher-elevation-handoff-2026-04-16-feedback-1",
          sourceTeacherCandidateInputArtifact:
            "memory/external-work-receipts/2026-04-16-external-finance-doctrine-teacher-candidate-inputs.md",
          sourceTeacherCandidateInputReviewArtifact:
            "memory/external-work-receipts/2026-04-16-external-finance-doctrine-teacher-candidate-input-review.md",
          candidateInputId:
            "finance-teacher-candidate-input-2026-04-16-finance-teacher-elevation-handoff-2026-04-16-feedback-1",
          targetFinanceCandidatePath:
            "memory/external-work-receipts/2026-04-16-external-finance-doctrine-promotion-candidates.md",
          reconciliationMode: "link_existing_candidate",
          reconciliationNotes:
            "Map this consumed teacher input to the same-day finance candidate flow without treating it as adopted doctrine.",
          status: "open",
        },
      ],
    });

    expect(
      parseExternalFinanceDoctrineTeacherCandidateInputReconciliationArtifact(rendered),
    ).toEqual({
      reconciledAt: "2026-04-16T23:55:00.000Z",
      sourceTeacherCandidateInputArtifact:
        "memory/external-work-receipts/2026-04-16-external-finance-doctrine-teacher-candidate-inputs.md",
      sourceTeacherCandidateInputReviewArtifact:
        "memory/external-work-receipts/2026-04-16-external-finance-doctrine-teacher-candidate-input-review.md",
      reconciliations: [
        {
          reconciliationId:
            "finance-teacher-candidate-input-reconciliation-2026-04-16-finance-teacher-candidate-input-2026-04-16-finance-teacher-elevation-handoff-2026-04-16-feedback-1",
          sourceTeacherCandidateInputArtifact:
            "memory/external-work-receipts/2026-04-16-external-finance-doctrine-teacher-candidate-inputs.md",
          sourceTeacherCandidateInputReviewArtifact:
            "memory/external-work-receipts/2026-04-16-external-finance-doctrine-teacher-candidate-input-review.md",
          candidateInputId:
            "finance-teacher-candidate-input-2026-04-16-finance-teacher-elevation-handoff-2026-04-16-feedback-1",
          targetFinanceCandidatePath:
            "memory/external-work-receipts/2026-04-16-external-finance-doctrine-promotion-candidates.md",
          reconciliationMode: "link_existing_candidate",
          reconciliationNotes:
            "Map this consumed teacher input to the same-day finance candidate flow without treating it as adopted doctrine.",
          status: "open",
        },
      ],
    });
  });
});
