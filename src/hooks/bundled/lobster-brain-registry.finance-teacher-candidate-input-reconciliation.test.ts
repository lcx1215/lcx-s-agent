import { describe, expect, it } from "vitest";
import {
  parseFeishuFinanceDoctrineTeacherCandidateInputReconciliationArtifact,
  renderFeishuFinanceDoctrineTeacherCandidateInputReconciliationArtifact,
} from "./lobster-brain-registry.js";

describe("finance doctrine teacher candidate input reconciliation artifact", () => {
  it("round-trips the bounded teacher candidate-input reconciliation artifact contract", () => {
    const rendered = renderFeishuFinanceDoctrineTeacherCandidateInputReconciliationArtifact({
      reconciledAt: "2026-04-16T23:55:00.000Z",
      sourceTeacherCandidateInputArtifact:
        "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-candidate-inputs.md",
      sourceTeacherCandidateInputReviewArtifact:
        "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-candidate-input-review.md",
      reconciliations: [
        {
          reconciliationId:
            "finance-teacher-candidate-input-reconciliation-2026-04-16-finance-teacher-candidate-input-2026-04-16-finance-teacher-elevation-handoff-2026-04-16-feedback-1",
          sourceTeacherCandidateInputArtifact:
            "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-candidate-inputs.md",
          sourceTeacherCandidateInputReviewArtifact:
            "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-candidate-input-review.md",
          candidateInputId:
            "finance-teacher-candidate-input-2026-04-16-finance-teacher-elevation-handoff-2026-04-16-feedback-1",
          targetFinanceCandidatePath:
            "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-promotion-candidates.md",
          reconciliationMode: "link_existing_candidate",
          reconciliationNotes:
            "Map this consumed teacher input to the same-day finance candidate flow without treating it as adopted doctrine.",
          status: "open",
        },
      ],
    });

    expect(parseFeishuFinanceDoctrineTeacherCandidateInputReconciliationArtifact(rendered)).toEqual(
      {
        reconciledAt: "2026-04-16T23:55:00.000Z",
        sourceTeacherCandidateInputArtifact:
          "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-candidate-inputs.md",
        sourceTeacherCandidateInputReviewArtifact:
          "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-candidate-input-review.md",
        reconciliations: [
          {
            reconciliationId:
              "finance-teacher-candidate-input-reconciliation-2026-04-16-finance-teacher-candidate-input-2026-04-16-finance-teacher-elevation-handoff-2026-04-16-feedback-1",
            sourceTeacherCandidateInputArtifact:
              "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-candidate-inputs.md",
            sourceTeacherCandidateInputReviewArtifact:
              "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-candidate-input-review.md",
            candidateInputId:
              "finance-teacher-candidate-input-2026-04-16-finance-teacher-elevation-handoff-2026-04-16-feedback-1",
            targetFinanceCandidatePath:
              "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-promotion-candidates.md",
            reconciliationMode: "link_existing_candidate",
            reconciliationNotes:
              "Map this consumed teacher input to the same-day finance candidate flow without treating it as adopted doctrine.",
            status: "open",
          },
        ],
      },
    );
  });
});
