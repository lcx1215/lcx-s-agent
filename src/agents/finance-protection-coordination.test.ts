import { expect, it, vi } from "vitest";
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
it("recognizes stop-limit protection with its exact limit price", () => {
  const result = classifyFinanceProtectionOrders(
    [{ ...stop, type: "stop_limit", limit_price: "89" }],
    new Map([["SPY", 1]]),
  );
  expect(result.unresolved).toEqual([]);
  expect(result.protective).toEqual([
    {
      id: "protect",
      instrument: "SPY",
      quantity: 1,
      stopPrice: 90,
      orderType: "stop_limit",
      limitPrice: 89,
    },
  ]);
});
it("matches broker crypto stop symbols to the position owner's canonical identity", () => {
  const result = classifyFinanceProtectionOrders(
    [
      {
        ...stop,
        symbol: "BTCUSD",
        qty: "0.000399",
        type: "stop_limit",
        stop_price: "90000",
        limit_price: "89000",
      },
    ],
    new Map([["BTC/USD", 0.000399]]),
  );
  expect(result.unresolved).toEqual([]);
  expect(result.reserved.get("BTC/USD")).toBe(0.000399);
  expect(result.protective[0]).toMatchObject({
    instrument: "BTC/USD",
    quantity: 0.000399,
    stopPrice: 90000,
    limitPrice: 89000,
  });
  expect(result.coverage[0]).toMatchObject({ status: "covered", uncoveredQuantity: 0 });
});
it("does not invent a crypto holding or rewrite an exact USD-suffixed identity", () => {
  expect(
    classifyFinanceProtectionOrders([{ ...stop, symbol: "BTCUSD" }], new Map()).unresolved,
  ).toEqual(["protect"]);
  const result = classifyFinanceProtectionOrders(
    [{ ...stop, symbol: "PUSD" }],
    new Map([
      ["PUSD", 1],
      ["P/USD", 2],
    ]),
  );
  expect(result.protective[0]?.instrument).toBe("PUSD");
  expect(result.reserved.has("P/USD")).toBe(false);
});
it("keeps an aliased crypto stop unresolved while cancellation is pending", () => {
  const result = classifyFinanceProtectionOrders(
    [
      {
        ...stop,
        symbol: "BTCUSD",
        qty: "0.000399",
        type: "stop_limit",
        limit_price: "89",
        status: "pending_cancel",
      },
    ],
    new Map([["BTC/USD", 0.000399]]),
  );
  expect(result.unresolved).toEqual(["protect"]);
  expect(result.protective).toEqual([]);
  expect(result.coverage[0]).toMatchObject({
    status: "no_recognized_stop",
    uncoveredQuantity: 0.000399,
  });
});
it.each([undefined, "NaN", "0", "-1", "91"])(
  "does not recognize stop-limit protection with invalid limit price %s",
  (limit_price) => {
    const result = classifyFinanceProtectionOrders(
      [{ ...stop, type: "stop_limit", limit_price }],
      new Map([["SPY", 1]]),
    );
    expect(result.unresolved).toEqual(["protect"]);
    expect(result.protective).toEqual([]);
  },
);
it.each([true, false, {}, []])(
  "does not coerce non-numeric stop-limit price values: %j",
  (limit_price) => {
    const result = classifyFinanceProtectionOrders(
      [{ ...stop, type: "stop_limit", limit_price }],
      new Map([["SPY", 1]]),
    );
    expect(result.unresolved).toEqual(["protect"]);
    expect(result.protective).toEqual([]);
  },
);
it.each([
  { status: "pending_cancel" },
  { status: "partially_filled", filled_qty: "0.1" },
  { qty: "3" },
  { filled_qty: null },
  { filled_qty: "" },
  { filled_qty: false },
  { filled_qty: [] },
  { qty: true },
  { stop_price: true },
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
it("rejects a legacy stop record that carries a limit price", () => {
  expect(() =>
    planFinanceProtectedReduction({
      positionQuantity: 1,
      sellQuantity: 1,
      protective: [{ id: "old-stop", quantity: 1, stopPrice: 90, limitPrice: 89 }],
    }),
  ).toThrow("invalid protected reduction");
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
it("preserves stop-limit type and price through cancellation and restoration", async () => {
  const { executeFinanceProtectedReduction } = await import("./finance-protection-coordination.js");
  let canceled = false,
    sold = false;
  const restoreProtection = vi.fn(async () => {});
  const result = await executeFinanceProtectedReduction({
    instrument: "BTC/USD",
    positionQuantity: 2,
    sellQuantity: 1,
    protection: {
      id: "stop-limit",
      quantity: 2,
      stopPrice: 90,
      orderType: "stop_limit",
      limitPrice: 89,
    },
    signal: AbortSignal.timeout(1000),
    readStop: async () => ({
      id: "stop-limit",
      instrument: "BTC/USD",
      quantity: 2,
      stopPrice: 90,
      orderType: "stop_limit",
      limitPrice: 89,
      filledQuantity: 0,
      status: canceled ? "canceled" : "new",
    }),
    cancelStop: async () => {
      canceled = true;
    },
    readPosition: async () => (sold ? 1 : 2),
    execute: async () => {
      sold = true;
      return { filledQuantity: 1 };
    },
    restoreProtection,
  });
  expect(result.filledQuantity).toBe(1);
  expect(restoreProtection).toHaveBeenCalledWith(1, 90, "stop_limit", 89);
});
it("refuses a type or limit-price change after cancellation starts", async () => {
  const { executeFinanceProtectedReduction } = await import("./finance-protection-coordination.js");
  let reads = 0,
    executed = false,
    restored = false;
  await expect(
    executeFinanceProtectedReduction({
      instrument: "BTC/USD",
      positionQuantity: 1,
      sellQuantity: 1,
      protection: {
        id: "stop-limit",
        quantity: 1,
        stopPrice: 90,
        orderType: "stop_limit",
        limitPrice: 89,
      },
      signal: AbortSignal.timeout(1000),
      readStop: async () => ({
        id: "stop-limit",
        instrument: "BTC/USD",
        quantity: 1,
        stopPrice: 90,
        orderType: reads++ === 0 ? "stop_limit" : "stop",
        ...(reads === 1 ? { limitPrice: 89 } : {}),
        filledQuantity: 0,
        status: reads === 1 ? "new" : "canceled",
      }),
      cancelStop: async () => {},
      readPosition: async () => 1,
      execute: async () => {
        executed = true;
        return { filledQuantity: 1 };
      },
      restoreProtection: async () => {
        restored = true;
      },
    }),
  ).rejects.toThrow("protection changed or filled");
  expect(executed).toBe(false);
  expect(restored).toBe(false);
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

it.each([NaN, Infinity, -1, 0])(
  "rejects invalid reduction sizing before touching protection: %s",
  async (sellQuantity) => {
    const { executeFinanceProtectedReduction } =
      await import("./finance-protection-coordination.js");
    const readStop = vi.fn();
    const cancelStop = vi.fn();
    await expect(
      executeFinanceProtectedReduction({
        instrument: "SPY",
        positionQuantity: 1,
        sellQuantity,
        protection: { id: "stop", quantity: 1, stopPrice: 90 },
        signal: AbortSignal.timeout(1000),
        readStop,
        cancelStop,
        readPosition: vi.fn(),
        execute: vi.fn(),
        restoreProtection: vi.fn(),
      }),
    ).rejects.toThrow("invalid protected reduction");
    expect(readStop).not.toHaveBeenCalled();
    expect(cancelStop).not.toHaveBeenCalled();
  },
);

it("does not classify protection against unknown holdings or an infinite stop", () => {
  expect(classifyFinanceProtectionOrders([stop], new Map([["SPY", NaN]])).unresolved).toEqual([
    "protect",
  ]);
  expect(() =>
    planFinanceProtectedReduction({
      positionQuantity: 1,
      sellQuantity: 1,
      protective: [{ id: "stop", quantity: 1, stopPrice: Infinity }],
    }),
  ).toThrow("invalid protected reduction");
});

it("reports uncovered holdings even when every open order is valid", () => {
  const result = classifyFinanceProtectionOrders(
    [stop],
    new Map([
      ["SPY", 1],
      ["BTC/USD", 0.000399],
    ]),
  );
  expect(result.unresolved).toEqual([]);
  expect(result.coverage).toEqual([
    {
      instrument: "SPY",
      positionQuantity: 1,
      recognizedStopQuantity: 1,
      uncoveredQuantity: 0,
      status: "covered",
    },
    {
      instrument: "BTC/USD",
      positionQuantity: 0.000399,
      recognizedStopQuantity: 0,
      uncoveredQuantity: 0.000399,
      status: "no_recognized_stop",
    },
  ]);
});
it("distinguishes partial coverage and excludes invalid stops from coverage", () => {
  expect(classifyFinanceProtectionOrders([stop], new Map([["SPY", 2]])).coverage[0]).toMatchObject({
    status: "partial",
    uncoveredQuantity: 1,
  });
  expect(
    classifyFinanceProtectionOrders([{ ...stop, status: "pending_cancel" }], new Map([["SPY", 1]]))
      .coverage[0],
  ).toMatchObject({ status: "no_recognized_stop", uncoveredQuantity: 1 });
  expect(classifyFinanceProtectionOrders([], new Map([["SPY", -1]])).coverage[0]).toMatchObject({
    status: "unsupported_position",
    uncoveredQuantity: null,
  });
});

it.each([
  "verify_cancellation",
  "verify_position",
  "verify_remaining_position",
  "restore_protection",
] as const)(
  "retains bounded observations when protected reduction fails at %s",
  async (failedStage) => {
    const { executeFinanceProtectedReduction, FinanceProtectedReductionError } =
      await import("./finance-protection-coordination.js");
    let canceled = false,
      positionReads = 0;
    const execute = vi.fn(async () => ({ filledQuantity: 1 }));
    const restore = vi.fn(async () => {
      if (failedStage === "restore_protection") {
        throw new Error("private transport detail");
      }
    });
    const pending = executeFinanceProtectedReduction({
      instrument: "SPY",
      positionQuantity: 2,
      sellQuantity: 1,
      protection: { id: "stop", quantity: 2, stopPrice: 90 },
      signal: AbortSignal.timeout(1000),
      readStop: async () => {
        if (canceled && failedStage === "verify_cancellation") {
          throw new Error("private transport detail");
        }
        return {
          id: "stop",
          instrument: "SPY",
          quantity: 2,
          filledQuantity: 0,
          stopPrice: 90,
          status: canceled ? "canceled" : "new",
        };
      },
      cancelStop: async () => {
        canceled = true;
      },
      readPosition: async () => {
        positionReads++;
        if (
          (positionReads === 1 && failedStage === "verify_position") ||
          (positionReads === 2 && failedStage === "verify_remaining_position")
        ) {
          throw new Error("private transport detail");
        }
        return positionReads === 1 ? 2 : 1;
      },
      execute,
      restoreProtection: restore,
    });
    await expect(pending).rejects.toBeInstanceOf(FinanceProtectedReductionError);
    const entered =
      failedStage === "verify_remaining_position" || failedStage === "restore_protection";
    await expect(pending).rejects.toMatchObject({
      diagnostic: {
        stage: failedStage,
        cancellationConfirmed: failedStage !== "verify_cancellation",
        sellExecutionEntered: entered,
        protectionRestored: false,
        ...(entered ? { filledQuantity: 1 } : {}),
      },
    });
    expect(execute).toHaveBeenCalledTimes(entered ? 1 : 0);
    expect(restore).toHaveBeenCalledTimes(failedStage === "restore_protection" ? 1 : 0);
  },
);

it("retains the adapter attested request state and transport cause without rearming an uncertain sell", async () => {
  const { AlpacaOrderUncertainError } = await import("./finance-alpaca-execution-adapter.js");
  const { executeFinanceProtectedReduction } = await import("./finance-protection-coordination.js");
  let canceled = false;
  const restore = vi.fn();
  const cause = Object.assign(new Error("private URL and headers"), { code: "ECONNRESET" });
  await expect(
    executeFinanceProtectedReduction({
      instrument: "SPY",
      positionQuantity: 2,
      sellQuantity: 1,
      protection: { id: "stop", quantity: 2, stopPrice: 90 },
      signal: AbortSignal.timeout(5000),
      readStop: async () => ({
        id: "stop",
        instrument: "SPY",
        quantity: 2,
        filledQuantity: 0,
        stopPrice: 90,
        orderType: "stop",
        status: canceled ? "canceled" : "new",
      }),
      cancelStop: async () => {
        canceled = true;
      },
      readPosition: async () => 2,
      execute: async () => {
        throw new AlpacaOrderUncertainError("original-cid", undefined, cause);
      },
      describeOrderRequestState: (error) =>
        error instanceof AlpacaOrderUncertainError ? "invoked" : undefined,
      restoreProtection: restore,
    }),
  ).rejects.toMatchObject({
    diagnostic: {
      stage: "execute_sell",
      orderRequestState: "invoked",
      readFailure: { code: "ECONNRESET" },
      protectionRestored: false,
    },
  });
  expect(restore).not.toHaveBeenCalled();
});
