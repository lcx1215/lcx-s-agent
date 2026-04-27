import { describe, expect, it } from "vitest";
import {
  parseFeishuFinanceDoctrinePromotionDecisionArtifact,
  renderFeishuFinanceDoctrinePromotionDecisionArtifact,
} from "./lobster-brain-registry.js";

describe("finance promotion decision artifact", () => {
  it("round-trips the bounded promotion decision artifact contract", () => {
    const rendered = renderFeishuFinanceDoctrinePromotionDecisionArtifact({
      decidedAt: "2026-03-25T19:10:00.000Z",
      consumer: "holdings_thesis_revalidation",
      linkedCandidateArtifact:
        "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-candidates.md",
      linkedReviewArtifact:
        "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-review.md",
      decisions: [
        {
          candidateKey: "closest_scenario:base_case",
          decisionOutcome: "proposal_created",
          reviewStateAtDecision: "ready_for_manual_promotion",
          decisionNotes: "create a manual doctrine proposal draft for operator review",
        },
      ],
    });

    expect(parseFeishuFinanceDoctrinePromotionDecisionArtifact(rendered)).toEqual({
      decidedAt: "2026-03-25T19:10:00.000Z",
      consumer: "holdings_thesis_revalidation",
      linkedCandidateArtifact:
        "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-candidates.md",
      linkedReviewArtifact:
        "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-review.md",
      decisions: [
        {
          candidateKey: "closest_scenario:base_case",
          decisionOutcome: "proposal_created",
          reviewStateAtDecision: "ready_for_manual_promotion",
          decisionNotes: "create a manual doctrine proposal draft for operator review",
        },
      ],
    });
  });

  it("fails closed when reviewStateAtDecision is invalid", () => {
    expect(
      parseFeishuFinanceDoctrinePromotionDecisionArtifact(`\
# Feishu Finance Doctrine Promotion Decisions

- **Decided At**: 2026-03-25T19:10:00.000Z
- **Consumer**: holdings_thesis_revalidation
- **Linked Candidate Artifact**: memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-candidates.md
- **Linked Review Artifact**: memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-review.md

## Decisions
### Decision 1
- **Candidate Key**: closest_scenario:base_case
- **Decision Outcome**: proposal_created
- **Review State At Decision**: deferred
- **Decision Notes**: bad transition
`),
    ).toEqual({
      decidedAt: "2026-03-25T19:10:00.000Z",
      consumer: "holdings_thesis_revalidation",
      linkedCandidateArtifact:
        "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-candidates.md",
      linkedReviewArtifact:
        "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-review.md",
      decisions: [],
    });
  });
});
