import type {
  FinanceMarketCollectionItem,
  FinanceMarketCollectionRequest,
} from "./finance-market-collection-registry.js";

// Published exchange calendar; unknown years remain unverified, never guessed.
// https://www.nyse.com/trade/hours-calendars (verified 2026-09-08)
// 2025 dates: https://www.nyse.com/publicdocs/ICE_NYSE_2025_Yearly_Trading_Calendar.pdf
const holidays: Record<string, readonly string[]> = {
  "2025": [
    "01-01",
    // National Day of Mourning: NYSE regulatory memo RM-25-01 (2025-01-02).
    "01-09",
    "01-20",
    "02-17",
    "04-18",
    "05-26",
    "06-19",
    "07-04",
    "09-01",
    "11-27",
    "12-25",
  ],
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

/** Undefined means the date or published calendar year is unverified. */
export function isFinanceUsEquitySessionDate(date: string): boolean | undefined {
  const time = dateMs(date);
  const closures = holidays[date.slice(0, 4)];
  if (!Number.isFinite(time) || !closures) {
    return undefined;
  }
  const weekday = new Date(time).getUTCDay();
  return weekday !== 0 && weekday !== 6 && !closures.includes(date.slice(5));
}

// Published 13:00 ET cash-equity closes from the same NYSE calendars above.
const earlyCloses: Record<string, readonly string[]> = {
  "2025": ["07-03", "11-28", "12-24"],
  "2026": ["11-27", "12-24"],
  "2027": ["11-26"],
  "2028": ["07-03", "11-24"],
};

/** Offline verified cash-equity bounds; closures and unknown years are not sessions. */
export function financeUsEquitySessionBounds(date: string):
  | {
      openMinute: number;
      closeMinute: number;
    }
  | undefined {
  if (isFinanceUsEquitySessionDate(date) !== true) {
    return undefined;
  }
  return {
    openMinute: 570,
    closeMinute: earlyCloses[date.slice(0, 4)]?.includes(date.slice(5)) ? 780 : 960,
  };
}

function isUsHistorySymbol(instrument: string): boolean {
  const symbol = instrument.trim().toUpperCase();
  if (symbol.startsWith("US.")) {
    return /^[A-Z][A-Z0-9]*(?:[.-][A-Z])?$/u.test(symbol.slice(3));
  }
  // Keep native tickers and common US share classes; a global suffix is no US calendar authority.
  return /^[A-Z][A-Z0-9]*(?:-[A-Z]|\.[AB])?$/u.test(symbol);
}

/** Calendar completeness is separate from freshness and cross-source price agreement. */
export function assessFinanceHistoryCoverage(
  request: FinanceMarketCollectionRequest,
  records: readonly FinanceMarketCollectionItem[],
) {
  const from = dateMs(request.fromDate);
  const to = dateMs(request.toDate);
  const crypto = ["crypto", "cryptocurrency"].includes(request.assetClass.toLowerCase());
  const equity =
    ["common_stock", "equity", "stock", "us_equity"].includes(request.assetClass.toLowerCase()) &&
    isUsHistorySymbol(request.instrument);
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
    const equitySession = equity ? isFinanceUsEquitySessionDate(label) : undefined;
    if (equity && equitySession === undefined) {
      return {
        status: "unverified" as const,
        gaps: ["historical_calendar_year_unverified"],
        expectedDays: 0,
        providers: [],
      };
    }
    if (crypto || equitySession) {
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
