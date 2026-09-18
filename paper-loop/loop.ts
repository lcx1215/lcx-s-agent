#!/usr/bin/env -S node --import tsx
/**
 * Trend paper-trading loop: data -> signal -> size -> paper fill -> P&L -> verdict.
 *
 * Deliberately self-contained. It does not import the research/governance layer,
 * because the point of this file is to close the loop, not to justify a decision.
 *
 * Data: public Binance spot market-data endpoint (same host the repo already
 * uses in src/agents/finance-free-market-collection-adapters.ts).
 *
 * It never places an order. Fills are simulated against real candles.
 * The only score is money, and it is reported honestly: total return, the
 * benchmark, the same-exposure benchmark, the capture ratio, and drawdown.
 * If capture <= 1, the market did the work and the timing subtracted.
 *
 * Usage:
 *   node --import tsx paper-loop/loop.ts
 *   node --import tsx paper-loop/loop.ts --symbols BTCUSDT,ETHUSDT,SOLUSDT
 *   node --import tsx paper-loop/loop.ts --start 2021-11-08 --bars 1800
 *   node --import tsx paper-loop/loop.ts --json
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { cachedJson } from "./cache.ts";

// ---------------------------------------------------------------- parameters

export type TrendParams = {
  fast: number;
  slow: number;
  atrPeriod: number;
  stopAtrMultiple: number;
  riskPerTrade: number;
  takerFee: number;
  slippage: number;
  maxGrossExposure: number;
};

export const DEFAULT_TREND_PARAMS: TrendParams = {
  fast: 20, // fast SMA on daily closes
  slow: 60, // slow SMA: trend filter
  atrPeriod: 14,
  stopAtrMultiple: 2.0, // trailing stop distance
  riskPerTrade: 0.01, // 1% of equity risked per position
  takerFee: 0.0005, // 0.05% per side (Binance spot taker)
  slippage: 0.0002, // 0.02% per side
  maxGrossExposure: 1.0, // never more than 1x equity at risk
};

const DATA_HOST = "https://data-api.binance.vision";
const LEDGER_PATH = resolve("branches/_system/paper-loop/ledger.json");

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function cliParamOverrides(params: TrendParams): TrendParams {
  const out = { ...params };
  for (const [flag, key] of [
    ["fast", "fast"],
    ["slow", "slow"],
    ["stop", "stopAtrMultiple"],
    ["risk", "riskPerTrade"],
    ["fee", "takerFee"],
  ] as const) {
    const i = process.argv.indexOf(`--${flag}`);
    if (i >= 0 && process.argv[i + 1] && Number.isFinite(Number(process.argv[i + 1]))) {
      out[key] = Number(process.argv[i + 1]);
    }
  }
  return out;
}

// ------------------------------------------------------------------- plumbing

export type Candle = { t: number; o: number; h: number; l: number; c: number };

const DAY_MS = 86_400_000;

/** A system that runs unattended must survive a transient upstream failure. */
async function withRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (i < attempts - 1) {
        await new Promise((r) => setTimeout(r, 600 * (i + 1)));
      }
    }
  }
  throw lastError;
}

function toCandle(k: unknown[]): Candle {
  return { t: Number(k[0]), o: Number(k[1]), h: Number(k[2]), l: Number(k[3]), c: Number(k[4]) };
}

async function fetchDaily(
  symbol: string,
  bars: number,
  startMs: number | undefined,
  endMs: number,
  useCache: boolean,
): Promise<Candle[]> {
  const want = Math.min(bars, 5000);
  // Binance caps one klines response at 1000 rows, so page forward until we
  // have the requested history instead of silently truncating at 1000.
  let cursor = startMs ?? (want > 1000 ? endMs - want * DAY_MS : undefined);

  const out: Candle[] = [];
  while (out.length < want) {
    const limit = Math.min(1000, want - out.length);
    const qs = new URLSearchParams({
      symbol,
      interval: "1d",
      limit: String(limit),
    });
    // `endTime` only bounds a page whose window could run past it. A page that
    // sits entirely in the past is determined by (symbol, limit, startTime), so
    // leaving `endTime` out keeps its cache key stable and lets the page be
    // reused. With `endTime` always in the key, `end: Date.now()` turned every
    // historical page into a permanent cache miss that re-stored a
    // byte-identical payload on each run.
    const pageEndMs = cursor === undefined ? undefined : cursor + limit * DAY_MS;
    if (pageEndMs === undefined || pageEndMs > endMs) {
      qs.set("endTime", String(endMs));
    }
    if (cursor !== undefined) {
      qs.set("startTime", String(cursor));
    }
    const url = `${DATA_HOST}/api/v3/klines?${qs.toString()}`;
    const raw = await cachedJson(
      url,
      () =>
        withRetry(async () => {
          const res = await fetch(url);
          if (!res.ok) {
            throw new Error(`${symbol}: HTTP ${res.status}`);
          }
          return (await res.json()) as unknown[][];
        }),
      useCache,
    );
    if (raw.length === 0) {
      break;
    }
    out.push(...raw.map(toCandle));
    cursor = Number(raw[raw.length - 1][0]) + DAY_MS;
    if (raw.length < limit || cursor >= endMs) {
      break;
    }
  }

  return out;
}

/** Simple moving average of closes; returns NaN until enough samples. */
function sma(closes: number[], period: number, i: number): number {
  if (i + 1 < period) {
    return Number.NaN;
  }
  let sum = 0;
  for (let k = i - period + 1; k <= i; k += 1) {
    sum += closes[k];
  }
  return sum / period;
}

/** Wilder ATR; NaN until enough samples. */
function atr(candles: Candle[], period: number, i: number): number {
  if (i < period) {
    return Number.NaN;
  }
  let sum = 0;
  for (let k = i - period + 1; k <= i; k += 1) {
    const prevClose = candles[k - 1].c;
    const c = candles[k];
    sum += Math.max(c.h - c.l, Math.abs(c.h - prevClose), Math.abs(c.l - prevClose));
  }
  return sum / period;
}

// ------------------------------------------------------------------ the loop

type Position = {
  symbol: string;
  entryPrice: number;
  qty: number;
  stop: number;
  entryTime: number;
};

type Trade = {
  symbol: string;
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  qty: number;
  pnl: number;
  reason: string;
};

type Result = {
  symbol: string;
  equity: number;
  peak: number;
  maxDrawdown: number;
  trades: Trade[];
  position: Position | null;
  lastCandle: Candle;
  firstCandle: Candle;
  bars: number;
  fast: number;
  slow: number;
  buyHold: number;
  /** Time-weighted average fraction of equity actually deployed in the market. */
  avgExposure: number;
};

function runSymbol(
  symbol: string,
  candles: Candle[],
  startingEquity: number,
  params: TrendParams,
): Result {
  const closes = candles.map((c) => c.c);

  let equity = startingEquity;
  let peak = startingEquity;
  let maxDrawdown = 0;

  let position: Position | null = null;
  let lastStopUpdate = -1;
  const trades: Trade[] = [];
  let exposureSum = 0;
  let exposureBars = 0;

  const cost = (price: number, qty: number) => price * qty * (params.takerFee + params.slippage);

  for (let i = 1; i < candles.length; i += 1) {
    const c = candles[i];
    const fast = sma(closes, params.fast, i);
    const slow = sma(closes, params.slow, i);
    const a = atr(candles, params.atrPeriod, i);

    if (position) {
      // Trailing stop, tightened once per bar.
      if (i !== lastStopUpdate && Number.isFinite(a)) {
        position.stop = Math.max(position.stop, c.c - params.stopAtrMultiple * a);
        lastStopUpdate = i;
      }

      const stopped = c.l <= position.stop;
      const trendBroken = Number.isFinite(fast) && Number.isFinite(slow) && fast < slow;

      if (stopped || trendBroken) {
        const exitPrice = stopped ? Math.min(position.stop, c.o) : c.c;
        const proceeds = exitPrice * position.qty - cost(exitPrice, position.qty);
        const pnl = proceeds - position.entryPrice * position.qty;
        equity += pnl;
        trades.push({
          symbol,
          entryTime: position.entryTime,
          exitTime: c.t,
          entryPrice: position.entryPrice,
          exitPrice,
          qty: position.qty,
          pnl,
          reason: stopped ? "stop" : "trend_break",
        });
        position = null;
      }
    } else if (Number.isFinite(fast) && Number.isFinite(slow) && Number.isFinite(a) && a > 0) {
      const uptrend = fast > slow;
      const justCrossed = sma(closes, params.fast, i - 1) <= sma(closes, params.slow, i - 1);
      if (uptrend && justCrossed) {
        const entryPrice = c.c * (1 + params.slippage);
        const stopDistance = params.stopAtrMultiple * a;
        const riskBudget = equity * params.riskPerTrade;
        const qty = Math.min(
          riskBudget / stopDistance,
          (equity * params.maxGrossExposure) / entryPrice,
        );
        if (qty > 0) {
          equity -= cost(entryPrice, qty);
          position = { symbol, entryPrice, qty, stop: entryPrice - stopDistance, entryTime: c.t };
          lastStopUpdate = i;
        }
      }
    }

    // Mark to market for the drawdown series.
    const marked = equity + (position ? position.qty * (c.c - position.entryPrice) : 0);
    peak = Math.max(peak, marked);
    maxDrawdown = Math.max(maxDrawdown, peak > 0 ? (peak - marked) / peak : 0);

    // How much of the book is actually exposed to the market on this bar.
    exposureSum += marked > 0 && position ? (position.qty * c.c) / marked : 0;
    exposureBars += 1;
  }

  const last = candles[candles.length - 1];
  const marked = equity + (position ? position.qty * (last.c - position.entryPrice) : 0);

  return {
    symbol,
    equity: marked,
    peak,
    maxDrawdown,
    trades,
    position,
    lastCandle: last,
    firstCandle: candles[0],
    bars: candles.length,
    fast: sma(closes, params.fast, candles.length - 1),
    slow: sma(closes, params.slow, candles.length - 1),
    buyHold: last.c / candles[0].c - 1,
    avgExposure: exposureBars > 0 ? exposureSum / exposureBars : 0,
  };
}

// ------------------------------------------------------------------ analysis

export type TrendAnalysis = {
  kind: "trend";
  symbols: string[];
  window: { start: string; end: string; bars: number };
  params: TrendParams;
  perSymbol: Array<{
    symbol: string;
    return: number;
    buyHold: number;
    maxDrawdown: number;
    trades: number;
    avgExposure: number;
    lastClose: number;
  }>;
  totalReturn: number;
  benchmark: number;
  alpha: number;
  avgExposure: number;
  sameExposureBenchmark: number;
  capture: number;
  maxDrawdown: number;
  trades: number;
  verdictCode: "EDGE" | "NO_EDGE";
  verdict: string;
};

export type TrendRequest = {
  symbols: string[];
  bars: number;
  startingEquity?: number;
  params?: Partial<TrendParams>;
  start?: string;
  end?: string;
  useCache?: boolean;
};

export async function runTrendAnalysis(req: TrendRequest): Promise<TrendAnalysis> {
  const params = { ...DEFAULT_TREND_PARAMS, ...req.params };
  const startingEquity = req.startingEquity ?? 10_000;
  const endMs = req.end ? Date.parse(`${req.end}T00:00:00Z`) : Date.now();
  const startMs = req.start ? Date.parse(`${req.start}T00:00:00Z`) : undefined;
  const useCache = req.useCache !== false;

  const perSymbolEquity = startingEquity / req.symbols.length;
  const results: Result[] = [];
  const skipped: string[] = [];

  for (const symbol of req.symbols) {
    const candles = await fetchDaily(symbol, req.bars, startMs, endMs, useCache);
    if (candles.length < params.slow + params.atrPeriod + 2) {
      skipped.push(symbol);
      continue;
    }
    results.push(runSymbol(symbol, candles, perSymbolEquity, params));
  }

  if (results.length === 0) {
    throw new Error(`no symbol had enough history (skipped: ${skipped.join(", ")})`);
  }

  const totalEquity = results.reduce((s, r) => s + r.equity, 0);
  const totalTrades = results.reduce((s, r) => s + r.trades.length, 0);
  const worstDd = results.reduce((m, r) => Math.max(m, r.maxDrawdown), 0);
  const benchmark = results.reduce((s, r) => s + r.buyHold, 0) / results.length;
  const avgExposure = results.reduce((s, r) => s + r.avgExposure, 0) / results.length;
  const totalReturn = totalEquity / startingEquity - 1;
  const sameExposureBenchmark = benchmark * avgExposure;
  const capture = sameExposureBenchmark !== 0 ? totalReturn / sameExposureBenchmark : 0;

  // A strategy that merely loses less than a falling market is still losing.
  // EDGE requires both: it must make money, and it must beat buy & hold.
  const makesMoney = totalReturn > 0;
  const beatsBenchmark = totalReturn > benchmark;
  const verdictCode: TrendAnalysis["verdictCode"] =
    makesMoney && beatsBenchmark ? "EDGE" : "NO_EDGE";
  const verdict = makesMoney
    ? beatsBenchmark
      ? "EDGE (makes money AND beats buy & hold -- in-sample)"
      : "NO EDGE (makes money, but buy & hold would have paid more)"
    : "NO EDGE (loses money -- do not go live)";

  const first = results.reduce(
    (min, r) => Math.min(min, r.firstCandle.t),
    Number.POSITIVE_INFINITY,
  );
  return {
    kind: "trend",
    symbols: req.symbols,
    window: {
      start: new Date(first).toISOString().slice(0, 10),
      end: new Date(results.reduce((m, r) => Math.max(m, r.lastCandle.t), 0))
        .toISOString()
        .slice(0, 10),
      bars: Math.max(...results.map((r) => r.bars)),
    },
    params,
    perSymbol: results.map((r) => ({
      symbol: r.symbol,
      return: r.equity / perSymbolEquity - 1,
      buyHold: r.buyHold,
      maxDrawdown: r.maxDrawdown,
      trades: r.trades.length,
      avgExposure: r.avgExposure,
      lastClose: r.lastCandle.c,
    })),
    totalReturn,
    benchmark,
    alpha: totalReturn - benchmark,
    avgExposure,
    sameExposureBenchmark,
    capture,
    maxDrawdown: worstDd,
    trades: totalTrades,
    verdictCode,
    verdict,
  };
}

// ------------------------------------------------------------------- reporting

export function pct(x: number, digits = 2): string {
  return `${(x * 100).toFixed(digits)}%`;
}

export function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function renderTrend(a: TrendAnalysis): string {
  const lines: string[] = [];
  lines.push("paper-loop: data -> signal -> size -> paper fill -> P&L");
  lines.push(
    `params: SMA(${a.params.fast}/${a.params.slow}) trend, ATR(${a.params.atrPeriod}) x ${a.params.stopAtrMultiple} stop, ` +
      `risk ${pct(a.params.riskPerTrade)}/trade, fees ${pct(a.params.takerFee)} + slip ${pct(a.params.slippage)}`,
  );
  lines.push(`window: ${a.window.start} -> ${a.window.end}   symbols: ${a.symbols.join(", ")}\n`);

  for (const s of a.perSymbol) {
    lines.push(`--- ${s.symbol}`);
    lines.push(
      `    return ${pct(s.return)}  benchmark ${pct(s.buyHold)}  maxDD ${pct(s.maxDrawdown)}  ` +
        `trades ${s.trades}  avg exposure ${pct(s.avgExposure)}`,
    );
  }

  lines.push("\n=== SCORE (the only score) ===");
  lines.push(`  total return     : ${pct(a.totalReturn)}`);
  lines.push(`  benchmark        : ${pct(a.benchmark)}  (equal-weight buy & hold, 100% exposure)`);
  lines.push(`  alpha            : ${pct(a.alpha)}  (vs fully-invested benchmark)`);
  lines.push(`  avg exposure     : ${pct(a.avgExposure)} of equity`);
  lines.push(`  same-exposure bm : ${pct(a.sameExposureBenchmark)}  (benchmark x avg exposure)`);
  lines.push(
    `  capture          : ${a.capture.toFixed(2)}x  (${
      a.sameExposureBenchmark <= 0
        ? "meaningless while the benchmark is negative"
        : a.capture >= 1
          ? "signal adds value"
          : "signal destroys value vs just holding"
    })`,
  );
  lines.push(`  max drawdown     : ${pct(a.maxDrawdown)}`);
  lines.push(`  trades           : ${a.trades}`);
  lines.push(`  verdict          : ${a.verdict}`);
  if (a.totalReturn <= 0 && a.totalReturn > a.benchmark) {
    lines.push(
      "  note             : it lost less than the market, which is not the same as earning.",
    );
  }
  return lines.join("\n");
}

function writeLedger(a: TrendAnalysis, startingEquity: number): void {
  const ledger = {
    schemaVersion: 2,
    updatedAt: new Date().toISOString(),
    params: a.params,
    symbols: a.symbols,
    startingEquity,
    equity: startingEquity * (1 + a.totalReturn),
    return: a.totalReturn,
    benchmark: a.benchmark,
    alpha: a.alpha,
    avgExposure: a.avgExposure,
    capture: a.capture,
    maxDrawdown: a.maxDrawdown,
    trades: a.trades,
    verdict: a.verdict,
  };
  mkdirSync(dirname(LEDGER_PATH), { recursive: true });
  writeFileSync(LEDGER_PATH, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
}

async function main(): Promise<void> {
  const symbols = arg("symbols", "BTCUSDT,ETHUSDT")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  const bars = Number(arg("bars", "1000"));
  const startingEquity = Number(arg("equity", "10000"));

  const analysis = await runTrendAnalysis({
    symbols,
    bars,
    startingEquity,
    params: cliParamOverrides(DEFAULT_TREND_PARAMS),
    start: arg("start", "") || undefined,
    end: arg("end", "") || undefined,
    useCache: !hasFlag("--no-cache"),
  });

  if (hasFlag("--json")) {
    console.log(JSON.stringify(analysis, null, 2));
    return;
  }
  console.log(renderTrend(analysis));
  writeLedger(analysis, startingEquity);
  console.log(`  ledger written: ${LEDGER_PATH}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
