import { describe, expect, it } from "vitest";
import {
  parseFeishuFinanceDoctrineEditHandoffArtifact,
  renderFeishuFinanceDoctrineEditHandoffArtifact,
} from "./lobster-brain-registry.js";

describe("finance doctrine edit handoff artifact", () => {
  it("round-trips the bounded doctrine-edit handoff artifact contract", () => {
    const rendered = renderFeishuFinanceDoctrineEditHandoffArtifact({
      handedOffAt: "2026-03-25T21:00:00.000Z",
      consumer: "holdings_thesis_revalidation",
      sourceProposalArtifact:
        "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-proposals.md",
      sourceDecisionArtifact:
        "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-decisions.md",
      linkedCandidateArtifact:
        "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-candidates.md",
      linkedReviewArtifact:
        "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-review.md",
      handoffs: [
        {
          handoffId:
            "finance-doctrine-edit-handoff-2026-03-25-finance-doctrine-proposal-2026-03-25-closest-scenario-base-case",
          proposalId: "finance-doctrine-proposal-2026-03-25-closest-scenario-base-case",
          candidateKey: "closest_scenario:base_case",
          proposedDoctrineChange:
            "Draft a bounded manual doctrine update for holdings_thesis_revalidation covering recurring signal closest_scenario=base_case.",
          rationaleFromCalibration:
            "Repeated closest_scenario=base_case in 2/2 recent calibration notes.",
          riskOrCounterargument: "Still needs operator review before doctrine wording is promoted.",
          targetDoctrineOrCard: "memory/local-memory/holding-holdings-thesis-revalidation.md",
          manualEditChecklist:
            "Confirm the target doctrine/card path remains memory/local-memory/holding-holdings-thesis-revalidation.md.",
          operatorDecisionNeeded:
            "Decide whether to edit the target doctrine/card manually, reject the edit after review, or supersede this handoff with a better draft.",
          status: "open",
        },
      ],
    });

    expect(parseFeishuFinanceDoctrineEditHandoffArtifact(rendered)).toEqual({
      handedOffAt: "2026-03-25T21:00:00.000Z",
      consumer: "holdings_thesis_revalidation",
      sourceProposalArtifact:
        "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-proposals.md",
      sourceDecisionArtifact:
        "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-decisions.md",
      linkedCandidateArtifact:
        "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-candidates.md",
      linkedReviewArtifact:
        "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-review.md",
      handoffs: [
        {
          handoffId:
            "finance-doctrine-edit-handoff-2026-03-25-finance-doctrine-proposal-2026-03-25-closest-scenario-base-case",
          proposalId: "finance-doctrine-proposal-2026-03-25-closest-scenario-base-case",
          candidateKey: "closest_scenario:base_case",
          proposedDoctrineChange:
            "Draft a bounded manual doctrine update for holdings_thesis_revalidation covering recurring signal closest_scenario=base_case.",
          rationaleFromCalibration:
            "Repeated closest_scenario=base_case in 2/2 recent calibration notes.",
          riskOrCounterargument: "Still needs operator review before doctrine wording is promoted.",
          targetDoctrineOrCard: "memory/local-memory/holding-holdings-thesis-revalidation.md",
          manualEditChecklist:
            "Confirm the target doctrine/card path remains memory/local-memory/holding-holdings-thesis-revalidation.md.",
          operatorDecisionNeeded:
            "Decide whether to edit the target doctrine/card manually, reject the edit after review, or supersede this handoff with a better draft.",
          status: "open",
        },
      ],
    });
  });

  it("fails closed on invalid handoff status entries", () => {
    expect(
      parseFeishuFinanceDoctrineEditHandoffArtifact(`\
# Feishu Finance Doctrine Edit Handoffs

- **Handed Off At**: 2026-03-25T21:00:00.000Z
- **Consumer**: holdings_thesis_revalidation
- **Source Proposal Artifact**: memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-proposals.md
- **Source Decision Artifact**: memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-decisions.md
- **Linked Candidate Artifact**: memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-candidates.md
- **Linked Review Artifact**: memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-review.md

## Handoffs
### Handoff 1
- **Handoff ID**: finance-doctrine-edit-handoff-2026-03-25-finance-doctrine-proposal-2026-03-25-closest-scenario-base-case
- **Proposal ID**: finance-doctrine-proposal-2026-03-25-closest-scenario-base-case
- **Candidate Key**: closest_scenario:base_case
- **Proposed Doctrine Change**: Draft a bounded manual doctrine update
- **Rationale From Calibration**: repeated pattern
- **Risk Or Counterargument**: still needs review
- **Target Doctrine Or Card**: memory/local-memory/holding-holdings-thesis-revalidation.md
- **Manual Edit Checklist**: confirm the target doctrine path
- **Operator Decision Needed**: decide whether to edit doctrine manually
- **Status**: pending
`),
    ).toEqual({
      handedOffAt: "2026-03-25T21:00:00.000Z",
      consumer: "holdings_thesis_revalidation",
      sourceProposalArtifact:
        "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-proposals.md",
      sourceDecisionArtifact:
        "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-decisions.md",
      linkedCandidateArtifact:
        "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-candidates.md",
      linkedReviewArtifact:
        "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-review.md",
      handoffs: [],
    });
  });
});
