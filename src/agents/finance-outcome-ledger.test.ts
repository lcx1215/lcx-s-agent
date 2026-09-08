import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { requireNodeSqlite } from "../memory/sqlite.js";
import { buildFinanceCaseRun, saveFinanceCaseRun } from "./finance-caseflow.js";
import { appendFinanceOutcome, readFinanceOutcomes } from "./finance-outcome-ledger.js";
import { runFinanceResearchRun } from "./finance-research-runner.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});
async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "finance-outcomes-"));
  directories.push(directory);
  const receipt = await runFinanceResearchRun({
    input: { ask: "Test historical claim", asOf: "2025-01-01T00:00:00Z" },
  });
  const run = buildFinanceCaseRun({
    caseId: "case-1",
    execution: {},
    budget: { maxApiCalls: 1 },
    receipt: {
      ...receipt,
      quarterlyOutput: {
        ...receipt.quarterlyOutput,
        candidateClaims: [
          {
            id: "claim-1",
            text: "Original uncertain view",
            status: "uncertain",
            evidenceIds: [],
          },
        ],
      },
    },
  });
  const saved = await saveFinanceCaseRun(directory, run);
  const input = {
    recordId: "q1",
    checkpointMonths: 3,
    observedAt: "2025-04-01T00:00:00Z",
    evidence: [
      {
        id: "price",
        source: "fixture://close",
        sourceTimestamp: "2025-03-31T00:00:00Z",
        field: "close",
        value: 120,
        unit: "USD",
      },
    ],
    assessments: [
      {
        claimId: "claim-1",
        finding: "inconclusive",
        evidenceIds: ["price"],
        deviation: "No predeclared numerical target",
        invalidationConditions: ["Original premise no longer holds"],
      },
    ],
  };
  return { directory, ref: saved.ref, input };
}
describe("finance outcome ledger", () => {
  it("binds observations to original claims without changing the packet", async () => {
    const { directory, ref, input } = await fixture();
    const before = await fs.readFile(path.join(directory, `${ref}.json`), "utf8");
    const record = await appendFinanceOutcome(directory, ref, input);
    expect(record.originalClaims).toEqual([{ id: "claim-1", text: "Original uncertain view" }]);
    expect(record.timing).toBe("due_or_later");
    expect(record.status).toBe("recorded_for_review");
    expect(await readFinanceOutcomes(directory, ref)).toEqual([record]);
    expect(await fs.readFile(path.join(directory, `${ref}.json`), "utf8")).toBe(before);
  });
  it("is idempotent under concurrent identical submissions and rejects silent overwrite", async () => {
    const { directory, ref, input } = await fixture();
    const results = await Promise.all(
      [0, 1].map(() => appendFinanceOutcome(directory, ref, input)),
    );
    expect(results[0].ref).toBe(results[1].ref);
    await expect(
      appendFinanceOutcome(directory, ref, { ...input, observedAt: "2025-04-02T00:00:00Z" }),
    ).rejects.toThrow("recordId conflict");
    expect(await readFinanceOutcomes(directory, ref)).toHaveLength(1);
  });
  it("appends corrections and preserves the original record", async () => {
    const { directory, ref, input } = await fixture();
    const first = await appendFinanceOutcome(directory, ref, input);
    const corrected = await appendFinanceOutcome(directory, ref, {
      ...input,
      recordId: "q1-correction",
      supersedes: first.ref,
      correctionReason: "Correct source field",
    });
    expect(corrected.previousRef).toBe(first.ref);
    expect(await readFinanceOutcomes(directory, ref)).toEqual([first, corrected]);
    await expect(
      appendFinanceOutcome(directory, ref, {
        ...input,
        recordId: "fork",
        supersedes: first.ref,
        correctionReason: "Conflicting correction",
      }),
    ).rejects.toThrow("unsuperseded");
  });
  it("rejects missing claim/evidence links and future observations", async () => {
    const { directory, ref, input } = await fixture();
    await expect(
      appendFinanceOutcome(directory, ref, {
        ...input,
        assessments: [{ ...input.assessments[0], claimId: "invented" }],
      }),
    ).rejects.toThrow("original claim");
    await expect(
      appendFinanceOutcome(directory, ref, {
        ...input,
        assessments: [{ ...input.assessments[0], evidenceIds: ["invented"] }],
      }),
    ).rejects.toThrow("evidence reference");
    await expect(
      appendFinanceOutcome(directory, ref, { ...input, observedAt: "2999-01-01T00:00:00Z" }),
    ).rejects.toThrow("between");
    await expect(
      appendFinanceOutcome(directory, ref, { ...input, observedAt: "2025-03-01T00:00:00Z" }),
    ).rejects.toThrow("source timestamp");
  });
  it("marks early observations as interim and enforces append-only SQL writes", async () => {
    const { directory, ref, input } = await fixture();
    const record = await appendFinanceOutcome(directory, ref, {
      ...input,
      observedAt: "2025-03-31T00:00:00Z",
    });
    expect(record.timing).toBe("interim");
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(path.join(directory, "outcome-ledger.sqlite"));
    try {
      expect(() => db.exec("DELETE FROM finance_outcomes")).toThrow("append-only");
      expect(() => db.exec("UPDATE finance_outcomes SET body='{}'")).toThrow("append-only");
    } finally {
      db.close();
    }
  });
  it("detects content tampering on read", async () => {
    const { directory, ref, input } = await fixture();
    await appendFinanceOutcome(directory, ref, input);
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(path.join(directory, "outcome-ledger.sqlite"));
    try {
      db.exec("DROP TRIGGER finance_outcome_no_update; UPDATE finance_outcomes SET body='{}'");
    } finally {
      db.close();
    }
    await expect(readFinanceOutcomes(directory, ref)).rejects.toThrow("integrity mismatch");
  });
});
