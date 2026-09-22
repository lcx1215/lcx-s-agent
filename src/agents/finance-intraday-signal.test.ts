import { describe, expect, it } from "vitest";
import type { FinanceIntradayBar } from "./finance-intraday-ledger.js";
import { evaluateFinanceIntradaySignal } from "./finance-intraday-signal.js";

function bars(closes: readonly number[]): FinanceIntradayBar[] {
  const base = Date.parse("2026-01-05T14:30:00Z");
  return closes.map((close, index) => {
    const open = index === 0 ? close : closes[index - 1];
    return {
      instrument: "SPY",
      intervalSeconds: 300,
      startAt: new Date(base + index * 300_000).toISOString(),
      endAt: new Date(base + (index + 1) * 300_000).toISOString(),
      open,
      high: Math.max(open, close),
      low: Math.min(open, close),
      close,
      volume: 10,
    };
  });
}

describe("intraday event signal", () => {
  it("emits a stable buy candidate only after a closed-bar breakout", () => {
    const before = evaluateFinanceIntradaySignal({
      bars: bars([100, 101, 100]),
      openingRangeBars: 3,
    });
    const after = evaluateFinanceIntradaySignal({
      bars: bars([100, 101, 100, 102]),
      openingRangeBars: 3,
    });
    const replay = evaluateFinanceIntradaySignal({
      bars: bars([100, 101, 100, 102]),
      openingRangeBars: 3,
    });
    expect(before.action).toBe("hold");
    expect(after).toMatchObject({
      action: "buy",
      reason: "opening_range_breakout",
      stopPrice: 100,
    });
    expect(replay.signalId).toBe(after.signalId);
    expect(after.executionAuthority).toBe("none");
  });

  it("emits event-driven stop and target sells for an open position", () => {
    const position = {
      instrument: "SPY",
      enteredAt: "2026-01-05T15:00:00Z",
      entryPrice: 102,
      stopPrice: 99,
      targetPrice: 108,
      quantity: 10,
    };
    const stopped = bars([100, 98]);
    const target = bars([100, 109]);
    expect(evaluateFinanceIntradaySignal({ bars: stopped, position }).reason).toBe(
      "opening_range_stop",
    );
    expect(evaluateFinanceIntradaySignal({ bars: target, position })).toMatchObject({
      action: "sell",
      reason: "reward_target",
      referencePrice: 108,
    });
  });
});
