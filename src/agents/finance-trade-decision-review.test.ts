import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  FINANCE_INTRADAY_TRADE_DECISION_REVIEW_SCHEMA,
  FINANCE_TRADE_DECISION_REVIEW_SCHEMA,
  createFinanceTradeDecisionReviewer,
  type FinanceIntradayTradeDecisionReviewRequest,
  type FinanceTradeDecisionReviewRequest,
} from "./finance-trade-decision-review.js";
import type { LogicalAgentModelAdapter } from "./logical-agent-model-router.js";

const request: FinanceTradeDecisionReviewRequest = {
  schemaVersion: FINANCE_TRADE_DECISION_REVIEW_SCHEMA,
  venue: "alpaca:paper",
  asOf: "2026-09-23T19:30:00.000Z",
  signalAnchor: "2026-08-31",
  ruleIds: ["trend_risk_normalised_v1"],
  equity: 100_000,
  rebalanceBand: 0.05,
  caps: { maxOrderNotional: 1_000, maxInstrumentNotional: 2_000, maxOrdersPerRun: 2 },
  reconciliation: { status: "reconciled" },
  positions: [],
  candidates: [
    {
      candidateId: "2026-08-31:SPY:buy",
      instrument: "SPY",
      side: "buy",
      targetWeight: 0.25,
      currentWeight: 0.1,
      weightDelta: 0.15,
      notional: 1_000,
      strategySignal: "hold",
      annualisedVol: 0.2,
      researchClose: 500,
      lastBarDate: "2026-09-22",
      executionQuote: {
        referencePrice: 501,
        referencePriceAt: "2026-09-23T19:29:59.000Z",
        bidPrice: 500,
        askPrice: 501,
        feed: "iex",
        priceBasis: "ask",
        ageMs: 1000,
        maxAgeMs: 5000,
      },
    },
  ],
};

const intradayRequest: FinanceIntradayTradeDecisionReviewRequest = {
  schemaVersion: FINANCE_INTRADAY_TRADE_DECISION_REVIEW_SCHEMA,
  venue: "alpaca:paper",
  asOf: "2026-09-23T19:30:00.000Z",
  signalAnchor: "intraday-signal-1",
  ruleIds: ["opening_range_breakout_long_next_bar_v1"],
  equity: 100_000,
  caps: { maxOrderNotional: 1_000, maxInstrumentNotional: 2_000, maxOrdersPerRun: 1 },
  positionBookObservedAt: "2026-09-23T19:29:59.000Z",
  reconciliation: { status: "ready", historyStatus: "reconciled", uncertaintyReserve: 0 },
  positions: [{ instrument: "SPY", quantity: 0, marketValue: 0 }],
  candidates: [
    {
      candidateId: "intraday-signal-1",
      instrument: "SPY",
      side: "buy",
      strategyRule: "opening_range_breakout_long_next_bar_v1",
      signalReason: "opening_range_breakout",
      signalReferencePrice: 500,
      signalReferencePriceAt: "2026-09-23T19:29:55.000Z",
      stopPrice: 498,
      targetPrice: 504,
      datasetHeadRef: "c".repeat(64),
      intradayOwnedQuantity: 0,
      brokerPositionQuantity: 0,
      executionQuote: {
        referencePrice: 501,
        referencePriceAt: "2026-09-23T19:29:59.000Z",
        bidPrice: 500,
        askPrice: 501,
        feed: "iex",
        priceBasis: "ask",
        sourceUrlOrArtifact: "fixture quote source",
        ageMs: 1000,
        maxAgeMs: 5000,
      },
    },
  ],
};

function adapter(output: unknown): LogicalAgentModelAdapter {
  return {
    id: "fixture",
    provider: "fixture-provider",
    modelId: "fixture-model",
    mode: "adapter",
    capabilities: ["quality_harness"],
    requiredTools: [],
    requiredSideEffects: ["provider_call"],
    invoke: vi.fn(async () => output),
    observe: vi.fn((call) => ({
      ...call,
      transportRequestId: "fixture-private-request-id",
      kind: "provider_call" as const,
    })),
  };
}

describe("configured finance trade decision reviewer", () => {
  it("returns only exact candidate-bound approve/veto decisions and hashes transport identity", async () => {
    const model = adapter({
      schemaVersion: FINANCE_TRADE_DECISION_REVIEW_SCHEMA,
      decisions: [
        {
          candidateId: request.candidates[0].candidateId,
          decision: "approve",
          rationale: "The proposed rebalance fits the supplied evidence and limits.",
        },
      ],
    });
    const reviewer = createFinanceTradeDecisionReviewer({} as OpenClawConfig, {
      adapterFactory: () => model,
      now: vi.fn().mockReturnValueOnce(100).mockReturnValue(125),
    });

    const result = await reviewer(request, AbortSignal.timeout(1000));

    expect(result).toMatchObject({
      status: "completed",
      attempted: true,
      provider: "fixture-provider",
      modelId: "fixture-model",
      latencyMs: 25,
      providerCallObserved: true,
      adapterAttested: true,
      decisions: [{ candidateId: request.candidates[0].candidateId, decision: "approve" }],
    });
    expect(result.requestIdSha256).toMatch(/^[a-f\d]{64}$/u);
    expect(JSON.stringify(result)).not.toContain("fixture-private-request-id");
    expect(model.invoke).toHaveBeenCalledWith(
      expect.objectContaining({ role: "risk_check", payload: request }),
      expect.any(AbortSignal),
    );
  });

  it("binds an intraday review to one exact signal and its own response schema", async () => {
    const model = adapter({
      schemaVersion: FINANCE_INTRADAY_TRADE_DECISION_REVIEW_SCHEMA,
      decisions: [
        {
          candidateId: intradayRequest.candidates[0].candidateId,
          decision: "approve",
          rationale: "The supplied signal, quote, and reconciled account facts are consistent.",
        },
      ],
    });
    const reviewer = createFinanceTradeDecisionReviewer({} as OpenClawConfig, {
      adapterFactory: () => model,
    });

    const result = await reviewer(intradayRequest, AbortSignal.timeout(1000));

    expect(result).toMatchObject({
      status: "completed",
      decisions: [{ candidateId: "intraday-signal-1", decision: "approve" }],
    });
    expect(model.invoke).toHaveBeenCalledWith(
      expect.objectContaining({ role: "risk_check", payload: intradayRequest }),
      expect.any(AbortSignal),
    );
  });

  it("does not accept a daily-review response schema for an intraday request", async () => {
    const model = adapter({
      schemaVersion: FINANCE_TRADE_DECISION_REVIEW_SCHEMA,
      decisions: [
        {
          candidateId: intradayRequest.candidates[0].candidateId,
          decision: "approve",
          rationale: "Wrong response contract.",
        },
      ],
    });
    const reviewer = createFinanceTradeDecisionReviewer({} as OpenClawConfig, {
      adapterFactory: () => model,
    });

    const result = await reviewer(intradayRequest, AbortSignal.timeout(1000));

    expect(result).toMatchObject({ status: "failed", failureCode: "output_contract" });
    expect(result.decisions).toBeUndefined();
  });

  it.each([
    {
      schemaVersion: FINANCE_TRADE_DECISION_REVIEW_SCHEMA,
      decisions: [
        {
          candidateId: "invented:TSLA:buy",
          decision: "approve",
          rationale: "Invented candidate.",
        },
      ],
    },
    {
      schemaVersion: FINANCE_TRADE_DECISION_REVIEW_SCHEMA,
      decisions: [
        {
          candidateId: request.candidates[0].candidateId,
          decision: "approve",
          rationale: "Approved.",
        },
        {
          candidateId: request.candidates[0].candidateId,
          decision: "veto",
          rationale: "Duplicate.",
        },
      ],
    },
    {
      schemaVersion: FINANCE_TRADE_DECISION_REVIEW_SCHEMA,
      decisions: [
        {
          candidateId: request.candidates[0].candidateId,
          decision: "buy",
          rationale: "Model must not choose an order side.",
        },
      ],
    },
  ])("fails closed on an output outside the decision contract", async (output) => {
    const reviewer = createFinanceTradeDecisionReviewer({} as OpenClawConfig, {
      adapterFactory: () => adapter(output),
    });

    const result = await reviewer(request, AbortSignal.timeout(1000));

    expect(result).toMatchObject({ status: "failed", failureCode: "output_contract" });
    expect(result.decisions).toBeUndefined();
  });

  it("records bounded provider failure codes without leaking transport or exception text", async () => {
    const model = adapter(null);
    vi.mocked(model.invoke).mockRejectedValueOnce(new Error("synthetic provider secret"));
    const reviewer = createFinanceTradeDecisionReviewer({} as OpenClawConfig, {
      adapterFactory: () => model,
    });

    const result = await reviewer(request, AbortSignal.timeout(1000));

    expect(result).toMatchObject({
      status: "failed",
      attempted: true,
      failureCode: "process_error",
    });
    expect(JSON.stringify(result)).not.toContain("synthetic provider secret");
  });

  it("classifies an aborted review deadline without exposing the abort reason", async () => {
    const model = adapter(null);
    vi.mocked(model.invoke).mockImplementation(async (_call, signal) => {
      throw signal.reason;
    });
    const reviewer = createFinanceTradeDecisionReviewer({} as OpenClawConfig, {
      adapterFactory: () => model,
    });
    const controller = new AbortController();
    controller.abort(new DOMException("synthetic deadline", "TimeoutError"));

    const result = await reviewer(request, controller.signal);

    expect(result).toMatchObject({ status: "failed", failureCode: "runtime_timeout" });
    expect(JSON.stringify(result)).not.toContain("synthetic deadline");
  });
});
