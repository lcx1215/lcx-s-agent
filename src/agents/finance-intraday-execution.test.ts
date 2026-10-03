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
  createFinanceExecutionSafetyContext,
  FinanceExecutionSafetyFactsError,
  FinanceExecutionSafetyTerminalFailureError,
  FinanceExecutionSafetyUncertainError,
  readFinanceExecutionSafetyClaims,
  withFinanceExecutionSafety,
} from "./finance-execution-safety.js";
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
  FINANCE_INTRADAY_OPENING_RANGE_RULE_V3,
  FINANCE_INTRADAY_OPENING_RANGE_FORM_VERSION_V3,
  resolveFinanceIntradayActiveRuleContract,
} from "./finance-intraday-paper.js";
import {
  appendFinanceBrokerHistory,
  appendFinanceExecutionReceipt,
} from "./finance-position-ledger.js";
import {
  activateFinanceStrategyRule,
  declareFinanceStrategyRule,
  readFinanceStrategyRuleLedger,
  retireFinanceStrategyRule,
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
  dynamicUniverse = false,
): Promise<FinanceIntradayStrategyBinding> {
  const ruleId = dynamicUniverse
    ? FINANCE_INTRADAY_OPENING_RANGE_RULE_V3
    : FINANCE_INTRADAY_OPENING_RANGE_RULE;
  const formVersion = dynamicUniverse
    ? FINANCE_INTRADAY_OPENING_RANGE_FORM_VERSION_V3
    : FINANCE_INTRADAY_OPENING_RANGE_FORM_VERSION;
  await declareFinanceStrategyRule(directory, {
    kind: "declared",
    ruleId,
    form: FINANCE_INTRADAY_OPENING_RANGE_FORM,
    formVersion,
    instruments: ["SPY"],
    emits: FINANCE_INTRADAY_OPENING_RANGE_EMITS,
    schedule: { kind: "intraday", timezone: "America/New_York" },
    body: {
      universe: ["SPY"],
      frozenRule: { openingRangeBars: 6, rewardRisk: 2 },
      data: { intervalSeconds: 300, feed: "iex" },
      ...(dynamicUniverse ? { paperUniverseScope: "fresh_us_equity_selection_v1" } : {}),
      ...(eligibility === "paper_contract_only"
        ? { measuredResult: { status: "paper_contract_only", executionAuthority: "none" } }
        : { paperExecutionEligibility: eligibility }),
    },
    observedAt: "2026-09-17T00:00:00Z",
  });
  await activateFinanceStrategyRule(directory, {
    kind: "activated",
    ruleId,
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
  it("recovers a durable same-signal Paper receipt before checking another pending account claim", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "intraday-pending-claim-"));
    temporary.push(directory);
    const strategyBinding = await activeRuleBinding(directory);
    const decision = (
      await appendFinanceIntradayDecision(directory, {
        signalId: "intraday-pending-claim-candidate",
        instrument: "SPY",
        sessionDate: "2026-09-18",
        action: "buy",
        reason: "opening_range_breakout",
        referencePrice: 100,
        referencePriceAt: "2026-09-18T15:00:00.000Z",
        stopPrice: 99,
        targetPrice: 102,
        datasetHeadRef: "c".repeat(64),
        strategyRule: "opening_range_breakout_long_next_bar_v1",
        strategyBinding,
      })
    ).record;
    const now = new Date().toISOString();
    const expires = new Date(Date.now() + 60_000).toISOString();
    const intent = {
      intentId: "intent:intraday-preexisting-unknown",
      runAuthorizationId: "fixture-unknown",
      instrument: "SPY",
      side: "buy" as const,
      orderType: "market" as const,
      quantity: 1,
      referencePrice: 100,
      referencePriceAt: now,
      rationale: "fixture pending claim",
    };
    const budget = {
      automation: "unattended" as const,
      allowedInstruments: ["SPY"],
      maxOrderNotional: 1_000,
      maxInstrumentNotional: 2_000,
      maxOrdersPerRun: 1,
    };
    const context = createFinanceExecutionSafetyContext({
      stateDir: directory,
      accountId: "paper-account",
      adapterId: "alpaca-venue",
      venue: "alpaca:paper",
      intent,
      budget,
      policy: {
        planId: "fixture-plan",
        revision: "1",
        riskModel: "fully_funded_unhedged_spot",
        authorizedSide: "buy",
        authorizedQuantity: 1,
        expiresAt: expires,
        maxPortfolioDrawdownFraction: 0.2,
        maxGrossExposure: 10_000,
        maxAccountAgeMs: 60_000,
        maxQuoteAgeMs: 60_000,
        maxInstrumentEvidenceAgeMs: 60_000,
      },
      readFacts: async () => ({
        accountId: "paper-account",
        adapterId: "alpaca-venue",
        venue: "alpaca:paper",
        instrument: "SPY",
        instrumentEvidence: {
          source: "fixture",
          observedAt: now,
          assetType: "spot_equity",
          fullyPaid: true,
          marginEnabled: false,
          hedged: false,
        },
        snapshotId: "fixture-snapshot",
        source: "fixture",
        observedAt: now,
        expiresAt: expires,
        positionQuantity: 0,
        openOrderIds: [],
        unresolvedOrderIds: [],
        account: {
          status: "ACTIVE",
          tradingBlocked: false,
          equity: 100_000,
          availableCash: 100_000,
          peakEquity: 100_000,
          currency: "USD",
          grossExposure: 0,
        },
        quote: {
          source: "fixture",
          price: 100,
          observedAt: now,
          expiresAt: expires,
          currency: "USD",
        },
      }),
    });
    const unknown = await withFinanceExecutionSafety({
      context,
      intent,
      budget,
      adapterId: "alpaca-venue",
      venue: "alpaca:paper",
      adapterKind: "venue",
      recordedAt: now,
      buildReceipt: (fill, recordedAt, accountId) =>
        buildFinanceExecutionReceipt({
          intent,
          adapter: { id: "alpaca-venue", venue: "alpaca:paper", kind: "venue" },
          fill,
          recordedAt,
          accountId,
        }),
      execute: async () => {
        throw new Error("fixture network timeout");
      },
    }).catch((error: unknown) => {
      expect(error).toBeInstanceOf(FinanceExecutionSafetyUncertainError);
      return undefined;
    });
    expect(unknown).toBeUndefined();
    expect(
      (
        await readFinanceExecutionSafetyClaims({
          stateDir: directory,
          accountId: "paper-account",
          venue: "alpaca:paper",
        })
      ).some((claim) => claim.status === "unknown"),
    ).toBe(true);

    const recoveredReceipt = buildFinanceExecutionReceipt({
      intent: {
        ...intent,
        intentId: `intent:${decision.input.signalId}`,
      },
      adapter: { id: "alpaca-venue", venue: "alpaca:paper", kind: "venue" },
      fill: {
        filledQuantity: 1,
        fillPrice: 100,
        filledAt: now,
        venueRef: "alpaca:paper:recovered-same-signal",
        terminalOrderIdentity: { orderId: "recovered-same-signal", terminal: true },
      },
      recordedAt: now,
      accountId: "paper-account",
    });
    await appendFinanceExecutionReceipt(directory, recoveredReceipt);

    const reviewer = approvingReviewer();
    const accountBookProvider = vi.fn();
    const executionQuoteProvider = vi.fn();
    const runOrder = vi.fn();
    const result = await executeFinanceIntradayDecision({
      directory,
      decision,
      controller: {
        accountId: "paper-account",
        accountBookProvider,
        executionQuoteProvider,
        createSafetyContext: vi.fn(),
      },
      caps: { maxOrderNotional: 1_000, maxInstrumentNotional: 2_000, maxOrdersPerRun: 1 },
      tradeDecisionReviewer: reviewer,
      now: () => Date.parse("2026-09-18T15:00:02.000Z"),
      runOrder: runOrder as never,
    });
    expect(result).toMatchObject({
      status: "recovered_placed",
      outcome: { status: "placed", receiptId: recoveredReceipt.receiptId },
    });
    expect(accountBookProvider).not.toHaveBeenCalled();
    expect(executionQuoteProvider).not.toHaveBeenCalled();
    expect(reviewer).not.toHaveBeenCalled();
    expect(runOrder).not.toHaveBeenCalled();

    const noReceiptDecision = (
      await appendFinanceIntradayDecision(directory, {
        signalId: "intraday-pending-claim-no-receipt",
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
        strategyBinding,
      })
    ).record;
    const refused = await executeFinanceIntradayDecision({
      directory,
      decision: noReceiptDecision,
      controller: {
        accountId: "paper-account",
        accountBookProvider,
        executionQuoteProvider,
        createSafetyContext: vi.fn(),
      },
      caps: { maxOrderNotional: 1_000, maxInstrumentNotional: 2_000, maxOrdersPerRun: 1 },
      tradeDecisionReviewer: reviewer,
      now: () => Date.parse("2026-09-18T15:00:02.000Z"),
      runOrder: runOrder as never,
    });
    expect(refused).toMatchObject({ status: "refused", outcome: { status: "refused" } });
    expect(refused.outcome.reasons).toEqual([
      "account_execution_safety_claim_pending_before_model_review",
    ]);
    expect(accountBookProvider).not.toHaveBeenCalled();
    expect(executionQuoteProvider).not.toHaveBeenCalled();
    expect(reviewer).not.toHaveBeenCalled();
    expect(runOrder).not.toHaveBeenCalled();
  });

  it("requires an existing same-account terminal entry proof before a managed-scope sell", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "intraday-managed-exit-unproven-"));
    temporary.push(directory);
    const strategyBinding = await activeRuleBinding(directory, "paper_execution_eligible", true);
    const decision = (
      await appendFinanceIntradayDecision(directory, {
        signalId: "intraday-unproven-managed-exit",
        instrument: "QQQ",
        sessionDate: "2026-09-18",
        action: "sell",
        reason: "opening_range_stop",
        referencePrice: 98,
        referencePriceAt: "2026-09-18T15:00:00.000Z",
        datasetHeadRef: "f".repeat(64),
        strategyRule: FINANCE_INTRADAY_OPENING_RANGE_RULE_V3,
        strategyBinding: {
          ...strategyBinding,
          scope: "managed_position_exit",
          managedExitProof: {
            accountId: "paper-account",
            entryDecisionRef: "a".repeat(64),
            entryReceiptId: "missing-terminal-entry-receipt",
            positionQuantity: 2,
          },
        },
      })
    ).record;
    const reviewer = approvingReviewer();
    const accountBookProvider = vi.fn();
    const executionQuoteProvider = vi.fn();
    const runOrder = vi.fn();
    const result = await executeFinanceIntradayDecision({
      directory,
      decision,
      controller: {
        accountId: "paper-account",
        accountBookProvider,
        executionQuoteProvider,
        createSafetyContext: vi.fn(),
      },
      caps: { maxOrderNotional: 1_000, maxInstrumentNotional: 2_000, maxOrdersPerRun: 1 },
      tradeDecisionReviewer: reviewer,
      now: () => Date.parse("2026-09-18T15:00:02.000Z"),
      runOrder: runOrder as never,
    });
    expect(result).toMatchObject({ status: "refused", outcome: { status: "refused" } });
    expect(result.outcome.reasons.join()).toContain("entry decision is not bound");
    expect(accountBookProvider).not.toHaveBeenCalled();
    expect(executionQuoteProvider).not.toHaveBeenCalled();
    expect(reviewer).not.toHaveBeenCalled();
    expect(runOrder).not.toHaveBeenCalled();
  });

  it("rejects a dynamic v3 seed-scope buy before quote, review, or order", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "intraday-dynamic-seed-buy-"));
    temporary.push(directory);
    const strategyBinding = await activeRuleBinding(directory, "paper_execution_eligible", true);
    const decision = (
      await appendFinanceIntradayDecision(directory, {
        signalId: "intraday-dynamic-seed-scope-buy",
        instrument: "SPY",
        sessionDate: "2026-09-18",
        action: "buy",
        reason: "opening_range_breakout",
        referencePrice: 100,
        referencePriceAt: "2026-09-18T15:00:00.000Z",
        stopPrice: 99,
        targetPrice: 102,
        datasetHeadRef: "d".repeat(64),
        strategyRule: FINANCE_INTRADAY_OPENING_RANGE_RULE_V3,
        strategyBinding,
      })
    ).record;
    const reviewer = approvingReviewer();
    const accountBookProvider = vi.fn();
    const executionQuoteProvider = vi.fn();
    const runOrder = vi.fn();
    const result = await executeFinanceIntradayDecision({
      directory,
      decision,
      controller: {
        accountId: "paper-account",
        accountBookProvider,
        executionQuoteProvider,
        createSafetyContext: vi.fn(),
      },
      caps: { maxOrderNotional: 1_000, maxInstrumentNotional: 2_000, maxOrdersPerRun: 1 },
      tradeDecisionReviewer: reviewer,
      now: () => Date.parse("2026-09-18T15:00:02.000Z"),
      runOrder: runOrder as never,
    });
    expect(result).toMatchObject({ status: "refused", outcome: { status: "refused" } });
    expect(result.outcome.reasons.join()).toContain("requires a fresh selected scope");
    expect(accountBookProvider).not.toHaveBeenCalled();
    expect(executionQuoteProvider).not.toHaveBeenCalled();
    expect(reviewer).not.toHaveBeenCalled();
    expect(runOrder).not.toHaveBeenCalled();
  });

  it.each([0, 1.5])(
    "allows a retired dynamic rule to exit its remainder after a native stop fills %s of 3 shares",
    async (stoppedQuantity) => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "intraday-retired-dynamic-exit-"));
      temporary.push(directory);
      const strategyBinding = await activeRuleBinding(directory, "paper_execution_eligible", true);
      const entry = (
        await appendFinanceIntradayDecision(directory, {
          signalId: "intraday-retired-dynamic-entry",
          instrument: "AAPL",
          sessionDate: "2026-09-18",
          action: "buy",
          reason: "opening_range_breakout",
          referencePrice: 100,
          referencePriceAt: "2026-09-18T14:00:00.000Z",
          stopPrice: 99,
          targetPrice: 102,
          datasetHeadRef: "a".repeat(64),
          strategyRule: FINANCE_INTRADAY_OPENING_RANGE_RULE_V3,
          strategyBinding: {
            ...strategyBinding,
            scope: "system_universe",
            universeSnapshotRef: caseflowFingerprint({ selected: ["AAPL"] }),
          },
        })
      ).record;
      const entryReceipt = buildFinanceExecutionReceipt({
        intent: {
          intentId: `intent:${entry.input.signalId}`,
          instrument: "AAPL",
          side: "buy",
          orderType: "market",
          quantity: 3,
          referencePrice: 100,
          referencePriceAt: entry.input.referencePriceAt,
          runAuthorizationId: "retired-dynamic-entry",
          rationale: "fixture terminal entry",
        },
        adapter: { id: "alpaca-venue", venue: "alpaca:paper", kind: "venue" },
        fill: {
          filledQuantity: 3,
          fillPrice: 100,
          filledAt: "2026-09-18T14:00:01.000Z",
          venueRef: "alpaca:paper:retired-dynamic-entry",
          terminalOrderIdentity: { orderId: "retired-dynamic-entry", terminal: true },
        },
        recordedAt: "2026-09-18T14:00:01.000Z",
        accountId: "paper-account",
      });
      await appendFinanceExecutionReceipt(directory, entryReceipt);
      if (stoppedQuantity > 0) {
        const child = {
          id: "retired-dynamic-stop",
          symbol: "AAPL",
          side: "sell",
          type: "stop",
          order_class: "oto",
          status: "partially_filled",
          qty: "3",
          filled_qty: String(stoppedQuantity),
          filled_at: "2026-09-18T14:15:00.000Z",
          updated_at: "2026-09-18T14:15:00.000Z",
        };
        await appendFinanceBrokerHistory(directory, {
          kind: "broker_history",
          accountId: "paper-account",
          venue: "alpaca:paper",
          query: "orders:retired-native-stop",
          cursor: "",
          payload: [
            {
              id: "retired-dynamic-entry",
              symbol: "AAPL",
              side: "buy",
              type: "market",
              order_class: "oto",
              status: "filled",
              qty: "3",
              filled_qty: "3",
              filled_at: entryReceipt.fill.filledAt,
              updated_at: entryReceipt.fill.filledAt,
              legs: [child],
            },
            child,
          ],
        });
        await appendFinanceBrokerHistory(directory, {
          kind: "broker_history",
          accountId: "paper-account",
          venue: "alpaca:paper",
          query: "activities:retired-native-stop",
          cursor: "",
          payload: [
            {
              id: "retired-stop-fill",
              activity_type: "FILL",
              type: "partial_fill",
              order_id: child.id,
              symbol: "AAPL",
              side: "sell",
              qty: String(stoppedQuantity),
              price: "98",
              transaction_time: child.filled_at,
            },
          ],
        });
      }
      await retireFinanceStrategyRule(directory, {
        kind: "retired",
        ruleId: FINANCE_INTRADAY_OPENING_RANGE_RULE_V3,
        observedAt: "2026-09-18T14:30:00.000Z",
        reason: "fixture replacement",
      });
      const exitBinding = {
        ...strategyBinding,
        scope: "managed_position_exit" as const,
        managedExitProof: {
          accountId: "paper-account",
          entryDecisionRef: entry.ref,
          entryReceiptId: entryReceipt.receiptId,
          positionQuantity: 3 - stoppedQuantity,
        },
      };
      const decision = (
        await appendFinanceIntradayDecision(directory, {
          signalId: "intraday-retired-dynamic-exit",
          instrument: "AAPL",
          sessionDate: "2026-09-18",
          action: "sell",
          reason: "opening_range_stop",
          referencePrice: 98,
          referencePriceAt: "2026-09-18T15:00:00.000Z",
          datasetHeadRef: "b".repeat(64),
          strategyRule: FINANCE_INTRADAY_OPENING_RANGE_RULE_V3,
          strategyBinding: exitBinding,
        })
      ).record;
      const reviewer = approvingReviewer();
      const runOrder = vi.fn(async () => ({
        ok: false as const,
        stage: "place" as const,
        refusals: ["fixture stops before dispatch"],
      }));
      const controller = {
        accountId: "paper-account",
        accountBookProvider: vi.fn(async () => ({
          accountId: "paper-account",
          venue: "alpaca:paper" as const,
          observedAt: "2026-09-18T15:00:01.000Z",
          expiresAt: "2026-09-18T15:01:01.000Z",
          equity: 100_000,
          positions: [{ instrument: "AAPL", quantity: 3 - stoppedQuantity, marketValue: 300 }],
        })),
        executionQuoteProvider: vi.fn(async () => ({
          referencePrice: 98,
          bidPrice: 98,
          askPrice: 98.1,
          referencePriceAt: "2026-09-18T15:00:01.000Z",
          sourceUrlOrArtifact: "fixture://quote",
          maxAgeMs: 30_000,
        })),
        createSafetyContext: vi.fn(),
      };
      const result = await executeFinanceIntradayDecision({
        directory,
        decision,
        controller,
        caps: { maxOrderNotional: 1_000, maxInstrumentNotional: 2_000, maxOrdersPerRun: 1 },
        tradeDecisionReviewer: reviewer,
        now: () => Date.parse("2026-09-18T15:00:02.000Z"),
        runOrder: runOrder as never,
      });
      expect(result).toMatchObject({ status: "refused", outcome: { status: "refused" } });
      expect(runOrder).toHaveBeenCalledOnce();
      const recordedOrderCalls = runOrder.mock.calls as unknown as Array<
        [{ quantityOverride: number; conclusion: { instrument: string; direction: string } }]
      >;
      expect(recordedOrderCalls[0]?.[0]).toMatchObject({
        quantityOverride: 3 - stoppedQuantity,
        conclusion: { instrument: "AAPL", direction: "sell" },
      });
      expect(reviewer).not.toHaveBeenCalled();

      const wrongAccountDecision = (
        await appendFinanceIntradayDecision(directory, {
          ...decision.input,
          signalId: "intraday-retired-dynamic-wrong-account",
          strategyBinding: {
            ...exitBinding,
            managedExitProof: { ...exitBinding.managedExitProof, accountId: "other-account" },
          },
        })
      ).record;
      const wrongAccountRun = vi.fn();
      const wrongAccountReview = approvingReviewer();
      const wrongAccount = await executeFinanceIntradayDecision({
        directory,
        decision: wrongAccountDecision,
        controller,
        caps: { maxOrderNotional: 1_000, maxInstrumentNotional: 2_000, maxOrdersPerRun: 1 },
        tradeDecisionReviewer: wrongAccountReview,
        now: () => Date.parse("2026-09-18T15:00:02.000Z"),
        runOrder: wrongAccountRun as never,
      });
      expect(wrongAccount).toMatchObject({ status: "refused" });
      expect(wrongAccountRun).not.toHaveBeenCalled();
      expect(wrongAccountReview).not.toHaveBeenCalled();
    },
  );

  it.each([
    { reason: "opening_range_stop", retired: false },
    { reason: "reward_target", retired: false },
    { reason: "pre_close", retired: false },
    { reason: "opening_range_stop", retired: true },
    { reason: "reward_target", retired: true },
    { reason: "pre_close", retired: true },
  ] as const)(
    "executes owned protective exit without model veto or replay (%j)",
    async ({ reason, retired }) => {
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
      if (retired) {
        await retireFinanceStrategyRule(directory, {
          kind: "retired",
          ruleId: decision.input.strategyRule,
          observedAt: "2026-09-18T15:00:01.000Z",
          reason: "disable new entries",
        });
      }
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
      if (retired) {
        const withoutOwnership = (
          await appendFinanceIntradayDecision(directory, {
            ...decision.input,
            signalId: "intraday-unproven-exit",
          })
        ).record;
        expect(
          await executeFinanceIntradayDecision({ ...request, decision: withoutOwnership }),
        ).toMatchObject({
          status: "refused",
          outcome: { reasons: [expect.stringContaining("entry ownership")] },
        });
        expect(runOrderMock).not.toHaveBeenCalled();
        await appendFinanceIntradayDecision(directory, {
          ...decision.input,
          signalId: "intraday-owned-entry",
          action: "buy",
          reason: "opening_range_breakout",
          referencePriceAt: "2026-09-18T14:30:00.000Z",
        });
        const newEntry = (
          await appendFinanceIntradayDecision(directory, {
            ...decision.input,
            signalId: "intraday-retired-new-entry",
            action: "buy",
            reason: "opening_range_breakout",
          })
        ).record;
        expect(
          await executeFinanceIntradayDecision({ ...request, decision: newEntry }),
        ).toMatchObject({ status: "refused" });
        const wrongAccount = (
          await appendFinanceIntradayDecision(directory, {
            ...decision.input,
            signalId: "intraday-wrong-account-exit",
          })
        ).record;
        expect(
          await executeFinanceIntradayDecision({
            ...request,
            decision: wrongAccount,
            controller: { ...controller, accountId: "another-account" },
          }),
        ).toMatchObject({
          status: "refused",
          outcome: { reasons: [expect.stringContaining("entry ownership")] },
        });
        expect(runOrderMock).not.toHaveBeenCalled();
      }
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

  it.each([
    new FinanceExecutionSafetyFactsError("broker_reconciliation_blocked"),
    new FinanceExecutionSafetyFactsError("account_snapshot_unavailable", {
      reason: "alpaca_safety_facts_inconsistent",
      stage: "account_arithmetic",
    }),
    new FinanceExecutionSafetyFactsError("account_snapshot_unavailable", {
      reason: "alpaca_safety_facts_inconsistent",
      stage: "account_arithmetic",
      accountArithmetic: {
        failedConditions: ["cash_equity_mismatch"],
        values: {
          equity: 100,
          cash: 90,
          shortMarketValue: 0,
          positionGross: 0,
          longMarketValue: 9,
          accountGross: 9,
          grossDrift: 0,
          grossDriftTolerance: 0.05,
          cashEquityResidual: -1,
          cashEquityTolerance: 0.01,
          controllerPeakEquity: 100,
        },
        trackNewHigh: true,
      },
    }),
  ])("preserves a typed controller failure before review (%s)", async (error) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "intraday-facts-failure-"));
    temporary.push(directory);
    const strategyBinding = await activeRuleBinding(directory);
    const decision = (
      await appendFinanceIntradayDecision(directory, {
        signalId: `facts-failure-${error.category}`,
        instrument: "SPY",
        sessionDate: "2026-09-18",
        action: "buy",
        reason: "opening_range_breakout",
        referencePrice: 500,
        referencePriceAt: "2026-09-18T15:00:00.000Z",
        stopPrice: 498,
        targetPrice: 504,
        datasetHeadRef: "d".repeat(64),
        strategyRule: FINANCE_INTRADAY_OPENING_RANGE_RULE,
        strategyBinding,
      })
    ).record;
    const reviewer = approvingReviewer();
    const executionQuoteProvider = vi.fn();
    const runOrder = vi.fn();
    const result = await executeFinanceIntradayDecision({
      directory,
      decision,
      controller: {
        accountId: "paper-account",
        accountBookProvider: async () => {
          throw error;
        },
        executionQuoteProvider,
        createSafetyContext: vi.fn(),
      },
      caps: { maxOrderNotional: 1000, maxInstrumentNotional: 5000, maxOrdersPerRun: 1 },
      tradeDecisionReviewer: reviewer,
      now: () => Date.parse("2026-09-18T15:00:02.000Z"),
      runOrder: runOrder as never,
    });
    expect(result.status).toBe("refused");
    expect(executionQuoteProvider).not.toHaveBeenCalled();
    expect(reviewer).not.toHaveBeenCalled();
    expect(runOrder).not.toHaveBeenCalled();
    const outcome = await readFinanceIntradayOutcome(directory, decision.input.signalId);
    expect(outcome).toMatchObject({
      reasons: [`execution_safety_${error.category}`],
      executionSafetyFailure: {
        stage: "facts",
        category: error.category,
        operation: "read_account_safety_facts",
        ...(error.provider ? { provider: error.provider } : {}),
      },
    });
  });

  it.each([
    { status: "blocked" as const, quarantinedInstruments: [], reason: /reconciliation blocked/u },
    {
      status: "restricted" as const,
      quarantinedInstruments: ["SPY"],
      reason: /instrument is quarantined/u,
    },
  ])("refuses $status account snapshots before quote and paid review", async (reconciliation) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "intraday-readiness-early-refusal-"));
    temporary.push(directory);
    const strategyBinding = await activeRuleBinding(directory);
    const decision = (
      await appendFinanceIntradayDecision(directory, {
        signalId: `readiness-${reconciliation.status}`,
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
    const reviewer = approvingReviewer();
    const executionQuoteProvider = vi.fn();
    const runOrder = vi.fn();
    const result = await executeFinanceIntradayDecision({
      directory,
      decision,
      controller: {
        accountId: "paper-account",
        accountBookProvider: async () => ({
          accountId: "paper-account",
          venue: "alpaca:paper",
          observedAt: "2026-09-18T15:00:01.000Z",
          expiresAt: "2026-09-18T15:01:01.000Z",
          equity: 100_000,
          positions: [],
          reconciliation: {
            ...reconciliation,
            historyStatus: "unresolved",
            uncertaintyReserve: 0,
            reasons: ["fixture readiness"],
          },
        }),
        executionQuoteProvider,
        createSafetyContext: vi.fn(),
      },
      caps: { maxOrderNotional: 1000, maxInstrumentNotional: 5000, maxOrdersPerRun: 1 },
      tradeDecisionReviewer: reviewer,
      now: () => Date.parse("2026-09-18T15:00:02.000Z"),
      runOrder: runOrder as never,
    });
    expect(result.status).toBe("refused");
    expect(executionQuoteProvider).not.toHaveBeenCalled();
    expect(reviewer).not.toHaveBeenCalled();
    expect(runOrder).not.toHaveBeenCalled();
    const outcome = await readFinanceIntradayOutcome(directory, decision.input.signalId);
    expect(outcome?.reasons.join()).toMatch(reconciliation.reason);
  });

  it.each([
    {
      invalid: "stop",
      stopPrice: 502,
      targetPrice: 504,
      brokerHeld: 0,
      refusal: "stop price",
    },
    { invalid: "target", stopPrice: 498, targetPrice: 499, brokerHeld: 0, refusal: "wrong side" },
    {
      invalid: "headroom",
      stopPrice: 498,
      targetPrice: 504,
      brokerHeld: 10,
      refusal: "rounds to zero",
    },
  ])("rejects a known compilation failure before paid review ($invalid)", async (fixture) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "intraday-precompile-"));
    temporary.push(directory);
    const strategyBinding = await activeRuleBinding(directory);
    const decision = (
      await appendFinanceIntradayDecision(directory, {
        signalId: `precompile-${fixture.invalid}`,
        instrument: "SPY",
        sessionDate: "2026-09-18",
        action: "buy",
        reason: "opening_range_breakout",
        referencePrice: 500,
        referencePriceAt: "2026-09-18T15:00:00.000Z",
        stopPrice: fixture.stopPrice,
        targetPrice: fixture.targetPrice,
        datasetHeadRef: "d".repeat(64),
        strategyRule: FINANCE_INTRADAY_OPENING_RANGE_RULE,
        strategyBinding,
      })
    ).record;
    const reviewer = approvingReviewer();
    const runOrder = vi.fn(async () => ({
      ok: false as const,
      stage: "place" as const,
      refusals: ["later gate refusal"],
    }));
    const createSafetyContext = vi.fn();
    const result = await executeFinanceIntradayDecision({
      directory,
      decision,
      controller: {
        accountId: "paper-account",
        accountBookProvider: async () => ({
          accountId: "paper-account",
          venue: "alpaca:paper",
          observedAt: "2026-09-18T15:00:01.000Z",
          expiresAt: "2026-09-18T15:01:01.000Z",
          equity: 100_000,
          positions: fixture.brokerHeld
            ? [{ instrument: "SPY", quantity: fixture.brokerHeld, marketValue: 5000 }]
            : [],
        }),
        executionQuoteProvider: async () => ({
          referencePrice: 500,
          bidPrice: 499.9,
          askPrice: 500,
          referencePriceAt: "2026-09-18T15:00:01.000Z",
          sourceUrlOrArtifact: "fixture://quote",
          maxAgeMs: 30_000,
        }),
        createSafetyContext,
      },
      caps: { maxOrderNotional: 1000, maxInstrumentNotional: 5000, maxOrdersPerRun: 1 },
      tradeDecisionReviewer: reviewer,
      now: () => Date.parse("2026-09-18T15:00:02.000Z"),
      runOrder: runOrder as never,
    });
    expect(result.status).toBe("refused");
    expect(reviewer).not.toHaveBeenCalled();
    expect(runOrder).not.toHaveBeenCalled();
    expect(createSafetyContext).not.toHaveBeenCalled();
    const outcome = await readFinanceIntradayOutcome(directory, decision.input.signalId);
    expect(outcome?.reasons.join()).toContain(fixture.refusal);
    expect(outcome?.tradeDecisionReview).toBeUndefined();
  });

  it.each([
    "unavailable",
    "output_truncated",
    "provider_payment_required",
    "veto",
    "invalid",
    "uncertain_execution",
    "definite_rejection",
    "terminal_rejection",
    "not_started",
  ] as const)(
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
      const attemptMode =
        reviewMode === "uncertain_execution" ||
        reviewMode === "definite_rejection" ||
        reviewMode === "terminal_rejection" ||
        reviewMode === "not_started";
      const uncertainMode = reviewMode === "uncertain_execution";
      const disposition =
        reviewMode === "uncertain_execution"
          ? "outcome_unresolved"
          : reviewMode === "terminal_rejection"
            ? "definite_rejection"
            : reviewMode;
      const attempt = attemptMode
        ? {
            phase: reviewMode === "not_started" ? ("not_started" as const) : ("execute" as const),
            disposition: disposition as "not_started" | "definite_rejection" | "outcome_unresolved",
            ...(reviewMode === "definite_rejection"
              ? { venueResponse: { httpStatus: 422, brokerCode: 42210000 } }
              : {}),
          }
        : undefined;
      const tradeDecisionReviewer: FinanceTradeDecisionReviewer | undefined = attemptMode
        ? approvingReviewer()
        : reviewMode === "veto"
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
          : reviewMode === "output_truncated" || reviewMode === "provider_payment_required"
            ? async () => ({
                status: "failed",
                attempted: true,
                provider: "fixture-provider",
                modelId: "fixture-model",
                latencyMs: 3,
                providerCallObserved: true,
                adapterAttested: true,
                failureCode: reviewMode,
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
        safetyFailure: {
          stage: "facts" as const,
          category: "cash_changed" as const,
          operation: "read_account_safety_facts" as const,
        },
      }));
      if (reviewMode === "unavailable") {
        runOrder.mockRejectedValueOnce(new Error("secret provider body must not persist"));
      } else if (
        reviewMode === "terminal_rejection" ||
        reviewMode === "definite_rejection" ||
        reviewMode === "not_started"
      ) {
        runOrder.mockRejectedValueOnce(
          new FinanceExecutionSafetyTerminalFailureError(
            "claim",
            reviewMode === "not_started" ? "not_started" : "rejected",
            attempt!,
            new Error("private response body"),
          ),
        );
      } else if (attempt) {
        runOrder.mockRejectedValueOnce(
          new FinanceExecutionSafetyUncertainError(
            "claim",
            new Error("private transport detail"),
            attempt,
          ),
        );
      }

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

      expect(result).toMatchObject({
        status: uncertainMode ? "uncertain" : "refused",
      });
      const reviewFailed =
        reviewMode === "unavailable" ||
        reviewMode === "output_truncated" ||
        reviewMode === "provider_payment_required";
      expect(runOrder).toHaveBeenCalledTimes(reviewFailed || attemptMode ? 1 : 0);
      const outcome = await readFinanceIntradayOutcome(directory, signalId);
      expect(outcome).toMatchObject({
        status: uncertainMode ? "uncertain" : "refused",
        tradeDecisionReview:
          reviewMode === "unavailable"
            ? { status: "failed", failureCode: "reviewer_unavailable" }
            : reviewMode === "output_truncated" || reviewMode === "provider_payment_required"
              ? { status: "failed", failureCode: reviewMode }
              : reviewMode === "invalid"
                ? { status: "failed", failureCode: "output_invalid" }
                : {
                    status: "completed",
                    decision: {
                      candidateId: signalId,
                      decision: attemptMode ? "approve" : "veto",
                    },
                  },
      });
      if (attempt) {
        expect(outcome?.reasons).toEqual([
          reviewMode === "not_started"
            ? "execution_dispatch_not_started"
            : reviewMode === "definite_rejection" || reviewMode === "terminal_rejection"
              ? "execution_venue_rejected"
              : "execution_outcome_unresolved",
        ]);
        expect(outcome?.executionSafetyFailure).toEqual({
          stage: reviewMode === "not_started" ? "reservation" : "execution",
          category: "unexpected",
          operation: reviewMode === "not_started" ? "reserve_execution_claim" : "execute_order",
          attempt,
        });
        expect(JSON.stringify(outcome)).not.toContain("private transport detail");
      } else if (reviewMode === "unavailable") {
        expect(outcome?.reasons).toEqual(["intraday_execution_unexpected_error"]);
        expect(outcome?.executionSafetyFailure).toBeUndefined();
        expect(JSON.stringify(outcome)).not.toContain("secret provider body");
      } else if (reviewFailed) {
        expect(outcome?.reasons).toEqual(["shared execution gate refusal"]);
        expect(outcome?.executionSafetyFailure).toEqual({
          stage: "facts",
          category: "cash_changed",
          operation: "read_account_safety_facts",
        });
      } else {
        expect(outcome?.reasons.join()).toMatch(/model veto|violated candidate binding/u);
        expect(outcome?.executionSafetyFailure).toBeUndefined();
      }
    },
  );

  it.each([
    "fresh",
    "stale",
    "timeout",
    "abort",
    "prepared_same",
    "prepared_changed",
    "prepared_failed_changed",
    "prepared_failed_stale",
  ] as const)(
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
          stopPrice: 498,
          targetPrice: 504,
          datasetHeadRef: "d".repeat(64),
          strategyRule: FINANCE_INTRADAY_OPENING_RANGE_RULE,
          strategyBinding,
        })
      ).record;
      const cancellation = new AbortController();
      const quoteProvider = vi.fn(async () => ({
        referencePrice: 500,
        bidPrice: 499,
        askPrice: mode.endsWith("changed") && quoteProvider.mock.calls.length > 1 ? 502 : 501,
        maxAgeMs: 30_000,
        referencePriceAt: mode.endsWith("stale")
          ? "2026-09-18T15:00:01.000Z"
          : new Date(clock).toISOString(),
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
        if (mode.startsWith("prepared_failed")) {
          return {
            status: "failed",
            attempted: true,
            provider: "fixture",
            modelId: "fixture",
            latencyMs: 65_000,
            providerCallObserved: true,
            adapterAttested: false,
            failureCode: "provider_payment_required",
          };
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
          ...(mode.startsWith("prepared_") ? { prepareExecutionQuote: quoteProvider } : {}),
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
      expect(runOrder).toHaveBeenCalledTimes(
        mode.endsWith("stale") || mode === "abort" || mode === "prepared_changed" ? 0 : 1,
      );
      if (mode === "prepared_changed") {
        expect("outcome" in result ? result.outcome.reasons : []).toEqual([
          "intraday reviewed execution prices changed; a new model review is required",
        ]);
      }
      if (mode === "fresh" || mode === "timeout" || mode === "prepared_same") {
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
      if (mode === "prepared_failed_changed") {
        expect(runOrder).toHaveBeenCalledWith(
          expect.objectContaining({
            market: {
              referencePrice: 502,
              referencePriceAt: new Date(clock).toISOString(),
            },
          }),
        );
        expect(
          "tradeDecisionReview" in result ? result.tradeDecisionReview : undefined,
        ).toMatchObject({ status: "failed", failureCode: "provider_payment_required" });
        expect("outcome" in result ? result.outcome.reasons : []).toEqual(["fixture shared gate"]);
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
