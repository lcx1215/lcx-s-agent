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
  reason: "opening_range_breakout" | "opening_range_stop" | "reward_target" | "no_trigger";
  referencePrice: number;
  referencePriceAt: string;
  stopPrice?: number;
  targetPrice?: number;
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
    }
  } else if (bars.length > openingRangeBars) {
    const opening = bars.slice(0, openingRangeBars);
    const openingHigh = Math.max(...opening.map((bar) => bar.high));
    const openingLow = Math.min(...opening.map((bar) => bar.low));
    if (latest.close > openingHigh) {
      action = "buy";
      reason = "opening_range_breakout";
      stopPrice = openingLow;
      targetPrice = latest.close + (latest.close - openingLow) * rewardRisk;
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
    executionAuthority: "none" as const,
  };
  return Object.freeze({ ...body, signalId: `intraday-${caseflowFingerprint(body)}` });
}
