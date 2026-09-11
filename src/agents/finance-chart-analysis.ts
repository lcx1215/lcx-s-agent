export const FINANCE_CHART_ANALYSIS_SCHEMA_VERSION = "lcx_finance_chart_analysis_v1" as const;

export type FinanceChartBar = Readonly<{
  timestamp: string;
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}>;

export type FinanceChartAnalysis = Readonly<{
  schemaVersion: typeof FINANCE_CHART_ANALYSIS_SCHEMA_VERSION;
  boundary: "finance_chart_analysis_research_only";
  observationCount: number;
  firstDate: string;
  lastDate: string;
  features: Readonly<{
    firstClose: number;
    lastClose: number;
    totalReturnPct: number;
    maxDrawdownPct: number;
    trendDirection: "up" | "down" | "range";
    slopePerBar: number;
    volatilityPct?: number;
    sma20?: number;
    sma50?: number;
    sma200?: number;
    rsi14?: number;
    atr14?: number;
    support20?: number;
    resistance20?: number;
    closeToSma20Pct?: number;
    recentVolumeRatio?: number;
  }>;
  observations: readonly string[];
  limitations: readonly string[];
}>;

export type FinanceChartRecord = Readonly<{
  sourceTimestamp?: unknown;
  data?: Readonly<Record<string, unknown>>;
  [key: string]: unknown;
}>;

export type FinanceChartBarNormalization = Readonly<{
  bars: readonly FinanceChartBar[];
  droppedCount: number;
}>;

function finiteNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeTimestamp(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value > 10_000_000_000 ? value : value * 1_000;
    const timestamp = new Date(milliseconds);
    return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : undefined;
  }
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function readField(record: FinanceChartRecord, key: string): unknown {
  if (record.data && Object.hasOwn(record.data, key)) {
    return record.data[key];
  }
  return record[key];
}

function normalizeRecord(record: FinanceChartRecord): FinanceChartBar | undefined {
  const timestamp = normalizeTimestamp(
    record.sourceTimestamp ?? readField(record, "timestamp") ?? readField(record, "date"),
  );
  const date = timestamp?.slice(0, 10);
  const open = finiteNumber(readField(record, "open"));
  const high = finiteNumber(readField(record, "high"));
  const low = finiteNumber(readField(record, "low"));
  const close = finiteNumber(readField(record, "close"));
  if (
    !timestamp ||
    !date ||
    open === undefined ||
    high === undefined ||
    low === undefined ||
    close === undefined ||
    open <= 0 ||
    high <= 0 ||
    low <= 0 ||
    close <= 0 ||
    high < low ||
    high < Math.max(open, close) ||
    low > Math.min(open, close)
  ) {
    return undefined;
  }
  const volume = finiteNumber(readField(record, "volume"));
  return {
    timestamp,
    date,
    open,
    high,
    low,
    close,
    ...(volume !== undefined && volume >= 0 ? { volume } : {}),
  };
}

function sourceKey(record: FinanceChartRecord): string {
  const providerName = record.providerName;
  if (typeof providerName === "string" && providerName.trim()) {
    return `provider:${providerName.trim().toLowerCase()}`;
  }
  const sourceUrlOrArtifact = record.sourceUrlOrArtifact;
  if (typeof sourceUrlOrArtifact === "string" && sourceUrlOrArtifact.trim()) {
    return `source:${sourceUrlOrArtifact.trim()}`;
  }
  return "unattributed";
}

export function normalizeFinanceChartBars(
  records: readonly FinanceChartRecord[],
): FinanceChartBarNormalization {
  const byDate = new Map<string, FinanceChartBar>();
  let droppedCount = 0;
  let selectedSourceKey: string | undefined;
  for (const record of records) {
    const normalized = normalizeRecord(record);
    if (!normalized) {
      droppedCount += 1;
      continue;
    }
    const currentSourceKey = sourceKey(record);
    if (selectedSourceKey === undefined) {
      selectedSourceKey = currentSourceKey;
    } else if (currentSourceKey !== selectedSourceKey) {
      // Do not silently stitch overlapping bars from different providers.
      droppedCount += 1;
      continue;
    }
    byDate.set(normalized.date, normalized);
  }
  const bars = [...byDate.values()].toSorted((left, right) =>
    left.timestamp.localeCompare(right.timestamp),
  );
  return { bars, droppedCount };
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sampleStdDev(values: readonly number[]): number {
  if (values.length < 2) {
    return 0;
  }
  const average = mean(values);
  return Math.sqrt(
    values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1),
  );
}

function simpleMovingAverage(values: readonly number[], period: number): number | undefined {
  if (values.length < period) {
    return undefined;
  }
  return mean(values.slice(-period));
}

function linearSlope(values: readonly number[]): number {
  if (values.length < 2) {
    return 0;
  }
  const xMean = (values.length - 1) / 2;
  const yMean = mean(values);
  let numerator = 0;
  let denominator = 0;
  values.forEach((value, index) => {
    const xDelta = index - xMean;
    numerator += xDelta * (value - yMean);
    denominator += xDelta ** 2;
  });
  return denominator === 0 ? 0 : numerator / denominator;
}

function maxDrawdownPct(closes: readonly number[]): number {
  let peak = closes[0] ?? 0;
  let maximum = 0;
  for (const close of closes) {
    peak = Math.max(peak, close);
    if (peak > 0) {
      maximum = Math.min(maximum, ((close - peak) / peak) * 100);
    }
  }
  return maximum;
}

function rsi14(closes: readonly number[], period = 14): number | undefined {
  if (closes.length <= period) {
    return undefined;
  }
  const changes = closes.slice(1).map((close, index) => close - (closes[index] ?? close));
  const recent = changes.slice(-period);
  const gains = recent.filter((change) => change > 0);
  const losses = recent.filter((change) => change < 0).map((change) => Math.abs(change));
  const averageGain = gains.reduce((sum, value) => sum + value, 0) / period;
  const averageLoss = losses.reduce((sum, value) => sum + value, 0) / period;
  if (averageLoss === 0) {
    return averageGain === 0 ? 50 : 100;
  }
  return 100 - 100 / (1 + averageGain / averageLoss);
}

function atr14(bars: readonly FinanceChartBar[], period = 14): number | undefined {
  if (bars.length <= period) {
    return undefined;
  }
  const ranges: number[] = [];
  for (let index = 1; index < bars.length; index += 1) {
    const bar = bars[index];
    const previous = bars[index - 1];
    if (!bar || !previous) {
      continue;
    }
    ranges.push(
      Math.max(
        bar.high - bar.low,
        Math.abs(bar.high - previous.close),
        Math.abs(bar.low - previous.close),
      ),
    );
  }
  return ranges.length < period ? undefined : mean(ranges.slice(-period));
}

function recentVolumeRatio(bars: readonly FinanceChartBar[], period = 20): number | undefined {
  if (bars.length < period * 2) {
    return undefined;
  }
  const volumes = bars.map((bar) => bar.volume);
  if (volumes.some((volume) => volume === undefined)) {
    return undefined;
  }
  const recent = mean(volumes.slice(-period) as number[]);
  const prior = mean(volumes.slice(-period * 2, -period) as number[]);
  return prior === 0 ? undefined : recent / prior;
}

function formatNumber(value: number): string {
  return value.toFixed(2);
}

export function analyzeFinanceChartBars(
  instrument: string,
  bars: readonly FinanceChartBar[],
  options: { droppedCount?: number } = {},
): FinanceChartAnalysis {
  if (bars.length < 2) {
    throw new Error("at least 2 valid OHLC bars are required for chart analysis");
  }
  const closes = bars.map((bar) => bar.close);
  const firstClose = closes[0] ?? 0;
  const lastClose = closes.at(-1) ?? 0;
  const totalReturnPct = firstClose === 0 ? 0 : (lastClose / firstClose - 1) * 100;
  const slopePerBar = linearSlope(closes);
  const recentWindow = closes.slice(-Math.min(20, closes.length));
  const recentBars = bars.slice(-Math.min(20, bars.length));
  const support20 = Math.min(...recentBars.map((bar) => bar.low));
  const resistance20 = Math.max(...recentBars.map((bar) => bar.high));
  const sma20 = simpleMovingAverage(closes, 20);
  const volatilityPct =
    closes.length < 2
      ? undefined
      : sampleStdDev(
          closes.slice(1).map((close, index) => (close / (closes[index] ?? close) - 1) * 100),
        );
  const features = {
    firstClose,
    lastClose,
    totalReturnPct,
    maxDrawdownPct: maxDrawdownPct(closes),
    trendDirection:
      totalReturnPct > 1 && slopePerBar > 0
        ? ("up" as const)
        : totalReturnPct < -1 && slopePerBar < 0
          ? ("down" as const)
          : ("range" as const),
    slopePerBar,
    ...(volatilityPct === undefined ? {} : { volatilityPct }),
    ...(sma20 === undefined ? {} : { sma20 }),
    ...(simpleMovingAverage(closes, 50) === undefined
      ? {}
      : { sma50: simpleMovingAverage(closes, 50) }),
    ...(simpleMovingAverage(closes, 200) === undefined
      ? {}
      : { sma200: simpleMovingAverage(closes, 200) }),
    ...(rsi14(closes) === undefined ? {} : { rsi14: rsi14(closes) }),
    ...(atr14(bars) === undefined ? {} : { atr14: atr14(bars) }),
    support20,
    resistance20,
    ...(sma20 === undefined ? {} : { closeToSma20Pct: (lastClose / sma20 - 1) * 100 }),
    ...(recentVolumeRatio(bars) === undefined
      ? {}
      : { recentVolumeRatio: recentVolumeRatio(bars) }),
  };
  const observations = [
    `${instrument} ${features.trendDirection} structure over ${bars.length} observations; total return ${formatNumber(totalReturnPct)}%.`,
    `Recent ${recentWindow.length}-bar range is ${formatNumber(Math.min(...recentWindow))} to ${formatNumber(Math.max(...recentWindow))}.`,
    `Observed maximum close-to-peak drawdown is ${formatNumber(features.maxDrawdownPct)}%.`,
    ...(features.sma20 === undefined
      ? ["SMA20 unavailable because the sample is shorter than 20 bars."]
      : [`Last close is ${formatNumber(features.closeToSma20Pct ?? 0)}% relative to SMA20.`]),
    ...(features.rsi14 === undefined
      ? ["RSI14 unavailable because the sample is shorter than 15 bars."]
      : [
          `RSI14 is ${formatNumber(features.rsi14)}; this is a momentum observation, not a trade signal.`,
        ]),
    ...(features.recentVolumeRatio === undefined
      ? ["Recent volume ratio unavailable because two complete 20-bar volume windows are required."]
      : [
          `Recent 20-bar volume is ${formatNumber(features.recentVolumeRatio)}x the preceding 20-bar average.`,
        ]),
  ];
  const limitations = [
    "This is deterministic OHLCV analysis for research context, not an order, position-size, or buy/sell instruction.",
    "EOD or delayed source timing must be read from the attached source receipt; it is not execution-grade realtime data.",
    "Pixel-only chart annotations, drawing tools, news labels, and visual patterns are not inferred by this numeric path.",
    ...(options.droppedCount
      ? [`${options.droppedCount} incomplete or invalid input rows were dropped.`]
      : []),
  ];
  return {
    schemaVersion: FINANCE_CHART_ANALYSIS_SCHEMA_VERSION,
    boundary: "finance_chart_analysis_research_only",
    observationCount: bars.length,
    firstDate: bars[0]?.date ?? "",
    lastDate: bars.at(-1)?.date ?? "",
    features,
    observations,
    limitations,
  };
}
