import type { SecFactsPayload } from "./finance-us-equity-source-adapters.js";

/** Retain missing fields; never combine different filing accessions or annual durations. */
export function secAnnualOperatingStatements(
  payload: SecFactsPayload,
  instrument: string,
  asOf: string,
) {
  const facts = payload.facts?.["us-gaap"] ?? {};
  const available = (filed: unknown) =>
    typeof filed === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(filed)
      ? Date.parse(filed + "T00:00:00Z") + 36 * 3600_000
      : NaN;
  const cohorts = (facts.NetCashProvidedByUsedInOperatingActivities?.units?.USD ?? []).filter(
    (f): f is typeof f & { accn: string; start: string; end: string } => {
      const days = (Date.parse(String(f.end)) - Date.parse(String(f.start))) / 86400_000;
      return (
        (f.form === "10-K" || f.form === "10-K/A") &&
        typeof f.accn === "string" &&
        typeof f.start === "string" &&
        typeof f.end === "string" &&
        days >= 300 &&
        days <= 380 &&
        available(f.filed) <= Date.parse(asOf)
      );
    },
  );
  const seen = new Set<string>();
  return cohorts
    .toSorted(
      (a, b) =>
        String(b.end).localeCompare(String(a.end)) ||
        String(b.filed).localeCompare(String(a.filed)),
    )
    .flatMap((cohort) => {
      const key = `${cohort.accn}:${cohort.start}:${cohort.end}`;
      if (seen.has(key)) {
        return [];
      }
      seen.add(key);
      const provenance: Record<string, string> = {};
      const pick = (
        name: string,
        tags: string[],
        unit = "USD",
        duration = true,
      ): number | undefined => {
        for (const tag of tags) {
          const rows = (facts[tag]?.units?.[unit] ?? []).filter(
            (f) =>
              f.accn === cohort.accn &&
              f.end === cohort.end &&
              f.filed === cohort.filed &&
              (duration ? f.start === cohort.start : f.start === undefined),
          );
          const values = [
            ...new Set(
              rows
                .map((f) => f.val)
                .filter((v): v is number => typeof v === "number" && Number.isFinite(v)),
            ),
          ];
          if (values.length > 1) {
            return undefined;
          }
          if (values.length === 1) {
            provenance[name] = tag;
            return values[0];
          }
        }
        return undefined;
      };
      const debtCurrent = pick("debtCurrent", ["LongTermDebtCurrent"], "USD", false);
      const debtNoncurrent = pick("debtNoncurrent", ["LongTermDebtNoncurrent"], "USD", false);
      const commercialPaper = pick("commercialPaper", ["CommercialPaper"], "USD", false);
      // This supported decomposition must be explicit; absent short-term debt is not zero.
      const totalDebt =
        debtCurrent !== undefined && debtNoncurrent !== undefined && commercialPaper !== undefined
          ? debtCurrent + debtNoncurrent + commercialPaper
          : undefined;
      return [
        {
          symbol: instrument,
          reportedCurrency: "USD",
          period: "FY",
          date: String(cohort.end),
          periodStart: cohort.start,
          filingDate: String(cohort.filed),
          accessionNumber: cohort.accn,
          publicationPrecision: "date_only_conservative_36h",
          statementProvider: "sec_edgar",
          revenue: pick("revenue", [
            "RevenueFromContractWithCustomerExcludingAssessedTax",
            "Revenues",
            "SalesRevenueNet",
          ]),
          netIncome: pick("netIncome", ["NetIncomeLoss"]),
          weightedAverageShsOutDil: pick(
            "dilutedShares",
            ["WeightedAverageNumberOfDilutedSharesOutstanding"],
            "shares",
          ),
          operatingCashFlow: pick("operatingCashFlow", [
            "NetCashProvidedByUsedInOperatingActivities",
          ]),
          capitalExpenditure: pick("capitalExpenditure", [
            "PaymentsToAcquirePropertyPlantAndEquipment",
          ]),
          cashAndCashEquivalents: pick(
            "cash",
            ["CashAndCashEquivalentsAtCarryingValue"],
            "USD",
            false,
          ),
          totalDebt,
          debtCurrent,
          debtNoncurrent,
          commercialPaper,
          debtDefinition:
            "long-term debt current and noncurrent plus commercial paper; inspect other borrowing and lease obligations separately",
          factTags: provenance,
        },
      ];
    });
}
