import { z } from "zod";
import { readFinanceFundamentalSnapshot } from "./finance-fundamental-store.js";

const Metric = z.enum([
  "revenue",
  "netIncome",
  "operatingCashFlow",
  "capitalExpenditure",
  "cash",
  "debt",
  "dilutedShares",
]);
const Statement = z
  .object({
    snapshotId: z.string().regex(/^[a-f0-9]{64}$/u),
    sourceId: z.string().max(120),
    source: z.string().max(500),
    capturedAt: z.string(),
    sourceTimestamp: z.string(),
    periodEnd: z.string().max(40).nullable(),
    currency: z.string().max(20).nullable(),
    publicationTimeUnknown: z.boolean(),
    debtDefinition: z.string().max(300).optional(),
    metrics: z.partialRecord(Metric, z.number().finite()),
  })
  .strict();
export const FinanceFundamentalDecisionContextSchema = z
  .object({
    boundary: z.literal("stored_fundamentals_not_current_quote_or_trade_signal"),
    instruments: z
      .array(
        z
          .object({
            instrument: z.string().max(120),
            status: z.enum(["stored", "missing_or_outside_window", "unreadable"]),
            statements: z.array(Statement).max(6),
            incompleteCoverage: z.boolean(),
          })
          .strict(),
      )
      .max(4),
    omittedInstrumentCount: z.number().int().nonnegative(),
    captureWindowDays: z.literal(30),
  })
  .strict();

const sources = [
  ["sec_edgar_annual_operating"],
  ["fmp_income_statement_annual", "alpha_vantage_income_statement"],
  ["fmp_cash_flow_statement_annual", "alpha_vantage_cash_flow"],
  ["fmp_balance_sheet_statement_annual", "alpha_vantage_balance_sheet"],
];
const fields = {
  revenue: ["revenue", "totalRevenue"],
  netIncome: ["netIncome"],
  operatingCashFlow: ["operatingCashFlow", "operatingCashflow"],
  capitalExpenditure: ["capitalExpenditure", "capitalExpenditures"],
  cash: ["cashAndCashEquivalents", "cashAndCashEquivalentsAtCarryingValue"],
  debt: ["totalDebt", "shortLongTermDebtTotal"],
  dilutedShares: ["weightedAverageShsOutDil"],
} as const;
const text = (value: unknown, max: number) =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;

/** Read-only shared projection for daily and intraday reviews; never fetches or creates a store. */
export function buildFinanceFundamentalDecisionContext(input: {
  directory: string;
  asOf: string;
  instruments: readonly string[];
}): z.infer<typeof FinanceFundamentalDecisionContextSchema> {
  const instruments = [
    ...new Set(input.instruments.map((s) => s.trim().toUpperCase()).filter(Boolean)),
  ];
  return FinanceFundamentalDecisionContextSchema.parse({
    boundary: "stored_fundamentals_not_current_quote_or_trade_signal",
    captureWindowDays: 30,
    omittedInstrumentCount: Math.max(0, instruments.length - 4),
    instruments: instruments.slice(0, 4).map((instrument) => {
      const statements: z.infer<typeof Statement>[] = [];
      let unreadable = false;
      for (const alternatives of sources) {
        for (const sourceId of alternatives) {
          try {
            const stored = readFinanceFundamentalSnapshot({
              directory: input.directory,
              instrument,
              assetClass: "us_equity",
              collection: "financial_statements",
              sourceId,
              asOf: input.asOf,
              knownBy: input.asOf,
              maxAgeMs: 30 * 86400_000,
            });
            if (!stored) {
              continue;
            }
            const selected = stored.receipt.records
              .filter((r) => Date.parse(r.sourceTimestamp) <= Date.parse(input.asOf))
              .slice(0, 2);
            for (const record of selected) {
              const metrics: Partial<Record<z.infer<typeof Metric>, number>> = {};
              for (const [name, aliases] of Object.entries(fields)) {
                const raw = aliases
                  .map((key) => record.data[key])
                  .find(
                    (v) =>
                      typeof v === "number" ||
                      (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))),
                  );
                const value =
                  typeof raw === "number" || typeof raw === "string" ? Number(raw) : NaN;
                if (Number.isFinite(value)) {
                  metrics[name as z.infer<typeof Metric>] = value;
                }
              }
              const debtDefinition = text(record.data.debtDefinition, 300);
              statements.push({
                snapshotId: stored.snapshotId,
                sourceId,
                source: record.sourceUrlOrArtifact.slice(0, 500),
                capturedAt: stored.capturedAt,
                sourceTimestamp: record.sourceTimestamp,
                periodEnd: text(record.data.date ?? record.data.fiscalDateEnding, 40),
                currency: text(record.data.reportedCurrency, 20),
                publicationTimeUnknown:
                  record.data.publicationTimeUnknown === true ||
                  !(record.data.filingDate || record.data.acceptedDate),
                ...(debtDefinition ? { debtDefinition } : {}),
                metrics,
              });
            }
            if (selected.length) {
              break;
            }
          } catch {
            unreadable = true;
          }
        }
        // An official cohort already contains all available statement fields. Keep partial data,
        // but do not crowd the bounded review with provider copies of the same issuer filing.
        if (alternatives[0] === "sec_edgar_annual_operating" && statements.length) {
          break;
        }
      }
      return {
        instrument,
        status: unreadable
          ? "unreadable"
          : statements.length
            ? "stored"
            : "missing_or_outside_window",
        statements: statements.slice(0, 6),
        incompleteCoverage: true,
      };
    }),
  });
}
