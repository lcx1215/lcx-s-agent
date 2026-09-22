import { z } from "zod";
import { caseflowFingerprint } from "./finance-caseflow.js";
import type { FinanceIntradayBar } from "./finance-intraday-ledger.js";
import { turnoverAndCost } from "./quant-math-advanced.js";

export const FINANCE_INTRADAY_PAPER_SCHEMA = "lcx_finance_intraday_paper_v1" as const;
export const FINANCE_INTRADAY_OPENING_RANGE_RULE =
  "opening_range_breakout_long_next_bar_v1" as const;

const Config = z
  .object({
    openingRangeBars: z.number().int().min(2).max(12).default(6),
    capital: z.number().finite().positive(),
    maxAllocationFraction: z.number().finite().positive().max(1),
    feeBpsPerSide: z.number().finite().nonnegative().max(500),
    spreadBps: z.number().finite().nonnegative().max(500),
    slippageBpsPerSide: z.number().finite().nonnegative().max(500),
    rewardRisk: z.number().finite().positive().max(10).default(2),
  })
  .strict();

export type FinanceIntradayPaperConfig = z.input<typeof Config>;

export type FinanceIntradayPaperTrade = Readonly<{
  sessionDate: string;
  instrument: string;
  signalAt: string;
  entryAt: string;
  exitAt: string;
  exitReason: "opening_range_stop" | "reward_target" | "session_end";
  quantity: number;
  entryReferencePrice: number;
  exitReferencePrice: number;
  grossReturn: number;
  netReturn: number;
  costFraction: number;
}>;

type Metric = Readonly<{
  sessions: number;
  trades: number;
  totalReturn: number;
  averageReturn: number;
  winRate: number;
  maxDrawdown: number;
}>;

export type FinanceIntradayPaperReceipt = Readonly<{
  schemaVersion: typeof FINANCE_INTRADAY_PAPER_SCHEMA;
  status: "paper_contract_only";
  executionAuthority: "none";
  strategyRule: typeof FINANCE_INTRADAY_OPENING_RANGE_RULE;
  datasetRef: string;
  config: z.output<typeof Config>;
  trades: readonly FinanceIntradayPaperTrade[];
  strategy: Metric;
  retailOpenToCloseBaseline: Metric;
  cashBaseline: Metric;
  checks: Readonly<{
    pointInTime: true;
    nextBarEntry: true;
    sameCostModel: true;
    noOrderPlacement: true;
  }>;
  limitations: readonly string[];
  receiptRef: string;
}>;

const newYorkParts = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function sessionParts(instant: string): { date: string; minute: number } {
  const parts = Object.fromEntries(
    newYorkParts.formatToParts(new Date(instant)).map((part) => [part.type, part.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minute: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

function metric(returns: readonly number[], trades: number): Metric {
  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;
  for (const value of returns) {
    equity *= 1 + value;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
  }
  return Object.freeze({
    sessions: returns.length,
    trades,
    totalReturn: equity - 1,
    averageReturn:
      returns.length === 0 ? 0 : returns.reduce((sum, value) => sum + value, 0) / returns.length,
    winRate:
      returns.length === 0 ? 0 : returns.filter((value) => value > 0).length / returns.length,
    maxDrawdown,
  });
}

function round(value: number): number {
  return Number(value.toFixed(12));
}

/**
 * Deterministic research replay. It consumes only closed ledger bars and never calls an execution
 * adapter: a backtest fill is evidence about a rule, not an order or an execution receipt.
 */
export function runFinanceIntradayPaperReplay(params: {
  bars: readonly FinanceIntradayBar[];
  ledgerHeadRef: string | null;
  config: FinanceIntradayPaperConfig;
}): FinanceIntradayPaperReceipt {
  const config = Config.parse(params.config);
  if (params.bars.length === 0) {
    throw new Error("intraday replay requires bars");
  }
  const instruments = new Set(params.bars.map((bar) => bar.instrument));
  const intervals = new Set(params.bars.map((bar) => bar.intervalSeconds));
  if (instruments.size !== 1 || intervals.size !== 1) {
    throw new Error("intraday replay requires one instrument and one interval");
  }
  const bySession = new Map<string, FinanceIntradayBar[]>();
  for (const bar of params.bars.toSorted((left, right) =>
    left.startAt.localeCompare(right.startAt),
  )) {
    const session = sessionParts(bar.startAt);
    if (session.minute < 570 || session.minute >= 960) {
      continue;
    }
    const rows = bySession.get(session.date) ?? [];
    rows.push(bar);
    bySession.set(session.date, rows);
  }

  const allInBpsPerSide = config.feeBpsPerSide + config.spreadBps / 2 + config.slippageBpsPerSide;
  const roundTripCost = turnoverAndCost({
    currentWeights: [0, 1],
    targetWeights: [1, 0],
    costBasisPoints: allInBpsPerSide,
  }).cost;
  const trades: FinanceIntradayPaperTrade[] = [];
  const strategyReturns: number[] = [];
  const baselineReturns: number[] = [];

  for (const [sessionDate, rows] of [...bySession].toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const bars = rows.toSorted((left, right) => left.startAt.localeCompare(right.startAt));
    if (bars.length <= config.openingRangeBars + 1) {
      continue;
    }
    const opening = bars.slice(0, config.openingRangeBars);
    const openingHigh = Math.max(...opening.map((bar) => bar.high));
    const baselineEntry = bars[config.openingRangeBars];
    const exit = bars.at(-1)!;
    baselineReturns.push(round(exit.close / baselineEntry.open - 1 - roundTripCost));

    const signalIndex = bars.findIndex(
      (bar, index) => index >= config.openingRangeBars && bar.close > openingHigh,
    );
    if (signalIndex < 0 || signalIndex + 1 >= bars.length) {
      strategyReturns.push(0);
      continue;
    }
    const signal = bars[signalIndex];
    const entry = bars[signalIndex + 1];
    const quantity = Math.floor((config.capital * config.maxAllocationFraction) / entry.open);
    if (quantity < 1) {
      strategyReturns.push(0);
      continue;
    }
    const stopPrice = Math.min(...opening.map((bar) => bar.low));
    const riskPerShare = entry.open - stopPrice;
    if (riskPerShare <= 0) {
      strategyReturns.push(0);
      continue;
    }
    const targetPrice = entry.open + riskPerShare * config.rewardRisk;
    let chosenExit = exit;
    let exitPrice = exit.close;
    let exitReason: FinanceIntradayPaperTrade["exitReason"] = "session_end";
    for (const candidate of bars.slice(signalIndex + 1)) {
      // When both touch within one OHLC bar the path is unknowable; choose the adverse outcome.
      if (candidate.low <= stopPrice) {
        chosenExit = candidate;
        exitPrice = stopPrice;
        exitReason = "opening_range_stop";
        break;
      }
      if (candidate.high >= targetPrice) {
        chosenExit = candidate;
        exitPrice = targetPrice;
        exitReason = "reward_target";
        break;
      }
    }
    const grossReturn = exitPrice / entry.open - 1;
    const netReturn = grossReturn - roundTripCost;
    strategyReturns.push(round(netReturn));
    trades.push(
      Object.freeze({
        sessionDate,
        instrument: entry.instrument,
        signalAt: signal.endAt,
        entryAt: entry.startAt,
        exitAt: chosenExit.endAt,
        exitReason,
        quantity,
        entryReferencePrice: entry.open,
        exitReferencePrice: round(exitPrice),
        grossReturn: round(grossReturn),
        netReturn: round(netReturn),
        costFraction: round(roundTripCost),
      }),
    );
  }
  if (strategyReturns.length === 0) {
    throw new Error("intraday replay has no complete regular-market sessions");
  }
  const datasetRef = caseflowFingerprint({
    ledgerHeadRef: params.ledgerHeadRef,
    bars: params.bars,
  });
  const body = {
    schemaVersion: FINANCE_INTRADAY_PAPER_SCHEMA,
    status: "paper_contract_only" as const,
    executionAuthority: "none" as const,
    strategyRule: FINANCE_INTRADAY_OPENING_RANGE_RULE,
    datasetRef,
    config,
    trades: Object.freeze(trades),
    strategy: metric(strategyReturns, trades.length),
    retailOpenToCloseBaseline: metric(baselineReturns, baselineReturns.length),
    cashBaseline: metric(
      strategyReturns.map(() => 0),
      0,
    ),
    checks: Object.freeze({
      pointInTime: true as const,
      nextBarEntry: true as const,
      sameCostModel: true as const,
      noOrderPlacement: true as const,
    }),
    limitations: Object.freeze([
      "A replay validates mechanics, not future alpha.",
      "Promotion needs real point-in-time data across at least three non-overlapping market regimes.",
      "Paper fills do not prove live liquidity, latency, capacity, or profitability.",
    ]),
  };
  return Object.freeze({ ...body, receiptRef: caseflowFingerprint(body) });
}
