import { expect, it, vi } from "vitest";
import { clientOrderIdentity } from "./finance-alpaca-execution-adapter.js";
import * as alpacaRun from "./finance-alpaca-run.js";
import * as credentials from "./finance-credential-env.js";
import * as executionRecovery from "./finance-execution-recovery.js";
import type { FinanceExecutionSafetyClaim } from "./finance-execution-safety.js";
import {
  matchesFinanceResearchRecoveryProtection,
  recoverFinanceResearchHistory,
  runFinanceResearchExecutionBridge,
} from "./finance-research-execution-bridge.js";
import * as transport from "./finance-write-transport.js";

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

it.each([1, 2])(
  "default history recovery never acquires write authority (filled quantity %s)",
  async (filledQuantity) => {
    const intent = {
      intentId: "old-reduction",
      instrument: "TSLA",
      side: "sell" as const,
      orderType: "market" as const,
      quantity: 2,
      referencePrice: 100,
      referencePriceAt: "2026-09-20T00:00:00Z",
      runAuthorizationId: "expired-run",
      rationale: "fixture",
    };
    const budget = {
      automation: "attended" as const,
      allowedInstruments: ["TSLA"],
      maxOrderNotional: 1000,
      maxInstrumentNotional: 2000,
      maxOrdersPerRun: 5,
    };
    const claim: FinanceExecutionSafetyClaim = {
      id: "claim",
      run: "expired-run",
      instrument: "TSLA",
      notional: 200,
      snapshotId: "old",
      at: intent.referencePriceAt,
      status: "unknown",
      binding: {
        accountId: "account",
        adapterId: "alpaca-venue",
        venue: "alpaca:paper",
        intent,
        budget,
        positionQuantity: 2,
        protectiveOrders: [{ id: "old-stop", quantity: 2, stopPrice: 90 }],
        policy: {
          planId: "old",
          revision: "1",
          riskModel: "fully_funded_unhedged_spot",
          authorizedSide: "sell",
          authorizedQuantity: 2,
          expiresAt: "2026-09-20T00:00:00Z",
          maxPortfolioDrawdownFraction: 0.2,
          maxGrossExposure: 2000,
          maxAccountAgeMs: 60000,
          maxQuoteAgeMs: 60000,
          maxInstrumentEvidenceAgeMs: 60000,
        },
      },
    };
    const read = vi.fn(async (url: string) => {
      const pathname = new URL(url).pathname;
      const value =
        pathname === "/v2/account"
          ? { id: "account" }
          : pathname.includes("orders:by_client_order_id")
            ? {
                client_order_id: clientOrderIdentity("paper", intent),
                symbol: "TSLA",
                side: "sell",
                type: "market",
                qty: "2",
                time_in_force: "gtc",
                id: "sell",
                status: filledQuantity === 2 ? "filled" : "canceled",
                filled_qty: String(filledQuantity),
                filled_avg_price: "100",
                filled_at: "2026-09-20T00:00:00Z",
              }
            : pathname === "/v2/orders/old-stop"
              ? {
                  id: "old-stop",
                  symbol: "TSLA",
                  side: "sell",
                  type: "stop",
                  time_in_force: "gtc",
                  status: "canceled",
                  qty: "2",
                  filled_qty: "0",
                  stop_price: "90",
                }
              : pathname.startsWith("/v2/positions/")
                ? { symbol: "TSLA", side: "long", qty: String(2 - filledQuantity) }
                : pathname === "/v2/orders"
                  ? []
                  : null;
      if (value === null) {
        throw new Error(`unexpected read: ${pathname}`);
      }
      return { status: 200, body: JSON.stringify(value) };
    });
    const env = vi.spyOn(credentials, "resolveFinanceCredentialEnv").mockReturnValue({
      ALPACA_API_KEY_ID: "PKFIXTURE_ONLY",
      ALPACA_API_SECRET_KEY: "FIXTURE_ONLY",
    });
    const readFactory = vi.spyOn(transport, "createFinanceUncachedFetch").mockReturnValue(read);
    const write = vi.fn(async () => {
      throw new Error("unexpected write");
    });
    const writeFactory = vi.spyOn(transport, "createFinanceWriteTransport").mockReturnValue(write);
    const recover = vi
      .spyOn(executionRecovery, "recoverConfirmedFinanceExecutions")
      .mockImplementation(async (options) => {
        const result = {
          replayed: [] as string[],
          alreadyRecorded: [],
          pendingReconciliation: [] as string[],
          legacyUnsupported: [],
          noFill: [],
          failures: [] as { claimId: string; reason: string }[],
        };
        try {
          const fill = await options.resolvePending!(claim, new AbortController().signal);
          if (fill) {
            result.replayed.push(claim.id);
          } else {
            result.pendingReconciliation.push(claim.id);
          }
        } catch {
          result.failures.push({
            claimId: claim.id,
            reason: "pending_execution_resolution_unavailable",
          });
        }
        return result;
      });
    try {
      const result = await recoverFinanceResearchHistory({
        mode: "shadow",
        stateDirectory: "offline-fixture",
        recovery: {
          safetyStateDir: "offline-fixture",
          accountId: "account",
          venue: "alpaca:paper",
        },
        execution: {
          instruments: ["AAPL"],
          market: { referencePrice: 100, referencePriceAt: intent.referencePriceAt },
          equity: 10000,
          budget: { ...budget, allowedInstruments: ["AAPL"] },
          runAuthorizationId: "new-run",
        },
      });
      expect(result.ok).toBe(filledQuantity === 2);
      expect(read).toHaveBeenCalled();
      expect(writeFactory).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
    } finally {
      recover.mockRestore();
      env.mockRestore();
      readFactory.mockRestore();
      writeFactory.mockRestore();
    }
  },
);

it("preserves the explicitly supplied controller recovery owner", async () => {
  const resolvePending = vi.fn(async () => undefined);
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
  try {
    await recoverFinanceResearchHistory({
      stateDirectory: "offline-fixture",
      recovery: {
        safetyStateDir: "offline-fixture",
        accountId: "account",
        venue: "alpaca:paper",
        resolvePending,
      },
    });
    expect(recover).toHaveBeenCalledWith(expect.objectContaining({ resolvePending }));
  } finally {
    recover.mockRestore();
  }
});
