import { caseflowFingerprint } from "./finance-caseflow.js";
import type { FinanceIntradayBar } from "./finance-intraday-ledger.js";

export type FinanceIntradayPositionState = Readonly<{
  instrument: string;
  enteredAt: string;
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  quantity: number;
}>;

export type FinanceIntradaySignal = Readonly<{
  schemaVersion: "lcx_finance_intraday_signal_v1";
  signalId: string;
  instrument: string;
  action: "buy" | "sell" | "hold";
  reason:
    | "opening_range_breakout"
    | "opening_range_stop"
    | "reward_target"
    | "pre_close"
    | "no_trigger";
  referencePrice: number;
  referencePriceAt: string;
  stopPrice?: number;
  targetPrice?: number;
  openingRangeGap?: Readonly<{
    expectedStartAt: string;
    expectedEndAt: string;
    missingBarStarts: readonly string[];
    duplicateBarStarts: readonly string[];
    invalidBarStarts: readonly string[];
  }>;
  executionAuthority: "none";
}>;

/**
 * Evaluate the newest closed bar. The caller owns polling and placement; this function owns only
 * the frozen market rule, so scheduler timing cannot silently become strategy timing.
 */
export function evaluateFinanceIntradaySignal(params: {
  bars: readonly FinanceIntradayBar[];
  openingRangeBars?: number;
  rewardRisk?: number;
  position?: FinanceIntradayPositionState;
  preCloseExit?: boolean;
  /** Host calendar binding; legacy callers retain their observed-bar contract. */
  marketOpenAt?: string;
}): FinanceIntradaySignal {
  const openingRangeBars = params.openingRangeBars ?? 6;
  const rewardRisk = params.rewardRisk ?? 2;
  if (
    !Number.isInteger(openingRangeBars) ||
    openingRangeBars < 2 ||
    !Number.isFinite(rewardRisk) ||
    rewardRisk <= 0
  ) {
    throw new Error("invalid intraday signal configuration");
  }
  const bars = params.bars.toSorted((left, right) => left.startAt.localeCompare(right.startAt));
  if (bars.length === 0) {
    throw new Error("intraday signal requires closed bars");
  }
  const latest = bars.at(-1)!;
  const instrument = latest.instrument;
  if (
    bars.some(
      (bar) => bar.instrument !== instrument || bar.intervalSeconds !== latest.intervalSeconds,
    )
  ) {
    throw new Error("intraday signal requires one instrument and interval");
  }
  let action: FinanceIntradaySignal["action"] = "hold";
  let reason: FinanceIntradaySignal["reason"] = "no_trigger";
  let referencePrice = latest.close;
  let stopPrice: number | undefined;
  let targetPrice: number | undefined;
  let openingRangeGap: FinanceIntradaySignal["openingRangeGap"];

  if (params.position) {
    if (params.position.instrument !== instrument) {
      throw new Error("position instrument mismatch");
    }
    if (latest.low <= params.position.stopPrice) {
      action = "sell";
      reason = "opening_range_stop";
      referencePrice = params.position.stopPrice;
    } else if (latest.high >= params.position.targetPrice) {
      action = "sell";
      reason = "reward_target";
      referencePrice = params.position.targetPrice;
    } else if (params.preCloseExit === true) {
      action = "sell";
      reason = "pre_close";
    }
  } else {
    let opening = bars.slice(0, openingRangeBars);
    if (params.marketOpenAt !== undefined) {
      const start = Date.parse(params.marketOpenAt);
      const interval = latest.intervalSeconds * 1_000;
      const end = start + openingRangeBars * interval;
      if (!Number.isFinite(start) || !Number.isFinite(end)) {
        throw new Error("invalid intraday opening window");
      }
      opening = bars.filter((bar) => {
        const at = Date.parse(bar.startAt);
        return at >= start && at < end;
      });
      // An unfinished window is waiting, not missing evidence. Never let later bars fill its slots.
      if (Date.parse(latest.endAt) >= end) {
        const expected = Array.from({ length: openingRangeBars }, (_, index) =>
          new Date(start + index * interval).toISOString(),
        );
        const counts = new Map<string, number>();
        const invalid = opening.filter((bar) => {
          counts.set(bar.startAt, (counts.get(bar.startAt) ?? 0) + 1);
          return (
            !expected.includes(bar.startAt) ||
            Date.parse(bar.endAt) !== Date.parse(bar.startAt) + interval
          );
        });
        const missing = expected.filter((at) => !counts.has(at));
        const duplicates = expected.filter((at) => (counts.get(at) ?? 0) > 1);
        if (missing.length || duplicates.length || invalid.length) {
          openingRangeGap = {
            expectedStartAt: new Date(start).toISOString(),
            expectedEndAt: new Date(end).toISOString(),
            missingBarStarts: missing,
            duplicateBarStarts: duplicates,
            invalidBarStarts: invalid.map((bar) => bar.startAt),
          };
        }
      }
    }
    if (!openingRangeGap && opening.length === openingRangeBars && bars.length > openingRangeBars) {
      const openingHigh = Math.max(...opening.map((bar) => bar.high));
      const openingLow = Math.min(...opening.map((bar) => bar.low));
      if (latest.close > openingHigh) {
        action = "buy";
        reason = "opening_range_breakout";
        stopPrice = openingLow;
        targetPrice = latest.close + (latest.close - openingLow) * rewardRisk;
      }
    }
  }

  const body = {
    schemaVersion: "lcx_finance_intraday_signal_v1" as const,
    instrument,
    action,
    reason,
    referencePrice,
    referencePriceAt: latest.endAt,
    ...(stopPrice === undefined ? {} : { stopPrice }),
    ...(targetPrice === undefined ? {} : { targetPrice }),
    ...(openingRangeGap ? { openingRangeGap } : {}),
    executionAuthority: "none" as const,
  };
  return Object.freeze({ ...body, signalId: `intraday-${caseflowFingerprint(body)}` });
}
