import { expect, it } from "vitest";
import type { FinanceCommitteeEvidence } from "./finance-agent-committee.js";
import {
  buildFinanceResearchIntradayFeedbackReview,
  financeIntradayFeedbackResponseContract,
} from "./finance-research-intraday-feedback.js";
import type { QualityHarnessArtifact } from "./quality-harness.js";

const asOf = "2026-09-22T15:00:00.000Z";
const refs = ["a", "b", "c"].map((value) => value.repeat(64));
const source: FinanceCommitteeEvidence = {
  id: "finance-controller:broker-account-summary",
  source: "finance-broker-profit-summary",
  timestamp: asOf,
  text: JSON.stringify({
    intradayExecutionHistory: {
      status: "observed",
      accountId: "account",
      venue: "alpaca:paper",
      asOf,
      entries: refs.map((outcomeRef, index) => ({
        outcomeRef,
        decisionRef: "d".repeat(64),
        signalId: `original-${index}`,
        instrument: "SPY",
        outcomeRecordedAt: "2026-09-22T14:00:00.000Z",
      })),
    },
  }),
};
function artifact(responses: unknown): QualityHarnessArtifact {
  return {
    answer: "Retain uncertainty.",
    claims: [
      {
        id: "claim",
        text: "A historical account refusal remains unresolved.",
        status: "supported",
        evidenceIds: [source.id],
        evidenceRelations: [{ evidenceId: source.id, relation: "supports" }],
      },
    ],
    supportingAnalysis: { financeIntradayFeedbackResponses: responses },
  };
}

it("retains grounded and deferred responses while missing feedback remains unaddressed", () => {
  const result = buildFinanceResearchIntradayFeedbackReview({
    evidence: [source],
    asOf,
    researchAccepted: false,
    artifact: artifact([
      {
        outcomeRef: refs[0],
        disposition: "considered",
        reason: "The supported claim retains the unresolved refusal.",
        claimId: "claim",
      },
      {
        outcomeRef: refs[1],
        disposition: "deferred",
        reason: "Await the original account reconciliation.",
      },
      {
        outcomeRef: "f".repeat(64),
        disposition: "considered",
        reason: "Invented input.",
        claimId: "claim",
      },
    ]),
    responseSource: "quality_final_artifact",
  });
  expect(result).toMatchObject({
    inputCount: 3,
    respondedCount: 2,
    researchAccepted: false,
    boundary: "reported_research_response_not_configuration_publication_execution_or_adoption",
  });
  expect(result?.entries.map((entry) => entry.disposition)).toEqual([
    "considered",
    "deferred",
    "not_addressed",
  ]);
  expect(result?.entries[1].reason).toBe("Await the original account reconciliation.");
  expect(result?.entries[2].reason).toBe("feedback_response_missing");
  expect(result?.entries[0].evidence[0].sha256).toMatch(/^[a-f0-9]{64}$/u);
  expect(result?.gaps).toContain("feedback_response_not_in_input");
  expect(
    financeIntradayFeedbackResponseContract({ evidence: [source], asOf })?.entries.map(
      (entry) => entry.outcomeRef,
    ),
  ).toEqual(refs);
});

it("does not turn conflicting, ungrounded or unseen responses into consideration", () => {
  const result = buildFinanceResearchIntradayFeedbackReview({
    evidence: [source],
    asOf,
    researchAccepted: true,
    artifact: artifact([
      { outcomeRef: refs[0], disposition: "considered", reason: "Unresolved.", claimId: "missing" },
      { outcomeRef: refs[1], disposition: "deferred", reason: "First reason." },
      { outcomeRef: refs[1], disposition: "rejected", reason: "Conflicting reason." },
      { outcomeRef: refs[2], disposition: "deferred", reason: "Keep this valid partial response." },
    ]),
    responseSource: "quality_final_artifact",
  });
  expect(result?.entries.map((entry) => entry.reason)).toEqual([
    "feedback_response_claim_not_grounded",
    "feedback_response_invalid_or_ambiguous",
    "Keep this valid partial response.",
  ]);
  const unseen = buildFinanceResearchIntradayFeedbackReview({
    evidence: [source],
    asOf,
    researchAccepted: true,
    artifact: artifact([
      {
        outcomeRef: refs[0],
        disposition: "considered",
        reason: "Claimed consideration.",
        claimId: "claim",
      },
    ]),
    responseEvidence: [],
  });
  expect(unseen?.respondedCount).toBe(0);
  expect(unseen?.entries[0].reason).toBe("feedback_not_in_response_stage_input");
});
