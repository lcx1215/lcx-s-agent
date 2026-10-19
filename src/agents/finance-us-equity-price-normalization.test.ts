import { describe, expect, it } from "vitest";
import {
  isLegalUsEquityPrice,
  normalizeUsEquityProtectionPrices,
} from "./finance-us-equity-price-normalization.js";

describe("US equity protective-price normalization", () => {
  it("rounds a long stop upward and recomputes an upward target at the same reward/risk", () => {
    const result = normalizeUsEquityProtectionPrices({
      instrument: "spy",
      assetClass: "etf",
      side: "buy",
      entryPrice: 766.105,
      stopPrice: 760.104,
      targetPrice: 778.107,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.stopPrice).toBe(760.11);
    expect(result.targetPrice).toBe(778.1);
    expect(result.provenance).toMatchObject({
      policyVersion: "alpaca_us_equity_stop_precision_v1",
      instrument: "SPY",
      original: { entryPrice: 766.105, stopPrice: 760.104, targetPrice: 778.107 },
      normalized: { entryPrice: 766.105, stopPrice: 760.11, targetPrice: 778.1 },
    });
    expect((result.targetPrice! - 766.105) / (766.105 - result.stopPrice)).toBeGreaterThanOrEqual(
      result.provenance.rewardRisk!,
    );
  });

  it("uses four decimals below one dollar and handles binary decimal representations", () => {
    expect(isLegalUsEquityPrice(0.29)).toBe(true);
    const result = normalizeUsEquityProtectionPrices({
      instrument: "ABC",
      assetClass: "us_equity",
      side: "buy",
      entryPrice: 1.2,
      stopPrice: 0.99991,
      targetPrice: 1.60018,
    });
    expect(result).toMatchObject({ ok: true, stopPrice: 1, targetPrice: 1.6 });
  });

  it.each([
    { entryPrice: 1.001, stopPrice: 1.0001, targetPrice: 1.01 },
    { entryPrice: Number.NaN, stopPrice: 90, targetPrice: 110 },
  ])("rejects invalid or cross-entry rounded prices: %o", (prices) => {
    expect(
      normalizeUsEquityProtectionPrices({
        instrument: "AAPL",
        assetClass: "us_equity",
        side: "buy",
        ...prices,
      }).ok,
    ).toBe(false);
  });

  it("rejects a non-finite target instead of omitting it", () => {
    expect(
      normalizeUsEquityProtectionPrices({
        instrument: "AAPL",
        assetClass: "us_equity",
        side: "buy",
        entryPrice: 100,
        stopPrice: 90,
        targetPrice: Number.POSITIVE_INFINITY,
      }).ok,
    ).toBe(false);
  });

  it("refuses crypto/options-shaped symbols so US equity ticks cannot leak across asset classes", () => {
    for (const instrument of ["BTC/USD", "AAPL261218C00100000"]) {
      expect(
        normalizeUsEquityProtectionPrices({
          instrument,
          assetClass: "us_equity",
          side: "buy",
          entryPrice: 100,
          stopPrice: 90,
          targetPrice: 120,
        }).ok,
      ).toBe(false);
    }
  });
});
