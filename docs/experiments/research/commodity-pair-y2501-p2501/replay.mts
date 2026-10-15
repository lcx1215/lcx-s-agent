import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  diagnosePairSpread,
  replayPairSpreadReversion,
  type PairSpreadObservation,
  type PairSpreadReplayContract,
} from "../../../../src/agents/quant-math-pair-spread.js";

type Bar = {
  date: string;
  Y2501_open: number;
  Y2501_high: number;
  Y2501_low: number;
  Y2501_close: number;
  Y2501_volume: number;
  Y2501_open_interest: number;
  Y2501_settle: number;
  P2501_open: number;
  P2501_high: number;
  P2501_low: number;
  P2501_close: number;
  P2501_volume: number;
  P2501_open_interest: number;
  P2501_settle: number;
};

const here = dirname(fileURLToPath(import.meta.url));
const csv = readFileSync(join(here, "input.csv"), "utf8").trim().split(/\r?\n/u);
const headers = csv[0].split(",");
const bars = csv.slice(1).map((line, lineIndex) => {
  const cells = line.split(",");
  if (cells.length !== headers.length) {
    throw new Error(
      `CSV row ${lineIndex + 2} has ${cells.length} fields; expected ${headers.length}`,
    );
  }
  const row = Object.fromEntries(headers.map((header, index) => [header, cells[index]]));
  return Object.fromEntries(
    headers.map((header) => [header, header === "date" ? row[header] : Number(row[header])]),
  ) as Bar;
});

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sampleDeviation(values: readonly number[]): number {
  const average = mean(values);
  return Math.sqrt(
    values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1),
  );
}

function median(values: readonly number[]): number {
  const sorted = [...values].toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function correlation(left: readonly number[], right: readonly number[]): number {
  const leftMean = mean(left);
  const rightMean = mean(right);
  const numerator = left.reduce(
    (sum, value, index) => sum + (value - leftMean) * (right[index] - rightMean),
    0,
  );
  const leftSquares = left.reduce((sum, value) => sum + (value - leftMean) ** 2, 0);
  const rightSquares = right.reduce((sum, value) => sum + (value - rightMean) ** 2, 0);
  return numerator / Math.sqrt(leftSquares * rightSquares);
}

function validOhlc(bar: Bar, prefix: "Y2501" | "P2501"): boolean {
  return (
    bar[`${prefix}_low`] <= Math.min(bar[`${prefix}_open`], bar[`${prefix}_close`]) &&
    bar[`${prefix}_high`] >= Math.max(bar[`${prefix}_open`], bar[`${prefix}_close`]) &&
    bar[`${prefix}_low`] <= bar[`${prefix}_high`]
  );
}

const observations: PairSpreadObservation[] = bars.map((bar) => ({
  timestamp: `${bar.date}T15:00:00+08:00`,
  priceA: bar.Y2501_close,
  priceB: bar.P2501_close,
}));
const spreads = bars.map((bar) => bar.Y2501_close - bar.P2501_close);
const yReturns = bars.slice(1).map((bar, index) => bar.Y2501_close / bars[index].Y2501_close - 1);
const pReturns = bars.slice(1).map((bar, index) => bar.P2501_close / bars[index].P2501_close - 1);
const pricesA = bars.map((bar) => bar.Y2501_close);
const pricesB = bars.map((bar) => bar.P2501_close);
const feePerContractPerSide = 2.5;
const marginPerContract = (prices: readonly number[]) => Math.ceil(Math.max(...prices) * 10 * 0.05);
const sourceRef =
  "Sina exact-contract daily bars captured 2026-09-30T04:31:28Z; input.csv + capture.json; closes cross-checked against Yonghui Futures 2024-08-26 daily report";
const rationale =
  "Y2501 and P2501 are DCE edible-oil contracts with the same delivery month and matching 10-metric-ton lot size; one lot per leg expresses a fixed Y-P price spread. Their downstream uses overlap, but they are not identical deliverables and the relationship is only a research hypothesis.";

const diagnostic = diagnosePairSpread({
  pairId: "DCE:Y2501-P2501",
  instrumentA: "Y2501",
  instrumentB: "P2501",
  relationshipRationale: rationale,
  sourceRef,
  construction: "fixed_spread",
  hedgeRatio: 1,
  lookbackWindow: 60,
  observations,
});

const costScenarios = [
  {
    id: "one_tick_width_one_tick_slippage",
    feePerContractPerSide,
    bidAskSpreadPoints: 2,
    slippagePointsPerSide: 2,
    assumption:
      "one-tick full quoted width per leg and one adverse tick per order; no historical bid/ask or fill data",
  },
  {
    id: "two_tick_width_two_tick_slippage_published_account_fee",
    feePerContractPerSide: 7.5,
    bidAskSpreadPoints: 4,
    slippagePointsPerSide: 4,
    assumption:
      "two-tick full quoted width per leg, two adverse ticks per order, and 7.5 CNY/side/contract published account-facing fee from the contemporaneous 2024-05 schedule; not the user's actual tariff",
  },
];

const scenarios = costScenarios.map((scenario) => {
  const contract = (
    instrument: "Y2501" | "P2501",
    prices: readonly number[],
  ): PairSpreadReplayContract => ({
    instrument,
    exchange: "DCE",
    contractId: instrument,
    contractMonth: "2025-01",
    contracts: 1,
    multiplier: 10,
    settlementCurrency: "CNY",
    commissionPerContractPerSide: scenario.feePerContractPerSide,
    bidAskSpreadPoints: scenario.bidAskSpreadPoints,
    slippagePointsPerSide: scenario.slippagePointsPerSide,
    initialMarginPerContract: marginPerContract(prices),
  });
  const replay = replayPairSpreadReversion({
    pairId: "DCE:Y2501-P2501",
    instrumentA: "Y2501",
    instrumentB: "P2501",
    relationshipRationale: rationale,
    sourceRef,
    hedgeRatio: 1,
    lookbackWindow: 60,
    entryZScore: 2,
    exitZScore: 0.5,
    stopZScore: 3.5,
    maxHoldingObservations: 20,
    contractA: contract("Y2501", pricesA),
    contractB: contract("P2501", pricesB),
    observations,
  });
  if (
    replay.events.some(
      (event) =>
        ["recovered", "stopped", "timed_out"].includes(event.status) &&
        event.censorReason !== undefined,
    )
  ) {
    throw new Error("Resolved replay events must not carry a censor reason");
  }
  return {
    id: scenario.id,
    assumptions: scenario,
    contractMarginFloorProxyCnyPerLot: {
      Y2501: marginPerContract(pricesA),
      P2501: marginPerContract(pricesB),
    },
    summary: replay.summary,
    events: replay.events.map((event) => {
      const entryBar = bars.find((bar) => bar.date === event.entryTimestamp?.slice(0, 10));
      const exitBar = bars.find((bar) => bar.date === event.exitTimestamp?.slice(0, 10));
      return {
        ...event,
        entryVolume: entryBar
          ? { Y2501: entryBar.Y2501_volume, P2501: entryBar.P2501_volume }
          : undefined,
        exitVolume: exitBar
          ? { Y2501: exitBar.Y2501_volume, P2501: exitBar.P2501_volume }
          : undefined,
      };
    }),
  };
});

const crossCheck = bars.find((bar) => bar.date === "2024-08-26");
if (!crossCheck || crossCheck.Y2501_close !== 7566 || crossCheck.P2501_close !== 8078) {
  throw new Error("The 2024-08-26 independent close-price cross-check did not match");
}

const result = {
  objective: "research-only replay of one exact DCE cross-commodity contract pair",
  capture: JSON.parse(readFileSync(join(here, "capture.json"), "utf8")) as unknown,
  dataQuality: {
    synchronizedRows: bars.length,
    duplicateDates: bars.length - new Set(bars.map((bar) => bar.date)).size,
    ohlcInconsistentRows: bars.filter((bar) => !validOhlc(bar, "Y2501") || !validOhlc(bar, "P2501"))
      .length,
    rowsWithZeroVolumeOrOpenInterest: bars.filter(
      (bar) =>
        bar.Y2501_volume <= 0 ||
        bar.P2501_volume <= 0 ||
        bar.Y2501_open_interest <= 0 ||
        bar.P2501_open_interest <= 0,
    ).length,
    firstTenSessionsMedianVolume: {
      Y2501: median(bars.slice(0, 10).map((bar) => bar.Y2501_volume)),
      P2501: median(bars.slice(0, 10).map((bar) => bar.P2501_volume)),
    },
    crossCheck20240826: {
      Y2501Close: crossCheck.Y2501_close,
      P2501Close: crossCheck.P2501_close,
      matchedIndependentPublishedValues: true,
    },
  },
  fixedParameters: {
    construction: "Y2501 close - P2501 close",
    lotCount: "1 contract per leg",
    multiplierPerLeg: "10 metric tons per contract",
    lookbackWindow: 60,
    entryZScore: 2,
    exitZScore: 0.5,
    stopZScore: 3.5,
    maxHoldingObservations: 20,
    parameterOrigin:
      "chosen before event-level replay, after source coverage and basic integrity inspection; not preregistered before data retrieval and not optimized",
  },
  closeSpreadStatistics: {
    observations: spreads.length,
    mean: mean(spreads),
    median: median(spreads),
    sampleStandardDeviation: sampleDeviation(spreads),
    minimum: Math.min(...spreads),
    maximum: Math.max(...spreads),
    first: spreads[0],
    last: spreads.at(-1),
  },
  dailyCloseReturnPearsonCorrelation: correlation(yReturns, pReturns),
  diagnostics: diagnostic,
  scenarios,
  interpretation:
    "One historical maturity is a descriptive case only. The cost scenarios use explicit assumptions because daily OHLC data does not contain historical bid/ask quotes, market depth, fills, or legging; account brokerage fees and time-varying margin are not reconstructed.",
};

writeFileSync(join(here, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(
  JSON.stringify(
    {
      dataQuality: result.dataQuality,
      closeSpreadStatistics: result.closeSpreadStatistics,
      dailyCloseReturnPearsonCorrelation: result.dailyCloseReturnPearsonCorrelation,
      diagnostics: {
        latestSpread: diagnostic.latestSpread,
        latestObservationZScore: diagnostic.latestObservationZScore,
        ar1Decay: diagnostic.ar1Decay,
        stationarityTest: diagnostic.stationarityTest,
      },
      scenarios: scenarios.map(({ id, summary, events }) => ({ id, summary, events })),
    },
    null,
    2,
  ),
);
