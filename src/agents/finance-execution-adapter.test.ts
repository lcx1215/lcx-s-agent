import { describe, expect, it, vi } from "vitest";
import {
  createPaperExecutionAdapter,
  DEFAULT_FINANCE_RISK_BUDGET,
  FINANCE_EXECUTION_RECEIPT_SCHEMA,
  FINANCE_RISK_BUDGET_ANY_INSTRUMENT,
  type FinanceExecutionAdapter,
  type FinanceExecutionIntent,
  type FinanceRiskBudget,
  placeFinanceOrder,
} from "./finance-execution-adapter.js";

type PlacementRequest = Parameters<typeof placeFinanceOrder>[0];

const budget: FinanceRiskBudget = {
  maxOrderNotional: 10_000,
  maxInstrumentNotional: 25_000,
  maxOrdersPerRun: 5,
  allowedInstruments: ["AAPL"],
};

const intent: FinanceExecutionIntent = {
  intentId: "intent-1",
  instrument: "AAPL",
  side: "buy",
  orderType: "market",
  quantity: 10,
  referencePrice: 231.4,
  referencePriceAt: "2026-09-17T21:00:00Z",
  runAuthorizationId: "run-1",
  rationale: "fixture",
};

const paper = createPaperExecutionAdapter({ instruments: ["AAPL"] });

function request(overrides: Partial<PlacementRequest> = {}): PlacementRequest {
  return {
    mode: "live_execution",
    intent,
    budget,
    adapters: [paper],
    executionAdapterId: "paper",
    committedInstrumentNotional: 0,
    ordersPlacedThisRun: 0,
    recordedAt: "2026-09-18T03:00:00Z",
    ...overrides,
  };
}

function spyAdapter(): { adapter: FinanceExecutionAdapter; invoke: ReturnType<typeof vi.fn> } {
  const invoke = vi.fn(async () => ({
    filledQuantity: 1,
    fillPrice: 1,
    filledAt: "2026-09-18T03:00:00Z",
    venueRef: "spy",
  }));
  return {
    invoke,
    adapter: {
      id: "spy",
      venue: "spy",
      kind: "venue",
      orderTypes: ["market", "limit"],
      instruments: ["AAPL"],
      credentialsAuthority: "external",
      execute: invoke,
    },
  };
}

describe("finance execution adapter seam", () => {
  it("places a paper order through the declared adapter and stamps the receipt", async () => {
    const result = await placeFinanceOrder(request());

    expect(result.status).toBe("placed");
    expect(result.refusalReasons).toEqual([]);
    expect(result.receipt).toMatchObject({
      schemaVersion: FINANCE_EXECUTION_RECEIPT_SCHEMA,
      intentId: "intent-1",
      runAuthorizationId: "run-1",
      adapterId: "paper",
      adapterKind: "paper",
      instrument: "AAPL",
      side: "buy",
      notional: 2314,
      executionAuthority: "declared_execution_adapter_required",
      recordedAt: "2026-09-18T03:00:00Z",
    });
    // A paper fill must never read as a market observation.
    expect(result.receipt?.fill.venueRef).toContain("paper");
  });

  it("refuses every mode other than live_execution before any adapter runs", async () => {
    const { adapter, invoke } = spyAdapter();
    for (const mode of ["research_only", "strategy_candidate", "conditional_trade_candidate"]) {
      const result = await placeFinanceOrder(
        request({
          mode: mode as PlacementRequest["mode"],
          adapters: [adapter],
          executionAdapterId: "spy",
        }),
      );
      expect(result.status).toBe("refused");
      expect(result.refusalReasons).toContain("finance_execution_requires_live_execution_mode");
      expect(result.receipt).toBeUndefined();
    }
    expect(invoke).not.toHaveBeenCalled();
  });

  it("requires an explicit run authorization and a declared adapter", async () => {
    const noAuthorization = await placeFinanceOrder(
      request({ intent: { ...intent, runAuthorizationId: "  " } }),
    );
    expect(noAuthorization.refusalReasons).toContain("explicit_run_authorization_required");

    const undeclared = await placeFinanceOrder(request({ executionAdapterId: "not-registered" }));
    expect(undeclared.refusalReasons).toContain("declared_execution_adapter_required");
    expect(undeclared.status).toBe("refused");
  });

  it("requires the adapter to accept the instrument and the order type", async () => {
    const narrow = createPaperExecutionAdapter({ instruments: ["MSFT"], orderTypes: ["limit"] });
    const result = await placeFinanceOrder(request({ adapters: [narrow] }));

    expect(result.refusalReasons).toContain("declared_adapter_instrument_unsupported");
    expect(result.refusalReasons).toContain("declared_adapter_order_type_unsupported");
    expect(result.receipt).toBeUndefined();
  });

  it("admits an order under the default budget without deleting the allowlist", async () => {
    expect(DEFAULT_FINANCE_RISK_BUDGET.allowedInstruments).toEqual([
      FINANCE_RISK_BUDGET_ANY_INSTRUMENT,
    ]);
    const result = await placeFinanceOrder(
      request({ budget: DEFAULT_FINANCE_RISK_BUDGET, adapters: [paper] }),
    );

    expect(result.status).toBe("placed");
    expect(result.refusalReasons).toEqual([]);
  });

  it("still refuses when the allowlist is explicitly empty or names another instrument", async () => {
    const empty = await placeFinanceOrder(
      request({ budget: { ...budget, allowedInstruments: [] }, adapters: [paper] }),
    );
    expect(empty.status).toBe("refused");
    expect(empty.refusalReasons).toContain("risk_budget_instrument_not_allowed");

    const narrowed = await placeFinanceOrder(
      request({ budget: { ...budget, allowedInstruments: ["MSFT"] }, adapters: [paper] }),
    );
    expect(narrowed.status).toBe("refused");
    expect(narrowed.refusalReasons).toContain("risk_budget_instrument_not_allowed");
  });

  it("treats the any-instrument token as open at the adapter level too", async () => {
    const openAdapter = createPaperExecutionAdapter({
      instruments: [FINANCE_RISK_BUDGET_ANY_INSTRUMENT],
    });
    const result = await placeFinanceOrder(
      request({
        adapters: [openAdapter],
        budget: { ...budget, allowedInstruments: [FINANCE_RISK_BUDGET_ANY_INSTRUMENT] },
      }),
    );

    expect(result.status).toBe("placed");
    expect(result.refusalReasons).toEqual([]);
  });

  it("refuses orders that break the order, instrument or count budget", async () => {
    const tooLarge = await placeFinanceOrder(request({ intent: { ...intent, quantity: 100 } }));
    expect(tooLarge.refusalReasons).toContain("risk_budget_order_notional_exceeded");

    const instrumentCap = await placeFinanceOrder(request({ committedInstrumentNotional: 24_000 }));
    expect(instrumentCap.refusalReasons).toContain("risk_budget_instrument_notional_exceeded");

    const countCap = await placeFinanceOrder(request({ ordersPlacedThisRun: 5 }));
    expect(countCap.refusalReasons).toContain("risk_budget_order_count_exceeded");
  });

  it("reports every boundary one order would cross instead of only the first", async () => {
    const result = await placeFinanceOrder(
      request({
        mode: "research_only",
        intent: { ...intent, quantity: 100, runAuthorizationId: "" },
        budget: { ...budget, allowedInstruments: [] },
      }),
    );

    expect(result.refusalReasons).toEqual([
      "finance_execution_requires_live_execution_mode",
      "explicit_run_authorization_required",
      "risk_budget_instrument_not_allowed",
      "risk_budget_order_notional_exceeded",
    ]);
  });

  it("refuses a market order that carries a limit price and a limit order without one", async () => {
    const marketWithLimit = await placeFinanceOrder(
      request({ intent: { ...intent, limitPrice: 200 } }),
    );
    expect(marketWithLimit.refusalReasons).toContain(
      "execution_intent_limit_price_forbidden_for_market_order",
    );

    const limitWithoutPrice = await placeFinanceOrder(
      request({ intent: { ...intent, orderType: "limit" } }),
    );
    expect(limitWithoutPrice.refusalReasons).toContain("execution_intent_limit_price_required");
  });

  it("requires a timestamped reference price rather than assuming one", async () => {
    const result = await placeFinanceOrder(
      request({ intent: { ...intent, referencePriceAt: "", referencePrice: Number.NaN } }),
    );

    expect(result.refusalReasons).toContain("execution_intent_reference_price_required");
    expect(result.refusalReasons).toContain("execution_intent_reference_price_timestamp_required");
  });

  it("clamps a paper limit fill to the limit and states its slippage assumption", async () => {
    const buy = await placeFinanceOrder(
      request({
        adapters: [createPaperExecutionAdapter({ instruments: ["AAPL"], slippageBps: 100 })],
        intent: { ...intent, orderType: "limit", limitPrice: 231 } as FinanceExecutionIntent,
      }),
    );
    expect(buy.receipt?.fill.fillPrice).toBe(231);

    const sell = await placeFinanceOrder(
      request({
        adapters: [createPaperExecutionAdapter({ instruments: ["AAPL"], slippageBps: 100 })],
        intent: {
          ...intent,
          side: "sell",
          orderType: "limit",
          limitPrice: 232,
        } as FinanceExecutionIntent,
      }),
    );
    expect(sell.receipt?.fill.fillPrice).toBe(232);
    expect(sell.receipt?.fill.venueRef).toContain("slippageBps=100");
  });

  it("derives a stable receipt id from the intent rather than a random one", async () => {
    const first = await placeFinanceOrder(request());
    const second = await placeFinanceOrder(request());
    expect(first.receipt?.receiptId).toBe(second.receipt?.receiptId);
  });
});
