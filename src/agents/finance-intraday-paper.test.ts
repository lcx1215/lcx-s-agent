import { describe, expect, it } from "vitest";
import type { FinanceIntradayBar } from "./finance-intraday-ledger.js";
import { runFinanceIntradayPaperReplay } from "./finance-intraday-paper.js";

function session(prices: readonly number[], day = "2026-01-05"): FinanceIntradayBar[] {
  const start = Date.parse(`${day}T14:30:00.000Z`);
  return prices.map((close, index) => {
    const open = index === 0 ? close : (prices[index - 1] ?? close);
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

const config = {
  openingRangeBars: 3,
  capital: 10_000,
  maxAllocationFraction: 0.5,
  feeBpsPerSide: 1,
  spreadBps: 4,
  slippageBpsPerSide: 2,
} as const;

describe("finance intraday paper replay", () => {
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

  it("charges the strategy and retail baseline with the same round-trip cost model", () => {
    const bars = session([100, 100, 100, 101, 101, 101]);
    const receipt = runFinanceIntradayPaperReplay({ bars, ledgerHeadRef: null, config });
    // 1 bp fee + 2 bp half-spread + 2 bp slippage on each of two sides.
    expect(receipt.trades[0]?.costFraction).toBe(0.001);
    expect(receipt.retailOpenToCloseBaseline.totalReturn).toBeCloseTo(0.009, 10);
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
  });
});
