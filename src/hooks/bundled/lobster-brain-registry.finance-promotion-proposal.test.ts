import { describe, expect, it } from "vitest";
import {
  parseFeishuFinanceDoctrinePromotionProposalArtifact,
  renderFeishuFinanceDoctrinePromotionProposalArtifact,
} from "./lobster-brain-registry.js";

describe("finance promotion proposal artifact", () => {
  it("round-trips the bounded promotion proposal artifact contract", () => {
    const rendered = renderFeishuFinanceDoctrinePromotionProposalArtifact({
      draftedAt: "2026-03-25T20:00:00.000Z",
      consumer: "holdings_thesis_revalidation",
      sourceDecisionArtifact:
        "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-decisions.md",
      linkedCandidateArtifact:
        "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-candidates.md",
      linkedReviewArtifact:
        "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-review.md",
      proposals: [
        {
          proposalId: "finance-doctrine-proposal-2026-03-25-closest-scenario-base-case",
          candidateKey: "closest_scenario:base_case",
          sourceCandidateText:
            "closest_scenario repeated base_case in 2/3 recent calibration notes",
          proposedDoctrineChange:
            "Draft a bounded manual doctrine update for holdings_thesis_revalidation covering recurring signal closest_scenario=base_case.",
          rationaleFromCalibration:
            "Repeated closest_scenario=base_case in 2/3 recent calibration notes.",
          riskOrCounterargument: "Still needs operator review before doctrine wording is promoted.",
          operatorNextAction:
            "Review the proposal draft, manually edit doctrine text if it is strong enough, or reject/supersede the draft.",
          status: "draft",
        },
      ],
    });

    expect(parseFeishuFinanceDoctrinePromotionProposalArtifact(rendered)).toEqual({
      draftedAt: "2026-03-25T20:00:00.000Z",
      consumer: "holdings_thesis_revalidation",
      sourceDecisionArtifact:
        "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-decisions.md",
      linkedCandidateArtifact:
        "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-candidates.md",
      linkedReviewArtifact:
        "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-review.md",
      proposals: [
        {
          proposalId: "finance-doctrine-proposal-2026-03-25-closest-scenario-base-case",
          candidateKey: "closest_scenario:base_case",
          sourceCandidateText:
            "closest_scenario repeated base_case in 2/3 recent calibration notes",
          proposedDoctrineChange:
            "Draft a bounded manual doctrine update for holdings_thesis_revalidation covering recurring signal closest_scenario=base_case.",
          rationaleFromCalibration:
            "Repeated closest_scenario=base_case in 2/3 recent calibration notes.",
          riskOrCounterargument: "Still needs operator review before doctrine wording is promoted.",
          operatorNextAction:
            "Review the proposal draft, manually edit doctrine text if it is strong enough, or reject/supersede the draft.",
          status: "draft",
        },
      ],
    });
  });

  it("fails closed on invalid proposal status entries", () => {
    expect(
      parseFeishuFinanceDoctrinePromotionProposalArtifact(`\
# Feishu Finance Doctrine Promotion Proposals

- **Drafted At**: 2026-03-25T20:00:00.000Z
- **Consumer**: holdings_thesis_revalidation
- **Source Decision Artifact**: memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-decisions.md
- **Linked Candidate Artifact**: memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-candidates.md
- **Linked Review Artifact**: memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-review.md

## Proposals
### Proposal 1
- **Proposal ID**: finance-doctrine-proposal-2026-03-25-closest-scenario-base-case
- **Candidate Key**: closest_scenario:base_case
- **Source Candidate Text**: closest_scenario repeated base_case in 2/3 recent calibration notes
- **Proposed Doctrine Change**: Draft a bounded manual doctrine update
- **Rationale From Calibration**: repeated pattern
- **Risk Or Counterargument**: still needs review
- **Operator Next Action**: review the draft
- **Status**: pending
`),
    ).toEqual({
      draftedAt: "2026-03-25T20:00:00.000Z",
      consumer: "holdings_thesis_revalidation",
      sourceDecisionArtifact:
        "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-decisions.md",
      linkedCandidateArtifact:
        "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-candidates.md",
      linkedReviewArtifact:
        "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-review.md",
      proposals: [],
    });
  });
});
