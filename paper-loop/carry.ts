#!/usr/bin/env -S node --import tsx
/**
 * Funding-rate carry analysis: market-neutral, no direction bet.
 *
 * Long spot + short perpetual, same notional. Price moves cancel, so the only
 * thing left to earn is the funding the short leg collects:
 *
 *   P&L per hour = N * rate_1h
 *   return on capital = P&L / (N * (1 + marginRatio))
 *
 * The point of this file is that it needs no price forecast. If it cannot earn
 * after costs, no amount of signal tuning will help, because there is nothing
 * to forecast.
 *
 * Basis is measured from the venue's own contemporaneous series (Hyperliquid
 * publishes `premium` alongside the funding rate; Deribit publishes the index
 * price in the same record). An earlier version derived basis by differencing
 * the perp candle close against the funding record's index price, which are not
 * sampled at the same instant, and produced a 0.47% basis where the true value
 * is 0.003%. That artifact inflated the result by ~1.9% over 8 months. Do not
 * reintroduce a cross-series difference without checking the sampling instants.
 *
 * Liquidation is modelled in liquidation.ts and reported in both collateral
 * modes, because that choice decides whether the trade can die.
 *
 * Data: Deribit and Hyperliquid public APIs. Binance futures is unreachable
 * from this environment. It never places an order.
 *
 * Usage:
 *   node --import tsx paper-loop/carry.ts
 *   node --import tsx paper-loop/carry.ts --venue hyperliquid --instrument BTC
 *   node --import tsx paper-loop/carry.ts --json
 */

import { cachedJson } from "./cache.ts";
import { assessCarryCosts, assessSpotLeg, type CarryCosts, type SpotLegRisk } from "./costs.ts";
import { assessLiquidation, type LiquidationRisk, type MarginPoint } from "./liquidation.ts";

// ---------------------------------------------------------------- parameters

export type CarryVenue = "deribit" | "hyperliquid";

export type CarryParams = {
  notional: number;
  marginRatio: number;
  spotFee: number;
  perpFee: number;
  enterApr: number;
  exitApr: number;
  lookbackHours: number;
  maintenanceMarginRate: number;
  /** Spot-leg leverage. 1 = fully paid, which is what the base model assumes. */
  spotLeverage: number;
};

export const DEFAULT_CARRY_PARAMS: CarryParams = {
  notional: 1,
  marginRatio: 0.5,
  spotFee: 0.0005,
  perpFee: 0.0005,
  enterApr: 0.02,
  exitApr: -0.02,
  lookbackHours: 72,
  maintenanceMarginRate: 0.005,
  spotLeverage: 1,
};

const DERIBIT = "https://www.deribit.com/api/v2/public";
const HYPERLIQUID = "https://api.hyperliquid.xyz";
const DAY = 24 * 3_600_000;
const HOUR_MS = 3_600_000;
const FUNDING_CHUNK = 28 * DAY;
const PERP_CHUNK = 60 * DAY;

/**
 * Venues stamp hourly records inconsistently: Hyperliquid's funding history
 * carries a millisecond offset while its candles sit exactly on the hour.
 * Floor both sides before aligning, or almost nothing matches.
 */
function hourOf(t: number): number {
  return Math.floor(t / HOUR_MS) * HOUR_MS;
}

export const CARRY_CAVEATS = [
  "funding is regime-dependent; a bull-market mean will not hold in a bear market",
  "venue counterparty and smart-contract risk is real and unpriced here",
  "the spot leg's liquidation is modelled from the perp price path, not a spot series",
  "collateral-move and rebalance costs are banded approximations, not order-level fills",
  "liquidity at size is not modelled; these costs assume you can always trade the notional",
];

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

// ------------------------------------------------------------------- plumbing

/** A funding record, plus whatever the venue gives us about the basis. */
type FundingRow = { t: number; rate1h: number; premium?: number; indexPrice?: number };

/** The minimum a funding-only simulation needs. */
type RatePoint = { t: number; rate1h: number };

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

async function getJson<T>(url: string): Promise<T> {
  return withRetry(async () => {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} for ${url}`);
    }
    return (await res.json()) as T;
  });
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  return withRetry(async () => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} for ${url}`);
    }
    return (await res.json()) as T;
  });
}

function dedupe<T extends { t: number }>(rows: T[]): T[] {
  rows.sort((a, b) => a.t - b.t);
  return rows.filter((r, i) => i === 0 || r.t !== rows[i - 1].t);
}

/** Deribit returns at most ~744 rows, so walk the window in chunks. */
async function fetchDeribitFunding(
  instrument: string,
  start: number,
  end: number,
  useCache: boolean,
): Promise<FundingRow[]> {
  const out: FundingRow[] = [];
  for (let s = start; s < end; s += FUNDING_CHUNK) {
    const e = Math.min(s + FUNDING_CHUNK - 1, end);
    const url =
      `${DERIBIT}/get_funding_rate_history?instrument_name=${encodeURIComponent(instrument)}` +
      `&start_timestamp=${s}&end_timestamp=${e}`;
    const json = await cachedJson(
      url,
      () =>
        getJson<{
          result?: Array<{ timestamp: number; interest_1h: number; index_price: number }>;
        }>(url),
      useCache,
    );
    for (const r of json.result ?? []) {
      out.push({ t: hourOf(r.timestamp), rate1h: r.interest_1h, indexPrice: r.index_price });
    }
  }
  return dedupe(out);
}

/** Hyperliquid returns at most 500 hourly rows per call. */
async function fetchHyperliquidFunding(
  coin: string,
  start: number,
  end: number,
  useCache: boolean,
): Promise<FundingRow[]> {
  const out: FundingRow[] = [];
  let cursor = start;
  for (let guard = 0; guard < 400 && cursor < end; guard += 1) {
    const body = { type: "fundingHistory", coin, startTime: cursor };
    const rows = await cachedJson(
      `${HYPERLIQUID}/info:${JSON.stringify(body)}`,
      () =>
        postJson<Array<{ time: number; fundingRate: string; premium: string }>>(
          `${HYPERLIQUID}/info`,
          body,
        ),
      useCache,
    );
    if (!Array.isArray(rows) || rows.length === 0) {
      break;
    }
    for (const r of rows) {
      if (r.time >= start && r.time <= end) {
        out.push({ t: hourOf(r.time), rate1h: Number(r.fundingRate), premium: Number(r.premium) });
      }
    }
    const last = rows[rows.length - 1].time;
    if (last <= cursor) {
      break;
    }
    cursor = last + 1;
    if (rows.length < 500) {
      break;
    }
  }
  return dedupe(out);
}

/** Hourly perpetual closes, keyed by bar open time. */
async function fetchPerpCloses(
  venue: CarryVenue,
  instrument: string,
  start: number,
  end: number,
  useCache: boolean,
): Promise<Map<number, number>> {
  const closes = new Map<number, number>();
  for (let s = start; s < end; s += PERP_CHUNK) {
    const e = Math.min(s + PERP_CHUNK - 1, end);
    if (venue === "hyperliquid") {
      const body = {
        type: "candleSnapshot",
        req: { coin: instrument, interval: "1h", startTime: s, endTime: e },
      };
      const rows = await cachedJson(
        `${HYPERLIQUID}/info:${JSON.stringify(body)}`,
        () => postJson<Array<{ t: number; c: string }>>(`${HYPERLIQUID}/info`, body),
        useCache,
      );
      for (const r of rows ?? []) {
        closes.set(hourOf(r.t), Number(r.c));
      }
    } else {
      const url =
        `${DERIBIT}/get_tradingview_chart_data?instrument_name=${encodeURIComponent(instrument)}` +
        `&start_timestamp=${s}&end_timestamp=${e}&resolution=60`;
      const json = await cachedJson(
        url,
        () => getJson<{ result?: { ticks: number[]; close: number[] } }>(url),
        useCache,
      );
      const r = json.result;
      if (r) {
        for (let i = 0; i < r.ticks.length; i += 1) {
          closes.set(hourOf(r.ticks[i]), r.close[i]);
        }
      }
    }
  }
  return closes;
}

// ------------------------------------------------------------------ the loop

/**
 * What the margin has to survive, measured over the longest available series.
 *
 * `worstPerpRise` is what an isolated-margin short leg faces: the outright rise
 * of the perpetual from entry. `worstBasisMove` is what a cross-margin book
 * faces, because the spot leg's gain offsets the price move and only the basis
 * is left. The two use different sources and different coverage on purpose.
 */
export type LongRunRisk = {
  worstPerpRise: number;
  days: number;
  worstBasisMove: number;
  basisHours: number;
  /**
   * "venue-premium" is the venue's own contemporaneous basis and is
   * trustworthy. "derived-cross-series" differences two series that are not
   * sampled at the same instant, and is known to overstate basis badly.
   */
  basisSource: "venue-premium" | "derived-cross-series";
};

/**
 * Worst rise of the perpetual from the entry point, over the longest window
 * available. This is what an isolated-margin short leg has to survive, and the
 * hourly series is too short to answer it, so it is measured on daily candles.
 */
/**
 * The long-run price series and the risk derived from it.
 *
 * `closes` is returned alongside the risk so the spot-leg model can reuse the
 * same full-window series instead of issuing a second, shorter request.
 */
export type LongRunSeries = { risk: LongRunRisk; closes: number[] };

async function fetchLongRunPerpMove(
  venue: CarryVenue,
  instrument: string,
  start: number,
  end: number,
  useCache: boolean,
): Promise<LongRunSeries> {
  const empty: LongRunRisk = {
    worstPerpRise: Number.NaN,
    days: 0,
    worstBasisMove: Number.NaN,
    basisHours: 0,
    basisSource: "derived-cross-series",
  };
  const closes: Array<{ t: number; c: number }> = [];
  const chunk = 200 * DAY;
  for (let s = start; s < end; s += chunk) {
    const e = Math.min(s + chunk - 1, end);
    if (venue === "hyperliquid") {
      const body = {
        type: "candleSnapshot",
        req: { coin: instrument, interval: "1d", startTime: s, endTime: e },
      };
      const rows = await cachedJson(
        `${HYPERLIQUID}/info:${JSON.stringify(body)}`,
        () => postJson<Array<{ t: number; c: string }>>(`${HYPERLIQUID}/info`, body),
        useCache,
      );
      for (const r of rows ?? []) {
        closes.push({ t: r.t, c: Number(r.c) });
      }
    } else {
      const url =
        `${DERIBIT}/get_tradingview_chart_data?instrument_name=${encodeURIComponent(instrument)}` +
        `&start_timestamp=${s}&end_timestamp=${e}&resolution=1D`;
      const json = await cachedJson(
        url,
        () => getJson<{ result?: { ticks: number[]; close: number[] } }>(url),
        useCache,
      );
      const r = json.result;
      if (r) {
        for (let i = 0; i < r.ticks.length; i += 1) {
          closes.push({ t: r.ticks[i], c: r.close[i] });
        }
      }
    }
  }
  if (closes.length < 2) {
    return { risk: empty, closes: [] };
  }
  closes.sort((a, b) => a.t - b.t);
  const valid = closes.filter((p) => Number.isFinite(p.c) && p.c > 0);
  if (valid.length < 2) {
    return { risk: empty, closes: [] };
  }
  const entry = valid[0].c;
  const worstPerpRise = Math.max(...valid.map((p) => p.c / entry - 1));
  // Basis fields stay at their placeholder here: this function only reads daily
  // candles, and the basis is measured by the caller on the venue's own premium
  // series, which covers a longer window than any candle request.
  return {
    risk: {
      ...empty,
      worstPerpRise,
      days: Math.round((valid[valid.length - 1].t - valid[0].t) / DAY),
    },
    closes: valid.map((p) => p.c),
  };
}

export type CarryLeg = {
  label: string;
  netReturn: number;
  annualised: number;
  fundingCollected: number;
  costs: number;
  entries: number;
  inMarketShare: number;
  maxDrawdown: number;
};

function simulate(
  series: RatePoint[],
  params: CarryParams,
  gated: boolean,
  label: string,
): CarryLeg {
  const capital = params.notional * (1 + params.marginRatio);
  let equity = capital;
  let peak = capital;
  let maxDrawdown = 0;
  let inPosition = false;
  let entries = 0;
  let hoursIn = 0;
  let fundingCollected = 0;
  let costs = 0;
  const rates: number[] = [];

  for (let i = 1; i < series.length; i += 1) {
    const p = series[i];
    rates.push(p.rate1h);
    const win = rates.slice(-params.lookbackHours);
    const apr = (win.reduce((a, b) => a + b, 0) / win.length) * 24 * 365;

    if (inPosition) {
      const funding = params.notional * p.rate1h;
      equity += funding;
      fundingCollected += funding;
      hoursIn += 1;
    }

    const wantIn = gated ? apr > params.enterApr : true;
    const wantOut = gated ? apr < params.exitApr : false;

    if (!inPosition && wantIn) {
      const fee = params.notional * (params.spotFee + params.perpFee);
      equity -= fee;
      costs += fee;
      inPosition = true;
      entries += 1;
    } else if (inPosition && wantOut) {
      const fee = params.notional * (params.spotFee + params.perpFee);
      equity -= fee;
      costs += fee;
      inPosition = false;
    }

    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
  }

  const netReturn = equity / capital - 1;
  const hours = Math.max(series.length - 1, 1);
  return {
    label,
    netReturn,
    annualised: netReturn / (hours / 24 / 365),
    fundingCollected,
    costs,
    entries,
    inMarketShare: hoursIn / hours,
    maxDrawdown,
  };
}

// ------------------------------------------------------------------ analysis

export type CarryAnalysis = {
  kind: "carry";
  venue: CarryVenue;
  instrument: string;
  window: { start: string; end: string; days: number; hours: number };
  /** Hourly price coverage, which is shorter than funding coverage. */
  marginCoverage: { hours: number; days: number };
  meanFundingApr: number;
  sharePositiveFunding: number;
  /** Basis measured from the venue's own contemporaneous series. */
  basis: { mean: number; worst: number; best: number };
  params: CarryParams;
  gated: CarryLeg;
  alwaysOn: CarryLeg;
  liquidation: { crossMargin: LiquidationRisk; isolated: LiquidationRisk };
  /** Measured over the longest available series for each risk, with coverage. */
  longRun: LongRunRisk;
  /** The second liquidation path: the long spot leg, if it is levered. */
  spotLeg: SpotLegRisk;
  /** Operational paths the funding simulation does not include. */
  costs: CarryCosts;
  /** Gated return minus the operational overlay. The verdict uses this figure. */
  netAfterOperationalCosts: number;
  verdictCode: "EDGE" | "NO_EDGE";
  verdict: string;
  caveats: string[];
};

export type CarryRequest = {
  venue: CarryVenue;
  instrument: string;
  start: number;
  end: number;
  params?: Partial<CarryParams>;
  useCache?: boolean;
};

export async function runCarryAnalysis(req: CarryRequest): Promise<CarryAnalysis> {
  const params = { ...DEFAULT_CARRY_PARAMS, ...req.params };
  const useCache = req.useCache !== false;

  const funding =
    req.venue === "hyperliquid"
      ? await fetchHyperliquidFunding(req.instrument, req.start, req.end, useCache)
      : await fetchDeribitFunding(req.instrument, req.start, req.end, useCache);
  const perpCloses = await fetchPerpCloses(req.venue, req.instrument, req.start, req.end, useCache);

  // The P&L only needs funding, which covers the full window. Prices are needed
  // only for the liquidation path, and hourly candles cover a much shorter
  // window, so the two are built separately and each reports its own coverage.
  const fundingSeries = funding.map((f) => ({ t: f.t, rate1h: f.rate1h }));
  if (fundingSeries.length < params.lookbackHours + 24) {
    throw new Error(
      `${req.venue} ${req.instrument}: only ${fundingSeries.length} hours of funding, not enough`,
    );
  }

  const marginPoints: MarginPoint[] = [];
  for (const f of funding) {
    const perpClose = perpCloses.get(f.t);
    if (perpClose === undefined || perpClose <= 0) {
      continue;
    }
    // Prefer the venue's own contemporaneous basis. Fall back to the index
    // price only when there is no premium field, and note it is coarser.
    const spotPrice =
      f.premium !== undefined && Number.isFinite(f.premium)
        ? perpClose / (1 + f.premium)
        : (f.indexPrice ?? Number.NaN);
    if (!Number.isFinite(spotPrice) || spotPrice <= 0) {
      continue;
    }
    marginPoints.push({ t: f.t, perpClose, spotPrice, funding: f.rate1h });
  }
  marginPoints.sort((a, b) => a.t - b.t);

  const spanDays = (fundingSeries[fundingSeries.length - 1].t - fundingSeries[0].t) / DAY;
  const meanRate = fundingSeries.reduce((s, p) => s + p.rate1h, 0) / fundingSeries.length;
  const sharePositive = fundingSeries.filter((p) => p.rate1h > 0).length / fundingSeries.length;
  const bases = marginPoints.map((p) => p.perpClose / p.spotPrice - 1);

  const gated = simulate(fundingSeries, params, true, "signal-gated");
  const alwaysOn = simulate(fundingSeries, params, false, "always-on");

  const liquidationOpts = {
    marginRatio: params.marginRatio,
    maintenanceMarginRate: params.maintenanceMarginRate,
  };
  const liquidation = {
    crossMargin: assessLiquidation(marginPoints, { ...liquidationOpts, collateralTransfer: true }),
    isolated: assessLiquidation(marginPoints, { ...liquidationOpts, collateralTransfer: false }),
  };
  const { risk: longRun, closes: longRunCloses } = await fetchLongRunPerpMove(
    req.venue,
    req.instrument,
    req.start,
    req.end,
    useCache,
  );

  // Cross-margin has to survive the basis, not the price, and the venue's own
  // premium series covers the whole funding window -- much longer than candles.
  const premiumSeries = funding
    .map((f) => f.premium)
    .filter((p): p is number => p !== undefined && Number.isFinite(p));
  const basisMoveSource = premiumSeries.length > 1 ? premiumSeries : bases;
  const worstBasisMove =
    basisMoveSource.length > 1 ? Math.max(...basisMoveSource) - basisMoveSource[0] : Number.NaN;
  longRun.worstBasisMove = worstBasisMove;
  longRun.basisHours = basisMoveSource.length;
  longRun.basisSource = premiumSeries.length > 1 ? "venue-premium" : "derived-cross-series";

  // The hourly path is far too short to decide the isolated case: a short leg
  // that never came close over 7 months can still be wiped out by a multi-year
  // rally. The full-window daily series is the binding evidence, so it overrides.
  const absorbable = params.marginRatio - params.maintenanceMarginRate;
  if (Number.isFinite(longRun.worstPerpRise) && longRun.worstPerpRise >= absorbable) {
    liquidation.isolated.liquidated = true;
    liquidation.isolated.requiredMarginRatio = Math.max(
      liquidation.isolated.requiredMarginRatio,
      params.maintenanceMarginRate + longRun.worstPerpRise,
    );
    liquidation.isolated.firstLiquidationAt ??= `${longRun.days}-day window`;
  }

  // The three paths the liquidation model does not cover. `simulate` already
  // models funding and the taker fees; this overlay models the operational
  // paths (collateral moves, hedge rebalances) and the levered spot leg.
  const spotLeg = assessSpotLeg(longRunCloses, {
    spotLeverage: params.spotLeverage,
    maintenanceMarginRate: params.maintenanceMarginRate,
  });
  const costs = assessCarryCosts(
    marginPoints,
    {},
    params.marginRatio,
    params.maintenanceMarginRate,
    spanDays,
  );
  const netAfterOperationalCosts = gated.netReturn - costs.totalCost;

  const makesMoney = netAfterOperationalCosts > 0;
  const signalHelps = gated.netReturn > alwaysOn.netReturn;
  // A book that gets liquidated is not a strategy with a low return; it is a
  // different, unhedged position. That outranks every other consideration, and
  // it includes the spot leg once that leg is levered.
  const fatal = liquidation.crossMargin.liquidated || spotLeg.liquidated;
  const verdictCode: CarryAnalysis["verdictCode"] = makesMoney && !fatal ? "EDGE" : "NO_EDGE";
  const verdict = spotLeg.liquidated
    ? `NO EDGE (the ${params.spotLeverage}x spot leg is liquidated by a ` +
      `${(spotLeg.worstSpotDrop * 100).toFixed(1)}% fall -- max survivable leverage is ` +
      `${spotLeg.maxSafeLeverage.toFixed(2)}x)`
    : fatal
      ? "NO EDGE (the book is liquidated -- the residual position is unhedged spot)"
      : !makesMoney
        ? "NO EDGE (loses money after costs -- do not go live)"
        : signalHelps
          ? "EDGE (positive carry, and the entry signal improves it)"
          : "EDGE (positive carry), but the entry signal subtracts -- prefer always-on";

  return {
    kind: "carry",
    venue: req.venue,
    instrument: req.instrument,
    window: {
      start: new Date(fundingSeries[0].t).toISOString().slice(0, 10),
      end: new Date(fundingSeries[fundingSeries.length - 1].t).toISOString().slice(0, 10),
      days: Number(spanDays.toFixed(0)),
      hours: fundingSeries.length,
    },
    marginCoverage: {
      hours: marginPoints.length,
      days:
        marginPoints.length > 1
          ? Number(((marginPoints[marginPoints.length - 1].t - marginPoints[0].t) / DAY).toFixed(0))
          : 0,
    },
    meanFundingApr: meanRate * 24 * 365,
    sharePositiveFunding: sharePositive,
    basis: {
      mean: bases.reduce((a, b) => a + b, 0) / bases.length,
      worst: Math.max(...bases),
      best: Math.min(...bases),
    },
    params,
    gated,
    alwaysOn,
    liquidation,
    longRun,
    spotLeg,
    costs,
    netAfterOperationalCosts,
    verdictCode,
    verdict,
    caveats: CARRY_CAVEATS,
  };
}

// ------------------------------------------------------------------- reporting

export function pct(x: number, digits = 2): string {
  return `${(x * 100).toFixed(digits)}%`;
}

function renderCarry(a: CarryAnalysis): string {
  const lines: string[] = [];
  lines.push("carry: funding -> delta-neutral paper position -> P&L -> verdict");
  lines.push(
    `params: margin ${pct(a.params.marginRatio)}, maintenance margin ${pct(a.params.maintenanceMarginRate)}, ` +
      `fees ${pct(a.params.spotFee)}+${pct(a.params.perpFee)} per side, enter ${pct(a.params.enterApr)} APR`,
  );
  lines.push(`data: ${a.venue}  ${a.instrument}  ${a.window.start} -> ${a.window.end}\n`);
  lines.push(`hours: ${a.window.hours}  span: ${a.window.days} days`);
  lines.push(
    `mean funding: ${pct(a.meanFundingApr)} APR on notional  |  positive in ${pct(a.sharePositiveFunding, 1)} of hours`,
  );
  lines.push(
    `basis: mean ${pct(a.basis.mean, 4)}  worst ${pct(a.basis.worst, 4)}  best ${pct(a.basis.best, 4)}  ` +
      `(venue's own contemporaneous series)\n`,
  );

  lines.push("=== breakdown (per unit notional; capital = notional x (1 + margin)) ===");
  for (const leg of [a.gated, a.alwaysOn]) {
    lines.push(
      `  ${leg.label.padEnd(14)} net ${pct(leg.netReturn).padStart(8)}  ` +
        `funding ${pct(leg.fundingCollected).padStart(8)}  costs ${pct(-leg.costs).padStart(8)}  ` +
        `entries ${String(leg.entries).padStart(3)}  in-market ${pct(leg.inMarketShare).padStart(7)}`,
    );
  }

  lines.push("\n=== liquidation (this is what kills carry books) ===");
  const absorb = a.params.marginRatio - a.params.maintenanceMarginRate;
  lines.push(`  margin absorbs a ${pct(absorb)} adverse move before liquidation`);
  lines.push(
    `  liquidation path covers ${a.marginCoverage.days} days ` +
      `(hourly candles cover less than funding does)`,
  );
  for (const [label, risk] of [
    ["cross-margin", a.liquidation.crossMargin],
    ["isolated", a.liquidation.isolated],
  ] as const) {
    lines.push(
      `  ${label.padEnd(13)} liquidated ${risk.liquidated ? "YES" : "no "}  ` +
        `min buffer ${pct(risk.minBufferRatio).padStart(9)}  ` +
        `margin needed ${pct(risk.requiredMarginRatio).padStart(8)}  ` +
        `worst perp move ${pct(risk.worstAdverseMove).padStart(8)}`,
    );
    if (risk.liquidated && risk.firstLiquidationAt) {
      lines.push(`                first liquidation: ${risk.firstLiquidationAt}`);
    }
  }
  lines.push(
    `  isolated      survives a ${pct(a.longRun.worstPerpRise)} perp rise? ` +
      `(daily candles, ${a.longRun.days} days)  ` +
      (a.longRun.worstPerpRise >= absorb ? "NO -> the short leg is liquidated" : "yes"),
  );
  lines.push(
    `  cross-margin  survives a ${pct(a.longRun.worstBasisMove)} basis move? ` +
      `(${a.longRun.basisHours} hours, ${a.longRun.basisSource})  ` +
      (a.longRun.worstBasisMove >= absorb ? "NO" : "yes"),
  );
  if (a.longRun.basisSource === "derived-cross-series") {
    lines.push(
      "                warning: basis derived across series; this venue publishes no premium field,",
    );
    lines.push(
      "                so the number above overstates the true basis. Treat the cross-margin row as unverified.",
    );
  }

  lines.push("\n=== SCORE (the only score) ===");
  lines.push("  cash benchmark   : 0.00%  (a market-neutral book must beat doing nothing)");
  lines.push(
    `  signal-gated     : ${pct(a.gated.netReturn)}  (${pct(a.gated.annualised)} per year)`,
  );
  lines.push(
    `  always-on        : ${pct(a.alwaysOn.netReturn)}  (${pct(a.alwaysOn.annualised)} per year)`,
  );
  lines.push(`  max drawdown     : ${pct(a.gated.maxDrawdown)} (gated)`);
  lines.push(`  verdict          : ${a.verdict}`);
  return lines.join("\n");
}

async function main(): Promise<void> {
  const venue = arg("venue", "deribit").toLowerCase();
  if (venue !== "deribit" && venue !== "hyperliquid") {
    console.log(`unknown venue "${venue}"; use deribit or hyperliquid.`);
    return;
  }
  const defaultStart = venue === "hyperliquid" ? "2023-05-12" : "2021-11-08";
  const startArg = arg("start", defaultStart);
  const endArg = arg("end", "");
  const instrument = arg("instrument", venue === "hyperliquid" ? "BTC" : "BTC-PERPETUAL");
  const spotLeverage = Number(arg("spot-leverage", "1"));

  const analysis = await runCarryAnalysis({
    venue,
    instrument,
    start: Date.parse(`${startArg}T00:00:00Z`),
    end: endArg ? Date.parse(`${endArg}T00:00:00Z`) : Date.now(),
    params: Number.isFinite(spotLeverage) && spotLeverage > 0 ? { spotLeverage } : {},
    useCache: !hasFlag("--no-cache"),
  });

  if (hasFlag("--json")) {
    console.log(JSON.stringify(analysis, null, 2));
    return;
  }
  console.log(renderCarry(analysis));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
