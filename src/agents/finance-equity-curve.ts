/**
 * Equity-curve seam: turn the durable receipt+mark stream into gross marked-value levels.
 *
 * The metrics themselves already exist (`src/agents/tools/quant-math-tool.ts`: max drawdown,
 * drawdown duration, CAGR, Calmar, Sharpe, Sortino, tracking error, ...). This module
 * deliberately computes **none** of them. What was missing is the step before: the ledger
 * stores fills and marks, and nothing turned those into the level series a metric needs.
 * That is the only job here, and it is why this module is separate from the ledger — the
 * dependency runs one way (`equity-curve -> position-ledger`) and never back.
 *
 * Three honesty rules:
 *
 * 1. A sample carries a defined equity only when every open position has a mark at or before
 *    that instant. Otherwise the instant is named in `undefinedEquityAt` and is **not**
 *    interpolated into `levels` — a curve with holes must say it has holes.
 * 2. The curve is sampled at mark instants only, because that is the only price information
 *    the ledger holds. It makes no claim about what happened *between* two marks, which is
 *    also why any annualised metric needs the caller to declare a sampling period rather
 *    than inheriting the metrics library's 252-day default.
 * 3. Fills recorded after the last mark cannot appear in any sample. They are counted in
 *    `receiptsAfterLastMark` instead of being silently dropped.
 */

import type { FinanceExecutionReceipt } from "./finance-execution-adapter.js";
import {
  projectFinancePositions,
  readFinancePositionRecords,
  type FinancePositionMark,
} from "./finance-position-ledger.js";

export const FINANCE_EQUITY_CURVE_SCHEMA = "lcx_finance_equity_curve_v2" as const;

export type FinanceEquitySample = Readonly<{
  at: string;
  realizedPnl: number;
  unrealizedPnl: number | null;
  /** Gross proxy: `initialCapital + realizedPnl + unrealizedPnl`; not brokerage net equity. */
  equity: number | null;
  openInstruments: readonly string[];
  instrumentsWithoutMark: readonly string[];
}>;

export type FinanceEquityCurve = Readonly<{
  schemaVersion: typeof FINANCE_EQUITY_CURVE_SCHEMA;
  boundary: "equity_curve_from_ledger_stream_only";
  pnlBasis: "gross_fill_price_only";
  initialCapital: number;
  sampleCount: number;
  samples: readonly FinanceEquitySample[];
  /** Equity levels, aligned with `levelTimestamps`. Holes are excluded, never interpolated. */
  levels: readonly number[];
  levelTimestamps: readonly string[];
  /** Sampled instants with no defined equity, because an open position had no mark. */
  undefinedEquityAt: readonly string[];
  /** Fills recorded after the last mark; they are reflected in no sample. */
  receiptsAfterLastMark: number;
  /** Gross marked-value proxy at the latest fully defined mark instant, not net account equity. */
  finalEquity: number | null;
  /**
   * Mean spacing between adjacent defined samples, in seconds. Present so a caller that
   * annualises a metric can see the period it is actually annualising over.
   */
  meanSampleSpacingSeconds: number | null;
}>;

function round6(value: number): number {
  return Number(value.toFixed(6));
}

function isUsableMark(mark: FinancePositionMark): boolean {
  return (
    mark.instrument.trim().length > 0 &&
    Number.isFinite(mark.price) &&
    mark.price > 0 &&
    mark.at.trim().length > 0
  );
}

/**
 * Project the stream onto every mark instant. Pure: no IO, no metrics, no annualisation.
 */
export function buildFinanceEquityCurve(params: {
  receipts: readonly FinanceExecutionReceipt[];
  marks?: readonly FinancePositionMark[];
  initialCapital: number;
}): FinanceEquityCurve {
  if (!Number.isFinite(params.initialCapital) || params.initialCapital <= 0) {
    throw new Error("initialCapital must be a positive finite number");
  }
  const marks = (params.marks ?? []).filter(isUsableMark);
  const instants = [...new Set(marks.map((mark) => mark.at))].toSorted((left, right) =>
    left.localeCompare(right),
  );
  const lastInstant = instants.at(-1);
  const receiptsAfterLastMark =
    lastInstant === undefined
      ? params.receipts.length
      : params.receipts.filter((receipt) => receipt.recordedAt > lastInstant).length;

  const samples: FinanceEquitySample[] = [];
  const levels: number[] = [];
  const levelTimestamps: string[] = [];
  const undefinedEquityAt: string[] = [];

  for (const at of instants) {
    const ledger = projectFinancePositions({
      receipts: params.receipts.filter((receipt) => receipt.recordedAt <= at),
      // The projection lets the last mark per instrument win, so ordering by time makes
      // "last" mean "latest as of this instant".
      marks: marks
        .filter((mark) => mark.at <= at)
        .toSorted((left, right) => left.at.localeCompare(right.at)),
    });
    const equity =
      ledger.unrealizedPnl === null
        ? null
        : round6(params.initialCapital + ledger.realizedPnl + ledger.unrealizedPnl);
    samples.push(
      Object.freeze({
        at,
        realizedPnl: ledger.realizedPnl,
        unrealizedPnl: ledger.unrealizedPnl,
        equity,
        openInstruments: Object.freeze(
          ledger.positions.filter((item) => item.quantity !== 0).map((item) => item.instrument),
        ),
        instrumentsWithoutMark: ledger.instrumentsWithoutMark,
      }),
    );
    if (equity === null) {
      undefinedEquityAt.push(at);
      continue;
    }
    levels.push(equity);
    levelTimestamps.push(at);
  }

  const spacingSeconds =
    levelTimestamps.length < 2
      ? null
      : round6(
          (Date.parse(levelTimestamps[levelTimestamps.length - 1]) -
            Date.parse(levelTimestamps[0])) /
            1_000 /
            (levelTimestamps.length - 1),
        );

  return Object.freeze({
    schemaVersion: FINANCE_EQUITY_CURVE_SCHEMA,
    boundary: "equity_curve_from_ledger_stream_only",
    pnlBasis: "gross_fill_price_only",
    initialCapital: params.initialCapital,
    sampleCount: instants.length,
    samples: Object.freeze(samples),
    levels: Object.freeze(levels),
    levelTimestamps: Object.freeze(levelTimestamps),
    undefinedEquityAt: Object.freeze(undefinedEquityAt),
    receiptsAfterLastMark,
    finalEquity: levels.length === 0 ? null : levels[levels.length - 1],
    meanSampleSpacingSeconds: spacingSeconds,
  });
}

/** Store-backed read: the same projection, from whatever the ledger has accumulated. */
export async function readFinanceEquityCurve(
  directory: string,
  options: { initialCapital: number },
): Promise<FinanceEquityCurve> {
  const read = await readFinancePositionRecords(directory);
  return buildFinanceEquityCurve({
    receipts: read.receipts,
    marks: read.marks,
    initialCapital: options.initialCapital,
  });
}
