/**
 * The daytime cycle: everything that can be done without a model.
 *
 * Two properties are load-bearing here, and both exist because the naive version is wrong:
 *
 * 1. The signal is anchored to the last COMPLETED month end, never to "today". Recomputing a
 *    rolling 12-month return against today's price every day makes the sign flip mid-month on
 *    noise, which turns a monthly rule into a daily one and destroys the measured ~0.77
 *    direction changes per year. Anchoring keeps the signal constant for the whole month, so
 *    the only thing that moves day to day is price drift — which is a legitimate reason to
 *    rebalance, and not a new bet.
 *
 * 2. Drift, not signal, is what triggers daytime trades. Weights are risk-normalised
 *    (inverse volatility), and a position is only touched when it drifts outside a declared
 *    band. "Daytime must do work" is satisfied by checking every day; it is not satisfied by
 *    inventing a fresh signal every day.
 *
 * There is no model call anywhere in this file. That is deliberate: the answer to
 * "will an LLM-driven day be expensive?" is that the daytime does not need one.
 */

import {
  fetchAlpacaVenueState,
  runFinanceAlpacaOrder,
  type AlpacaVenueState,
} from "./finance-alpaca-run.js";
import type { FinanceExecutionReceipt } from "./finance-execution-adapter.js";
import { createChinaReachableUsEodHistoryCollectionAdapter } from "./finance-free-market-collection-adapters.js";
import { runFinancePaperOrder } from "./finance-paper-run.js";
import type { FinancePosition } from "./finance-position-ledger.js";
import {
  appendFinanceExecutionReceipt,
  appendFinancePositionMark,
  projectFinancePositions,
  readFinancePositionLedger,
} from "./finance-position-ledger.js";
import { resolveFinanceStateDir } from "./finance-state-dir.js";

export const FINANCE_DAILY_CYCLE_SCHEMA = "lcx_finance_daily_cycle_v1" as const;

/**
 * Both order paths return the same shape, so the cycle can treat them identically and a
 * per-instrument failure becomes a refusal instead of an aborted run.
 */
type FinanceCycleOrderOutcome =
  | Awaited<ReturnType<typeof runFinanceAlpacaOrder>>
  | Awaited<ReturnType<typeof runFinancePaperOrder>>;

export type FinanceDailyCycleCaps = Readonly<{
  maxOrderNotional: number;
  maxInstrumentNotional: number;
  maxOrdersPerRun: number;
}>;

export type FinanceDailyCycleParams = Readonly<{
  instruments: readonly string[];
  equity: number;
  asOf: string;
  caps: FinanceDailyCycleCaps;
  runAuthorizationId: string;
  /** Absolute weight difference that must be exceeded before a position is touched. */
  rebalanceBand?: number;
  /**
   * Actually place orders. Off by default: a plan is not an order.
   *
   * `paper` is the local simulator: no venue, no credential, fills labelled `paper:`.
   * `alpaca` reaches Alpaca's paper host with the configured `PK…` key; live has to be
   * asked for separately and is never the default here.
   */
  place?: boolean;
  venue?: "paper" | "alpaca";
  directory?: string;
  slippageBps?: number;
}>;

export type FinanceDailyCycleTarget = Readonly<{
  instrument: string;
  signal: "hold" | "cash";
  weight: number;
  annualisedVol: number;
  lastBarDate: string;
  close: number;
}>;

export type FinanceDailyCycleDrift = Readonly<{
  instrument: string;
  target: number;
  current: number;
  delta: number;
  action: "buy" | "sell" | "none";
  notional: number;
}>;

export type FinanceDailyCycleReport = Readonly<{
  schemaVersion: typeof FINANCE_DAILY_CYCLE_SCHEMA;
  ok: boolean;
  asOf: string;
  /** Month end the signal was computed from. Constant within a calendar month. */
  signalAnchor: string;
  modelCalls: 0;
  targets: readonly FinanceDailyCycleTarget[];
  drift: readonly FinanceDailyCycleDrift[];
  dataIssues: readonly string[];
  placed: readonly { instrument: string; quantity: number; notional: number }[];
  refusals: readonly string[];
}>;

type Bar = Readonly<{ date: string; close: number }>;

/** The last month end whose month is strictly before `asOf`'s month. */
export function lastCompletedMonthEnd(months: readonly Bar[], asOf: string): Bar | undefined {
  const asOfMonth = asOf.slice(0, 7);
  for (let index = months.length - 1; index >= 0; index -= 1) {
    const candidate = months[index];
    if (candidate && candidate.date.slice(0, 7) < asOfMonth) {
      return candidate;
    }
  }
  return undefined;
}

function monthEnds(series: readonly Bar[]): Bar[] {
  const byMonth = new Map<string, Bar>();
  for (const row of series) {
    const key = row.date.slice(0, 7);
    const previous = byMonth.get(key);
    if (!previous || row.date > previous.date) {
      byMonth.set(key, row);
    }
  }
  return [...byMonth.values()].toSorted((a, b) => a.date.localeCompare(b.date));
}

/**
 * Reverse-solve the stop distance so the compiler's risk sizing lands on the intended notional.
 *
 * The compiler sizes as `equity * maxRiskPerTradeFraction / stopDistance`. Feeding it a fixed
 * 15% stop gives every instrument the same ~6.5k regardless of its target weight, which quietly
 * flattens the inverse-volatility allocation the whole strategy exists to express: SPY wanted
 * 21k and GLD 9k, and both got ~6k. Solving `stopDistance = equity * f / notional` instead makes
 * the risk budget carry the allocation.
 *
 * The clamp is not decoration. A tiny notional solves to a very wide stop and a large one to a
 * stop so tight that ordinary noise would trigger it, so the answer is bounded to a range a
 * trend strategy can actually survive. Inside the band the sizing is exact; outside it the cap
 * still binds and the residual is carried to the next session.
 */
export function solveInvalidationPrice(close: number, notional: number, equity: number): number {
  const RISK_FRACTION = 0.01;
  const MIN_STOP = 0.05;
  const MAX_STOP = 0.3;
  const raw = notional > 0 && equity > 0 ? (equity * RISK_FRACTION) / notional : MAX_STOP;
  const stop = Math.min(Math.max(raw, MIN_STOP), MAX_STOP);
  return Number((close * (1 - stop)).toFixed(2));
}

export function annualisedVol(dailyCloses: readonly number[]): number {
  if (dailyCloses.length < 30) {
    return Number.NaN;
  }
  const returns: number[] = [];
  for (let index = 1; index < dailyCloses.length; index += 1) {
    const previous = dailyCloses[index - 1];
    const current = dailyCloses[index];
    if (previous && current && previous > 0) {
      returns.push(Math.log(current / previous));
    }
  }
  if (returns.length < 30) {
    return Number.NaN;
  }
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance =
    returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance * 252);
}

/**
 * Turn ledger positions into current weights.
 *
 * A held position whose price cannot be read is NOT a flat book, and it is not returned as a
 * zero weight either — it is returned in `unpriced` so the caller can say so. Handing back a
 * silent zero is the whole duplicate-order failure: the cycle then computes current = 0 for
 * something it already owns and buys it again.
 *
 * Flat positions (`quantity === 0`) are neither weighted nor unpriced: there is nothing to
 * price and nothing to protect.
 */
export function currentWeightsFromPositions(
  positions: readonly FinancePosition[],
  equity: number,
): { weights: ReadonlyMap<string, number>; unpriced: readonly string[] } {
  const weights = new Map<string, number>();
  const unpriced = new Set<string>();
  for (const position of positions) {
    const symbol = position.instrument.toUpperCase();
    if (position.quantity === 0) {
      continue;
    }
    const price = position.markPrice;
    if (price === undefined || !Number.isFinite(price) || price <= 0) {
      unpriced.add(symbol);
      continue;
    }
    if (equity <= 0) {
      continue;
    }
    weights.set(symbol, (position.quantity * price) / equity);
  }
  return { weights, unpriced: [...unpriced].toSorted() };
}

/**
 * Check one instrument against the venue before trading it, or return why not.
 *
 * The venue is the authoritative book, so "did the last order fill?" is answered by asking it
 * rather than by remembering it. Two things stop a trade, and both are about buying the same
 * thing twice:
 *
 * 1. An order is still open there — placing another is a duplicate by construction.
 * 2. The venue holds a quantity the local ledger does not know about — the ledger missed a
 *    fill, and sizing from it would buy into a position that is already bigger than it thinks.
 *
 * `null` means "nothing to report, trade it".
 */
export function venueReconciliationIssue(params: {
  instrument: string;
  openOrders: number;
  /** Signed quantity the venue reports. `undefined` is "unknown", which is not the same as 0. */
  venueQuantity?: number;
  ledgerQuantity: number;
}): string | null {
  if (params.openOrders > 0) {
    return (
      `venue already has ${params.openOrders} open order(s) for this instrument; ` +
      `refusing to place another`
    );
  }
  if (params.venueQuantity === undefined) {
    return null;
  }
  if (Math.abs(params.venueQuantity - params.ledgerQuantity) > 1e-6) {
    return (
      `out of sync with the venue: it holds ${params.venueQuantity}, the ledger says ` +
      `${params.ledgerQuantity}; refusing to size from a book that disagrees`
    );
  }
  return null;
}

/**
 * The receipts that belong to the book this run is actually trading.
 *
 * The ledger keeps simulated and venue fills in one append-only stream, and it counts them
 * apart precisely so a simulated book is never read as a real one. Reading the whole stream
 * here undoes that: a `--venue paper` fill will never appear at the venue, so carrying it into
 * an alpaca run makes `venueReconciliationIssue` disagree on every instrument, forever, with
 * no way to recover — one rehearsal would permanently brick the live path.
 */
export function receiptsForVenue(
  receipts: readonly FinanceExecutionReceipt[],
  venue: "paper" | "alpaca",
): readonly FinanceExecutionReceipt[] {
  if (venue === "paper") {
    return receipts.filter((receipt) => receipt.adapterKind === "paper");
  }
  return receipts.filter(
    (receipt) => receipt.adapterKind === "venue" && receipt.venue.startsWith("alpaca"),
  );
}

export type FinanceCycleFillRecord = Readonly<{
  /** Whether the ledger now knows about this fill. */
  recorded: boolean;
  /**
   * Whether the position can be priced. The next cycle reads current weights from the mark, so
   * a fill without one is a position that will be mistaken for an empty book tomorrow.
   */
  marked: boolean;
  /** Filled quantity. Zero when the venue reported no fill. */
  quantity: number;
  /** What the fill actually cost: filled quantity times the price the venue reports. */
  notional: number;
  /** Notional committed to this instrument after this fill, including what came before. */
  committedNotional: number;
  /** Non-null whenever the operator has to look at this by hand. */
  refusal: string | null;
}>;

/**
 * Remember a fill, or say why it could not be remembered.
 *
 * The ledger is the only memory the next cycle has: reading it is how `current` weights are
 * computed. Skipping this write means tomorrow reads a flat book, recomputes the same drift and
 * buys the same thing again — the duplicate-order failure, one layer above the one the fill
 * poll addresses.
 *
 * A fill that cannot be written is still committed money, so it counts toward the instrument
 * cap whether or not the write succeeded; the refusal is what tells the operator it happened.
 */
export async function recordCycleFill(params: {
  directory: string;
  receipt: FinanceExecutionReceipt;
  committedNotional?: number;
}): Promise<FinanceCycleFillRecord> {
  const { receipt } = params;
  const previous = params.committedNotional ?? 0;
  const quantity = receipt.fill.filledQuantity;
  const notional = Number((quantity * receipt.fill.fillPrice).toFixed(2));

  if (quantity <= 0) {
    return Object.freeze({
      recorded: false,
      marked: false,
      quantity: 0,
      notional: 0,
      committedNotional: previous,
      refusal: `order accepted but the venue reported no fill (${receipt.fill.venueRef})`,
    });
  }

  try {
    await appendFinanceExecutionReceipt(params.directory, receipt);
  } catch (error) {
    return Object.freeze({
      recorded: false,
      marked: false,
      quantity,
      notional,
      committedNotional: previous + receipt.notional,
      refusal:
        `filled ${quantity} but the ledger write failed — ` +
        (error instanceof Error ? error.message : String(error)),
    });
  }

  // The mark is what the next cycle prices this position with. Without it the position exists
  // but has no weight, which reads exactly like an empty book — and buys it again.
  try {
    await appendFinancePositionMark(params.directory, {
      instrument: receipt.instrument,
      price: receipt.fill.fillPrice,
      at: receipt.fill.filledAt,
    });
  } catch (error) {
    return Object.freeze({
      recorded: true,
      marked: false,
      quantity,
      notional,
      committedNotional: previous + receipt.notional,
      refusal:
        `filled ${quantity} and recorded, but the mark write failed — ` +
        (error instanceof Error ? error.message : String(error)),
    });
  }

  return Object.freeze({
    recorded: true,
    marked: true,
    quantity,
    notional,
    committedNotional: previous + receipt.notional,
    refusal: null,
  });
}

/**
 * One instrument's order attempt, with the failure contained to that instrument.
 *
 * The order path throws for reasons that say nothing about the rest of the book: a symbol the
 * venue will not accept, a transport error, or a refusal to report an unknown fill state.
 * Letting one of those escape would abort the cycle mid-book, so the remaining targets would
 * never even be considered — and the run would report nothing about them at all.
 */
export async function attemptCycleOrder(
  attempt: () => Promise<FinanceCycleOrderOutcome>,
): Promise<FinanceCycleOrderOutcome> {
  try {
    return await attempt();
  } catch (error) {
    return Object.freeze({
      ok: false as const,
      stage: "place" as const,
      refusals: Object.freeze([
        `order path threw — ${error instanceof Error ? error.message : String(error)}`,
      ]),
    });
  }
}

export async function runFinanceDailyCycle(
  params: FinanceDailyCycleParams,
): Promise<FinanceDailyCycleReport> {
  const asOf = params.asOf;
  const band = params.rebalanceBand ?? 0.05;
  const instruments = params.instruments.map((item) => item.toUpperCase());
  const dataIssues: string[] = [];
  const refusals: string[] = [];
  const placed: { instrument: string; quantity: number; notional: number }[] = [];

  const adapter = createChinaReachableUsEodHistoryCollectionAdapter();
  const monthSeries = new Map<string, Bar[]>();
  const closes = new Map<string, number[]>();
  const lastBar = new Map<string, Bar>();

  for (const instrument of instruments) {
    try {
      const rows = await adapter.collect(
        {
          instrument,
          assetClass: "us_equity",
          collection: "eod_history",
          asOf,
          limit: 8000,
        },
        AbortSignal.timeout(60_000),
      );
      const series = rows
        .map((row) => ({
          // A non-string date stringified would be "[object Object]", which then fails the
          // filter below and reads as "no data". Asking the type is cheaper than debugging that.
          date: typeof row.data.date === "string" ? row.data.date : "",
          close: Number(row.data.close),
        }))
        .filter(
          (row) =>
            /^\d{4}-\d{2}-\d{2}$/u.test(row.date) && Number.isFinite(row.close) && row.close > 0,
        )
        .toSorted((a, b) => a.date.localeCompare(b.date));
      if (series.length < 400) {
        dataIssues.push(`${instrument}: only ${series.length} bars, need >= 400`);
        continue;
      }
      monthSeries.set(instrument, monthEnds(series));
      closes.set(
        instrument,
        series.slice(-253).map((row) => row.close),
      );
      lastBar.set(instrument, series[series.length - 1]);
    } catch (error) {
      dataIssues.push(`${instrument}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Signal: anchored to the last completed month end, constant for the whole month.
  const anchorMonthEnds = new Map<string, Bar>();
  const anchors = new Set<string>();
  for (const [instrument, months] of monthSeries) {
    const anchor = lastCompletedMonthEnd(months, asOf);
    if (anchor) {
      anchorMonthEnds.set(instrument, anchor);
      anchors.add(anchor.date);
    }
  }
  if (anchors.size === 0) {
    dataIssues.push("no completed month end available for any instrument");
  }
  const signalAnchor = [...anchors].toSorted().at(-1) ?? "";

  const raw: { instrument: string; signal: "hold" | "cash"; inverseVol: number; vol: number }[] =
    [];
  for (const instrument of instruments) {
    const months = monthSeries.get(instrument);
    const anchor = anchorMonthEnds.get(instrument);
    const priceSeries = closes.get(instrument);
    if (!months || !anchor || !priceSeries) {
      continue;
    }
    const anchorIndex = months.findIndex((row) => row.date === anchor.date);
    const prior = months[anchorIndex - 12];
    if (!prior) {
      dataIssues.push(`${instrument}: fewer than 13 month ends before anchor`);
      continue;
    }
    const vol = annualisedVol(priceSeries);
    if (!Number.isFinite(vol) || vol <= 0) {
      dataIssues.push(`${instrument}: volatility could not be estimated`);
      continue;
    }
    const totalReturn = anchor.close / prior.close - 1;
    raw.push({
      instrument,
      signal: totalReturn > 0 ? "hold" : "cash",
      inverseVol: 1 / vol,
      vol,
    });
  }

  const eligible = raw.filter((row) => row.signal === "hold");
  const inverseSum = eligible.reduce((sum, row) => sum + row.inverseVol, 0);
  const targets: FinanceDailyCycleTarget[] = raw.map((row) => ({
    instrument: row.instrument,
    signal: row.signal,
    weight: row.signal === "hold" && inverseSum > 0 ? row.inverseVol / inverseSum : 0,
    annualisedVol: row.vol,
    lastBarDate: lastBar.get(row.instrument)?.date ?? "",
    close: lastBar.get(row.instrument)?.close ?? Number.NaN,
  }));

  // Current weights from the actual ledger, not from an assumed book.
  const directory = params.directory ?? resolveFinanceStateDir().directory;
  let currentWeight: ReadonlyMap<string, number> = new Map();
  const unpricedPositions = new Set<string>();
  const ledgerQuantity = new Map<string, number>();
  try {
    const ledger = await readFinancePositionLedger(directory, { asOf });
    // Sizing and reconciliation both have to see the book this run trades, not every fill the
    // ledger has ever seen. See `receiptsForVenue`.
    const book = projectFinancePositions({
      receipts: receiptsForVenue(ledger.receipts, params.venue ?? "paper"),
      marks: ledger.marks,
    });
    const derived = currentWeightsFromPositions(book.positions, params.equity);
    currentWeight = derived.weights;
    for (const symbol of derived.unpriced) {
      unpricedPositions.add(symbol);
    }
    for (const position of book.positions) {
      ledgerQuantity.set(position.instrument.toUpperCase(), position.quantity);
    }
  } catch {
    dataIssues.push("position ledger unreadable; treating book as flat");
  }
  if (unpricedPositions.size > 0) {
    dataIssues.push(`held but unpriced (no mark): ${[...unpricedPositions].toSorted().join(", ")}`);
  }

  // Only the part OUTSIDE the band is traded, and never more than the declared cap.
  //
  // Trading the full delta would make a first build concentrate the whole book into one day and
  // blow the per-order cap (SPY alone wants ~21k of a 100k book). Trading the excess instead
  // means the book converges over a few sessions, which is both cap-safe and honest: a target
  // weight is a destination, not a single order.
  const drift: FinanceDailyCycleDrift[] = targets.map((target) => {
    const current = currentWeight.get(target.instrument) ?? 0;
    const delta = target.weight - current;
    const excess = Math.max(0, Math.abs(delta) - band);
    const desiredNotional = excess * params.equity;
    const notional = Math.min(desiredNotional, params.caps.maxOrderNotional);
    const action = excess <= 0 ? "none" : delta > 0 ? "buy" : "sell";
    return {
      instrument: target.instrument,
      target: Number(target.weight.toFixed(4)),
      current: Number(current.toFixed(4)),
      delta: Number(delta.toFixed(4)),
      action,
      notional: Number(notional.toFixed(2)),
    };
  });

  // Notional already committed to each instrument *in this run*. Without it every order looks
  // like the first one of the run and both declared caps (`maxOrdersPerRun`,
  // `maxInstrumentNotional`) silently stop being enforced.
  const committedNotional = new Map<string, number>();

  // Ask the venue what it holds before trading, once per run. It is the authoritative book:
  // a fill the local ledger missed shows up here and nowhere else.
  let venueState: AlpacaVenueState | null = null;
  let venueUnverified: string | null = null;
  if (params.place === true && params.venue === "alpaca") {
    const read = await fetchAlpacaVenueState();
    if (read.ok) {
      venueState = read.state;
    } else {
      venueUnverified = read.reason;
      dataIssues.push(`venue state unreadable: ${read.reason}`);
    }
  }

  if (params.place === true) {
    for (const item of drift) {
      if (item.action === "none") {
        continue;
      }
      const target = targets.find((row) => row.instrument === item.instrument);
      if (!target || !Number.isFinite(target.close) || target.close <= 0) {
        refusals.push(`${item.instrument}: no usable reference price`);
        continue;
      }
      if (venueUnverified !== null) {
        refusals.push(
          `${item.instrument}: venue state unreadable (${venueUnverified}); ` +
            `refusing to trade against a book that cannot be verified`,
        );
        continue;
      }
      if (venueState !== null) {
        const issue = venueReconciliationIssue({
          instrument: item.instrument,
          openOrders: venueState.openOrders.get(item.instrument) ?? 0,
          venueQuantity: venueState.positions.get(item.instrument) ?? 0,
          ledgerQuantity: ledgerQuantity.get(item.instrument) ?? 0,
        });
        if (issue !== null) {
          refusals.push(`${item.instrument}: ${issue}`);
          continue;
        }
      }
      if (unpricedPositions.has(item.instrument)) {
        // Sizing against a book whose current weight is unknown is how the same position gets
        // bought twice. Everything this run can still do correctly, it does — just not here.
        refusals.push(
          `${item.instrument}: held but the ledger has no mark price; refusing to size against an unknown book`,
        );
        continue;
      }
      const shared = {
        conclusion: {
          conclusionId: `daily_cycle:${signalAnchor}:${item.instrument}`,
          instrument: item.instrument,
          direction: item.action,
          conviction: 1,
          assetClass: "us_equity",
          horizonDays: 30,
          invalidationPrice: solveInvalidationPrice(target.close, item.notional, params.equity),
          thesis:
            `Daily drift rebalance against frozen monthly target (anchor ${signalAnchor}). ` +
            `target=${item.target} current=${item.current} band=${band}.`,
          invalidationCondition: "monthly signal flips to cash, or drift returns inside band",
        },
        market: {
          referencePrice: target.close,
          referencePriceAt: `${target.lastBarDate}T20:00:00.000Z`,
        },
        equity: params.equity,
        runAuthorizationId: params.runAuthorizationId,
        budget: {
          automation: "unattended",
          allowedInstruments: instruments,
          maxOrderNotional: params.caps.maxOrderNotional,
          maxInstrumentNotional: params.caps.maxInstrumentNotional,
          maxOrdersPerRun: params.caps.maxOrdersPerRun,
        },
        instruments,
        ordersPlacedThisRun: placed.length,
        committedInstrumentNotional: committedNotional.get(item.instrument) ?? 0,
      } as const;
      // Slippage is a modelling assumption the local simulator needs and the venue does not:
      // an Alpaca fill reports the price it actually got, so passing a modelled one would
      // silently overwrite a real observation with a guess.
      //
      const result = await attemptCycleOrder(() =>
        params.venue === "alpaca"
          ? runFinanceAlpacaOrder(shared)
          : runFinancePaperOrder({
              ...shared,
              ...(params.slippageBps === undefined ? {} : { slippageBps: params.slippageBps }),
            }),
      );
      if (!result.ok) {
        refusals.push(`${item.instrument}: ${result.refusals.join("; ")}`);
        continue;
      }
      const record = await recordCycleFill({
        directory,
        receipt: result.receipt,
        committedNotional: committedNotional.get(item.instrument) ?? 0,
      });
      committedNotional.set(item.instrument, record.committedNotional);
      if (record.refusal !== null) {
        refusals.push(`${item.instrument}: ${record.refusal}`);
      }
      if (!record.recorded) {
        continue;
      }
      placed.push({
        instrument: item.instrument,
        quantity: record.quantity,
        notional: record.notional,
      });
    }
  }

  return Object.freeze({
    schemaVersion: FINANCE_DAILY_CYCLE_SCHEMA,
    ok: dataIssues.length === 0,
    asOf,
    signalAnchor,
    modelCalls: 0,
    targets,
    drift,
    dataIssues,
    placed,
    refusals,
  });
}
