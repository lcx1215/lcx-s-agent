import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../memory/sqlite.js";
import {
  FINANCE_FUNDAMENTAL_DATABASE,
  readFinanceFundamentalSnapshot,
} from "./finance-fundamental-store.js";
import type { FinanceMarketCollectionAdapter } from "./finance-market-collection-registry.js";
import {
  gatherFinanceOperatingEvidence,
  normalizeFinanceOperatingStatements,
} from "./finance-operating-evidence.js";

const dirs: string[] = [];
const temp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "fundamental-store-"));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const at = "2026-09-27T12:00:00.000Z";
const captured = "2026-09-27T12:00:01.000Z";
const later = "2026-09-27T13:00:00.000Z";
function adapters(partial = false): FinanceMarketCollectionAdapter[] {
  const statements: [string, Record<string, number>][] = [
    [
      "fmp_income_statement_annual",
      { revenue: 1000, netIncome: 120, weightedAverageShsOutDil: 10 },
    ],
    ["fmp_cash_flow_statement_annual", { operatingCashFlow: 150, capitalExpenditure: -50 }],
    ["fmp_balance_sheet_statement_annual", { cashAndCashEquivalents: 200, totalDebt: 100 }],
  ];
  return statements.map(([sourceId, data]) => ({
    id: String(sourceId),
    providerName: "fmp",
    providerRole: "cross_check_market_data" as const,
    priority: 1,
    supports: () => true,
    collect: vi.fn(async (request) =>
      partial && String(sourceId).includes("balance")
        ? []
        : [
            {
              itemId: String(sourceId),
              collection: "financial_statements" as const,
              providerName: "fmp",
              providerRole: "cross_check_market_data" as const,
              sourceFamily: "fundamentals_api" as const,
              sourceTimestamp: "2026-02-01T12:00:00Z",
              observedAt: captured,
              delayStatus: "official_lagged" as const,
              sourceUrlOrArtifact: "https://example.test/statements",
              data: {
                ...data,
                symbol: request.instrument,
                date: "2025-12-31",
                reportedCurrency: "USD",
                period: "FY",
                acceptedDate: "2026-02-01T12:00:00Z",
              },
            },
          ],
    ),
  }));
}
const read = (directory: string, knownBy = later, instrument = "ACME") =>
  readFinanceFundamentalSnapshot({
    directory,
    instrument,
    assetClass: "us_equity",
    collection: "financial_statements",
    sourceId: "fmp_income_statement_annual",
    asOf: knownBy,
    knownBy,
    maxAgeMs: 6 * 3600_000,
  });
const gather = (directory: string, sources = adapters(), asOf = at, write = true) =>
  gatherFinanceOperatingEvidence({
    directory,
    instrument: "ACME",
    asOf,
    write,
    adapters: sources,
    now: () => captured,
  });

describe("fundamental snapshots feeding business valuation", () => {
  it("persists three statements and reconstructs facts without a network call in the next run", async () => {
    const directory = temp();
    const first = await gather(directory);
    expect(first.facts).toMatchObject({ operatingCashFlow: 150, capitalExpenditure: 50 });
    expect(first.storage.map((s) => s.access)).toEqual(Array(3).fill("database_readback"));
    const sources = adapters();
    const second = await gather(directory, sources, later, false);
    expect(second.facts).toEqual(first.facts);
    expect(second.storage.map((s) => s.snapshotId)).toEqual(first.storage.map((s) => s.snapshotId));
    sources.forEach((s) => expect(s.collect).not.toHaveBeenCalled());
    expect(second.evidence[0].detail).toContain(captured);
    expect(second.evidence[0].sourceUrlOrArtifact).toBe("https://example.test/statements");
  });
  it("excludes future knowledge, expired snapshots and another company", async () => {
    const directory = temp();
    await gather(directory);
    expect(read(directory, at)).toBeUndefined();
    expect(read(directory, "2026-09-27T19:00:00Z")).toBeUndefined();
    expect(read(directory, later, "OTHER")).toBeUndefined();
    expect(read(directory)).toBeDefined();
  });
  it("retains incomplete evidence without fabricating a complete cash-flow valuation", async () => {
    const directory = temp();
    const result = await gather(directory, adapters(true));
    expect(result.facts).toBeUndefined();
    expect(result.evidence).toHaveLength(2);
    expect(result.issues).toContain("fmp_balance_sheet_statement_annual: no financial statements");
    expect(read(directory)).toBeDefined();
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(path.join(directory, FINANCE_FUNDAMENTAL_DATABASE), {
      readOnly: true,
    });
    expect(db.prepare("SELECT count(*) AS n FROM fundamental_snapshots").get()?.n).toBe(3);
    db.close();
  });
  it("read-only collection and absent-store lookup do not create a database", async () => {
    const directory = temp();
    expect(read(directory)).toBeUndefined();
    expect((await gather(directory, adapters(), at, false)).facts).toBeDefined();
    expect(fs.readdirSync(directory)).toEqual([]);
  });
  it("uses the latest disclosed revision while preserving the earlier knowledge cutoff", () => {
    const common = {
      symbol: "ACME",
      date: "2025-12-31",
      reportedCurrency: "USD",
      period: "FY",
      acceptedDate: "2026-02-01T12:00:00Z",
    };
    const rows = [
      {
        sourceId: "fmp_income_statement_annual",
        data: { ...common, revenue: 1000, netIncome: 120, weightedAverageShsOutDil: 10 },
      },
      {
        sourceId: "fmp_cash_flow_statement_annual",
        data: { ...common, operatingCashFlow: 150, capitalExpenditure: -50 },
      },
      {
        sourceId: "fmp_balance_sheet_statement_annual",
        data: { ...common, cashAndCashEquivalents: 200, totalDebt: 100 },
      },
      {
        sourceId: "fmp_cash_flow_statement_annual",
        data: {
          ...common,
          acceptedDate: "2026-03-01T12:00:00Z",
          operatingCashFlow: 90,
          capitalExpenditure: -50,
        },
      },
    ];
    expect(normalizeFinanceOperatingStatements("ACME", at, rows)?.operatingCashFlow).toBe(90);
    expect(
      normalizeFinanceOperatingStatements("ACME", "2026-02-15T12:00:00Z", rows)?.operatingCashFlow,
    ).toBe(150);
  });
  it("keeps fallback statements as partial research evidence and reuses their original snapshots", async () => {
    const directory = temp();
    const fallback = adapters().map(
      (a, i) =>
        ({
          ...a,
          id: [
            "alpha_vantage_income_statement",
            "alpha_vantage_cash_flow",
            "alpha_vantage_balance_sheet",
          ][i],
          collect: vi.fn(async (request, signal) =>
            (await a.collect(request, signal)).map((record) => ({
              ...record,
              data: {
                fiscalDateEnding: "2025-12-31",
                reportedCurrency: "USD",
                publicationTimeUnknown: true,
                operatingCashflow: "150",
              },
            })),
          ),
        }) satisfies FinanceMarketCollectionAdapter,
    );
    const first = await gather(directory, fallback);
    expect(first.evidence).toHaveLength(3);
    expect(first.facts).toBeUndefined();
    expect(first.evidence[0].detail).toContain("publicationTimeUnknown");
    fallback.forEach((a) => a.collect.mockClear());
    const second = await gather(directory, fallback, later, false);
    expect(second.evidence).toHaveLength(3);
    expect(second.storage.filter((s) => s.access === "database_reuse")).toHaveLength(3);
    fallback.forEach((a) => expect(a.collect).not.toHaveBeenCalled());
  });
  it("rejects corrupt stored content instead of claiming database evidence", async () => {
    const directory = temp();
    await gather(directory);
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(path.join(directory, FINANCE_FUNDAMENTAL_DATABASE));
    db.exec(
      "UPDATE fundamental_snapshots SET body='{}' WHERE source_id='fmp_income_statement_annual'",
    );
    db.close();
    expect(() => read(directory)).toThrow("checksum mismatch");
    const result = await gather(directory, adapters(), later, false);
    expect(result.facts).toBeUndefined();
    expect(result.issues.join(" ")).toContain("database verification unavailable");
  });
});
