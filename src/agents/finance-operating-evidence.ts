import { runFinanceMarketCollectionRefresh } from "./finance-market-collection-registry.js";
import { createRegisteredCapabilityAdapters } from "./finance-registered-capability-adapters.js";
import type { FinanceResearchEvidence } from "./finance-research-execution-bridge.js";
import type { FinanceOperatingFacts } from "./finance-value-assessment.js";

type Statement = { sourceId: string; data: Record<string, unknown> };
// A date without an offset does not establish an intraday release instant.
function publicationTime(data: Record<string, unknown>): number {
  const value = data.acceptedDate ?? data.filingDate;
  if (typeof value !== "string") {
    return Number.NaN;
  }
  if (/T.*(?:Z|[+-]\d{2}:?\d{2})$/u.test(value)) {
    return Date.parse(value);
  }
  const day = value.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/u.test(day)
    ? Date.parse(`${day}T00:00:00Z`) + 36 * 3600_000
    : Number.NaN;
}
/** Do not join fiscal years, currencies or publication dates by array position. */
export function normalizeFinanceOperatingStatements(
  instrument: string,
  asOf: string,
  statements: readonly Statement[],
): FinanceOperatingFacts | undefined {
  const known = statements.filter(
    ({ data }) =>
      data.symbol === instrument &&
      data.reportedCurrency === "USD" &&
      data.period === "FY" &&
      typeof data.date === "string" &&
      Number.isFinite(publicationTime(data)) &&
      publicationTime(data) <= Date.parse(asOf),
  );
  const periods = [...new Set(known.map(({ data }) => String(data.date)))].toSorted().toReversed();
  for (const period of periods) {
    const rows = known.filter(({ data }) => data.date === period);
    const income = rows.find((row) => row.sourceId === "fmp_income_statement_annual");
    const cash = rows.find((row) => row.sourceId === "fmp_cash_flow_statement_annual");
    const balance = rows.find((row) => row.sourceId === "fmp_balance_sheet_statement_annual");
    if (!income || !cash || !balance) {
      continue;
    }
    const num = (row: Statement, key: string) =>
      typeof row.data[key] === "number" ? row.data[key] : Number.NaN;
    const facts: FinanceOperatingFacts = {
      instrument,
      currency: "USD",
      periodEnd: period,
      publishedAt: [income, cash, balance]
        .map(({ data }) => new Date(publicationTime(data)).toISOString())
        .toSorted()
        .at(-1)!,
      revenue: num(income, "revenue"),
      netIncome: num(income, "netIncome"),
      dilutedShares: num(income, "weightedAverageShsOutDil"),
      operatingCashFlow: num(cash, "operatingCashFlow"),
      capitalExpenditure: Math.abs(num(cash, "capitalExpenditure")),
      cash: num(balance, "cashAndCashEquivalents"),
      debt: num(balance, "totalDebt"),
      sourceIds: [income.sourceId, cash.sourceId, balance.sourceId],
    };
    if (Object.values(facts).some((v) => typeof v === "number" && !Number.isFinite(v))) {
      continue;
    }
    return facts;
  }
  return undefined;
}

/** Reuses registered statement adapters; a provider DCF target is never substituted for our calculation. */
export async function gatherFinanceOperatingEvidence(input: {
  instrument: string;
  asOf: string;
  fmpApiKey?: string;
}) {
  const ids = [
    "fmp_income_statement_annual",
    "fmp_cash_flow_statement_annual",
    "fmp_balance_sheet_statement_annual",
  ];
  const adapters = createRegisteredCapabilityAdapters({ fmpApiKey: input.fmpApiKey });
  const evidence: FinanceResearchEvidence[] = [];
  const statements: Statement[] = [];
  const issues: string[] = [];
  for (const id of ids) {
    try {
      const result = await runFinanceMarketCollectionRefresh({
        request: {
          collection: "financial_statements",
          instrument: input.instrument,
          assetClass: "us_equity",
          asOf: input.asOf,
          limit: 3,
        },
        adapters: adapters.filter((a) => a.id === id),
      });
      const rows = result.records.map((record) => record.data as Record<string, unknown>);
      if (!rows.length) {
        issues.push(`${id}: no financial statements`);
        continue;
      }
      statements.push(...rows.map((data) => ({ sourceId: id, data })));
      evidence.push({
        sourceId: id,
        sourceUrlOrArtifact: `provider:fmp/${id.slice(4)}`,
        independenceKey: `issuer:${input.instrument}:annual-statements`,
        description: "annual operating statement; publication and fiscal period retained",
        detail: JSON.stringify(rows),
      });
    } catch {
      issues.push(`${id}: statement collection unavailable`);
    }
  }
  return {
    evidence,
    facts: normalizeFinanceOperatingStatements(input.instrument, input.asOf, statements),
    issues,
  };
}
