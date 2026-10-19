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

describe("calendar-bound fixed opening window", () => {
  const marketOpenAt = "2026-01-05T14:30:00.000Z";
  const complete = () => bars([100, 100, 100, 100, 100, 100, 102, 103]);

  it("keeps a complete opening window unchanged and does not require later bars to be contiguous", () => {
    const input = complete().filter((_, index) => index !== 6);
    const legacy = evaluateFinanceIntradaySignal({ bars: input });
    expect(evaluateFinanceIntradaySignal({ bars: input, marketOpenAt })).toEqual(legacy);
  });

  it.each([0, 3, 5])("never replaces missing opening slot %i with a later bar", (missing) => {
    const input = complete();
    const absent = input[missing].startAt;
    input.splice(missing, 1);
    expect(evaluateFinanceIntradaySignal({ bars: input }).action).toBe("buy");
    expect(evaluateFinanceIntradaySignal({ bars: input, marketOpenAt })).toMatchObject({
      action: "hold",
      reason: "no_trigger",
      openingRangeGap: {
        expectedStartAt: marketOpenAt,
        expectedEndAt: "2026-01-05T15:00:00.000Z",
        missingBarStarts: [absent],
      },
    });
  });

  it("reports late-start, duplicate and invalid-duration opening evidence", () => {
    const input = complete();
    expect(evaluateFinanceIntradaySignal({ bars: input.slice(2), marketOpenAt })).toMatchObject({
      action: "hold",
      openingRangeGap: { missingBarStarts: [input[0].startAt, input[1].startAt] },
    });
    expect(
      evaluateFinanceIntradaySignal({ bars: [...input, input[1]], marketOpenAt }),
    ).toMatchObject({
      action: "hold",
      openingRangeGap: { duplicateBarStarts: [input[1].startAt] },
    });
    const invalid = input.map((bar, index) =>
      index === 1 ? { ...bar, endAt: input[2].endAt } : bar,
    );
    expect(evaluateFinanceIntradaySignal({ bars: invalid, marketOpenAt })).toMatchObject({
      action: "hold",
      openingRangeGap: { invalidBarStarts: [input[1].startAt] },
    });
  });

  it("waits for an unfinished window without declaring future slots missing", () => {
    const signal = evaluateFinanceIntradaySignal({ bars: complete().slice(0, 2), marketOpenAt });
    expect(signal.action).toBe("hold");
    expect(signal.openingRangeGap).toBeUndefined();
  });

  it.each([
    { stopPrice: 104, targetPrice: 110, preCloseExit: false, reason: "opening_range_stop" },
    { stopPrice: 99, targetPrice: 102, preCloseExit: false, reason: "reward_target" },
    { stopPrice: 99, targetPrice: 110, preCloseExit: true, reason: "pre_close" },
  ])(
    "preserves $reason despite missing opening evidence",
    ({ reason, preCloseExit, ...prices }) => {
      const input = complete().slice(1);
      const signal = evaluateFinanceIntradaySignal({
        bars: input,
        marketOpenAt,
        preCloseExit,
        position: {
          instrument: "SPY",
          enteredAt: input[6].endAt,
          entryPrice: 102,
          quantity: 1,
          ...prices,
        },
      });
      expect(signal).toMatchObject({ action: "sell", reason });
      expect(signal.openingRangeGap).toBeUndefined();
    },
  );
});

// Frozen native VCSH entry prefix: decision cb3db9bbf7c2deeb; no account/provider fixture.
it("keeps the real VCSH missing 13:55 slot from expanding the opening range", () => {
  const rows: readonly [string, number, number, number, number, number][] = [
    ["2026-10-01T13:30:00.000Z", 76.94, 76.96, 76.94, 76.95, 2130],
    ["2026-10-01T13:35:00.000Z", 76.95, 76.95, 76.95, 76.95, 600],
    ["2026-10-01T13:40:00.000Z", 76.925, 76.925, 76.925, 76.925, 225],
    ["2026-10-01T13:45:00.000Z", 76.93, 76.93, 76.93, 76.93, 400],
    ["2026-10-01T13:50:00.000Z", 76.94, 76.94, 76.94, 76.94, 2100],
    ["2026-10-01T14:00:00.000Z", 76.91, 76.91, 76.91, 76.91, 400],
    ["2026-10-01T14:05:00.000Z", 76.9, 76.93, 76.9, 76.92, 15040],
    ["2026-10-01T14:10:00.000Z", 76.915, 76.915, 76.905, 76.91, 935],
    ["2026-10-01T14:15:00.000Z", 76.905, 76.905, 76.905, 76.905, 5541],
    ["2026-10-01T14:20:00.000Z", 76.91, 76.93, 76.91, 76.93, 5300],
    ["2026-10-01T14:25:00.000Z", 76.935, 76.955, 76.935, 76.955, 70303],
    ["2026-10-01T14:30:00.000Z", 76.95, 76.95, 76.945, 76.945, 5125],
    ["2026-10-01T14:35:00.000Z", 76.945, 76.955, 76.945, 76.955, 5183],
    ["2026-10-01T14:40:00.000Z", 76.97, 76.97, 76.965, 76.965, 1500],
    ["2026-10-01T14:45:00.000Z", 76.975, 76.975, 76.97, 76.975, 13022],
    ["2026-10-01T14:50:00.000Z", 76.96, 76.96, 76.96, 76.96, 2451],
    ["2026-10-01T14:55:00.000Z", 76.97, 76.97, 76.96, 76.96, 7216],
    ["2026-10-01T15:00:00.000Z", 76.96, 76.96, 76.95, 76.95, 300],
    ["2026-10-01T15:05:00.000Z", 76.955, 76.955, 76.955, 76.955, 900],
    ["2026-10-01T15:10:00.000Z", 76.985, 76.985, 76.985, 76.985, 1002],
    ["2026-10-01T15:15:00.000Z", 76.99, 76.99, 76.99, 76.99, 6600],
    ["2026-10-01T15:20:00.000Z", 77.015, 77.02, 77.01, 77.015, 28198],
    ["2026-10-01T15:25:00.000Z", 77.005, 77.015, 77.005, 77.01, 3000],
    ["2026-10-01T15:30:00.000Z", 77.02, 77.02, 77.02, 77.02, 400],
    ["2026-10-01T15:35:00.000Z", 77.05, 77.05, 77.05, 77.05, 600],
  ];
  const input: FinanceIntradayBar[] = rows.map(([startAt, open, high, low, close, volume]) => ({
    instrument: "VCSH",
    intervalSeconds: 300,
    startAt,
    endAt: new Date(Date.parse(startAt) + 300_000).toISOString(),
    open,
    high,
    low,
    close,
    volume,
  }));
  expect(evaluateFinanceIntradaySignal({ bars: input })).toMatchObject({
    action: "buy",
    stopPrice: 76.91,
  });
  expect(
    evaluateFinanceIntradaySignal({ bars: input, marketOpenAt: "2026-10-01T13:30:00.000Z" }),
  ).toMatchObject({
    action: "hold",
    referencePrice: 77.05,
    openingRangeGap: {
      missingBarStarts: ["2026-10-01T13:55:00.000Z"],
      expectedEndAt: "2026-10-01T14:00:00.000Z",
    },
  });
});
