#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  runFinanceMarketCollectionRefresh,
  createYahooPublicEodHistoryCollectionAdapter,
  type FinanceMarketCollectionItem,
} from "../../src/agents/finance-market-collection-registry.ts";
import { buildFinanceStrategyMethodKit } from "../../src/agents/finance-strategy-method-kit.ts";

type PriceRow = Readonly<{ date: string; close: number; sourceTimestamp: string }>;
type MethodName = "buy_hold" | "trend_breadth_gate";
type Metric = Readonly<{
  totalReturn: number;
  cagr: number;
  volatility: number;
  maxDrawdown: number;
  turnover: number;
  worstDailyReturn: number;
  observations: number;
}>;
type EvaluatedSeries = Readonly<{
  dailyReturns: readonly number[];
  positions: readonly number[];
  metric: Metric;
}>;

type PeriodMetric = Readonly<{ window: string; metric: Metric }>;

type StressVariant = Readonly<{
  lookback: number;
  costBps: number;
  breadth: number;
}>;

type StressVariantResult = Readonly<
  StressVariant & {
    baseline: Metric;
    enriched: Metric;
    baselinePeriods: readonly PeriodMetric[];
    enrichedPeriods: readonly PeriodMetric[];
    cagrDeltaPp: number;
    maxDrawdownDeltaPp: number;
    totalReturnDeltaPp: number;
  }
>;

const DEFAULT_SYMBOLS = ["SPY", "QQQ", "IWM", "AAPL", "MSFT", "NVDA"] as const;
const DEFAULT_LOOKBACK = 200;
const DEFAULT_COST_BPS = 15;
const DEFAULT_BREADTH = 0.5;
const STRESS_LOOKBACKS = Object.freeze([100, 150, 200, 250] as const);
const STRESS_COSTS_BPS = Object.freeze([0, 15, 30, 60] as const);
const STRESS_BREADTHS = Object.freeze([0.4, 0.5, 0.6] as const);

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function parseDate(value: string, label: string): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`${label} must be an ISO timestamp or YYYY-MM-DD`);
  }
  return date;
}

function parseOptions(args: readonly string[]) {
  const asOf = parseDate(valueAfter(args, "--as-of") ?? new Date().toISOString(), "--as-of");
  const toDate = valueAfter(args, "--to-date") ?? isoDate(new Date(asOf.getTime() - 86_400_000));
  const fromDateValue = valueAfter(args, "--from-date");
  const fromDate = fromDateValue
    ? parseDate(fromDateValue, "--from-date")
    : new Date(asOf.getTime());
  if (!fromDateValue) {
    fromDate.setUTCFullYear(fromDate.getUTCFullYear() - 3);
  }
  const symbols = [
    ...new Set(
      (valueAfter(args, "--symbols") ?? DEFAULT_SYMBOLS.join(","))
        .split(",")
        .map((value) => value.trim().toUpperCase())
        .filter(Boolean),
    ),
  ];
  const lookback = Number(valueAfter(args, "--lookback") ?? DEFAULT_LOOKBACK);
  const costBps = Number(valueAfter(args, "--cost-bps") ?? DEFAULT_COST_BPS);
  const breadth = Number(valueAfter(args, "--breadth") ?? DEFAULT_BREADTH);
  if (symbols.length < 3) {
    throw new Error("--symbols must contain at least three instruments");
  }
  if (!Number.isInteger(lookback) || lookback < 20) {
    throw new Error("--lookback must be an integer >= 20");
  }
  if (!Number.isFinite(costBps) || costBps < 0 || costBps > 500) {
    throw new Error("--cost-bps must be in [0,500]");
  }
  if (!Number.isFinite(breadth) || breadth <= 0 || breadth > 1) {
    throw new Error("--breadth must be in (0,1]");
  }
  if (fromDate >= parseDate(toDate, "--to-date")) {
    throw new Error("from date must be before to date");
  }
  return {
    asOf: asOf.toISOString(),
    fromDate: isoDate(fromDate),
    toDate,
    symbols: Object.freeze(symbols),
    lookback,
    costBps,
    breadth,
    stress: args.includes("--stress"),
    out: valueAfter(args, "--out"),
  } as const;
}

function numberField(item: FinanceMarketCollectionItem, field: string): number | undefined {
  const value = item.data[field];
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function rowsFromItems(items: readonly FinanceMarketCollectionItem[]): PriceRow[] {
  return items
    .map((item) => {
      const date =
        typeof item.data.date === "string" ? item.data.date : item.sourceTimestamp.slice(0, 10);
      const close = numberField(item, "close");
      return close === undefined ? null : { date, close, sourceTimestamp: item.sourceTimestamp };
    })
    .filter((row): row is PriceRow => row !== null)
    .toSorted((left, right) => left.date.localeCompare(right.date));
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stdev(values: readonly number[]): number {
  if (values.length < 2) {
    return 0;
  }
  const average = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
}

function summarize(dailyReturns: readonly number[], positions: readonly number[]): Metric {
  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;
  for (const dailyReturn of dailyReturns) {
    equity *= 1 + dailyReturn;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.min(maxDrawdown, equity / peak - 1);
  }
  const years = dailyReturns.length / 252;
  const turnoverPositions = positions.at(-1) === 1 ? [...positions, 0] : positions;
  const turnover = turnoverPositions
    .slice(1)
    .reduce((sum, position, index) => sum + Math.abs(position - positions[index]), 0);
  return {
    totalReturn: equity - 1,
    cagr: years > 0 && equity > 0 ? equity ** (1 / years) - 1 : -1,
    volatility: stdev(dailyReturns) * Math.sqrt(252),
    maxDrawdown,
    turnover,
    worstDailyReturn: dailyReturns.length ? Math.min(...dailyReturns) : 0,
    observations: dailyReturns.length,
  };
}

function evaluateSeries(
  symbol: string,
  rowsBySymbol: Readonly<Record<string, readonly PriceRow[]>>,
  dates: readonly string[],
  lookback: number,
  breadthThreshold: number,
  costRate: number,
  method: MethodName,
): EvaluatedSeries {
  const rows = rowsBySymbol[symbol];
  if (!rows || rows.length !== dates.length) {
    throw new Error(`aligned rows missing for ${symbol}`);
  }
  const closes = rows.map((row) => row.close);
  const breadth: boolean[] = dates.map((_date, index) => {
    if (index + 1 < lookback) {
      return false;
    }
    const above = Object.values(rowsBySymbol).filter((series) => {
      const close = series[index]?.close;
      if (close === undefined) {
        return false;
      }
      const window = series.slice(index - lookback + 1, index + 1).map((row) => row.close);
      return close > mean(window);
    }).length;
    return above / Object.keys(rowsBySymbol).length >= breadthThreshold;
  });
  const dailyReturns: number[] = [];
  const positions: number[] = [0];
  for (let index = 1; index < closes.length; index += 1) {
    // A signal formed at close t is first tradable on the following session;
    // with close-only data, apply it to the next complete close-to-close bar.
    const signalIndex = index - 2;
    const trend =
      signalIndex >= 0 &&
      signalIndex + 1 >= lookback &&
      closes[signalIndex] > mean(closes.slice(signalIndex - lookback + 1, signalIndex + 1));
    const position =
      method === "buy_hold" ? 1 : signalIndex >= 0 && trend && breadth[signalIndex] ? 1 : 0;
    const previousPosition = positions[index - 1] ?? 0;
    const grossReturn = closes[index] / closes[index - 1] - 1;
    const transactionCost = Math.abs(position - previousPosition) * costRate;
    dailyReturns.push(position * grossReturn - transactionCost);
    positions.push(position);
  }
  if (positions.at(-1) === 1) {
    dailyReturns[dailyReturns.length - 1] = (dailyReturns.at(-1) ?? 0) - costRate;
  }
  return { dailyReturns, positions, metric: summarize(dailyReturns, positions) };
}

function aggregateSeries(series: readonly EvaluatedSeries[]): EvaluatedSeries {
  const dailyReturns = Array.from({ length: series[0]?.dailyReturns.length ?? 0 }, (_, index) =>
    mean(series.map((item) => item.dailyReturns[index] ?? 0)),
  );
  const positions = Array.from({ length: series[0]?.positions.length ?? 0 }, (_, index) =>
    mean(series.map((item) => item.positions[index] ?? 0)),
  );
  return { dailyReturns, positions, metric: summarize(dailyReturns, positions) };
}

function periodMetrics(
  series: EvaluatedSeries,
  dates: readonly string[],
): readonly Readonly<{ window: string; metric: Metric }>[] {
  const periods = [
    [dates[0], dates[Math.floor(dates.length / 3) - 1]],
    [dates[Math.floor(dates.length / 3)], dates[Math.floor((2 * dates.length) / 3) - 1]],
    [dates[Math.floor((2 * dates.length) / 3)], dates.at(-1)],
  ] as const;
  return periods.map(([start, end], periodIndex) => {
    const from = periodIndex === 0 ? 0 : Math.floor((periodIndex * dates.length) / 3) - 1;
    const to =
      periodIndex === 2
        ? series.dailyReturns.length
        : Math.floor(((periodIndex + 1) * dates.length) / 3) - 1;
    return {
      window: `${start}..${end}`,
      metric: summarize(
        series.dailyReturns.slice(Math.max(0, from), to),
        series.positions.slice(Math.max(0, from), to + 1),
      ),
    };
  });
}

export function buildStressVariants(): readonly StressVariant[] {
  return Object.freeze(
    STRESS_LOOKBACKS.flatMap((lookback) =>
      STRESS_COSTS_BPS.flatMap((costBps) =>
        STRESS_BREADTHS.map((breadth) => Object.freeze({ lookback, costBps, breadth })),
      ),
    ),
  );
}

function medianValue(values: readonly number[]): number {
  const sorted = values.toSorted((a, b) => a - b);
  if (sorted.length === 0) {
    return 0;
  }
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function evaluateStressMatrix(
  rowsBySymbol: Readonly<Record<string, readonly PriceRow[]>>,
  dates: readonly string[],
): Readonly<{
  variants: readonly StressVariantResult[];
  summary: Readonly<{
    variantCount: number;
    cagrOutperformanceCount: number;
    drawdownImprovementCount: number;
    bothCagrAndDrawdownCount: number;
    minCagrDeltaPp: number;
    medianCagrDeltaPp: number;
    maxCagrDeltaPp: number;
    minMaxDrawdownDeltaPp: number;
    maxMaxDrawdownDeltaPp: number;
  }>;
}> {
  const variants = buildStressVariants();
  const results = variants.map((variant) => {
    const costRate = variant.costBps / 10_000;
    const evaluated = Object.fromEntries(
      ["buy_hold", "trend_breadth_gate"].map((method) => [
        method,
        aggregateSeries(
          Object.keys(rowsBySymbol).map((symbol) =>
            evaluateSeries(
              symbol,
              rowsBySymbol,
              dates,
              variant.lookback,
              variant.breadth,
              costRate,
              method as MethodName,
            ),
          ),
        ),
      ]),
    ) as Record<MethodName, EvaluatedSeries>;
    const baseline = evaluated.buy_hold.metric;
    const enriched = evaluated.trend_breadth_gate.metric;
    return Object.freeze({
      ...variant,
      baseline,
      enriched,
      baselinePeriods: periodMetrics(evaluated.buy_hold, dates),
      enrichedPeriods: periodMetrics(evaluated.trend_breadth_gate, dates),
      cagrDeltaPp: (enriched.cagr - baseline.cagr) * 100,
      maxDrawdownDeltaPp: (enriched.maxDrawdown - baseline.maxDrawdown) * 100,
      totalReturnDeltaPp: (enriched.totalReturn - baseline.totalReturn) * 100,
    });
  });
  const cagrDeltas = results.map((result) => result.cagrDeltaPp).toSorted((a, b) => a - b);
  const drawdownDeltas = results
    .map((result) => result.maxDrawdownDeltaPp)
    .toSorted((a, b) => a - b);
  const median = medianValue(cagrDeltas);
  return Object.freeze({
    variants: Object.freeze(results),
    summary: Object.freeze({
      variantCount: results.length,
      cagrOutperformanceCount: results.filter((result) => result.cagrDeltaPp > 0).length,
      drawdownImprovementCount: results.filter((result) => result.maxDrawdownDeltaPp > 0).length,
      bothCagrAndDrawdownCount: results.filter(
        (result) => result.cagrDeltaPp > 0 && result.maxDrawdownDeltaPp > 0,
      ).length,
      minCagrDeltaPp: cagrDeltas[0] ?? 0,
      medianCagrDeltaPp: median,
      maxCagrDeltaPp: cagrDeltas.at(-1) ?? 0,
      minMaxDrawdownDeltaPp: drawdownDeltas[0] ?? 0,
      maxMaxDrawdownDeltaPp: drawdownDeltas.at(-1) ?? 0,
    }),
  });
}

async function collectSymbol(symbol: string, options: ReturnType<typeof parseOptions>) {
  // The canonical collection contract caps one request at 250 rows. A
  // 300-calendar-day equity chunk is below that cap even after exchange
  // holidays are accounted for, and each response is checked for truncation.
  const chunkCalendarDays = 300;
  const start = parseDate(options.fromDate, "--from-date");
  let end = parseDate(options.toDate, "--to-date");
  const receipts = [];
  const records: FinanceMarketCollectionItem[] = [];
  const seenDates = new Set<string>();
  while (end >= start) {
    const chunkStart = new Date(
      Math.max(start.getTime(), end.getTime() - chunkCalendarDays * 86_400_000),
    );
    const receipt = await runFinanceMarketCollectionRefresh({
      request: {
        instrument: symbol,
        assetClass: "us_equity",
        collection: "eod_history",
        asOf: options.asOf,
        fromDate: isoDate(chunkStart),
        toDate: isoDate(end),
        limit: 250,
      },
      adapters: [createYahooPublicEodHistoryCollectionAdapter()],
      maxSources: 1,
      timeoutMs: 30_000,
    });
    if (receipt.records.length >= 250) {
      throw new Error(
        `${symbol} source chunk reached the provider row cap; refusing incomplete historical coverage`,
      );
    }
    receipts.push(receipt);
    for (const record of receipt.records) {
      const date = typeof record.data.date === "string" ? record.data.date : record.itemId;
      if (!seenDates.has(date)) {
        seenDates.add(date);
        records.push(record);
      }
    }
    end = new Date(chunkStart.getTime() - 86_400_000);
  }
  const rows = rowsFromItems(records);
  if (
    receipts.some((receipt) => receipt.status !== "ready") ||
    rows.length < options.lookback + 20
  ) {
    const statuses = receipts
      .map((receipt) => `${receipt.status}:${receipt.records.length}`)
      .join(",");
    throw new Error(`${symbol} source chunks=${statuses} combinedRecords=${rows.length}`);
  }
  return { receipts, rows };
}

export async function runBenchmark(args: readonly string[] = process.argv.slice(2)) {
  const options = parseOptions(args);
  const collected = await Promise.all(
    options.symbols.map((symbol) => collectSymbol(symbol, options)),
  );
  const dateSets = collected.map(({ rows }) => new Set(rows.map((row) => row.date)));
  const dates =
    collected[0]?.rows
      .map((row) => row.date)
      .filter((date) => dateSets.every((set) => set.has(date))) ?? [];
  if (dates.length < options.lookback + 30) {
    throw new Error(`aligned observations=${dates.length} is below the minimum`);
  }
  const rowsBySymbol: Record<string, readonly PriceRow[]> = {};
  for (const [index, symbol] of options.symbols.entries()) {
    const byDate = new Map(collected[index]?.rows.map((row) => [row.date, row]));
    rowsBySymbol[symbol] = dates
      .map((date) => byDate.get(date))
      .filter((row): row is PriceRow => row !== undefined);
  }
  const costRate = options.costBps / 10_000;
  const methods = Object.freeze(["buy_hold", "trend_breadth_gate"] as const);
  const evaluated = Object.fromEntries(
    methods.map((method) => [
      method,
      Object.fromEntries(
        options.symbols.map((symbol) => [
          symbol,
          evaluateSeries(
            symbol,
            rowsBySymbol,
            dates,
            options.lookback,
            options.breadth,
            costRate,
            method,
          ),
        ]),
      ),
    ]),
  ) as Record<MethodName, Record<string, EvaluatedSeries>>;
  const portfolio = Object.fromEntries(
    methods.map((method) => [method, aggregateSeries(Object.values(evaluated[method]))]),
  ) as Record<MethodName, EvaluatedSeries>;
  const comparisons = Object.fromEntries(
    options.symbols.map((symbol) => {
      const baseline = evaluated.buy_hold[symbol]?.metric;
      const enriched = evaluated.trend_breadth_gate[symbol]?.metric;
      return [
        symbol,
        {
          baseline,
          enriched,
          cagrDeltaPp: ((enriched?.cagr ?? 0) - (baseline?.cagr ?? 0)) * 100,
          maxDrawdownDeltaPp: ((enriched?.maxDrawdown ?? 0) - (baseline?.maxDrawdown ?? 0)) * 100,
        },
      ];
    }),
  );
  const receipt = {
    schemaVersion: "lcx_finance_strategy_method_benchmark_v1",
    status: "completed",
    boundary: "research_only_no_execution",
    methodKit: buildFinanceStrategyMethodKit("backtest 3-year US equity method benchmark"),
    data: {
      source: "yahoo_public_eod_history",
      sourceRole: "primary_market_data",
      asOf: options.asOf,
      fromDate: dates[0],
      toDate: dates.at(-1),
      symbols: options.symbols,
      alignedObservations: dates.length,
      sourceReceipts: collected.map(({ receipts, rows }, index) => ({
        symbol: options.symbols[index],
        status: receipts.every((receipt) => receipt.status === "ready") ? "ready" : "needs_review",
        recordCount: rows.length,
        chunks: receipts.map((receipt) => ({
          fromDate: receipt.request.fromDate,
          toDate: receipt.request.toDate,
          status: receipt.status,
          recordCount: receipt.records.length,
          sourceAttempts: receipt.sourceAttempts,
        })),
        firstSourceTimestamp: rows[0]?.sourceTimestamp,
        lastSourceTimestamp: rows.at(-1)?.sourceTimestamp,
      })),
      priceField: "unadjusted close; dividends are not included by this adapter",
    },
    frozenRule: {
      lookbackSessions: options.lookback,
      breadthThreshold: options.breadth,
      transactionCostBpsPerTurn: options.costBps,
      signalTiming: "decision from prior completed close, return starts next session",
      baseline: "same-universe buy-and-hold with same entry/exit costs",
    },
    portfolio: Object.fromEntries(
      methods.map((method) => [
        method,
        { metric: portfolio[method].metric, periods: periodMetrics(portfolio[method], dates) },
      ]),
    ),
    comparisons,
    ...(options.stress ? { stressMatrix: evaluateStressMatrix(rowsBySymbol, dates) } : {}),
    checks: {
      realSourceReceipts: true,
      allSourcesReady: true,
      noLookaheadSignalTiming: true,
      sameCostBaseline: true,
      threeNonOverlappingPeriods: true,
      commonExposureBreadthGate: true,
      modelLearningClaim: "not_claimed",
      profitClaim: "not_claimed",
    },
  } as const;
  if (options.out) {
    await fs.writeFile(path.resolve(options.out), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  }
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runBenchmark()
    .then((receipt) => process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(
        `finance_strategy_method_benchmark_blocked: ${(error as Error).message}\n`,
      );
      process.exitCode = 1;
    });
}

export const __test = { evaluateSeries, summarize, periodMetrics, parseOptions, medianValue };
