import { expect, it, vi } from "vitest";
import * as alpacaRun from "./finance-alpaca-run.js";
import * as executionRecovery from "./finance-execution-recovery.js";
import {
  matchesFinanceResearchRecoveryProtection,
  runFinanceResearchExecutionBridge,
} from "./finance-research-execution-bridge.js";

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

it("uses controller exact quantity in both the research mandate and placement compiler", async () => {
  const recover = vi
    .spyOn(executionRecovery, "recoverConfirmedFinanceExecutions")
    .mockResolvedValue({
      replayed: [],
      alreadyRecorded: [],
      pendingReconciliation: [],
      legacyUnsupported: [],
      noFill: [],
      failures: [],
    });
  const place = vi
    .spyOn(alpacaRun, "runFinanceAlpacaOrder")
    .mockResolvedValue({ ok: false, stage: "place", refusals: ["offline placement sentinel"] });
  const input = {
    instrument: "BTC/USD",
    assetClass: "crypto" as const,
    modelText: JSON.stringify({
      conclusionId: "exact-reduction",
      instrument: "BTC/USD",
      assetClass: "crypto",
      direction: "sell",
      conviction: 0.9,
      thesis: "sourced reduction",
      invalidationPrice: 110,
      horizonDays: 30,
      evidence: [{ sourceId: "a" }, { sourceId: "b" }],
      quantityOverride: 999,
    }),
    evidence: ["a", "b"].map((sourceId) => ({
      sourceId,
      description: "fixture",
      detail: "offline evidence",
      sourceUrlOrArtifact: `fixture:${sourceId}`,
    })),
    market: { referencePrice: 100, referencePriceAt: "2026-09-22T00:00:00Z" },
    equity: 100000,
    runAuthorizationId: "offline-input",
  };
  const control = {
    mode: "alpaca_paper" as const,
    stateDirectory: "offline-only",
    recovery: {
      safetyStateDir: "offline-only",
      accountId: "fixture-account",
      venue: "alpaca:paper",
    },
    riskContext: {
      drawdownFraction: 0,
      averagingDown: false,
      revengeSizing: false,
      hasSignificantAutocorrelation: true,
    },
    execution: {
      market: input.market,
      equity: input.equity,
      runAuthorizationId: "controller-run",
      budget: {
        automation: "unattended" as const,
        allowedInstruments: ["BTC/USD"],
        maxOrderNotional: 1000,
        maxInstrumentNotional: 5000,
        maxOrdersPerRun: 8,
      },
      instruments: ["BTC/USD"],
      quantityOverride: 0.000399,
      createSafetyContext: () => ({ kind: "controller_execution_safety" as const }),
    },
  };
  try {
    const exact = await runFinanceResearchExecutionBridge(input, control);
    expect(exact).toMatchObject({
      status: "refused",
      decision: { passed: true, intent: { quantity: 0.000399 } },
      placement: { refusals: ["offline placement sentinel"] },
    });
    expect(place).toHaveBeenCalledWith(
      expect.objectContaining({
        quantityOverride: 0.000399,
        mode: "paper",
        runAuthorizationId: "controller-run",
      }),
    );
    place.mockClear();
    const oversized = await runFinanceResearchExecutionBridge(input, {
      ...control,
      execution: { ...control.execution, quantityOverride: 51 },
    });
    expect(oversized).toMatchObject({
      status: "refused",
      decision: { passed: false, intent: undefined },
    });
    expect(place).not.toHaveBeenCalled();
    const wrongAsset = await runFinanceResearchExecutionBridge(
      { ...input, assetClass: "us_equity" },
      control,
    );
    expect(wrongAsset).toMatchObject({
      status: "refused",
      refusals: ["model conclusion changed the authorized instrument or asset class"],
    });
    expect(place).not.toHaveBeenCalled();
  } finally {
    recover.mockRestore();
    place.mockRestore();
  }
});
