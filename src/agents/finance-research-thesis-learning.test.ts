import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { FinanceCommitteeEvidence } from "./finance-agent-committee.js";
import {
  persistFinanceResearchThesisLearning,
  validateFinanceResearchThesisProposals,
} from "./finance-research-thesis-learning.js";
import { readFinanceThesisLedger } from "./finance-thesis-ledger.js";

const AS_OF = "2026-09-10T12:00:00.000Z";
const LATER = "2026-09-11T12:00:00.000Z";
const directories: string[] = [];

async function storeDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "finance-thesis-learning-"));
  directories.push(directory);
  return directory;
}

function sourceEvidence(
  overrides: Partial<FinanceCommitteeEvidence> = {},
): FinanceCommitteeEvidence {
  return {
    id: "finance-model:SPY",
    source: "finance-research-batch-runner",
    timestamp: AS_OF,
    text: "SPY remains within the cited observation window.",
    ...overrides,
  };
}

function validate(runId: string, timestamp = AS_OF) {
  const evidence = sourceEvidence({ timestamp });
  return validateFinanceResearchThesisProposals({
    value: [
      {
        claimId: "spy-claim",
        instrument: "SPY",
        rationale: "The evidence is limited to the observed window.",
        invalidationConditions: ["The stated market structure no longer holds."],
      },
    ],
    claims: [
      {
        id: "spy-claim",
        text: "SPY market structure remains range-bound in the observed window.",
        status: "supported",
        evidenceIds: [evidence.id],
      },
    ],
    evidence: [evidence],
    instruments: ["SPY"],
    asOf: AS_OF,
    receiptReference: `/state/research-${runId}.json`,
    runId,
  });
}

describe("finance research thesis learning", () => {
  afterAll(async () => {
    await Promise.all(
      directories.map((directory) => fs.rm(directory, { recursive: true, force: true })),
    );
  });

  it("accepts only supported claims tied to declared instruments and cited in-run evidence", () => {
    expect(validate("quality-1")).toHaveLength(1);
    expect(() =>
      validateFinanceResearchThesisProposals({
        value: [
          {
            claimId: "uncertain-claim",
            instrument: "SPY",
            invalidationConditions: ["A condition changes."],
          },
        ],
        claims: [
          {
            id: "uncertain-claim",
            text: "A possible SPY claim.",
            status: "uncertain",
            evidenceIds: ["finance-model:SPY"],
            uncertainty: "Insufficient coverage.",
          },
        ],
        evidence: [sourceEvidence()],
        instruments: ["SPY"],
        asOf: AS_OF,
        receiptReference: "/state/research.json",
        runId: "quality-2",
      }),
    ).toThrow(/not a supported claim/);
  });

  it("refuses proposals outside the target universe or with evidence after the cutoff", () => {
    expect(() =>
      validateFinanceResearchThesisProposals({
        value: [
          {
            claimId: "spy-claim",
            instrument: "QQQ",
            invalidationConditions: ["A condition changes."],
          },
        ],
        claims: [
          {
            id: "spy-claim",
            text: "SPY market structure remains range-bound.",
            status: "supported",
            evidenceIds: ["finance-model:SPY"],
          },
        ],
        evidence: [sourceEvidence()],
        instruments: ["SPY"],
        asOf: AS_OF,
        receiptReference: "/state/research.json",
        runId: "quality-3",
      }),
    ).toThrow(/outside this run's declared universe/);
    expect(() => validate("quality-4", LATER)).toThrow(/outside the run's as-of window/);
  });

  it("opens once, then accumulates source-linked evidence for the stable thesis", async () => {
    const directory = await storeDirectory();
    const first = await persistFinanceResearchThesisLearning({
      directory,
      eligible: true,
      proposals: validate("quality-1"),
      observedAt: AS_OF,
    });
    const next = await persistFinanceResearchThesisLearning({
      directory,
      eligible: true,
      proposals: validate("quality-2"),
      observedAt: LATER,
    });

    expect(first.status).toBe("persisted");
    expect(first.results[0]?.action).toBe("opened");
    expect(next.status).toBe("persisted");
    expect(next.results[0]?.action).toBe("evidence_appended");
    const ledger = await readFinanceThesisLedger(directory);
    expect(ledger.theses).toHaveLength(1);
    expect(ledger.theses[0]?.evidence.map((item) => item.id)).toEqual([
      "quality-1:finance-model:SPY",
      "quality-2:finance-model:SPY",
    ]);
    expect(ledger.evidenceAppendRecordCount).toBe(1);
  });

  it("does not write when the research gates did not pass", async () => {
    const directory = await storeDirectory();
    const result = await persistFinanceResearchThesisLearning({
      directory,
      eligible: false,
      proposals: validate("quality-1"),
      observedAt: AS_OF,
    });
    expect(result.status).toBe("not_eligible");
    expect((await readFinanceThesisLedger(directory)).recordCount).toBe(0);
  });
});
