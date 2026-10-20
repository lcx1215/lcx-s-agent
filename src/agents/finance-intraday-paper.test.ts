import { describe, expect, it } from "vitest";
import {
  FINANCE_ALPACA_MARKET_CALENDAR_SOURCE,
  FINANCE_ALPACA_MARKET_CALENDAR_URL,
  type FinanceAlpacaMarketSession,
} from "./finance-alpaca-market-calendar.js";
import { caseflowFingerprint } from "./finance-caseflow.js";
import { financeUsEquityLocalTimeInstant } from "./finance-cycle-schedule.js";
import type { FinanceIntradayBar } from "./finance-intraday-ledger.js";
import {
  FINANCE_INTRADAY_OPENING_RANGE_RULE_V2,
  FinanceIntradayReplayInputError,
  financeIntradayPreCloseExitBarMinute,
  financeIntradayExecutionUniverse,
  resolveFinanceIntradayPaperExecutionEligibility,
  runFinanceIntradayPaperReplay,
} from "./finance-intraday-paper.js";

function session(
  prices: readonly number[],
  day = "2026-01-05",
  complete = true,
): FinanceIntradayBar[] {
  const start = Date.parse(`${day}T14:30:00.000Z`);
  const values = complete
    ? [...prices, ...Array<number>(Math.max(0, 78 - prices.length)).fill(prices.at(-1)!)]
    : prices;
  return values.map((close, index) => {
    const open = index === 0 ? close : (values[index - 1] ?? close);
    const startAt = new Date(start + index * 300_000).toISOString();
    return {
      instrument: "SPY",
      intervalSeconds: 300,
      startAt,
      endAt: new Date(start + (index + 1) * 300_000).toISOString(),
      open,
      high: Math.max(open, close),
      low: Math.min(open, close),
      close,
      volume: 1000,
    };
  });
}

function marketCalendarSession(date: string): FinanceAlpacaMarketSession {
  const openMinute = 570;
  const closeMinute = 960;
  const openAt = financeUsEquityLocalTimeInstant(date, openMinute)!;
  const closeAt = financeUsEquityLocalTimeInstant(date, closeMinute)!;
  const sourceUrlOrArtifact = `${FINANCE_ALPACA_MARKET_CALENDAR_URL}?start=${date}&end=${date}&date_type=TRADING`;
  return {
    date,
    openAt,
    closeAt,
    openMinute,
    closeMinute,
    observedAt: new Date(Date.parse(openAt) - 60_000).toISOString(),
    calendarRef: caseflowFingerprint({
      source: FINANCE_ALPACA_MARKET_CALENDAR_SOURCE,
      sourceUrlOrArtifact,
      date,
      openAt,
      closeAt,
    }),
    sourceUrlOrArtifact,
  };
}

function completeRegularSession(): FinanceIntradayBar[] {
  const start = Date.parse("2026-09-18T13:30:00.000Z");
  const intervalMs = 300_000;
  return Array.from({ length: 78 }, (_, index) => {
    const previousClose = index === 0 ? 100 : index <= 3 ? 100 : index === 4 ? 103 : 103.5;
    const close =
      index < 3 ? 100 : index === 3 ? 103 : index === 76 ? 108 : index === 77 ? 110 : 103.5;
    const startAt = new Date(start + index * intervalMs).toISOString();
    const open = index === 0 ? 100 : previousClose;
    return {
      instrument: "SPY",
      intervalSeconds: 300,
      startAt,
      endAt: new Date(start + (index + 1) * intervalMs).toISOString(),
      open,
      high: Math.max(open, close),
      low: Math.min(open, close),
      close,
      volume: 1000,
    };
  });
}

const config = {
  openingRangeBars: 3,
  capital: 10_000,
  maxAllocationFraction: 0.5,
  feeBpsPerSide: 1,
  spreadBps: 4,
  slippageBpsPerSide: 2,
} as const;

describe("finance intraday paper replay", () => {
  it.each(["middle", "missing_open", "missing_close"])(
    "rejects a contiguous partial v1 session: %s",
    (kind) => {
      const full = session([100, 100, 100, 101, 102, 103]);
      const bars =
        kind === "middle"
          ? full.slice(6, 30)
          : kind === "missing_open"
            ? full.slice(1)
            : full.slice(0, -1);
      expect(() =>
        runFinanceIntradayPaperReplay({ bars, ledgerHeadRef: "partial", config }),
      ).toThrow(/complete sessions/);
    },
  );

  it("admits a complete published early close and rejects holiday or unknown calendar dates", () => {
    const early = session([100, 100, 100, 101, 102, 103], "2026-11-27").slice(0, 42);
    expect(
      runFinanceIntradayPaperReplay({ bars: early, ledgerHeadRef: "early", config }).strategy
        .sessions,
    ).toBe(1);
    for (const day of ["2026-12-25", "2030-01-07"]) {
      expect(() =>
        runFinanceIntradayPaperReplay({
          bars: session([100, 100, 100, 101, 102, 103], day),
          ledgerHeadRef: "unverified",
          config,
        }),
      ).toThrow(/complete sessions/);
    }
  });

  it("uses and binds an explicit official calendar in v1", () => {
    const bars = session([100, 100, 100, 101, 102, 103]);
    const calendar = marketCalendarSession("2026-01-05");
    const result = runFinanceIntradayPaperReplay({
      bars,
      ledgerHeadRef: "calendar",
      config,
      marketSessions: [calendar],
    });
    expect(result.marketCalendarRef).toBeTruthy();
    expect(() =>
      runFinanceIntradayPaperReplay({
        bars,
        ledgerHeadRef: "calendar",
        config,
        marketSessions: [{ ...calendar, closeMinute: 780 }],
      }),
    ).toThrow(/invalid/);
  });

  it.each([0.1, 0.5, 1])(
    "scales strategy and benchmark returns by deployed capital (%s)",
    (allocation) => {
      const receipt = runFinanceIntradayPaperReplay({
        bars: session([100, 100, 100, 101, 102, 103]),
        ledgerHeadRef: null,
        config: {
          ...config,
          maxAllocationFraction: allocation,
          feeBpsPerSide: 0,
          spreadBps: 0,
          slippageBpsPerSide: 0,
        },
      });
      const trade = receipt.trades[0];
      expect(receipt.strategy.totalReturn).toBeCloseTo(
        (trade.quantity * (trade.exitReferencePrice - trade.entryReferencePrice)) / config.capital,
        10,
      );
      const baselineQuantity = Math.floor((config.capital * allocation) / 100);
      expect(receipt.retailOpenToCloseBaseline.totalReturn).toBeCloseTo(
        (baselineQuantity * 3) / config.capital,
        10,
      );
    },
  );

  it.each([4, 5])("refuses a missing signal-entry/holding interval at index %s", (missingIndex) => {
    const bars = session([100, 101, 100, 102, 103, 104, 105]).filter(
      (_, index) => index !== missingIndex,
    );
    expect(() => runFinanceIntradayPaperReplay({ bars, ledgerHeadRef: "head", config })).toThrow(
      FinanceIntradayReplayInputError,
    );
  });

  it("refuses an overlapping interval and a bar with a mismatched duration", () => {
    const bars = session([100, 101, 100, 102, 103, 104]);
    expect(() =>
      runFinanceIntradayPaperReplay({ bars: [...bars, bars[3]], ledgerHeadRef: "head", config }),
    ).toThrow(/bar_sequence_gap_or_overlap/);
    const malformed = bars.map((bar, index) =>
      index === 3 ? { ...bar, endAt: bars[4].endAt } : bar,
    );
    expect(() =>
      runFinanceIntradayPaperReplay({ bars: malformed, ledgerHeadRef: "head", config }),
    ).toThrow(/bar_duration_mismatch/);
  });

  it("retains calendar-rejected days alongside usable days instead of concealing source gaps", () => {
    const bars = completeRegularSession();
    const incomplete = session([100, 101, 100, 102, 103, 104], "2026-01-05", false);
    const result = runFinanceIntradayPaperReplay({
      bars: [...bars, ...incomplete],
      ledgerHeadRef: "head",
      config,
      strategyRule: FINANCE_INTRADAY_OPENING_RANGE_RULE_V2,
      marketSessions: [marketCalendarSession("2026-09-18"), marketCalendarSession("2026-01-05")],
    });
    expect(result.strategy.sessions).toBe(1);
    expect(result.excludedSessions).toEqual([
      { sessionDate: "2026-01-05", reason: "incomplete_calendar_session", selectedBars: 6 },
    ]);
  });

  it("expands only an explicitly opted-in Paper rule to the fresh selected snapshot", () => {
    const selected = ["QQQ", "MSFT"];
    expect(
      financeIntradayExecutionUniverse(
        { instruments: ["SPY"], paperUniverseScope: "static" },
        selected,
      ),
    ).toEqual([]);
    expect(
      financeIntradayExecutionUniverse(
        { instruments: ["SPY"], paperUniverseScope: "fresh_us_equity_selection_v1" },
        selected,
      ),
    ).toEqual(selected);
  });

  it.each([
    {
      ruleBody: { measuredResult: { status: "paper_contract_only", executionAuthority: "none" } },
      expected: { status: "paper_contract_only", automatedPaperPlacementAllowed: true },
    },
    {
      ruleBody: { paperExecutionEligibility: "paper_contract_only" },
      expected: { status: "paper_contract_only", automatedPaperPlacementAllowed: true },
    },
    {
      ruleBody: { paperExecutionEligibility: "paper_execution_eligible" },
      expected: { status: "paper_execution_eligible", automatedPaperPlacementAllowed: true },
    },
    {
      ruleBody: {},
      expected: { status: "eligibility_missing", automatedPaperPlacementAllowed: false },
    },
    {
      ruleBody: { paperExecutionEligibility: "unknown" },
      expected: { status: "eligibility_invalid", automatedPaperPlacementAllowed: false },
    },
  ])("resolves Paper-only placement separately from live authority", ({ ruleBody, expected }) => {
    expect(resolveFinanceIntradayPaperExecutionEligibility(ruleBody)).toEqual(expected);
  });

  it("freezes the opening range and enters only at the bar after the signal", () => {
    const bars = session([100, 101, 100, 102, 103, 104]);
    const receipt = runFinanceIntradayPaperReplay({ bars, ledgerHeadRef: "head", config });
    expect(receipt.executionAuthority).toBe("none");
    expect(receipt.status).toBe("paper_contract_only");
    expect(receipt.trades).toHaveLength(1);
    expect(receipt.trades[0]).toMatchObject({
      signalAt: bars[4 - 1]?.endAt,
      entryAt: bars[4]?.startAt,
      entryReferencePrice: 102,
      exitReferencePrice: 104,
    });
    expect(receipt.checks).toEqual({
      pointInTime: true,
      nextBarEntry: true,
      sameCostModel: true,
      noOrderPlacement: true,
    });
  });

  it("starts its open-to-close benchmark at the actual session open, independent of opening-range length", () => {
    const bars = session([100, 110, 120, 130, 135, 140]);
    for (const openingRangeBars of [2, 3, 4]) {
      const receipt = runFinanceIntradayPaperReplay({
        bars,
        ledgerHeadRef: "opening-move",
        config: {
          ...config,
          openingRangeBars,
          feeBpsPerSide: 0,
          spreadBps: 0,
          slippageBpsPerSide: 0,
        },
      });
      expect(receipt.retailOpenToCloseBaseline.totalReturn).toBeCloseTo(
        (50 * (140 - 100)) / 10000,
        10,
      );
    }
  });

  it("charges the strategy and retail baseline with the same round-trip cost model", () => {
    const bars = session([100, 100, 100, 101, 101, 101]);
    const receipt = runFinanceIntradayPaperReplay({ bars, ledgerHeadRef: null, config });
    // 1 bp fee + 2 bp half-spread + 2 bp slippage on each of two sides.
    expect(receipt.trades[0]?.costFraction).toBe(0.001);
    expect(receipt.retailOpenToCloseBaseline.totalReturn).toBeCloseTo(0.0045, 10);
  });

  it("keeps uninvestable capital in cash for both strategy and benchmark", () => {
    const receipt = runFinanceIntradayPaperReplay({
      bars: session([100, 100, 100, 101, 102, 103]),
      ledgerHeadRef: null,
      config: { ...config, capital: 1 },
    });
    expect(receipt.strategy).toMatchObject({ trades: 0, totalReturn: 0 });
    expect(receipt.retailOpenToCloseBaseline).toMatchObject({ trades: 0, totalReturn: 0 });
  });

  it("accumulates fixed-capital P&L without inventing reinvestment across sessions", () => {
    const prices = [100, 100, 100, 101, 102, 103];
    const costs = { ...config, feeBpsPerSide: 0, spreadBps: 0, slippageBpsPerSide: 0 };
    const one = runFinanceIntradayPaperReplay({
      bars: session(prices),
      ledgerHeadRef: null,
      config: costs,
    });
    const two = runFinanceIntradayPaperReplay({
      bars: [...session(prices), ...session(prices, "2026-01-06")],
      ledgerHeadRef: null,
      config: costs,
    });
    expect(two.strategy.totalReturn).toBeCloseTo(2 * one.strategy.totalReturn, 10);
    expect(two.retailOpenToCloseBaseline.totalReturn).toBeCloseTo(0.03, 10);
  });

  it("records cash when there is no breakout and can show costs erasing a gross edge", () => {
    const quiet = runFinanceIntradayPaperReplay({
      bars: session([100, 100, 100, 99, 99, 99]),
      ledgerHeadRef: null,
      config,
    });
    expect(quiet.strategy).toMatchObject({ trades: 0, totalReturn: 0 });

    const costly = runFinanceIntradayPaperReplay({
      bars: session([100, 100, 100, 100.1, 100.11, 100.12]),
      ledgerHeadRef: null,
      config: { ...config, feeBpsPerSide: 20, spreadBps: 20, slippageBpsPerSide: 20 },
    });
    expect(costly.trades[0]?.grossReturn).toBeGreaterThan(0);
    expect(costly.trades[0]?.netReturn).toBeLessThan(0);
    const trade = costly.trades[0];
    const accountReturn =
      (trade.quantity * trade.entryReferencePrice * trade.netReturn) / config.capital;
    expect(costly.strategy.totalReturn).toBeCloseTo(accountReturn, 10);
    expect(costly.strategy.maxDrawdown).toBeCloseTo(-accountReturn, 10);
  });

  it("replays v2 exits before the closing bar and rejects incomplete sessions", () => {
    const bars = completeRegularSession();
    const receipt = runFinanceIntradayPaperReplay({
      bars,
      ledgerHeadRef: "head",
      config,
      strategyRule: FINANCE_INTRADAY_OPENING_RANGE_RULE_V2,
      marketSessions: [marketCalendarSession("2026-09-18")],
    });
    expect(receipt.strategyRule).toBe(FINANCE_INTRADAY_OPENING_RANGE_RULE_V2);
    expect(receipt.trades[0]).toMatchObject({
      exitAt: bars[76]?.endAt,
      exitReferencePrice: 108,
      exitReason: "pre_close",
    });
    expect(() =>
      runFinanceIntradayPaperReplay({
        bars: session([100, 101, 100, 102, 103, 104], "2026-01-05", false),
        ledgerHeadRef: "partial",
        config,
        strategyRule: FINANCE_INTRADAY_OPENING_RANGE_RULE_V2,
        marketSessions: [marketCalendarSession("2026-01-05")],
      }),
    ).toThrow(/complete sessions with the required market calendar/);
  });

  it("leaves one full bar interval between the exit signal bar and the cash close", () => {
    expect(financeIntradayPreCloseExitBarMinute(60)).toBe(958);
    expect(financeIntradayPreCloseExitBarMinute(300)).toBe(950);
    expect(financeIntradayPreCloseExitBarMinute(900)).toBe(930);
  });
});
