import { expect, it } from "vitest";
import {
  classifyFinanceProtectionOrders,
  planFinanceProtectedReduction,
} from "./finance-protection-coordination.js";
const stop = {
  id: "protect",
  symbol: "SPY",
  qty: "1",
  filled_qty: "0",
  stop_price: "90",
  type: "stop",
  side: "sell",
  status: "new",
  time_in_force: "gtc",
};
it("recognizes protective reservations without treating them as pending entries", () => {
  const result = classifyFinanceProtectionOrders([stop], new Map([["SPY", 2]]));
  expect(result.unresolved).toEqual([]);
  expect(result.reserved.get("SPY")).toBe(1);
  expect(
    planFinanceProtectedReduction({
      positionQuantity: 2,
      sellQuantity: 1,
      protective: result.protective,
    }).status,
  ).toBe("ready");
  expect(
    planFinanceProtectedReduction({
      positionQuantity: 2,
      sellQuantity: 2,
      protective: result.protective,
    }),
  ).toMatchObject({
    status: "protection_change_required",
    conflictingOrderIds: ["protect"],
    requiresTerminalCancellationAndFreshPosition: true,
  });
});
it.each([
  { status: "pending_cancel" },
  { status: "partially_filled", filled_qty: "0.1" },
  { qty: "3" },
  { time_in_force: "day" },
  { expires_at: "2020-01-01T00:00:00Z" },
])("does not clear unsettled or invalid protection: %j", (patch) => {
  expect(
    classifyFinanceProtectionOrders([{ ...stop, ...patch }], new Map([["SPY", 2]])).unresolved,
  ).toEqual(["protect"]);
});
it("rejects duplicate protection IDs and cumulative over-reservation", () => {
  expect(classifyFinanceProtectionOrders([stop, stop], new Map([["SPY", 2]])).unresolved).toEqual([
    "protect",
  ]);
  expect(
    classifyFinanceProtectionOrders(
      [stop, { ...stop, id: "second", qty: "2" }],
      new Map([["SPY", 2]]),
    ).unresolved,
  ).toEqual(["second"]);
});
it("waits for terminal cancellation, re-reads inventory and protects only the remaining position", async () => {
  const { executeFinanceProtectedReduction } = await import("./finance-protection-coordination.js");
  const steps: string[] = [];
  let canceled = false;
  let sold = false;
  let reads = 0;
  const result = await executeFinanceProtectedReduction({
    instrument: "SPY",
    positionQuantity: 2,
    sellQuantity: 1,
    protection: { id: "stop", quantity: 2, stopPrice: 90 },
    signal: AbortSignal.timeout(1000),
    readStop: async () => {
      steps.push("read-stop");
      return {
        id: "stop",
        instrument: "SPY",
        quantity: 2,
        stopPrice: 90,
        filledQuantity: 0,
        status: !canceled ? "new" : ++reads === 1 ? "pending_cancel" : "canceled",
      };
    },
    cancelStop: async () => {
      steps.push("cancel");
      canceled = true;
    },
    readPosition: async () => {
      steps.push("read-position");
      return sold ? 1 : 2;
    },
    execute: async () => {
      steps.push("sell");
      sold = true;
      return { filledQuantity: 1 };
    },
    restoreProtection: async (quantity, stopPrice) => {
      steps.push("protect");
      expect(quantity).toBe(1);
      expect(stopPrice).toBe(90);
    },
  });
  expect(result.filledQuantity).toBe(1);
  expect(steps).toEqual([
    "read-stop",
    "cancel",
    "read-stop",
    "read-stop",
    "read-position",
    "sell",
    "read-position",
    "protect",
  ]);
});
it("does not sell when the protective stop fills during cancellation", async () => {
  const { executeFinanceProtectedReduction } = await import("./finance-protection-coordination.js");
  let canceled = false,
    executed = false;
  await expect(
    executeFinanceProtectedReduction({
      instrument: "SPY",
      positionQuantity: 1,
      sellQuantity: 1,
      protection: { id: "stop", quantity: 1, stopPrice: 90 },
      signal: AbortSignal.timeout(1000),
      readStop: async () => ({
        id: "stop",
        instrument: "SPY",
        quantity: 1,
        stopPrice: 90,
        filledQuantity: canceled ? 1 : 0,
        status: canceled ? "filled" : "new",
      }),
      cancelStop: async () => {
        canceled = true;
      },
      readPosition: async () => 0,
      execute: async () => {
        executed = true;
        return { filledQuantity: 1 };
      },
      restoreProtection: async () => {
        throw new Error("must not re-arm");
      },
    }),
  ).rejects.toThrow("changed or filled");
  expect(executed).toBe(false);
});
it("never re-arms an old quantity after an uncertain sell", async () => {
  const { executeFinanceProtectedReduction } = await import("./finance-protection-coordination.js");
  let canceled = false,
    restored = false;
  await expect(
    executeFinanceProtectedReduction({
      instrument: "SPY",
      positionQuantity: 1,
      sellQuantity: 1,
      protection: { id: "stop", quantity: 1, stopPrice: 90 },
      signal: AbortSignal.timeout(1000),
      readStop: async () => ({
        id: "stop",
        instrument: "SPY",
        quantity: 1,
        stopPrice: 90,
        filledQuantity: 0,
        status: canceled ? "canceled" : "new",
      }),
      cancelStop: async () => {
        canceled = true;
      },
      readPosition: async () => 1,
      execute: async () => {
        throw new Error("lost response");
      },
      restoreProtection: async () => {
        restored = true;
      },
    }),
  ).rejects.toThrow("requires reconciliation");
  expect(restored).toBe(false);
});
it("restores original protection after a proven sell rejection", async () => {
  const { executeFinanceProtectedReduction } = await import("./finance-protection-coordination.js");
  const rejected = new Error("venue rejected");
  let canceled = false;
  let restored = 0;
  await expect(
    executeFinanceProtectedReduction({
      instrument: "SPY",
      positionQuantity: 2,
      sellQuantity: 1,
      protection: { id: "stop", quantity: 2, stopPrice: 90 },
      signal: AbortSignal.timeout(1000),
      readStop: async () => ({
        id: "stop",
        instrument: "SPY",
        quantity: 2,
        stopPrice: 90,
        filledQuantity: 0,
        status: canceled ? "canceled" : "new",
      }),
      cancelStop: async () => {
        canceled = true;
      },
      readPosition: async () => 2,
      execute: async () => {
        throw rejected;
      },
      isDefinitelyRejected: (error) => error === rejected,
      restoreProtection: async (quantity) => {
        restored = quantity;
      },
    }),
  ).rejects.toBe(rejected);
  expect(restored).toBe(2);
});
