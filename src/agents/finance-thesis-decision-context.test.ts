import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildFinanceThesisDecisionContext } from "./finance-thesis-decision-context.js";
import { openFinanceThesis, transitionFinanceThesis } from "./finance-thesis-ledger.js";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("finance thesis decision context", () => {
  it("projects existing active theses as of the decision time and prioritizes candidate instruments", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "finance-thesis-context-"));
    temporary.push(directory);
    await openFinanceThesis(directory, {
      thesisId: "spy-thesis",
      instrument: "SPY",
      claim: "Broad earnings growth remains supportive.",
      rationale: "Fixture rationale.",
      evidence: [{ id: "filing-1", source: "official-filing", reference: "fixture://10-q" }],
      invalidationConditions: ["Earnings trend reverses."],
      observedAt: "2026-09-10T00:00:00.000Z",
    });
    await openFinanceThesis(directory, {
      thesisId: "macro-thesis",
      instrument: "US_MACRO",
      claim: "Inflation is moderating.",
      evidence: [{ id: "series-1", source: "official-series", reference: "fixture://cpi" }],
      invalidationConditions: ["Inflation reaccelerates."],
      observedAt: "2026-09-11T00:00:00.000Z",
    });
    await transitionFinanceThesis(directory, {
      thesisId: "spy-thesis",
      to: "invalidated",
      reason: "Fixture invalidation after the review time.",
      observedAt: "2026-09-20T00:00:00.000Z",
    });

    const context = await buildFinanceThesisDecisionContext({
      directory,
      asOf: "2026-09-15T00:00:00.000Z",
      instruments: ["spy"],
    });

    expect(context).toMatchObject({
      schemaVersion: "lcx_finance_thesis_decision_context_v1",
      observedAt: "2026-09-15T00:00:00.000Z",
      activeThesisCount: 2,
      theses: [
        expect.objectContaining({
          thesisId: "spy-thesis",
          instrument: "SPY",
          evidence: [expect.objectContaining({ source: "official-filing" })],
          invalidationConditions: ["Earnings trend reverses."],
        }),
        expect.objectContaining({ thesisId: "macro-thesis", instrument: "US_MACRO" }),
      ],
    });

    const afterInvalidation = await buildFinanceThesisDecisionContext({
      directory,
      asOf: "2026-09-21T00:00:00.000Z",
      instruments: ["SPY"],
    });
    expect(afterInvalidation.theses.map((thesis) => thesis.thesisId)).toEqual(["macro-thesis"]);
  });

  it("reports an empty existing owner without manufacturing thesis evidence", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "finance-thesis-context-empty-"));
    temporary.push(directory);

    const context = await buildFinanceThesisDecisionContext({
      directory,
      asOf: "2026-09-15T00:00:00.000Z",
      instruments: ["SPY"],
    });

    expect(context).toMatchObject({
      activeThesisCount: 0,
      ledgerHeadRef: null,
      theses: [],
      omittedThesisCount: 0,
    });
  });
});
