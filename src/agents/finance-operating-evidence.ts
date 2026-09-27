import {
  appendFinanceFundamentalSnapshot,
  readFinanceFundamentalSnapshot,
} from "./finance-fundamental-store.js";
import type { FinanceMarketCollectionAdapter } from "./finance-market-collection-registry.js";
import { runFinanceMarketCollectionRefresh } from "./finance-market-collection-registry.js";
import { createRegisteredCapabilityAdapters } from "./finance-registered-capability-adapters.js";
import type { FinanceResearchEvidence } from "./finance-research-execution-bridge.js";
import { createSecAnnualOperatingStatementsAdapter } from "./finance-us-equity-source-adapters.js";
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
    const rows = known
      .filter(({ data }) => data.date === period)
      .toSorted((a, b) => publicationTime(b.data) - publicationTime(a.data));
    const official = rows.filter((row) => row.sourceId === "sec_edgar_annual_operating");
    const candidates = [
      ...official.map((row) => [row, row, row]),
      [
        rows.find((row) => row.sourceId === "fmp_income_statement_annual"),
        rows.find((row) => row.sourceId === "fmp_cash_flow_statement_annual"),
        rows.find((row) => row.sourceId === "fmp_balance_sheet_statement_annual"),
      ],
    ];
    for (const [income, cash, balance] of candidates) {
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
        ...(income.sourceId === "sec_edgar_annual_operating"
          ? {
              publicationTimeBasis: "conservative_known_by" as const,
              debtDefinition: String(balance.data.debtDefinition),
            }
          : {}),
        revenue: num(income, "revenue"),
        netIncome: num(income, "netIncome"),
        dilutedShares: num(income, "weightedAverageShsOutDil"),
        operatingCashFlow: num(cash, "operatingCashFlow"),
        capitalExpenditure: Math.abs(num(cash, "capitalExpenditure")),
        cash: num(balance, "cashAndCashEquivalents"),
        debt: num(balance, "totalDebt"),
        sourceIds: [...new Set([income.sourceId, cash.sourceId, balance.sourceId])],
      };
      if (Object.values(facts).some((v) => typeof v === "number" && !Number.isFinite(v))) {
        continue;
      }
      return facts;
    }
  }
  return undefined;
}

/** Reuses registered statement adapters; a provider DCF target is never substituted for our calculation. */
export async function gatherFinanceOperatingEvidence(input: {
  instrument: string;
  asOf: string;
  fmpApiKey?: string;
  alphaVantageApiKey?: string;
  directory?: string;
  write?: boolean;
  adapters?: readonly FinanceMarketCollectionAdapter[];
  now?: () => string;
}) {
  const ids = [
    "sec_edgar_annual_operating",
    "fmp_income_statement_annual",
    "fmp_cash_flow_statement_annual",
    "fmp_balance_sheet_statement_annual",
  ];
  const adapters = input.adapters ?? [
    createSecAnnualOperatingStatementsAdapter(),
    ...createRegisteredCapabilityAdapters({
      fmpApiKey: input.fmpApiKey,
      alphaVantageApiKey: input.alphaVantageApiKey,
    }),
  ];
  if (!adapters.some((a) => a.id === "sec_edgar_annual_operating")) {
    ids.shift();
  }
  const fallbackIds: Record<string, string> = {
    fmp_income_statement_annual: "alpha_vantage_income_statement",
    fmp_cash_flow_statement_annual: "alpha_vantage_cash_flow",
    fmp_balance_sheet_statement_annual: "alpha_vantage_balance_sheet",
  };
  const queueFallback = (id: string) => {
    const fallback = fallbackIds[id];
    if (fallback && adapters.some((a) => a.id === fallback)) {
      ids.push(fallback);
    }
  };
  const now = input.now ?? (() => new Date().toISOString());
  const storage: { sourceId: string; access: string; snapshotId?: string }[] = [];
  const evidence: FinanceResearchEvidence[] = [];
  const statements: Statement[] = [];
  const issues: string[] = [];
  for (const id of ids) {
    if (
      id !== "sec_edgar_annual_operating" &&
      normalizeFinanceOperatingStatements(input.instrument, input.asOf, statements)
    ) {
      break;
    }
    try {
      const cached = input.directory
        ? readFinanceFundamentalSnapshot({
            directory: input.directory,
            instrument: input.instrument,
            assetClass: "us_equity",
            collection: "financial_statements",
            sourceId: id,
            asOf: input.asOf,
            knownBy: input.asOf,
            maxAgeMs: 6 * 3600_000,
          })
        : undefined;
      let result = cached?.receipt;
      let snapshotId = cached?.snapshotId;
      if (!result) {
        result = await runFinanceMarketCollectionRefresh({
          request: {
            collection: "financial_statements",
            instrument: input.instrument,
            assetClass: "us_equity",
            asOf: input.asOf,
            limit: 3,
          },
          adapters: adapters.filter((a) => a.id === id),
        });
        if (input.directory && input.write) {
          const capturedAt = now();
          snapshotId = appendFinanceFundamentalSnapshot({
            directory: input.directory,
            sourceId: id,
            capturedAt,
            receipt: result,
          });
          // Consume the durable snapshot, not a second in-memory interpretation.
          if (result.records.length) {
            const stored = readFinanceFundamentalSnapshot({
              directory: input.directory,
              instrument: input.instrument,
              assetClass: "us_equity",
              collection: "financial_statements",
              sourceId: id,
              asOf: input.asOf,
              knownBy: capturedAt,
              maxAgeMs: 0,
            });
            if (!stored || stored.snapshotId !== snapshotId) {
              throw new Error("fundamental snapshot readback failed");
            }
            result = stored.receipt;
          }
        }
      }
      storage.push({
        sourceId: id,
        access: cached
          ? "database_reuse"
          : snapshotId
            ? result.records.length
              ? "database_readback"
              : "database_recorded_empty"
            : result.adaptersCalled
              ? "collected_unpersisted"
              : "no_adapter",
        snapshotId,
      });
      const rows = result.records.map((record) => record.data as Record<string, unknown>);
      if (!rows.length) {
        const failures = result.sourceAttempts
          .filter((a) => a.status === "failed")
          .map((a) => a.error ?? "source unavailable");
        issues.push(
          `${id}: no financial statements${failures.length ? "; " + failures.join("; ") : ""}`,
        );
        queueFallback(id);
        continue;
      }
      statements.push(...rows.map((data) => ({ sourceId: id, data })));
      evidence.push({
        sourceId: id,
        sourceUrlOrArtifact: result.records[0].sourceUrlOrArtifact,
        independenceKey: `issuer:${input.instrument}:annual-statements`,
        description: "annual operating statement; publication and fiscal period retained",
        detail: JSON.stringify({
          snapshotId,
          access: cached ? "database_reuse" : "collected",
          collectedAt: cached?.capturedAt ?? result.records[0].observedAt,
          records: result.records,
        }),
      });
    } catch {
      issues.push(`${id}: statement collection or database verification unavailable`);
      queueFallback(id);
    }
  }
  return {
    evidence,
    facts: normalizeFinanceOperatingStatements(input.instrument, input.asOf, statements),
    issues,
    storage,
  };
}
