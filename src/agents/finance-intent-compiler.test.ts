import { describe, expect, it } from "vitest";
import {
  compileExecutionIntent,
  type FinanceResearchConclusion,
} from "./finance-intent-compiler.js";

const market = { referencePrice: 100, referencePriceAt: "2026-09-20T00:00:00.000Z" };
const equity = 100_000;

const equityConclusion: FinanceResearchConclusion = {
  conclusionId: "c1",
  instrument: "AAPL",
  direction: "buy",
  conviction: 0.8,
  thesis: "earnings revision cycle turning",
  assetClass: "us_equity",
  invalidationPrice: 95,
};

const valueConclusion: FinanceResearchConclusion = {
  conclusionId: "c2",
  instrument: "BRK.B",
  direction: "buy",
  conviction: 0.7,
  thesis: "intrinsic value well above price",
  assetClass: "us_equity",
  horizonDays: 900,
  invalidationCondition: "book value stops compounding",
};

describe("compileExecutionIntent", () => {
  it("refuses when the conclusion names no instrument", () => {
    const result = compileExecutionIntent({
      conclusion: { ...equityConclusion, instrument: undefined },
      market,
      equity,
      runAuthorizationId: "auth-1",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusals.join()).toMatch(/names no instrument/);
    }
  });

  it("refuses a hold or an avoid, because neither is an order", () => {
    for (const direction of ["hold", "avoid", undefined] as const) {
      const result = compileExecutionIntent({
        conclusion: { ...equityConclusion, direction },
        market,
        equity,
        runAuthorizationId: "auth-1",
      });
      expect(result.ok).toBe(false);
    }
  });

  it("refuses when conviction is missing rather than assuming it is high", () => {
    const result = compileExecutionIntent({
      conclusion: { ...equityConclusion, conviction: undefined },
      market,
      equity,
      runAuthorizationId: "auth-1",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusals.join()).toMatch(/no conviction/);
    }
  });

  it("refuses conviction below the class floor", () => {
    const result = compileExecutionIntent({
      conclusion: { ...equityConclusion, conviction: 0.4 },
      market,
      equity,
      runAuthorizationId: "auth-1",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusals.join()).toMatch(/below the .* floor/);
    }
  });

  it("sizes from the stop distance for a stop-driven class", () => {
    const result = compileExecutionIntent({
      conclusion: equityConclusion,
      market,
      equity,
      runAuthorizationId: "auth-1",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // 1% of 100k = 1000 risked, stop distance 5 -> 200 shares.
      expect(result.intent.quantity).toBe(200);
      expect(result.intent.side).toBe("buy");
      expect(result.intent.instrument).toBe("AAPL");
    }
  });

  it("refuses a stop-driven class that gives no stop", () => {
    const result = compileExecutionIntent({
      conclusion: { ...equityConclusion, invalidationPrice: undefined },
      market,
      equity,
      runAuthorizationId: "auth-1",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusals.join()).toMatch(/sizes from a price stop/);
    }
  });

  it("accepts a value conclusion without a price stop, given an invalidation condition", () => {
    const result = compileExecutionIntent({
      conclusion: valueConclusion,
      market,
      equity,
      runAuthorizationId: "auth-1",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Class C risks 3% of equity with no price stop: 3000 / 100 = 30 shares.
      expect(result.intent.quantity).toBe(30);
    }
  });

  it("refuses a value conclusion that states no invalidation condition", () => {
    const result = compileExecutionIntent({
      conclusion: { ...valueConclusion, invalidationCondition: undefined },
      market,
      equity,
      runAuthorizationId: "auth-1",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusals.join()).toMatch(/invalidation condition/);
    }
  });

  it("refuses adding to a losing position in the same direction", () => {
    const result = compileExecutionIntent({
      conclusion: equityConclusion,
      market,
      equity,
      runAuthorizationId: "auth-1",
      existingPosition: { quantity: 100, unrealizedFraction: -0.2 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusals.join()).toMatch(/averaging down/);
    }
  });

  it("still lets a value strategy build a position when nothing is underwater", () => {
    // The point of testing the boundary from both sides: class C must be able to
    // add over time, or the rule meant to stop averaging down would freeze it.
    const result = compileExecutionIntent({
      conclusion: valueConclusion,
      market,
      equity,
      runAuthorizationId: "auth-1",
      existingPosition: { quantity: 10, unrealizedFraction: 0.05 },
    });
    expect(result.ok).toBe(true);
  });

  it("refuses an unauthorized run", () => {
    const result = compileExecutionIntent({
      conclusion: equityConclusion,
      market,
      equity,
      runAuthorizationId: "",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusals.join()).toMatch(/no run authorization/);
    }
  });

  it("refuses a price with no timestamp", () => {
    const result = compileExecutionIntent({
      conclusion: equityConclusion,
      market: { referencePrice: 100, referencePriceAt: "" },
      equity,
      runAuthorizationId: "auth-1",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusals.join()).toMatch(/no timestamp/);
    }
  });

  it("attaches the stop it sized from, so the order is not left bare", () => {
    // The gate is satisfied by a stop price; if the intent does not carry it,
    // the position is sized from protection it never receives.
    const result = compileExecutionIntent({
      conclusion: equityConclusion,
      market,
      equity,
      runAuthorizationId: "auth-1",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.intent.stopPrice).toBe(95);
    }
  });

  it("leaves the stop off when the class uses a condition instead of a price", () => {
    const result = compileExecutionIntent({
      conclusion: valueConclusion,
      market,
      equity,
      runAuthorizationId: "auth-1",
    });
    if (result.ok) {
      expect(result.intent.stopPrice).toBeUndefined();
    }
  });

  it("reports every refusal at once", () => {
    const result = compileExecutionIntent({
      conclusion: { conclusionId: "c3" },
      market: { referencePrice: 0, referencePriceAt: "" },
      equity: 0,
      runAuthorizationId: "",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusals.length).toBeGreaterThanOrEqual(4);
    }
  });
});
