import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildFinanceCaseRun, saveFinanceCaseRun } from "../finance-caseflow.js";
import { appendFinanceOutcome } from "../finance-outcome-ledger.js";
import { runFinanceResearchRun } from "../finance-research-runner.js";
import { financeOutcomeLedgerPath } from "../finance-state-dir.js";
import type { AnyAgentTool } from "./common.js";
import {
  createFinanceOutcomeLedgerReadTool,
  financeOutcomeAssessmentBlockedBy,
} from "./finance-outcome-ledger-read-tool.js";

const AS_OF = "2025-01-01T00:00:00Z";
const OBSERVED_AT = "2025-04-01T00:00:00Z";

const directories: string[] = [];

async function storeDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "finance-outcome-read-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

/**
 * Offline fixture: the same synthetic source and model adapters the caseflow demo uses, so a case
 * can be produced without a market, a credential or a real model call.
 */
async function seedCase(
  directory: string,
  params: { withClaims: boolean; caseId: string },
): Promise<string> {
  const checkpoint = {
    path: path.join(directory, "checkpoints.sqlite"),
    runId: "outcome-read-fixture",
    executionFingerprint: "outcome-read-fixture-v1",
  };
  const modelInvoker = async (request: unknown) => {
    const input = request as { stage?: string; evidence?: readonly { id: string }[] };
    if (input.stage === "intake") {
      return { kind: "plan", requirements: ["source evidence"], missingEvidence: [] };
    }
    if (input.stage === "draft" || input.stage === "format") {
      return {
        kind: "artifact",
        artifact: {
          answer: "Synthetic research candidate; no real market conclusion is asserted.",
          claims: params.withClaims
            ? [
                {
                  id: "fixture-claim",
                  text: "Synthetic evidence records an index value of 100.",
                  status: "supported",
                  evidenceIds: [
                    input.evidence?.find((item) => !item.id.startsWith("finance-batch-summary"))
                      ?.id,
                  ],
                },
              ]
            : [],
        },
      };
    }
    return {
      kind: "review",
      review: {
        verdict: "pass",
        criticalFindings: [],
        evidenceGaps: [],
        notes: ["Synthetic fixture checked the supplied packet and found no gaps."],
      },
    };
  };

  const receipt = await runFinanceResearchRun({
    input: {
      ask: `Synthetic outcome read fixture (${params.caseId})`,
      asOf: AS_OF,
      targets: [
        {
          id: "fixture",
          instrument: "FIXTURE",
          assetClass: "us_equity",
          realtime: false as const,
          collections: [{ collection: "news" as const, freshnessMaxMinutes: 60 }],
        },
      ],
    },
    liveFetch: true,
    modelInvoker,
    qualityModelInvoker: modelInvoker,
    modelCheckpoint: { ...checkpoint, maxModelCalls: 32 },
    batchOptions: {
      checkpoint,
      maxApiCalls: 2,
      realtimeAdapters: [],
      collectionAdapters: [
        {
          id: "synthetic-source",
          providerName: "synthetic-source",
          providerRole: "primary_market_data" as const,
          priority: 1,
          supports: () => true,
          collect: async () => [
            {
              itemId: "fixture-value",
              collection: "news" as const,
              providerName: "synthetic-source",
              providerRole: "primary_market_data" as const,
              sourceFamily: "market_data_api" as const,
              sourceTimestamp: AS_OF,
              observedAt: AS_OF,
              delayStatus: "realtime" as const,
              sourceUrlOrArtifact: "fixture://index",
              data: { index: 100, synthetic: true },
            },
          ],
        },
      ],
    },
  });

  const saved = await saveFinanceCaseRun(
    directory,
    buildFinanceCaseRun({
      caseId: params.caseId,
      receipt,
      budget: { maxApiCalls: 2 },
      execution: { kind: "synthetic_fixture", model: "injected_fixture" },
    }),
  );
  return saved.ref;
}

type Payload = {
  ok: boolean;
  status?: string;
  reason?: string;
  action?: string;
  caseDirectory?: string;
  databasePath?: string;
  databasePresent?: boolean;
  caseCount?: number;
  totalOutcomeCount?: number;
  blockedCaseCount?: number;
  casesWithoutClaims?: number;
  emptyReason?: string | null;
  knownRefs?: readonly string[];
  cases?: readonly {
    caseId: string;
    ref: string;
    claimCount: number;
    gapCount: number;
    gapKinds: readonly string[];
    outcomeCount: number;
    assessmentBlockedBy: string | null;
    latest: { findings?: Record<string, number>; assessmentCount?: number } | null;
    outcomes?: readonly unknown[];
  }[];
};

async function read(tool: AnyAgentTool, args: Record<string, unknown>): Promise<Payload> {
  const result = await tool.execute("read-outcomes", args);
  return result.details as Payload;
}

describe("finance_outcome_ledger_read", () => {
  it("refuses without a case directory instead of guessing one", async () => {
    const payload = await read(createFinanceOutcomeLedgerReadTool(), {});

    expect(payload.ok).toBe(false);
    expect(payload.status).toBe("absent");
    expect(payload.reason).toBe("finance_outcome_case_directory_required");
    // The whole point of refusing: not finding a book must not read as "nothing was assessed".
    expect(payload.action).toContain("not evidence");
  });

  it("names an absent directory as absent rather than as an empty history", async () => {
    const payload = await read(createFinanceOutcomeLedgerReadTool(), {
      caseDirectory: path.join(os.tmpdir(), "definitely-not-a-caseflow-directory"),
    });

    expect(payload.ok).toBe(false);
    expect(payload.status).toBe("absent");
    expect(payload.reason).toBe("finance_outcome_case_directory_absent");
  });

  it("reports no_cases for a directory that holds no case files", async () => {
    const directory = await storeDirectory();
    await fs.writeFile(path.join(directory, "README.md"), "not a case");

    const payload = await read(createFinanceOutcomeLedgerReadTool(), { caseDirectory: directory });

    expect(payload.ok).toBe(true);
    expect(payload.status).toBe("no_cases");
    expect(payload.caseCount).toBe(0);
  });

  it("rejects an unknown case reference and lists the ones it knows", async () => {
    const directory = await storeDirectory();
    const ref = await seedCase(directory, { withClaims: true, caseId: "outcome-read-known" });

    const payload = await read(createFinanceOutcomeLedgerReadTool(), {
      caseDirectory: directory,
      packetRef: "0".repeat(64),
    });

    expect(payload.ok).toBe(false);
    expect(payload.reason).toBe("finance_outcome_packet_ref_unknown");
    expect(payload.knownRefs).toContain(ref);
  });

  it("says an unassessed case is unassessed, not that the call was right", async () => {
    const directory = await storeDirectory();
    await seedCase(directory, { withClaims: true, caseId: "outcome-read-unassessed" });

    const payload = await read(createFinanceOutcomeLedgerReadTool(), { caseDirectory: directory });

    expect(payload.ok).toBe(true);
    expect(payload.status).toBe("empty");
    expect(payload.totalOutcomeCount).toBe(0);
    expect(payload.databasePresent).toBe(false);
    expect(payload.databasePath).toBe(financeOutcomeLedgerPath(directory));
    // The tempting reading of an empty ledger is the wrong one, so the tool states the right one.
    expect(payload.emptyReason).toContain("nothing here says a forecast was right");
    expect(payload.cases?.[0]?.assessmentBlockedBy).toBeNull();
  });

  it("explains a claimless case by naming the gap family that stopped it", async () => {
    const directory = await storeDirectory();
    await seedCase(directory, { withClaims: false, caseId: "outcome-read-no-claims" });

    const payload = await read(createFinanceOutcomeLedgerReadTool(), { caseDirectory: directory });

    expect(payload.cases?.[0]?.claimCount).toBe(0);
    expect(payload.cases?.[0]?.outcomeCount).toBe(0);
    // Waiting will not help: an outcome is measured against a claim, so a claimless case is a
    // permanent dead end rather than a pending one.
    expect(payload.cases?.[0]?.assessmentBlockedBy).toBe("case_has_unresolved_gaps");
    // "Blocked by 426 gaps" is not actionable; "blocked by <family>" is, so the family is carried
    // alongside the count rather than left to be recovered from the raw gaps.
    expect(payload.cases?.[0]?.gapCount).toBeGreaterThan(0);
    expect(payload.cases?.[0]?.gapKinds?.length).toBeGreaterThan(0);
    // The whole point of naming the family: a run that diagnosed an upstream failure must not read
    // the same as a run that never produced anything.
    expect(payload.casesWithoutClaims).toBe(1);
  });

  it("reads a recorded assessment back with its findings counted", async () => {
    const directory = await storeDirectory();
    const ref = await seedCase(directory, { withClaims: true, caseId: "outcome-read-assessed" });
    await appendFinanceOutcome(directory, ref, {
      recordId: "quarter-1",
      checkpointMonths: 3,
      observedAt: OBSERVED_AT,
      evidence: [
        {
          id: "q1-index",
          source: "fixture://quarter-observation",
          sourceTimestamp: OBSERVED_AT,
          field: "index",
          value: 105,
        },
      ],
      assessments: [
        {
          claimId: "fixture-claim",
          finding: "contradicted",
          evidenceIds: ["q1-index"],
          deviation: "Synthetic change of 5 index points.",
          invalidationConditions: ["A fixture is not evidence about actual markets."],
        },
      ],
    });

    const payload = await read(createFinanceOutcomeLedgerReadTool(), {
      caseDirectory: directory,
      packetRef: ref,
    });

    expect(payload.status).toBe("ready");
    expect(payload.totalOutcomeCount).toBe(1);
    expect(payload.databasePresent).toBe(true);
    const latest = payload.cases?.[0]?.latest;
    expect(latest?.assessmentCount).toBe(1);
    // The half that answers "was the call right", counted rather than left to the caller.
    expect(latest?.findings).toEqual({ supported: 0, contradicted: 1, inconclusive: 0 });
    // The chain itself is not returned unless asked for.
    expect(payload.cases?.[0]?.outcomes).toBeUndefined();
  });

  it("returns the full chain only when asked", async () => {
    const directory = await storeDirectory();
    const ref = await seedCase(directory, { withClaims: true, caseId: "outcome-read-chain" });
    await appendFinanceOutcome(directory, ref, {
      recordId: "quarter-1",
      checkpointMonths: 3,
      observedAt: OBSERVED_AT,
      evidence: [
        {
          id: "q1-index",
          source: "fixture://quarter-observation",
          sourceTimestamp: OBSERVED_AT,
          field: "index",
          value: 105,
        },
      ],
      assessments: [
        {
          claimId: "fixture-claim",
          finding: "inconclusive",
          evidenceIds: ["q1-index"],
          deviation: "Synthetic change of 5 index points.",
          invalidationConditions: ["A fixture is not evidence about actual markets."],
        },
      ],
    });

    const payload = await read(createFinanceOutcomeLedgerReadTool(), {
      caseDirectory: directory,
      packetRef: ref,
      includeOutcomes: true,
    });

    expect(payload.cases?.[0]?.outcomes).toHaveLength(1);
  });

  it("never mutates the ledger it reads", async () => {
    const directory = await storeDirectory();
    const ref = await seedCase(directory, { withClaims: true, caseId: "outcome-read-readonly" });
    await appendFinanceOutcome(directory, ref, {
      recordId: "quarter-1",
      checkpointMonths: 3,
      observedAt: OBSERVED_AT,
      evidence: [
        {
          id: "q1-index",
          source: "fixture://quarter-observation",
          sourceTimestamp: OBSERVED_AT,
          field: "index",
          value: 105,
        },
      ],
      assessments: [
        {
          claimId: "fixture-claim",
          finding: "supported",
          evidenceIds: ["q1-index"],
          deviation: "Synthetic change of 5 index points.",
          invalidationConditions: ["A fixture is not evidence about actual markets."],
        },
      ],
    });
    const database = financeOutcomeLedgerPath(directory);
    const before = await fs.stat(database);

    const tool = createFinanceOutcomeLedgerReadTool();
    await read(tool, { caseDirectory: directory, packetRef: ref, includeOutcomes: true });
    await read(tool, { caseDirectory: directory });

    const after = await fs.stat(database);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });
});

describe("financeOutcomeAssessmentBlockedBy", () => {
  it("does not block a case that has a claim to measure against", () => {
    expect(financeOutcomeAssessmentBlockedBy({ claimCount: 1, gapCount: 0 })).toBeNull();
    // A gap on a case that still produced a claim is a caveat on the claim, not a reason it can
    // never be assessed.
    expect(financeOutcomeAssessmentBlockedBy({ claimCount: 1, gapCount: 426 })).toBeNull();
  });

  it("names an upstream failure apart from a run that produced nothing", () => {
    // The distinction this function exists for: both have zero claims, and the next action differs.
    expect(financeOutcomeAssessmentBlockedBy({ claimCount: 0, gapCount: 426 })).toBe(
      "case_has_unresolved_gaps",
    );
    expect(financeOutcomeAssessmentBlockedBy({ claimCount: 0, gapCount: 0 })).toBe(
      "case_has_no_claims",
    );
  });
});
