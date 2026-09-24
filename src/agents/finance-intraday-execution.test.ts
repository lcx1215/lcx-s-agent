import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { runFinanceAlpacaOrder } from "./finance-alpaca-run.js";
import { buildFinanceExecutionReceipt } from "./finance-execution-adapter.js";
import {
  appendFinanceIntradayDecision,
  readFinanceIntradayOutcome,
} from "./finance-intraday-control-ledger.js";
import { executeFinanceIntradayDecision } from "./finance-intraday-execution.js";
import { appendFinanceExecutionReceipt } from "./finance-position-ledger.js";
import type {
  FinanceTradeDecisionReviewRequest,
  FinanceTradeDecisionReviewer,
} from "./finance-trade-decision-review.js";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((item) => fs.rm(item, { recursive: true, force: true })),
  );
});

function approvingReviewer() {
  return vi.fn(async (request: FinanceTradeDecisionReviewRequest) => ({
    status: "completed" as const,
    attempted: true,
    provider: "fixture-provider",
    modelId: "fixture-model",
    latencyMs: 5,
    providerCallObserved: true,
    adapterAttested: true,
    decisions: [
      {
        candidateId: request.candidates[0]?.candidateId ?? "missing-candidate",
        decision: "approve" as const,
        rationale: "The exact supplied signal and quote are consistent.",
      },
    ],
  }));
}

describe("intraday decision execution bridge", () => {
  it("closes exactly the observed paper position and never replays a terminal signal", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "intraday-execution-"));
    temporary.push(directory);
    const decision = (
      await appendFinanceIntradayDecision(directory, {
        signalId: "intraday-sell-1",
        instrument: "SPY",
        sessionDate: "2026-09-18",
        action: "sell",
        reason: "reward_target",
        referencePrice: 108,
        referencePriceAt: "2026-09-18T15:00:00.000Z",
        datasetHeadRef: "a".repeat(64),
        strategyRule: "opening_range_breakout_long_next_bar_v1",
      })
    ).record;
    const coreReceipt = buildFinanceExecutionReceipt({
      intent: {
        intentId: "intent:daily-cycle-core",
        instrument: "SPY",
        side: "buy",
        orderType: "market",
        quantity: 50,
        referencePrice: 100,
        referencePriceAt: "2026-09-18T14:00:00.000Z",
        runAuthorizationId: "daily-cycle:2026-09-18",
        rationale: "core fixture",
      },
      adapter: { id: "alpaca-venue", venue: "alpaca:paper", kind: "venue" },
      fill: {
        filledQuantity: 50,
        fillPrice: 100,
        filledAt: "2026-09-18T14:00:01.000Z",
        venueRef: "alpaca:paper:core-order",
        terminalOrderIdentity: { orderId: "core-order", terminal: true },
      },
      recordedAt: "2026-09-18T14:00:01.000Z",
      accountId: "paper-account",
    });
    const intradayReceipt = buildFinanceExecutionReceipt({
      intent: {
        intentId: "intent:intraday-owned-entry",
        instrument: "SPY",
        side: "buy",
        orderType: "market",
        quantity: 17.5,
        referencePrice: 107,
        referencePriceAt: "2026-09-18T14:30:00.000Z",
        runAuthorizationId: "intraday-paper:2026-09-18:intraday-owned-entry",
        rationale: "intraday fixture",
      },
      adapter: { id: "alpaca-venue", venue: "alpaca:paper", kind: "venue" },
      fill: {
        filledQuantity: 17.5,
        fillPrice: 107,
        filledAt: "2026-09-18T14:30:01.000Z",
        venueRef: "alpaca:paper:intraday-order",
        terminalOrderIdentity: { orderId: "intraday-order", terminal: true },
      },
      recordedAt: "2026-09-18T14:30:01.000Z",
      accountId: "paper-account",
    });
    await appendFinanceExecutionReceipt(directory, coreReceipt);
    await appendFinanceExecutionReceipt(directory, intradayReceipt);
    const receipt = { receiptId: "receipt-1" } as never;
    const runOrderMock = vi.fn(async (_request: Parameters<typeof runFinanceAlpacaOrder>[0]) => ({
      ok: true as const,
      receipt,
      notes: [],
    }));
    const runOrder = runOrderMock as unknown as typeof runFinanceAlpacaOrder;
    const recordFill = vi.fn(async () => ({
      recorded: true,
      marked: true,
      quantity: 17.5,
      notional: 1890,
      committedNotional: 1890,
      refusal: null,
    }));
    const tradeDecisionReviewer = approvingReviewer();
    const controller = {
      accountId: "paper-account",
      accountBookProvider: vi.fn(async () => ({
        accountId: "paper-account",
        venue: "alpaca:paper" as const,
        observedAt: "2026-09-18T15:00:01.000Z",
        expiresAt: "2026-09-18T15:01:01.000Z",
        equity: 100_000,
        positions: [{ instrument: "SPY", quantity: 67.5, marketValue: 7_290 }],
      })),
      executionQuoteProvider: vi.fn(async () => ({
        referencePrice: 107.9,
        referencePriceAt: "2026-09-18T15:00:01.000Z",
        sourceUrlOrArtifact: "fixture",
        bidPrice: 107.9,
        askPrice: 108,
        maxAgeMs: 30_000,
      })),
      createSafetyContext: vi.fn(() => ({ kind: "controller_execution_safety" as const })),
    };
    const request = {
      directory,
      decision,
      controller,
      caps: { maxOrderNotional: 5_000, maxInstrumentNotional: 10_000, maxOrdersPerRun: 1 },
      tradeDecisionReviewer,
      now: () => Date.parse("2026-09-18T15:00:02.000Z"),
      runOrder,
      recordFill,
    };
    expect(await executeFinanceIntradayDecision(request)).toMatchObject({
      status: "placed",
      tradeDecisionReview: {
        status: "completed",
        decision: { candidateId: "intraday-sell-1", decision: "approve" },
      },
    });
    expect(runOrderMock).toHaveBeenCalledTimes(1);
    expect(tradeDecisionReviewer).toHaveBeenCalledTimes(1);
    expect(tradeDecisionReviewer).toHaveBeenCalledWith(
      expect.objectContaining({
        schemaVersion: "lcx_finance_intraday_trade_decision_review_v1",
        ruleIds: ["opening_range_breakout_long_next_bar_v1"],
        candidates: [
          expect.objectContaining({
            candidateId: "intraday-sell-1",
            instrument: "SPY",
            side: "sell",
            intradayOwnedQuantity: 17.5,
            brokerPositionQuantity: 67.5,
          }),
        ],
      }),
      expect.any(AbortSignal),
    );
    expect(await readFinanceIntradayOutcome(directory, "intraday-sell-1")).toMatchObject({
      tradeDecisionReview: {
        status: "completed",
        decision: { decision: "approve" },
      },
    });
    expect(runOrderMock.mock.calls[0]?.[0]).toMatchObject({
      quantityOverride: 17.5,
      mode: "paper",
    });
    expect(await executeFinanceIntradayDecision(request)).toMatchObject({
      status: "already_terminal",
      outcome: { status: "placed", receiptId: "receipt-1" },
    });
    expect(runOrderMock).toHaveBeenCalledTimes(1);
    expect(tradeDecisionReviewer).toHaveBeenCalledTimes(1);
  });

  it.each(["unavailable", "veto", "invalid"] as const)(
    "persists the intraday review and refuses placement when the model is %s",
    async (reviewMode) => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "intraday-review-gate-"));
      temporary.push(directory);
      const signalId = `intraday-review-${reviewMode}`;
      const decision = (
        await appendFinanceIntradayDecision(directory, {
          signalId,
          instrument: "SPY",
          sessionDate: "2026-09-18",
          action: "buy",
          reason: "opening_range_breakout",
          referencePrice: 500,
          referencePriceAt: "2026-09-18T15:00:00.000Z",
          stopPrice: 498,
          targetPrice: 504,
          datasetHeadRef: "d".repeat(64),
          strategyRule: "opening_range_breakout_long_next_bar_v1",
        })
      ).record;
      const tradeDecisionReviewer: FinanceTradeDecisionReviewer | undefined =
        reviewMode === "veto"
          ? async (request) => ({
              status: "completed",
              attempted: true,
              provider: "fixture-provider",
              modelId: "fixture-model",
              latencyMs: 3,
              providerCallObserved: true,
              adapterAttested: true,
              decisions: [
                {
                  candidateId: request.candidates[0]?.candidateId ?? "missing-candidate",
                  decision: "veto",
                  rationale: "The supplied candidate is not sufficiently supported.",
                },
              ],
            })
          : reviewMode === "invalid"
            ? ((async () => ({
                status: "completed",
                attempted: true,
                provider: "fixture-provider",
                modelId: "fixture-model",
                latencyMs: 3,
                providerCallObserved: true,
                adapterAttested: true,
                decisions: [],
              })) as unknown as FinanceTradeDecisionReviewer)
            : undefined;
      const runOrder = vi.fn();

      const result = await executeFinanceIntradayDecision({
        directory,
        decision,
        controller: {
          accountId: "paper-account",
          accountBookProvider: vi.fn(async () => ({
            accountId: "paper-account",
            venue: "alpaca:paper" as const,
            observedAt: "2026-09-18T15:00:01.000Z",
            expiresAt: "2026-09-18T15:01:01.000Z",
            equity: 100_000,
            positions: [],
            reconciliation: {
              status: "ready" as const,
              historyStatus: "reconciled" as const,
              uncertaintyReserve: 0,
              quarantinedInstruments: [],
              reasons: [],
            },
          })),
          executionQuoteProvider: vi.fn(async () => ({
            referencePrice: 500,
            referencePriceAt: "2026-09-18T15:00:01.000Z",
            sourceUrlOrArtifact: "fixture quote source",
            bidPrice: 499.9,
            askPrice: 500,
            feed: "iex",
            priceBasis: "ask" as const,
            maxAgeMs: 30_000,
          })),
          createSafetyContext: vi.fn(),
        },
        caps: { maxOrderNotional: 5_000, maxInstrumentNotional: 10_000, maxOrdersPerRun: 1 },
        tradeDecisionReviewer,
        now: () => Date.parse("2026-09-18T15:00:02.000Z"),
        runOrder: runOrder as never,
      });

      expect(result).toMatchObject({ status: "refused" });
      expect(runOrder).not.toHaveBeenCalled();
      const outcome = await readFinanceIntradayOutcome(directory, signalId);
      expect(outcome).toMatchObject({
        status: "refused",
        tradeDecisionReview:
          reviewMode === "unavailable"
            ? { status: "failed", failureCode: "reviewer_unavailable" }
            : reviewMode === "invalid"
              ? { status: "failed", failureCode: "output_invalid" }
              : {
                  status: "completed",
                  decision: { candidateId: signalId, decision: "veto" },
                },
      });
    },
  );

  it("recovers a placed outcome from an existing receipt instead of resending", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "intraday-execution-"));
    temporary.push(directory);
    const signalId = "intraday-buy-recovered";
    const decision = (
      await appendFinanceIntradayDecision(directory, {
        signalId,
        instrument: "SPY",
        sessionDate: "2026-09-18",
        action: "buy",
        reason: "opening_range_breakout",
        referencePrice: 100,
        referencePriceAt: "2026-09-18T15:00:00.000Z",
        stopPrice: 99,
        targetPrice: 102,
        datasetHeadRef: "b".repeat(64),
        strategyRule: "opening_range_breakout_long_next_bar_v1",
      })
    ).record;
    const receipt = buildFinanceExecutionReceipt({
      intent: {
        intentId: `intent:${signalId}`,
        instrument: "SPY",
        side: "buy",
        orderType: "market",
        quantity: 1,
        referencePrice: 100,
        referencePriceAt: "2026-09-18T15:00:01.000Z",
        runAuthorizationId: `intraday-paper:2026-09-18:${signalId}`,
        rationale: "fixture",
      },
      adapter: { id: "alpaca-venue", venue: "alpaca:paper", kind: "venue" },
      fill: {
        filledQuantity: 1,
        fillPrice: 100,
        filledAt: "2026-09-18T15:00:02.000Z",
        venueRef: "alpaca:paper:order-1",
        terminalOrderIdentity: { orderId: "order-1", terminal: true },
      },
      recordedAt: "2026-09-18T15:00:02.000Z",
      accountId: "paper-account",
    });
    await appendFinanceExecutionReceipt(directory, receipt);
    const runOrderMock = vi.fn();
    const result = await executeFinanceIntradayDecision({
      directory,
      decision,
      controller: {
        accountId: "paper-account",
        accountBookProvider: vi.fn(async () => ({
          accountId: "paper-account",
          venue: "alpaca:paper" as const,
          observedAt: "2026-09-18T15:01:00.000Z",
          expiresAt: "2026-09-18T15:02:00.000Z",
          equity: 100_000,
          positions: [{ instrument: "SPY", quantity: 1, marketValue: 100 }],
        })),
        executionQuoteProvider: vi.fn(),
        createSafetyContext: vi.fn(),
      },
      caps: { maxOrderNotional: 5_000, maxInstrumentNotional: 10_000, maxOrdersPerRun: 1 },
      runOrder: runOrderMock as never,
    });
    expect(result).toMatchObject({
      status: "recovered_placed",
      outcome: { status: "placed", receiptId: receipt.receiptId },
    });
    expect(runOrderMock).not.toHaveBeenCalled();
  });
});
