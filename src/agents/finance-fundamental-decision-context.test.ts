import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { requireNodeSqlite } from "../memory/sqlite.js";
import {
  appendFinanceFundamentalSnapshot,
  FINANCE_FUNDAMENTAL_DATABASE,
} from "./finance-fundamental-store.js";
import type { FinanceMarketCollectionReceipt } from "./finance-market-collection-registry.js";
import {
  buildFinanceThesisDecisionContext,
  FinanceThesisDecisionContextSchema,
} from "./finance-thesis-decision-context.js";
const dirs: string[] = [];
const temp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "fundamental-decision-"));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const asOf = "2026-09-28T00:00:00.000Z";
function seed(directory: string) {
  const receipt: FinanceMarketCollectionReceipt = {
    schemaVersion: "lcx_finance_market_collection_v1",
    refreshId: "fixture",
    boundary: "finance_market_collection_research_only",
    request: {
      instrument: "AAPL",
      assetClass: "us_equity",
      collection: "financial_statements",
      asOf: "2026-09-27T00:00:00.000Z",
    },
    status: "needs_review",
    records: [
      {
        itemId: "filing",
        collection: "financial_statements",
        providerName: "SEC",
        providerRole: "official_or_issuer_reference",
        sourceFamily: "official_filing",
        sourceTimestamp: "2026-02-01T12:00:00Z",
        observedAt: "2026-09-27T00:00:00Z",
        delayStatus: "official_lagged",
        sourceUrlOrArtifact: "https://example.test/filing",
        data: {
          date: "2025-12-31",
          filingDate: "2026-02-01",
          reportedCurrency: "USD",
          revenue: 1000,
          operatingCashFlow: 150,
          capitalExpenditure: 50,
          netIncome: "None",
        },
      },
    ],
    sourceAttempts: [],
    selectedSourceIds: ["sec_edgar_annual_operating"],
    missingEvidence: [],
    requiredNextSteps: [],
    adaptersCalled: true,
    notTouched: [],
  };
  return appendFinanceFundamentalSnapshot({
    directory,
    sourceId: "sec_edgar_annual_operating",
    capturedAt: "2026-09-27T00:00:01.000Z",
    receipt,
  });
}
it.each([undefined, "intraday"] as const)(
  "projects actual candidate fundamentals into shared %s review context without requiring a thesis",
  async (horizon) => {
    const directory = temp();
    const snapshotId = seed(directory);
    const context = await buildFinanceThesisDecisionContext({
      directory,
      asOf,
      instruments: ["aapl", "SPY"],
      horizon,
    });
    expect(context.theses).toEqual([]);
    expect(context.fundamentals?.instruments[0]).toMatchObject({
      instrument: "AAPL",
      status: "stored",
      statements: [{ snapshotId, metrics: { revenue: 1000, operatingCashFlow: 150 } }],
    });
    expect(context.fundamentals?.instruments[0].statements[0].metrics).not.toHaveProperty(
      "netIncome",
    );
    expect(context.fundamentals?.instruments[1]).toMatchObject({
      instrument: "SPY",
      status: "missing_or_outside_window",
      statements: [],
    });
    expect(FinanceThesisDecisionContextSchema.parse(JSON.parse(JSON.stringify(context)))).toEqual(
      context,
    );
  },
);
it("does not create an absent database and bounds candidate coverage", async () => {
  const directory = temp();
  const context = await buildFinanceThesisDecisionContext({
    directory,
    asOf,
    instruments: ["A", "B", "C", "D", "E", "a"],
  });
  expect(context.fundamentals?.instruments).toHaveLength(4);
  expect(context.fundamentals?.omittedInstrumentCount).toBe(1);
  expect(fs.readdirSync(directory)).toEqual([]);
});
it("excludes future knowledge and old capture windows without blocking context", async () => {
  const directory = temp();
  seed(directory);
  for (const cutoff of ["2026-09-26T00:00:00.000Z", "2026-11-01T00:00:00.000Z"]) {
    const c = await buildFinanceThesisDecisionContext({
      directory,
      asOf: cutoff,
      instruments: ["AAPL"],
    });
    expect(c.fundamentals?.instruments[0].status).toBe("missing_or_outside_window");
  }
});
it("reports corrupt fundamental evidence without turning it into a veto or losing thesis context", async () => {
  const directory = temp();
  seed(directory);
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(path.join(directory, FINANCE_FUNDAMENTAL_DATABASE));
  db.exec("UPDATE fundamental_snapshots SET body='{}'");
  db.close();
  const c = await buildFinanceThesisDecisionContext({ directory, asOf, instruments: ["AAPL"] });
  expect(c.fundamentals?.instruments[0]).toMatchObject({ status: "unreadable", statements: [] });
  expect(c.theses).toEqual([]);
});
