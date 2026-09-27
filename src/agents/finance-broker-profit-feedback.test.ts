import { describe, it, expect } from "vitest";
import { summarizeFinanceBrokerFills } from "./finance-broker-profit-feedback.js";
const fill = (id: string, side: string, qty: string, price: string) => ({
  id,
  activity_type: "FILL",
  type: "fill",
  symbol: "SPY",
  side,
  qty,
  price,
  transaction_time: `2026-09-20T10:0${id}:00Z`,
});
describe("broker profit feedback", () => {
  it("deduplicates activities and matches partial fills without using order snapshots", () => {
    const buy = fill("1", "buy", "2", "100");
    expect(
      summarizeFinanceBrokerFills(
        [buy, buy, fill("2", "sell", "1", "110"), fill("3", "sell", "1", "95")],
        true,
      ),
    ).toMatchObject({
      buyFills: 1,
      sellFills: 2,
      matchedLotCount: 2,
      openLotCount: 0,
      grossMatchedPnl: 5,
      netMatchedPnl: 5,
    });
  });
  it("never calls open gains, unverified costs or unattributed fees net profit", () => {
    const rows = [fill("1", "buy", "2", "100"), fill("2", "sell", "1", "110")];
    expect(summarizeFinanceBrokerFills(rows, false).netMatchedPnl).toBeNull();
    expect(
      summarizeFinanceBrokerFills(
        [...rows, { id: "fee", activity_type: "CFEE", qty: "-0.01" }],
        true,
      ),
    ).toMatchObject({ netMatchedPnl: null, feeActivityCount: 1 });
    expect(summarizeFinanceBrokerFills([rows[0]], true)).toMatchObject({
      status: "no_closed_matches",
      netMatchedPnl: null,
    });
  });
  it("does not invent a cost basis for sells with missing buys", () => {
    expect(summarizeFinanceBrokerFills([fill("1", "sell", "1", "100")], true).issues).toContain(
      "unmatched_sell_or_short_position",
    );
    expect(() => summarizeFinanceBrokerFills([fill("1", "buy", "", "100")], true)).toThrow(
      "invalid activity number",
    );
  });
});

it("does not invent ordering between opposing fills at the same timestamp", () => {
  const buy = fill("1", "buy", "1", "100");
  const sell = { ...fill("2", "sell", "1", "110"), transaction_time: buy.transaction_time };
  expect(summarizeFinanceBrokerFills([buy, sell], true)).toMatchObject({
    netMatchedPnl: null,
    issues: ["ambiguous_same_time_fill_order"],
  });
});
