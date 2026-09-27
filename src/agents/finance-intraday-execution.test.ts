import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FINANCE_ALPACA_MARKET_CALENDAR_SOURCE,
  FINANCE_ALPACA_MARKET_CALENDAR_URL,
} from "./finance-alpaca-market-calendar.js";
import type { runFinanceAlpacaOrder } from "./finance-alpaca-run.js";
import { caseflowFingerprint } from "./finance-caseflow.js";
import { buildFinanceExecutionReceipt } from "./finance-execution-adapter.js";
import {
  appendFinanceIntradayDecision,
  readFinanceIntradayOutcome,
  type FinanceIntradayStrategyBinding,
} from "./finance-intraday-control-ledger.js";
import { executeFinanceIntradayDecision } from "./finance-intraday-execution.js";
import {
  FINANCE_INTRADAY_OPENING_RANGE_EMITS,
  FINANCE_INTRADAY_OPENING_RANGE_FORM,
  FINANCE_INTRADAY_OPENING_RANGE_FORM_VERSION,
  FINANCE_INTRADAY_OPENING_RANGE_RULE,
  resolveFinanceIntradayActiveRuleContract,
} from "./finance-intraday-paper.js";
import { appendFinanceExecutionReceipt } from "./finance-position-ledger.js";
import {
  activateFinanceStrategyRule,
  declareFinanceStrategyRule,
  readFinanceStrategyRuleLedger,
} from "./finance-strategy-rule-ledger.js";
import { openFinanceThesis } from "./finance-thesis-ledger.js";
import type {
  FinanceTradeDecisionReviewRequest,
  FinanceTradeDecisionReviewer,
} from "./finance-trade-decision-review.js";

const readerMocks = vi.hoisted(() => ({ readUniverse: vi.fn() }));
vi.mock("./finance-research-runner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./finance-research-runner.js")>();
  return { ...actual, readFinanceResearchEquityUniverseSnapshot: readerMocks.readUniverse };
});

const temporary: string[] = [];
afterEach(async () => {
  readerMocks.readUniverse.mockReset();
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

async function activeRuleBinding(
  directory: string,
  eligibility: "paper_execution_eligible" | "paper_contract_only" = "paper_execution_eligible",
): Promise<FinanceIntradayStrategyBinding> {
  await declareFinanceStrategyRule(directory, {
    kind: "declared",
    ruleId: FINANCE_INTRADAY_OPENING_RANGE_RULE,
    form: FINANCE_INTRADAY_OPENING_RANGE_FORM,
    formVersion: FINANCE_INTRADAY_OPENING_RANGE_FORM_VERSION,
    instruments: ["SPY"],
    emits: FINANCE_INTRADAY_OPENING_RANGE_EMITS,
    schedule: { kind: "intraday", timezone: "America/New_York" },
    body: {
      universe: ["SPY"],
      frozenRule: { openingRangeBars: 6, rewardRisk: 2 },
      data: { intervalSeconds: 300, feed: "iex" },
      ...(eligibility === "paper_contract_only"
        ? { measuredResult: { status: "paper_contract_only", executionAuthority: "none" } }
        : { paperExecutionEligibility: eligibility }),
    },
    observedAt: "2026-09-17T00:00:00Z",
  });
  await activateFinanceStrategyRule(directory, {
    kind: "activated",
    ruleId: FINANCE_INTRADAY_OPENING_RANGE_RULE,
    reason: "Paper-only contract; the shared Paper controller owns execution gates",
    observedAt: "2026-09-17T00:01:00Z",
  });
  const read = await readFinanceStrategyRuleLedger(directory);
  const rule = read.ledger.rules[0];
  if (!rule) {
    throw new Error("expected active ORB fixture");
  }
  const contract = resolveFinanceIntradayActiveRuleContract(rule);
  return {
    declarationRef: contract.declarationRef,
    activationRef: contract.activationRef,
    declaredInstruments: [...contract.instruments],
    parameters: {
      openingRangeBars: contract.openingRangeBars,
      rewardRisk: contract.rewardRisk,
      intervalSeconds: contract.intervalSeconds,
      feed: contract.feed,
    },
    scope: "strategy_universe",
    marketSession: (() => {
      const date = "2026-09-18";
      const openAt = "2026-09-18T13:30:00.000Z";
      const closeAt = "2026-09-18T20:00:00.000Z";
      const sourceUrlOrArtifact = `${FINANCE_ALPACA_MARKET_CALENDAR_URL}?start=${date}&end=${date}&date_type=TRADING`;
      return {
        date,
        openAt,
        closeAt,
        openMinute: 570,
        closeMinute: 960,
        observedAt: "2026-09-18T14:59:59.000Z",
        calendarRef: caseflowFingerprint({
          source: FINANCE_ALPACA_MARKET_CALENDAR_SOURCE,
          sourceUrlOrArtifact,
          date,
          openAt,
          closeAt,
        }),
        sourceUrlOrArtifact,
      };
    })(),
  };
}

describe("intraday decision execution bridge", () => {
  it.each(["opening_range_stop", "reward_target", "pre_close"] as const)(
    "executes owned protective %s without model veto and never replays it",
    async (reason) => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "intraday-execution-"));
      temporary.push(directory);
      const strategyBinding = await activeRuleBinding(directory);
      await openFinanceThesis(directory, {
        thesisId: "spy-long-horizon",
        instrument: "SPY",
        claim: "Broad earnings growth remains supportive.",
        evidence: [{ id: "source-1", source: "fixture-source", reference: "fixture://source" }],
        invalidationConditions: ["Earnings trend reverses."],
        observedAt: "2026-09-18T14:00:00.000Z",
      });
      const decision = (
        await appendFinanceIntradayDecision(directory, {
          signalId: "intraday-sell-1",
          instrument: "SPY",
          sessionDate: "2026-09-18",
          action: "sell",
          reason,
          referencePrice: 108,
          referencePriceAt: "2026-09-18T15:00:00.000Z",
          datasetHeadRef: "a".repeat(64),
          strategyRule: "opening_range_breakout_long_next_bar_v1",
          strategyBinding,
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
      expect(await executeFinanceIntradayDecision(request)).toMatchObject({ status: "placed" });
      expect(runOrderMock).toHaveBeenCalledTimes(1);
      expect(tradeDecisionReviewer).not.toHaveBeenCalled();
      expect(await readFinanceIntradayOutcome(directory, "intraday-sell-1")).toMatchObject({
        reasons: ["strategy-owned protective exit; discretionary model review bypassed"],
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
      expect(tradeDecisionReviewer).not.toHaveBeenCalled();
      const unownedDecision = (
        await appendFinanceIntradayDecision(directory, {
          ...decision.input,
          signalId: `unowned-${reason}`,
        })
      ).record;
      const refused = await executeFinanceIntradayDecision({
        ...request,
        decision: unownedDecision,
        controller: {
          ...controller,
          accountBookProvider: async () => ({
            ...(await controller.accountBookProvider()),
            positions: [],
          }),
        },
      });
      expect(refused).toMatchObject({
        status: "refused",
        outcome: {
          reasons: [expect.stringContaining("position gate refused")],
        },
      });
      expect(runOrderMock).toHaveBeenCalledTimes(1);
      expect(tradeDecisionReviewer).not.toHaveBeenCalled();
    },
  );

  it.each(["unavailable", "output_truncated", "veto", "invalid"] as const)(
    "keeps review failure advisory but preserves valid veto and contract gates (%s)",
    async (reviewMode) => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "intraday-review-gate-"));
      temporary.push(directory);
      const strategyBinding = await activeRuleBinding(directory);
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
          strategyBinding,
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
          : reviewMode === "output_truncated"
            ? async () => ({
                status: "failed",
                attempted: true,
                provider: "fixture-provider",
                modelId: "fixture-model",
                latencyMs: 3,
                providerCallObserved: true,
                adapterAttested: true,
                failureCode: "output_truncated",
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
      const runOrder = vi.fn(async () => ({
        ok: false as const,
        stage: "place" as const,
        refusals: ["shared execution gate refusal"],
      }));

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
      const reviewFailed = reviewMode === "unavailable" || reviewMode === "output_truncated";
      expect(runOrder).toHaveBeenCalledTimes(reviewFailed ? 1 : 0);
      const outcome = await readFinanceIntradayOutcome(directory, signalId);
      expect(outcome).toMatchObject({
        status: "refused",
        tradeDecisionReview:
          reviewMode === "unavailable"
            ? { status: "failed", failureCode: "reviewer_unavailable" }
            : reviewMode === "output_truncated"
              ? { status: "failed", failureCode: "output_truncated" }
              : reviewMode === "invalid"
                ? { status: "failed", failureCode: "output_invalid" }
                : {
                    status: "completed",
                    decision: { candidateId: signalId, decision: "veto" },
                  },
      });
      if (reviewFailed) {
        expect(outcome?.reasons).toEqual(["shared execution gate refusal"]);
      } else {
        expect(outcome?.reasons.join()).toMatch(/model veto|violated candidate binding/u);
      }
    },
  );

  it.each(["fresh", "stale", "timeout", "abort"] as const)(
    "revalidates quotes after review and records actual fallback time (%s)",
    async (mode) => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "intraday-refresh-"));
      temporary.push(directory);
      const strategyBinding = await activeRuleBinding(directory);
      let clock = Date.parse("2026-09-18T15:00:02.000Z");
      const decision = (
        await appendFinanceIntradayDecision(directory, {
          signalId: `refresh-${mode}`,
          instrument: "SPY",
          sessionDate: "2026-09-18",
          action: "buy",
          reason: "opening_range_breakout",
          referencePrice: 500,
          referencePriceAt: "2026-09-18T15:00:00.000Z",
          datasetHeadRef: "d".repeat(64),
          strategyRule: FINANCE_INTRADAY_OPENING_RANGE_RULE,
          strategyBinding,
        })
      ).record;
      const cancellation = new AbortController();
      const quoteProvider = vi.fn(async () => ({
        referencePrice: 500,
        bidPrice: 499,
        askPrice: 501,
        maxAgeMs: 30_000,
        referencePriceAt:
          mode === "stale" ? "2026-09-18T15:00:01.000Z" : new Date(clock).toISOString(),
        sourceUrlOrArtifact: "fixture://quote",
      }));
      const runOrder = vi.fn(async () => ({
        ok: false as const,
        stage: "place" as const,
        refusals: ["fixture shared gate"],
      }));
      const reviewer: FinanceTradeDecisionReviewer = async (request) => {
        clock += 65_000;
        if (mode === "timeout") {
          throw new Error("timeout");
        }
        if (mode === "abort") {
          cancellation.abort();
        }
        return approvingReviewer()(request);
      };
      const result = await executeFinanceIntradayDecision({
        directory,
        decision,
        controller: {
          accountId: "paper-account",
          accountBookProvider: async () => ({
            accountId: "paper-account",
            venue: "alpaca:paper",
            observedAt: new Date(clock).toISOString(),
            expiresAt: new Date(clock + 120_000).toISOString(),
            equity: 100_000,
            positions: [],
          }),
          executionQuoteProvider: quoteProvider,
          createSafetyContext: vi.fn(),
        },
        caps: { maxOrderNotional: 1000, maxInstrumentNotional: 5000, maxOrdersPerRun: 1 },
        tradeDecisionReviewer: reviewer,
        now: () => clock,
        signal: cancellation.signal,
        runOrder,
      });
      expect(result.status).toBe("refused");
      expect(quoteProvider).toHaveBeenCalledTimes(mode === "abort" ? 1 : 2);
      expect(runOrder).toHaveBeenCalledTimes(mode === "stale" || mode === "abort" ? 0 : 1);
      if (mode === "fresh" || mode === "timeout") {
        expect(runOrder).toHaveBeenCalledWith(
          expect.objectContaining({
            market: {
              referencePrice: 501,
              referencePriceAt: new Date(clock).toISOString(),
            },
          }),
        );
      }
      if (mode === "timeout") {
        expect(
          "tradeDecisionReview" in result ? result.tradeDecisionReview : undefined,
        ).toMatchObject({
          failureCode: "runtime_timeout",
          latencyMs: 65_000,
        });
      }
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

  it("refuses a legacy pending decision without strategy provenance before any venue adapter call", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "intraday-legacy-pending-"));
    temporary.push(directory);
    const decision = (
      await appendFinanceIntradayDecision(directory, {
        signalId: "intraday-legacy-pending",
        instrument: "SPY",
        sessionDate: "2026-09-18",
        action: "buy",
        reason: "opening_range_breakout",
        referencePrice: 500,
        referencePriceAt: "2026-09-18T15:00:00.000Z",
        stopPrice: 498,
        targetPrice: 504,
        datasetHeadRef: "c".repeat(64),
        strategyRule: FINANCE_INTRADAY_OPENING_RANGE_RULE,
      })
    ).record;
    const accountBookProvider = vi.fn();
    const executionQuoteProvider = vi.fn();
    const runOrder = vi.fn();
    const result = await executeFinanceIntradayDecision({
      directory,
      decision,
      controller: {
        accountId: "paper-account",
        accountBookProvider: accountBookProvider as never,
        executionQuoteProvider: executionQuoteProvider as never,
        createSafetyContext: vi.fn(),
      },
      caps: { maxOrderNotional: 5_000, maxInstrumentNotional: 10_000, maxOrdersPerRun: 1 },
      now: () => Date.parse("2026-09-18T15:00:02.000Z"),
      runOrder: runOrder as never,
    });
    expect(result).toMatchObject({ status: "refused" });
    expect(await readFinanceIntradayOutcome(directory, decision.input.signalId)).toMatchObject({
      status: "refused",
      reasons: [expect.stringContaining("no active-strategy provenance")],
    });
    expect(accountBookProvider).not.toHaveBeenCalled();
    expect(executionQuoteProvider).not.toHaveBeenCalled();
    expect(runOrder).not.toHaveBeenCalled();
  });

  it("routes a Paper-only contract through the shared Paper execution gates", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "intraday-paper-contract-only-"));
    temporary.push(directory);
    const strategyBinding = await activeRuleBinding(directory, "paper_contract_only");
    const decision = (
      await appendFinanceIntradayDecision(directory, {
        signalId: "intraday-paper-contract-only",
        instrument: "SPY",
        sessionDate: "2026-09-18",
        action: "buy",
        reason: "opening_range_breakout",
        referencePrice: 500,
        referencePriceAt: "2026-09-18T15:00:00.000Z",
        stopPrice: 498,
        targetPrice: 504,
        datasetHeadRef: "e".repeat(64),
        strategyRule: FINANCE_INTRADAY_OPENING_RANGE_RULE,
        strategyBinding,
      })
    ).record;
    const accountBookProvider = vi.fn(async () => ({
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
    }));
    const executionQuoteProvider = vi.fn(async () => ({
      referencePrice: 500,
      referencePriceAt: "2026-09-18T15:00:01.000Z",
      sourceUrlOrArtifact: "fixture quote source",
      bidPrice: 499.9,
      askPrice: 500,
      feed: "iex" as const,
      priceBasis: "ask" as const,
      maxAgeMs: 30_000,
    }));
    const runOrder = vi.fn(async () => ({
      ok: false as const,
      stage: "place" as const,
      refusals: ["shared execution gate refusal"],
    }));
    const tradeDecisionReviewer = approvingReviewer();
    const result = await executeFinanceIntradayDecision({
      directory,
      decision,
      controller: {
        accountId: "paper-account",
        accountBookProvider: accountBookProvider as never,
        executionQuoteProvider: executionQuoteProvider as never,
        createSafetyContext: vi.fn(),
      },
      caps: { maxOrderNotional: 5_000, maxInstrumentNotional: 10_000, maxOrdersPerRun: 1 },
      tradeDecisionReviewer,
      now: () => Date.parse("2026-09-18T15:00:02.000Z"),
      runOrder: runOrder as never,
    });
    expect(result).toMatchObject({ status: "refused" });
    expect(await readFinanceIntradayOutcome(directory, decision.input.signalId)).toMatchObject({
      status: "refused",
      reasons: ["shared execution gate refusal"],
    });
    expect(accountBookProvider).toHaveBeenCalledTimes(1);
    expect(executionQuoteProvider).toHaveBeenCalledTimes(1);
    expect(tradeDecisionReviewer).toHaveBeenCalledTimes(1);
    expect(runOrder).toHaveBeenCalledTimes(1);
  });

  it("rechecks the current declaration and refuses a stale or tampered pending binding", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "intraday-stale-binding-"));
    temporary.push(directory);
    const strategyBinding = await activeRuleBinding(directory);
    const decision = (
      await appendFinanceIntradayDecision(directory, {
        signalId: "intraday-stale-binding",
        instrument: "SPY",
        sessionDate: "2026-09-18",
        action: "buy",
        reason: "opening_range_breakout",
        referencePrice: 500,
        referencePriceAt: "2026-09-18T15:00:00.000Z",
        stopPrice: 498,
        targetPrice: 504,
        datasetHeadRef: "f".repeat(64),
        strategyRule: FINANCE_INTRADAY_OPENING_RANGE_RULE,
        strategyBinding: { ...strategyBinding, declarationRef: "0".repeat(64) },
      })
    ).record;
    const accountBookProvider = vi.fn();
    const executionQuoteProvider = vi.fn();
    const runOrder = vi.fn();
    const result = await executeFinanceIntradayDecision({
      directory,
      decision,
      controller: {
        accountId: "paper-account",
        accountBookProvider: accountBookProvider as never,
        executionQuoteProvider: executionQuoteProvider as never,
        createSafetyContext: vi.fn(),
      },
      caps: { maxOrderNotional: 5_000, maxInstrumentNotional: 10_000, maxOrdersPerRun: 1 },
      now: () => Date.parse("2026-09-18T15:00:02.000Z"),
      runOrder: runOrder as never,
    });
    expect(result).toMatchObject({ status: "refused" });
    expect(await readFinanceIntradayOutcome(directory, decision.input.signalId)).toMatchObject({
      status: "refused",
      reasons: [expect.stringContaining("does not match the currently active strategy contract")],
    });
    expect(accountBookProvider).not.toHaveBeenCalled();
    expect(executionQuoteProvider).not.toHaveBeenCalled();
    expect(runOrder).not.toHaveBeenCalled();
  });

  it("re-refuses an otherwise valid pending signal if the active ORB declaration becomes ambiguous", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "intraday-ambiguous-active-rule-"));
    temporary.push(directory);
    const strategyBinding = await activeRuleBinding(directory);
    await declareFinanceStrategyRule(directory, {
      kind: "declared",
      ruleId: "alternate_orb_rule",
      form: FINANCE_INTRADAY_OPENING_RANGE_FORM,
      formVersion: FINANCE_INTRADAY_OPENING_RANGE_FORM_VERSION,
      instruments: ["SPY"],
      emits: FINANCE_INTRADAY_OPENING_RANGE_EMITS,
      schedule: { kind: "intraday", timezone: "America/New_York" },
      body: {
        universe: ["SPY"],
        frozenRule: { openingRangeBars: 6, rewardRisk: 2 },
        data: { intervalSeconds: 300, feed: "iex" },
        paperExecutionEligibility: "paper_execution_eligible",
      },
      observedAt: "2026-09-17T00:00:00Z",
    });
    await activateFinanceStrategyRule(directory, {
      kind: "activated",
      ruleId: "alternate_orb_rule",
      observedAt: "2026-09-17T00:01:00Z",
    });
    const decision = (
      await appendFinanceIntradayDecision(directory, {
        signalId: "intraday-ambiguous-rule",
        instrument: "SPY",
        sessionDate: "2026-09-18",
        action: "buy",
        reason: "opening_range_breakout",
        referencePrice: 500,
        referencePriceAt: "2026-09-18T15:00:00.000Z",
        stopPrice: 498,
        targetPrice: 504,
        datasetHeadRef: "3".repeat(64),
        strategyRule: FINANCE_INTRADAY_OPENING_RANGE_RULE,
        strategyBinding,
      })
    ).record;
    const accountBookProvider = vi.fn();
    const result = await executeFinanceIntradayDecision({
      directory,
      decision,
      controller: {
        accountId: "paper-account",
        accountBookProvider: accountBookProvider as never,
        executionQuoteProvider: vi.fn() as never,
        createSafetyContext: vi.fn(),
      },
      caps: { maxOrderNotional: 5_000, maxInstrumentNotional: 10_000, maxOrdersPerRun: 1 },
      runOrder: vi.fn() as never,
    });
    expect(result).toMatchObject({ status: "refused" });
    expect(accountBookProvider).not.toHaveBeenCalled();
  });

  it("refuses explicit diagnostic scope even with otherwise eligible active-strategy provenance", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "intraday-diagnostic-scope-"));
    temporary.push(directory);
    const strategyBinding = await activeRuleBinding(directory);
    const decision = (
      await appendFinanceIntradayDecision(directory, {
        signalId: "intraday-diagnostic-scope",
        instrument: "SPY",
        sessionDate: "2026-09-18",
        action: "buy",
        reason: "opening_range_breakout",
        referencePrice: 500,
        referencePriceAt: "2026-09-18T15:00:00.000Z",
        stopPrice: 498,
        targetPrice: 504,
        datasetHeadRef: "1".repeat(64),
        strategyRule: FINANCE_INTRADAY_OPENING_RANGE_RULE,
        strategyBinding: { ...strategyBinding, scope: "explicit_diagnostic" },
      })
    ).record;
    const accountBookProvider = vi.fn();
    const runOrder = vi.fn();
    const result = await executeFinanceIntradayDecision({
      directory,
      decision,
      controller: {
        accountId: "paper-account",
        accountBookProvider: accountBookProvider as never,
        executionQuoteProvider: vi.fn() as never,
        createSafetyContext: vi.fn(),
      },
      caps: { maxOrderNotional: 5_000, maxInstrumentNotional: 10_000, maxOrdersPerRun: 1 },
      now: () => Date.parse("2026-09-18T15:00:02.000Z"),
      runOrder: runOrder as never,
    });
    expect(result).toMatchObject({ status: "refused" });
    expect(accountBookProvider).not.toHaveBeenCalled();
    expect(runOrder).not.toHaveBeenCalled();
  });

  it("re-reads the dynamic snapshot and refuses a pending signal after its universe changes", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "intraday-changed-universe-"));
    temporary.push(directory);
    const strategyBinding = await activeRuleBinding(directory);
    const decisionSnapshot = { selected: ["SPY"] } as never;
    const currentSnapshot = { selected: ["QQQ"] } as never;
    readerMocks.readUniverse.mockReturnValue(currentSnapshot);
    const decision = (
      await appendFinanceIntradayDecision(directory, {
        signalId: "intraday-changed-universe",
        instrument: "SPY",
        sessionDate: "2026-09-18",
        action: "buy",
        reason: "opening_range_breakout",
        referencePrice: 500,
        referencePriceAt: "2026-09-18T15:00:00.000Z",
        stopPrice: 498,
        targetPrice: 504,
        datasetHeadRef: "2".repeat(64),
        strategyRule: FINANCE_INTRADAY_OPENING_RANGE_RULE,
        strategyBinding: {
          ...strategyBinding,
          scope: "system_universe",
          universeSnapshotRef: caseflowFingerprint(decisionSnapshot),
        },
      })
    ).record;
    const accountBookProvider = vi.fn();
    const executionQuoteProvider = vi.fn();
    const runOrder = vi.fn();
    const result = await executeFinanceIntradayDecision({
      directory,
      decision,
      controller: {
        accountId: "paper-account",
        accountBookProvider: accountBookProvider as never,
        executionQuoteProvider: executionQuoteProvider as never,
        createSafetyContext: vi.fn(),
      },
      caps: { maxOrderNotional: 5_000, maxInstrumentNotional: 10_000, maxOrdersPerRun: 1 },
      runOrder: runOrder as never,
      now: () => Date.parse("2026-09-18T15:00:02.000Z"),
    });
    expect(readerMocks.readUniverse).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ status: "refused" });
    expect(await readFinanceIntradayOutcome(directory, decision.input.signalId)).toMatchObject({
      status: "refused",
      reasons: [expect.stringContaining("no longer matches the current validated snapshot")],
    });
    expect(accountBookProvider).not.toHaveBeenCalled();
    expect(executionQuoteProvider).not.toHaveBeenCalled();
    expect(runOrder).not.toHaveBeenCalled();
  });
});
