import { expect, it } from "vitest";
import { matchesFinanceResearchRecoveryProtection } from "./finance-research-execution-bridge.js";

const stopLimitProtection = {
  id: "protection-1",
  quantity: 0.5,
  stopPrice: 90,
  orderType: "stop_limit" as const,
  limitPrice: 89,
};
const stopLimitOrder = {
  id: "protection-1",
  symbol: "BTC/USD",
  side: "sell",
  type: "stop_limit",
  time_in_force: "gtc",
  qty: "0.5",
  stop_price: "90",
  limit_price: "89",
  status: "canceled",
  filled_qty: "0",
};

it("matches a stop-limit recovery record only to its exact canceled broker order", () => {
  expect(
    matchesFinanceResearchRecoveryProtection({
      instrument: "BTC/USD",
      protection: stopLimitProtection,
      brokerOrder: stopLimitOrder,
    }),
  ).toBe(true);
});

it.each([
  { type: "stop" },
  { limit_price: "88" },
  { limit_price: undefined },
  { stop_price: "91" },
  { time_in_force: "day" },
  { filled_qty: "0.1" },
])("rejects recovery when stop-limit broker identity drifts: %j", (patch) => {
  expect(
    matchesFinanceResearchRecoveryProtection({
      instrument: "BTC/USD",
      protection: stopLimitProtection,
      brokerOrder: { ...stopLimitOrder, ...patch },
    }),
  ).toBe(false);
});

it("rejects unsupported persisted protection types at recovery time", () => {
  const invalidProtection = {
    ...stopLimitProtection,
    orderType: "trailing_stop" as never,
  };
  expect(
    matchesFinanceResearchRecoveryProtection({
      instrument: "BTC/USD",
      protection: invalidProtection,
      brokerOrder: stopLimitOrder,
    }),
  ).toBe(false);
});

it("does not treat legacy stop-only records as stop-limit authorization", () => {
  expect(
    matchesFinanceResearchRecoveryProtection({
      instrument: "BTC/USD",
      protection: { id: "protection-1", quantity: 0.5, stopPrice: 90 },
      brokerOrder: stopLimitOrder,
    }),
  ).toBe(false);
});

it("rejects coerced non-numeric broker limit prices", () => {
  expect(
    matchesFinanceResearchRecoveryProtection({
      instrument: "BTC/USD",
      protection: { ...stopLimitProtection, limitPrice: 1 },
      brokerOrder: { ...stopLimitOrder, limit_price: true },
    }),
  ).toBe(false);
});

it("keeps legacy stop records compatible with exact stop orders", () => {
  expect(
    matchesFinanceResearchRecoveryProtection({
      instrument: "AAPL",
      protection: { id: "old-stop", quantity: 1, stopPrice: 90 },
      brokerOrder: {
        id: "old-stop",
        symbol: "AAPL",
        side: "sell",
        type: "stop",
        time_in_force: "gtc",
        qty: "1",
        stop_price: "90",
        status: "canceled",
        filled_qty: "0",
      },
    }),
  ).toBe(true);
});

it.each([{ qty: true }, { stop_price: true }, { filled_qty: false }])(
  "rejects coercible malformed broker numeric fields during recovery: %j",
  (patch) => {
    expect(
      matchesFinanceResearchRecoveryProtection({
        instrument: "BTC/USD",
        protection: { ...stopLimitProtection, quantity: 1, stopPrice: 1, limitPrice: 1 },
        brokerOrder: { ...stopLimitOrder, qty: "1", stop_price: "1", limit_price: "1", ...patch },
      }),
    ).toBe(false);
  },
);
