import type {
  FinanceMarketCollectionItem,
  FinanceMarketCollectionRequest,
} from "./finance-market-collection-registry.js";

// Published exchange calendar; unknown years remain unverified, never guessed.
// https://www.nyse.com/trade/hours-calendars (verified 2026-09-08)
const holidays: Record<string, readonly string[]> = {
  "2026": [
    "01-01",
    "01-19",
    "02-16",
    "04-03",
    "05-25",
    "06-19",
    "07-03",
    "09-07",
    "11-26",
    "12-25",
  ],
  "2027": [
    "01-01",
    "01-18",
    "02-15",
    "03-26",
    "05-31",
    "06-18",
    "07-05",
    "09-06",
    "11-25",
    "12-24",
  ],
  "2028": ["01-17", "02-21", "04-14", "05-29", "06-19", "07-04", "09-04", "11-23", "12-25"],
};
const dayMs = 86_400_000;
function dateMs(value: string | undefined) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    return NaN;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value
    ? parsed
    : NaN;
}

/** Calendar completeness is separate from freshness and cross-source price agreement. */
export function assessFinanceHistoryCoverage(
  request: FinanceMarketCollectionRequest,
  records: readonly FinanceMarketCollectionItem[],
) {
  const from = dateMs(request.fromDate);
  const to = dateMs(request.toDate);
  const crypto = ["crypto", "cryptocurrency"].includes(request.assetClass.toLowerCase());
  const equity = ["common_stock", "equity", "stock", "us_equity"].includes(
    request.assetClass.toLowerCase(),
  );
  if (
    !Number.isFinite(from) ||
    !Number.isFinite(to) ||
    from > to ||
    to - from > 3 * 366 * dayMs ||
    (!crypto && !equity)
  ) {
    return {
      status: "unverified" as const,
      gaps: ["historical_window_coverage_unverified"],
      expectedDays: 0,
      providers: [],
    };
  }
  // Include only fully completed prior calendar dates; no intraday bar is a final close.
  const asOfDay = dateMs(request.asOf.slice(0, 10));
  if (!Number.isFinite(asOfDay) || to >= asOfDay) {
    return {
      status: "unverified" as const,
      gaps: ["historical_window_contains_unfinished_day"],
      expectedDays: 0,
      providers: [],
    };
  }
  const expected: string[] = [];
  for (let time = from; time <= to; time += dayMs) {
    const date = new Date(time);
    const label = date.toISOString().slice(0, 10);
    if (equity && !holidays[label.slice(0, 4)]) {
      return {
        status: "unverified" as const,
        gaps: ["historical_calendar_year_unverified"],
        expectedDays: 0,
        providers: [],
      };
    }
    if (
      crypto ||
      (date.getUTCDay() !== 0 &&
        date.getUTCDay() !== 6 &&
        !holidays[label.slice(0, 4)].includes(label.slice(5)))
    ) {
      expected.push(label);
    }
  }
  const groups = new Map<string, FinanceMarketCollectionItem[]>();
  for (const row of records) {
    const group = groups.get(row.providerName) ?? [];
    group.push(row);
    groups.set(row.providerName, group);
  }
  const providers = [...groups].map(([provider, rows]) => {
    const dates = new Set<string>();
    const invalid: string[] = [];
    for (const row of rows) {
      const date = typeof row.data.date === "string" ? row.data.date : "";
      const close = row.data.close;
      if (
        !Number.isFinite(dateMs(date)) ||
        !expected.includes(date) ||
        typeof close !== "number" ||
        !Number.isFinite(close) ||
        close <= 0 ||
        dates.has(date)
      ) {
        invalid.push(row.itemId);
      } else {
        dates.add(date);
      }
    }
    const missing = expected.filter((date) => !dates.has(date));
    return {
      provider,
      coveredDays: dates.size,
      missing,
      invalid,
      complete: expected.length > 0 && missing.length === 0 && invalid.length === 0,
    };
  });
  const complete = providers.length > 0 && providers.every((provider) => provider.complete);
  return {
    status: complete ? ("complete" as const) : ("incomplete" as const),
    gaps: complete ? [] : ["historical_window_coverage_incomplete"],
    expectedDays: expected.length,
    providers,
  };
}
