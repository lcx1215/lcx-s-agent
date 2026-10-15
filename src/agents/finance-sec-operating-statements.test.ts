import { describe, expect, it } from "vitest";
import { normalizeFinanceOperatingStatements } from "./finance-operating-evidence.js";
import { secAnnualOperatingStatements } from "./finance-sec-operating-statements.js";
import type { SecFactsPayload } from "./finance-us-equity-source-adapters.js";
const at = "2026-04-01T00:00:00Z";
function fixture(): SecFactsPayload {
  const values: [string, number, boolean, string][] = [
    ["NetCashProvidedByUsedInOperatingActivities", 150, true, "USD"],
    ["RevenueFromContractWithCustomerExcludingAssessedTax", 1000, true, "USD"],
    ["NetIncomeLoss", 120, true, "USD"],
    ["WeightedAverageNumberOfDilutedSharesOutstanding", 10, true, "shares"],
    ["PaymentsToAcquirePropertyPlantAndEquipment", 50, true, "USD"],
    ["CashAndCashEquivalentsAtCarryingValue", 200, false, "USD"],
    ["LongTermDebtCurrent", 10, false, "USD"],
    ["LongTermDebtNoncurrent", 80, false, "USD"],
    ["CommercialPaper", 10, false, "USD"],
  ];
  return {
    facts: {
      "us-gaap": Object.fromEntries(
        values.map(([tag, val, duration, unit]) => [
          tag,
          {
            units: {
              [unit]: [
                {
                  val,
                  accn: "0001-26-001",
                  filed: "2026-02-01",
                  end: "2025-12-31",
                  ...(duration ? { start: "2025-01-01" } : {}),
                  form: "10-K",
                },
              ],
            },
          },
        ]),
      ),
    },
  };
}
const normalize = (p: SecFactsPayload, cutoff = at) =>
  normalizeFinanceOperatingStatements(
    "ACME",
    cutoff,
    secAnnualOperatingStatements(p, "ACME", cutoff).map((data) => ({
      sourceId: "sec_edgar_annual_operating",
      data,
    })),
  );
describe("SEC operating annual facts", () => {
  it("joins one accession and annual duration with exact monetary/share units", () => {
    const rows = secAnnualOperatingStatements(fixture(), "ACME", at);
    expect(rows[0]).toMatchObject({
      accessionNumber: "0001-26-001",
      publicationPrecision: "date_only_conservative_36h",
      totalDebt: 100,
    });
    expect(normalize(fixture())).toMatchObject({
      revenue: 1000,
      operatingCashFlow: 150,
      capitalExpenditure: 50,
      dilutedShares: 10,
      debt: 100,
      sourceIds: ["sec_edgar_annual_operating"],
    });
  });
  it("does not use a same-day filing date as a known intraday publication instant", () => {
    expect(normalize(fixture(), "2026-02-01T23:59:59Z")).toBeUndefined();
    expect(normalize(fixture(), "2026-02-02T12:00:00Z")).toBeDefined();
  });
  it.each(["accession", "quarter", "units", "ambiguous", "missing_debt"])(
    "keeps %s mismatches as incomplete evidence",
    (kind) => {
      const p = fixture();
      const facts = p.facts!["us-gaap"];
      if (kind === "accession") {
        facts.NetIncomeLoss.units!.USD[0].accn = "other";
      }
      if (kind === "quarter") {
        facts.NetIncomeLoss.units!.USD[0].start = "2025-10-01";
      }
      if (kind === "units") {
        facts.WeightedAverageNumberOfDilutedSharesOutstanding.units = {
          USD: [{ ...facts.WeightedAverageNumberOfDilutedSharesOutstanding.units!.shares[0] }],
        };
      }
      if (kind === "ambiguous") {
        facts.NetIncomeLoss.units!.USD.push({ ...facts.NetIncomeLoss.units!.USD[0], val: 999 });
      }
      if (kind === "missing_debt") {
        delete facts.CommercialPaper;
      }
      expect(secAnnualOperatingStatements(p, "ACME", at)).toHaveLength(1);
      expect(normalize(p)).toBeUndefined();
    },
  );
  it("allows complete fallback statements when the official cohort is incomplete", () => {
    const complete = secAnnualOperatingStatements(fixture(), "ACME", at)[0];
    const broken = { ...complete, totalDebt: undefined };
    const statements = [
      { sourceId: "sec_edgar_annual_operating", data: broken },
      ...[
        "fmp_income_statement_annual",
        "fmp_cash_flow_statement_annual",
        "fmp_balance_sheet_statement_annual",
      ].map((sourceId) => ({ sourceId, data: complete })),
    ];
    expect(normalizeFinanceOperatingStatements("ACME", at, statements)?.sourceIds).toEqual([
      "fmp_income_statement_annual",
      "fmp_cash_flow_statement_annual",
      "fmp_balance_sheet_statement_annual",
    ]);
  });
  it("does not classify quarterly cash flow in a 10-K as annual", () => {
    const p = fixture();
    p.facts!["us-gaap"].NetCashProvidedByUsedInOperatingActivities.units!.USD[0].start =
      "2025-10-01";
    expect(secAnnualOperatingStatements(p, "ACME", at)).toEqual([]);
  });
});
