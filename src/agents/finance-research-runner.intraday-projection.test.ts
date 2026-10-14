import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildFinanceCommitteePlan,
  runFinanceCommittee,
  type FinanceCommitteeInput,
} from "./finance-agent-committee.js";
import {
  narrowFinanceNightIntradayEvidence,
  summarizeFinanceNightIntradayEvidence,
} from "./finance-night-review-context.js";
import { createFinanceCommitteeExecutor } from "./finance-research-runner.js";
import type { QualityHarnessModelRequest } from "./quality-harness-contract.js";

const AS_OF = "2026-10-12T21:47:48.377Z";
const ID = "finance-night:intraday:2026-10-12";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

function sourceSummary() {
  return summarizeFinanceNightIntradayEvidence(
    {
      asOf: AS_OF,
      sessionDate: "2026-10-12",
      decisions: Array.from({ length: 522 }, (_, index) => ({
        recordedAt: AS_OF,
        signalId: `signal-${index}`,
        instrument: "SPY",
        action: "hold",
        reason: "Unconfirmed broker evidence remains a blocking gap. ".repeat(3),
        referencePrice: 100,
        referencePriceAt: AS_OF,
        outcome: null,
      })),
    },
    100_000,
  );
}

function input(
  text = sourceSummary(),
  producer = true,
  otherBytes = 224_000,
): FinanceCommitteeInput {
  return {
    ask: "Review supplied evidence; keep broker uncertainty and research-only boundaries.",
    asOf: AS_OF,
    decisionMode: "research_only",
    userConstraints: { financeProducerPreparationOnly: producer, brokerConfirmed: false },
    evidence: [
      {
        id: "unchanged-rule",
        source: "rule-ledger",
        timestamp: AS_OF,
        text: "x".repeat(otherBytes),
      },
      { id: ID, source: "finance-intraday-control-ledger", timestamp: AS_OF, text },
    ],
  };
}

async function capture(request: FinanceCommitteeInput, role: "data_cleaning" | "research_draft") {
  let captured: QualityHarnessModelRequest | undefined;
  let originalBytes = 0;
  let originalAfter = "";
  let invocationError = "";
  const executor = createFinanceCommitteeExecutor();
  await runFinanceCommittee<Record<string, unknown>>({
    input: request,
    purpose: "producer_preparation",
    modelInvoker: async () => {
      throw new Error("unexpected model transport");
    },
    executor: async (context) => {
      const task = buildFinanceCommitteePlan(request).find((item) => item.id === role);
      if (!task) {
        throw new Error("missing original committee role");
      }
      const before = JSON.stringify(context.sharedContext);
      try {
        return await executor({
          ...context,
          task,
          input: task.input,
          agent: { ...context.agent, id: role },
          modelSlot: {
            ...context.modelSlot,
            invoke: async (payload: unknown) => {
              // The original executor supplies this request; the substitute is only the model IO.
              captured = payload as QualityHarnessModelRequest;
              originalBytes = Buffer.byteLength(JSON.stringify(captured), "utf8");
              invocationError = originalBytes > 256_000 ? "input_constraint" : "capture_only";
              throw new Error(invocationError);
            },
          },
        });
      } finally {
        originalAfter = JSON.stringify(context.sharedContext);
        expect(originalAfter).toBe(before);
      }
    },
  });
  if (!captured) {
    throw new Error("original executor request not observed");
  }
  return { payload: captured, bytes: originalBytes, error: invocationError, originalAfter };
}

describe("producer-preparation intraday request projection", () => {
  it("fits original intake and draft requests while preserving full original evidence and source hashes", async () => {
    const request = input();
    const untouched = JSON.stringify(request);
    const unprojected = await capture(
      { ...request, userConstraints: { financeProducerPreparationOnly: false } },
      "data_cleaning",
    );
    expect(unprojected.bytes).toBeGreaterThan(256_000);
    for (const role of ["data_cleaning", "research_draft"] as const) {
      const result = await capture(request, role);
      expect(result.bytes).toBeLessThanOrEqual(256_000);
      expect(result.error).toBe("capture_only");
      expect(result.payload.evidence[0]).toEqual(request.evidence[0]);
      const projection = JSON.parse(result.payload.evidence[1].text);
      expect(projection.coverage.totalDecisionCount).toBe(522);
      expect(projection.coverage.omittedDecisionCount).toBe(522 - projection.decisions.length);
      expect(projection.projection).toMatchObject({
        originalEvidenceId: ID,
        originalTextSha256: hash(request.evidence[1].text),
        sourcePointer: "/evidence/1/text",
        fullSourceReadClaimed: false,
      });
    }
    expect(JSON.stringify(request)).toBe(untouched);
  });

  it("preserves original distributions, review counts and exact retained latest rows", () => {
    const original = JSON.parse(sourceSummary());
    original.coverage.extraMetadata = { boundary: "diagnostic_only" };
    original.distributions.extraMetadata = { source: "original_distribution_metadata" };
    original.distributions.byAction.extraMetadata = { note: "unchanged" };
    original.distributions.byAction.values[0].extraMetadata = "original_value_metadata";
    const text = JSON.stringify(original);
    const projected = JSON.parse(
      narrowFinanceNightIntradayEvidence(text, 12_000, {
        evidenceId: ID,
        sourcePointer: "/evidence/1/text",
      }),
    );
    expect(projected.distributions).toEqual(original.distributions);
    expect(projected.coverage.extraMetadata).toEqual(original.coverage.extraMetadata);
    expect(projected.coverage.recordedReviewEvidence).toEqual(
      original.coverage.recordedReviewEvidence,
    );
    expect(projected.decisions).toEqual(original.decisions.slice(-projected.decisions.length));
    expect(projected.projection.additionallyOmittedDecisionCount).toBe(
      100 - projected.decisions.length,
    );
  });

  it("keeps wrong schema and inconsistent coverage requests rejected instead of inventing summaries", async () => {
    for (const patch of [
      { schemaVersion: "unknown" },
      {
        coverage: { totalDecisionCount: 100, includedDecisionCount: 100, omittedDecisionCount: 1 },
      },
    ]) {
      const text = JSON.stringify({ ...JSON.parse(sourceSummary()), ...patch });
      const result = await capture(input(text), "data_cleaning");
      expect(result.error).toBe("input_constraint");
      expect(result.payload.evidence[1].text).toBe(text);
    }
  });

  it("preserves legacy non-producer requests and refuses when other fields leave no summary budget", async () => {
    const legacy = await capture(input(sourceSummary(), false), "research_draft");
    expect(legacy.error).toBe("input_constraint");
    expect(legacy.payload.evidence[1].text).toBe(sourceSummary());
    const exhausted = await capture(input(sourceSummary(), true, 270_000), "data_cleaning");
    expect(exhausted.error).toBe("input_constraint");
    expect(exhausted.payload.evidence[1].text).toBe(sourceSummary());
    expect(() =>
      narrowFinanceNightIntradayEvidence(sourceSummary(), 20, {
        evidenceId: ID,
        sourcePointer: "/evidence/1/text",
      }),
    ).toThrow("assigned byte budget");
  });
});
