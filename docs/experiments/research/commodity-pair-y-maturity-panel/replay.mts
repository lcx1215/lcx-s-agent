import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  diagnosePairSpread,
  replayPairSpreadReversion,
  type PairSpreadObservation,
  type PairSpreadReplayContract,
} from "../../../../src/agents/quant-math-pair-spread.js";

type Bar = {
  date: string;
  symbol: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  openInterest: number;
  settle: number;
};

const here = fileURLToPath(new URL(".", import.meta.url));
const input = readFileSync(join(here, "input.csv"), "utf8");
const capture = JSON.parse(readFileSync(join(here, "capture.json"), "utf8")) as {
  capturedAtUtc: string;
  csvSha256: string;
  csvBytes: number;
  rowCount: number;
  series: Record<string, { rawRows: number; firstDate: string; lastDate: string; sha256: string }>;
};
const actualSha = createHash("sha256").update(input).digest("hex");
if (actualSha !== capture.csvSha256) {
  throw new Error(`input.csv SHA-256 mismatch: expected ${capture.csvSha256}, got ${actualSha}`);
}
if (Buffer.byteLength(input) !== capture.csvBytes) {
  throw new Error(
    `input.csv size mismatch: expected ${capture.csvBytes}, got ${Buffer.byteLength(input)}`,
  );
}

const [headerLine, ...lines] = input.trim().split(/\r?\n/u);
if (!headerLine) {
  throw new Error("input.csv is empty");
}
const headers = headerLine.split(",");
const expectedHeaders = [
  "date",
  "symbol",
  "open",
  "high",
  "low",
  "close",
  "volume",
  "open_interest",
  "settle",
];
if (headers.join("|") !== expectedHeaders.join("|")) {
  throw new Error("input.csv headers differ from the capture contract");
}
const bars = lines.map((line, index) => {
  const cells = line.split(",");
  if (cells.length !== headers.length) {
    throw new Error(`CSV row ${index + 2} has ${cells.length} fields; expected ${headers.length}`);
  }
  const row = Object.fromEntries(headers.map((name, cellIndex) => [name, cells[cellIndex]]));
  const bar: Bar = {
    date: row.date,
    symbol: row.symbol,
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: Number(row.volume),
    openInterest: Number(row.open_interest),
    settle: Number(row.settle),
  };
  if (
    !/^\d{4}-\d{2}-\d{2}$/u.test(bar.date) ||
    !bar.symbol ||
    [bar.open, bar.high, bar.low, bar.close, bar.volume, bar.openInterest, bar.settle].some(
      (value) => !Number.isFinite(value),
    )
  ) {
    throw new Error(`CSV row ${index + 2} has invalid fields`);
  }
  if (
    bar.low > Math.min(bar.open, bar.close) ||
    bar.high < Math.max(bar.open, bar.close) ||
    bar.low > bar.high ||
    bar.volume < 0 ||
    bar.openInterest < 0
  ) {
    throw new Error(`CSV row ${index + 2} has invalid OHLC, volume, or open interest`);
  }
  return bar;
});
if (bars.length !== capture.rowCount) {
  throw new Error(`CSV row count mismatch: expected ${capture.rowCount}, got ${bars.length}`);
}

const bySymbol = new Map<string, Map<string, Bar>>();
for (const bar of bars) {
  const dates = bySymbol.get(bar.symbol) ?? new Map<string, Bar>();
  if (dates.has(bar.date)) {
    throw new Error(`Duplicate contract observation: ${bar.symbol} ${bar.date}`);
  }
  dates.set(bar.date, bar);
  bySymbol.set(bar.symbol, dates);
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].toSorted((left, right) => left - right);
  return sorted[Math.floor((sorted.length - 1) * p)];
}

function correlation(left: readonly number[], right: readonly number[]): number | null {
  if (left.length !== right.length || left.length < 2) {
    return null;
  }
  const leftMean = mean(left);
  const rightMean = mean(right);
  const numerator = left.reduce(
    (sum, value, index) => sum + (value - leftMean) * (right[index] - rightMean),
    0,
  );
  const leftSquares = left.reduce((sum, value) => sum + (value - leftMean) ** 2, 0);
  const rightSquares = right.reduce((sum, value) => sum + (value - rightMean) ** 2, 0);
  const denominator = Math.sqrt(leftSquares * rightSquares);
  return denominator > 0 ? numerator / denominator : null;
}

function dateOf(timestamp: string | undefined): string | undefined {
  return timestamp?.slice(0, 10);
}

const feeScenarios = [
  {
    id: "lower_cost_stress",
    commissionPerContractPerSide: 2.5,
    bidAskSpreadPoints: 2,
    slippagePointsPerSide: 2,
    description:
      "CNY 2.5/contract/side commission, one 2-point full quoted width and one 2-point adverse slippage per order; standardized assumption, not historical quotes or user tariff",
  },
  {
    id: "higher_cost_stress",
    commissionPerContractPerSide: 7.5,
    bidAskSpreadPoints: 4,
    slippagePointsPerSide: 4,
    description:
      "CNY 7.5/contract/side commission, one 4-point full quoted width and one 4-point adverse slippage per order; standardized stress assumption, not historical quotes or user tariff",
  },
] as const;
const relationshipRationale =
  "Y and P are DCE edible-oil contracts with the same delivery month, CNY/metric-ton quote, and 10-metric-ton contract multiplier. One lot per leg gives equal nominal tonnage, not a proven market-neutral hedge. Their downstream uses overlap, but substitution and convergence remain hypotheses.";

const pairs = ["01", "05", "09"].flatMap((month) =>
  [22, 23, 24, 25, 26].map((year) => ({
    month,
    contractMonth: `20${year}-${month}`,
    instrumentA: `Y${year}${month}`,
    instrumentB: `P${year}${month}`,
  })),
);
const results = pairs.map((pair) => {
  const seriesA = bySymbol.get(pair.instrumentA);
  const seriesB = bySymbol.get(pair.instrumentB);
  const sourceA = capture.series[pair.instrumentA];
  const sourceB = capture.series[pair.instrumentB];
  if (!seriesA || !seriesB || !sourceA || !sourceB) {
    throw new Error(`Missing captured source series for ${pair.instrumentA}/${pair.instrumentB}`);
  }
  const sharedDates = [...seriesA.keys()].filter((date) => seriesB.has(date)).toSorted();
  const activeBars = sharedDates.flatMap((date) => {
    const a = seriesA.get(date)!;
    const b = seriesB.get(date)!;
    return a.volume > 0 && a.openInterest > 0 && b.volume > 0 && b.openInterest > 0
      ? [{ date, a, b }]
      : [];
  });
  if (activeBars.length < 81) {
    throw new Error(
      `${pair.instrumentA}/${pair.instrumentB} has fewer than 81 jointly active sessions`,
    );
  }

  const observations: PairSpreadObservation[] = activeBars.map(({ date, a, b }) => ({
    timestamp: `${date}T15:00:00+08:00`,
    priceA: a.close,
    priceB: b.close,
  }));
  const sourceRef = `Sina exact-contract daily snapshot captured ${capture.capturedAtUtc}; input.csv SHA-256 ${capture.csvSha256}; raw response hashes are in capture.json`;
  const diagnostic = diagnosePairSpread({
    pairId: `DCE:${pair.instrumentA}-${pair.instrumentB}`,
    instrumentA: pair.instrumentA,
    instrumentB: pair.instrumentB,
    relationshipRationale,
    sourceRef,
    construction: "fixed_spread",
    hedgeRatio: 1,
    lookbackWindow: 60,
    observations,
  });
  const returnsA = activeBars
    .slice(1)
    .map((bar, index) => bar.a.close / activeBars[index].a.close - 1);
  const returnsB = activeBars
    .slice(1)
    .map((bar, index) => bar.b.close / activeBars[index].b.close - 1);
  const maxPriceA = activeBars.map((bar) => bar.a.close);
  const maxPriceB = activeBars.map((bar) => bar.b.close);
  const scenarios = feeScenarios.map((scenario) => {
    const contract = (instrument: string, prices: readonly number[]): PairSpreadReplayContract => ({
      instrument,
      exchange: "DCE",
      contractId: instrument,
      contractMonth: pair.contractMonth,
      contracts: 1,
      multiplier: 10,
      settlementCurrency: "CNY",
      commissionPerContractPerSide: scenario.commissionPerContractPerSide,
      bidAskSpreadPoints: scenario.bidAskSpreadPoints,
      slippagePointsPerSide: scenario.slippagePointsPerSide,
      initialMarginPerContract: Math.ceil(Math.max(...prices) * 10 * 0.05),
    });
    const replay = replayPairSpreadReversion({
      pairId: `DCE:${pair.instrumentA}-${pair.instrumentB}`,
      instrumentA: pair.instrumentA,
      instrumentB: pair.instrumentB,
      relationshipRationale,
      sourceRef,
      hedgeRatio: 1,
      lookbackWindow: 60,
      entryZScore: 2,
      exitZScore: 0.5,
      stopZScore: 3.5,
      maxHoldingObservations: 20,
      contractA: contract(pair.instrumentA, maxPriceA),
      contractB: contract(pair.instrumentB, maxPriceB),
      observations,
    });
    const events = replay.events.map((event) => {
      const signalBar = activeBars.find(({ date }) => date === dateOf(event.signalTimestamp));
      const entryBar = activeBars.find(({ date }) => date === dateOf(event.entryTimestamp));
      const exitBar = activeBars.find(({ date }) => date === dateOf(event.exitTimestamp));
      return {
        ...event,
        signalVolume: signalBar
          ? { [pair.instrumentA]: signalBar.a.volume, [pair.instrumentB]: signalBar.b.volume }
          : undefined,
        entryVolume: entryBar
          ? { [pair.instrumentA]: entryBar.a.volume, [pair.instrumentB]: entryBar.b.volume }
          : undefined,
        exitVolume: exitBar
          ? { [pair.instrumentA]: exitBar.a.volume, [pair.instrumentB]: exitBar.b.volume }
          : undefined,
      };
    });
    return {
      id: scenario.id,
      assumptions: scenario,
      summary: replay.summary,
      events,
    };
  });

  return {
    pairId: `DCE:${pair.instrumentA}-${pair.instrumentB}`,
    deliveryMonth: pair.contractMonth,
    deliveryMonthCode: pair.month,
    source: {
      [pair.instrumentA]: sourceA,
      [pair.instrumentB]: sourceB,
    },
    dataQuality: {
      rawRowsA: sourceA.rawRows,
      rawRowsB: sourceB.rawRows,
      rawOverlapRows: sharedDates.length,
      excludedRowsForZeroVolumeOrOpenInterest: sharedDates.length - activeBars.length,
      activeSynchronizedRows: activeBars.length,
      firstActiveDate: activeBars[0].date,
      lastActiveDate: activeBars.at(-1)!.date,
      medianVolume: {
        [pair.instrumentA]: median(activeBars.map((bar) => bar.a.volume)),
        [pair.instrumentB]: median(activeBars.map((bar) => bar.b.volume)),
      },
      p10Volume: {
        [pair.instrumentA]: percentile(
          activeBars.map((bar) => bar.a.volume),
          0.1,
        ),
        [pair.instrumentB]: percentile(
          activeBars.map((bar) => bar.b.volume),
          0.1,
        ),
      },
      returnsCorrelationOnCommonActiveObservations: correlation(returnsA, returnsB),
    },
    fixedRuleDiagnostic: {
      ar1Coefficient: diagnostic.ar1Decay.coefficient,
      halfLifeObservations: diagnostic.ar1Decay.halfLifeObservations,
      adfStatus: diagnostic.stationarityTest.status,
      adfResult:
        diagnostic.stationarityTest.status === "assessed"
          ? diagnostic.stationarityTest.result
          : diagnostic.stationarityTest.reason,
    },
    scenarios,
  };
});

const januaryPairs = results.filter((result) => result.deliveryMonthCode === "01");
for (let index = 1; index < januaryPairs.length; index += 1) {
  if (
    januaryPairs[index].dataQuality.firstActiveDate <=
    januaryPairs[index - 1].dataQuality.lastActiveDate
  ) {
    throw new Error(
      "January delivery-pair active windows overlap; they cannot be called separate annual slices",
    );
  }
}

const result = {
  objective: "research-only robustness panel for fixed Y-P exact-contract rules",
  capture: {
    capturedAtUtc: capture.capturedAtUtc,
    csvSha256: capture.csvSha256,
    csvBytes: capture.csvBytes,
    rowCount: capture.rowCount,
    seriesCount: Object.keys(capture.series).length,
  },
  frozenParameters: {
    construction: "close(Y) - close(P)",
    contracts: "one listed contract per leg, each 10 metric tons",
    hedgeRatio: 1,
    lookbackWindow: 60,
    entryZScore: 2,
    exitZScore: 0.5,
    stopZScore: 3.5,
    maxHoldingObservations: 20,
    filter:
      "use only paired dates with positive volume and positive open interest in both exact contracts",
    fillProxy: "signal on completed close, enter/exit at next jointly active observation close",
  },
  evaluationDesign: {
    januaryCohortsHaveNonOverlappingActiveDates: true,
    januaryCohorts: januaryPairs.map((result) => ({
      pairId: result.pairId,
      firstActiveDate: result.dataQuality.firstActiveDate,
      lastActiveDate: result.dataQuality.lastActiveDate,
    })),
    mayAndSeptemberContractsOverlapAcrossTheirActiveLifecycles: true,
    overlappingPairsAreReportedSeparatelyAndNeverSummed: true,
    cleanPreregisteredOutOfSampleClaim: false,
  },
  pairs: results,
  limitations: [
    "The pair and frozen thresholds were chosen after the Y2501 data had been captured; this is not preregistered or a clean out-of-sample study.",
    "January cohorts have disjoint active dates, but they remain one selected commodity relationship and do not establish a stable future edge.",
    "May and September pair lifecycles overlap calendar time; each is an independent descriptive contract replay, not an additive portfolio return.",
    "Daily closes are next-observation fill proxies. Historical bid/ask, queue position, legging, partial fills, and exchange execution prices are unavailable.",
    "The two fee/slippage cases are standardized cost stresses, not historical tariffs, observed quotes, or the user's account costs.",
    "The 5% margin value is only a static minimum-margin proxy using each pair's maximum close; historical and broker margin changes, spread offsets, and liquidation are not modeled.",
    "No continuous-contract roll, delivery eligibility, limit-lock execution, taxes, portfolio cross-pair netting, or order capacity is modeled.",
    "A positive daily volume/open-interest filter does not prove sufficient capacity for a real order.",
  ],
};

writeFileSync(join(here, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(
  `Replayed ${results.length} maturity pairs across ${januaryPairs.length} disjoint January lifecycles; result.json updated\n`,
);
