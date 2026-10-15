import { expect, it } from "vitest";
import { calculateFinancePositionSize as size } from "./finance-position-sizing.js";
const base = { side: "buy" as const, entryPrice: 100, stopPrice: 99, riskBudget: 200 };
it("recalculates each entry scenario rather than reusing shares", () => {
  expect(size(base)).toMatchObject({
    quantity: 200,
    plannedLoss: 200,
    guaranteedMaximumLoss: false,
    costsProvided: false,
  });
  expect(size({ ...base, entryPrice: 101 })).toMatchObject({
    quantity: 100,
    plannedLoss: 200,
    notional: 10100,
  });
});
it("includes supplied costs and capital cap without rounding up", () => {
  expect(size({ ...base, roundTripCostPerUnit: 0.1, fixedCosts: 2 })).toMatchObject({
    quantity: 180,
    plannedStopLoss: 180,
    estimatedCosts: 20,
    plannedLoss: 200,
  });
  expect(size({ ...base, maxNotional: 5000 })).toMatchObject({
    quantity: 50,
    notional: 5000,
    plannedLoss: 50,
  });
});
it("handles short scenarios and insufficient budgets", () => {
  expect(size({ ...base, side: "sell", stopPrice: 102 })).toMatchObject({
    quantity: 100,
    plannedLoss: 200,
  });
  expect(size({ ...base, fixedCosts: 201 })).toMatchObject({ quantity: 0, plannedLoss: 0 });
});
it.each([
  { stopPrice: 100 },
  { stopPrice: 101 },
  { riskBudget: 0 },
  { entryPrice: NaN },
  { roundTripCostPerUnit: -1 },
  { fixedCosts: Infinity },
  { maxNotional: -1 },
])("rejects invalid inputs %j", (change) => {
  expect(() => size({ ...base, ...change })).toThrow();
});
it("keeps floating point boundary sizes within both budgets", () => {
  const result = size({ ...base, entryPrice: 1, stopPrice: 0.9, riskBudget: 0.3, maxNotional: 3 });
  expect(result.plannedLoss).toBeLessThanOrEqual(0.3);
  expect(result.notional).toBeLessThanOrEqual(3);
});
