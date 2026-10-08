import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FINANCE_ALPACA_MARKET_CALENDAR_SOURCE,
  FINANCE_ALPACA_MARKET_CALENDAR_URL,
} from "./finance-alpaca-market-calendar.js";
import {
  compileFinanceAlpacaOrderIntent,
  type runFinanceAlpacaOrder,
} from "./finance-alpaca-run.js";
import { AlpacaSafetyQuoteReadError } from "./finance-alpaca-safety-provider.js";
import { caseflowFingerprint } from "./finance-caseflow.js";
import type { FinanceDailyAccountBook } from "./finance-daily-cycle.js";
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
import * as strategyRules from "./finance-strategy-rule-ledger.js";
import * as thesisContext from "./finance-thesis-decision-context.js";
import { openFinanceThesis } from "./finance-thesis-ledger.js";
import {
  FINANCE_INTRADAY_QUOTE_APPROVAL_POLICY,
  type FinanceTradeDecisionReviewRequest,
  type FinanceTradeDecisionReviewer,
} from "./finance-trade-decision-review.js";

const readerMocks = vi.hoisted(() => ({ readUniverse: vi.fn() }));
vi.mock("./finance-research-runner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./finance-research-runner.js")>();
  return { ...actual, readFinanceResearchEquityUniverseSnapshot: readerMocks.readUniverse };
});

const temporary: string[] = [];
afterEach(async () => {
  readerMocks.readUniverse.mockReset();
  vi.restoreAllMocks();
  vi.useRealTimers();
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
  it.each([
    { delayMs: 10_000, ageMs: 11_000, review: true },
    { delayMs: 29_000, ageMs: 30_000, review: true },
    { delayMs: 29_001, ageMs: 30_001, review: false },
  ])(
    "checks actual quote age after local evidence preparation ($delayMs)",
    async ({ delayMs, ageMs, review }) => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "intraday-context-lease-"));
      temporary.push(directory);
      const strategyBinding = await activeRuleBinding(directory);
      const decision = (
        await appendFinanceIntradayDecision(directory, {
          signalId: `context-lease-${delayMs}`,
          instrument: "SPY",
          sessionDate: "2026-09-18",
          action: "buy",
          reason: "opening_range_breakout",
          referencePrice: 100,
          referencePriceAt: "2026-09-18T15:00:01.000Z",
          stopPrice: 99,
          targetPrice: 102,
          datasetHeadRef: "c".repeat(64),
          strategyRule: "opening_range_breakout_long_next_bar_v1",
          strategyBinding,
        })
      ).record;
      let clock = Date.parse("2026-09-18T15:00:02.000Z");
      const build = thesisContext.buildFinanceThesisDecisionContext;
      const contextReader = vi
        .spyOn(thesisContext, "buildFinanceThesisDecisionContext")
        .mockImplementation(async (params) => {
          const context = await build(params);
          clock += delayMs;
          return context;
        });
      const quoteProvider = vi.fn(async () => ({
        referencePrice: 100,
        referencePriceAt: "2026-09-18T15:00:01.000Z",
        sourceUrlOrArtifact: "fixture://quote",
        bidPrice: 99.9,
        askPrice: 100,
        maxAgeMs: 30_000,
      }));
      const reviewer = approvingReviewer();
      const runOrder = vi.fn(async () => ({
        ok: false as const,
        refusals: ["fixture final gate refused"],
      }));
      const safetyContext = vi.fn();
      const result = await executeFinanceIntradayDecision({
        directory,
        decision,
        controller: {
          accountId: "paper-account",
          accountBookProvider: async () => ({
            accountId: "paper-account",
            venue: "alpaca:paper" as const,
            observedAt: "2026-09-18T15:00:01.000Z",
            expiresAt: "2026-09-18T15:01:01.000Z",
            equity: 100_000,
            positions: [],
          }),
          executionQuoteProvider: quoteProvider,
          createSafetyContext: safetyContext,
        },
        caps: { maxOrderNotional: 5000, maxInstrumentNotional: 10000, maxOrdersPerRun: 1 },
        tradeDecisionReviewer: reviewer,
        now: () => clock,
        runOrder: runOrder as never,
      });
      const stored = await readFinanceIntradayOutcome(directory, decision.input.signalId);
      expect(stored).toEqual(result.outcome);
      expect(contextReader).toHaveBeenCalledOnce();
      expect(quoteProvider).toHaveBeenCalledOnce();
      expect(reviewer).toHaveBeenCalledTimes(review ? 1 : 0);
      expect(runOrder).toHaveBeenCalledTimes(review ? 1 : 0);
      expect(safetyContext).not.toHaveBeenCalled();
      if (review) {
        expect(stored?.tradeDecisionReview?.request.asOf).toBe(new Date(clock).toISOString());
        expect(stored?.tradeDecisionReview?.request.candidates[0].executionQuote.ageMs).toBe(ageMs);
        expect(stored?.tradeDecisionReview?.request.decisionContext?.observedAt).toBe(
          "2026-09-18T15:00:02.000Z",
        );
      } else {
        expect(stored?.tradeDecisionReview).toBeUndefined();
        expect(stored?.reasons[0]).toContain("after context preparation");
        expect(JSON.parse(stored!.reasons[1])).toEqual({
          phase: "quote_before_model_review_after_context",
          quoteAtMs: Date.parse("2026-09-18T15:00:01.000Z"),
          checkedAtMs: clock,
          ageMs,
          maxAgeMs: 30_000,
        });
      }
    },
  );
  it.each(["initial", "refresh", "spoof", "account", "cancelled"] as const)(
    "persists only trusted preparation quote evidence (%s)",
    async (mode) => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "quote-diagnostic-execution-"));
      temporary.push(directory);
      const strategyBinding = await activeRuleBinding(directory);
      const decision = (
        await appendFinanceIntradayDecision(directory, {
          signalId: `quote-${mode}`,
          instrument: "SPY",
          sessionDate: "2026-09-18",
          action: "buy",
          reason: "opening_range_breakout",
          referencePrice: 100,
          referencePriceAt: "2026-09-18T15:00:01.000Z",
          stopPrice: 99,
          targetPrice: 102,
          datasetHeadRef: "c".repeat(64),
          strategyRule: "opening_range_breakout_long_next_bar_v1",
          strategyBinding,
        })
      ).record;
      const typed = new AlpacaSafetyQuoteReadError("alpaca_safety_snapshot_read_unavailable", {
        stage: "quote_snapshot",
        httpStatus: 503,
      });
      let elapsed = 0;
      vi.spyOn(performance, "now").mockImplementation(() => elapsed);
      const caller = new AbortController();
      const account = {
        accountId: "paper-account",
        venue: "alpaca:paper" as const,
        observedAt: "2026-09-18T15:00:01.000Z",
        expiresAt: "2026-09-18T15:01:01.000Z",
        equity: 100_000,
        positions: [],
      };
      const quote = {
        referencePrice: 100,
        referencePriceAt: account.observedAt,
        bidPrice: 99.9,
        askPrice: 100,
        maxAgeMs: 30_000,
        sourceUrlOrArtifact: "fixture://quote",
      };
      const reviewer = approvingReviewer();
      const runOrder = vi.fn();
      const createSafetyContext = vi.fn();
      const quoteProvider = vi.fn(async () => {
        elapsed += 7_000;
        if (mode === "refresh") {
          return quote;
        }
        if (mode === "cancelled") {
          caller.abort(new Error("PRIVATE_BODY"));
        }
        if (mode === "spoof") {
          throw Object.assign(new Error("PRIVATE_BODY"), {
            name: "AlpacaSafetyQuoteReadError",
            reason: typed.reason,
            diagnostic: typed.diagnostic,
          });
        }
        throw typed;
      });
      const result = await executeFinanceIntradayDecision({
        directory,
        decision,
        controller: {
          accountId: "paper-account",
          accountBookProvider: async () => {
            elapsed += 4_000;
            if (mode === "account") {
              throw typed;
            }
            return account;
          },
          executionQuoteProvider: quoteProvider,
          ...(mode === "refresh"
            ? {
                prepareExecutionQuote: async () => {
                  elapsed += 9_000;
                  throw typed;
                },
              }
            : {}),
          createSafetyContext,
        },
        caps: { maxOrderNotional: 5000, maxInstrumentNotional: 10000, maxOrdersPerRun: 1 },
        tradeDecisionReviewer: reviewer,
        signal: caller.signal,
        now: () => Date.parse("2026-09-18T15:00:02.000Z"),
        runOrder: runOrder as never,
      });
      const stored = await readFinanceIntradayOutcome(directory, decision.input.signalId);
      expect(stored).toEqual(result.outcome);
      expect(stored?.executionFailure).toMatchObject({
        stage:
          mode === "account"
            ? "account_book"
            : mode === "refresh"
              ? "refresh_quote"
              : "initial_quote",
        category: mode === "cancelled" ? "cancelled" : "unexpected",
        elapsedMs: mode === "account" ? 4_000 : mode === "refresh" ? 20_000 : 11_000,
        stageElapsedMs: mode === "account" ? 4_000 : mode === "refresh" ? 9_000 : 7_000,
      });
      if (mode === "initial" || mode === "refresh") {
        expect(stored?.reasons).toEqual([
          "intraday_execution_quote_unavailable:alpaca_safety_snapshot_read_unavailable:quote_snapshot",
        ]);
        expect(stored?.executionFailure?.quote).toEqual({
          reason: typed.reason,
          ...typed.diagnostic,
        });
      } else {
        expect(stored?.reasons).toEqual(["intraday_execution_unexpected_error"]);
        expect(stored?.executionFailure?.quote).toBeUndefined();
      }
      expect(JSON.stringify(stored)).not.toMatch(/PRIVATE_BODY|secret.invalid/);
      expect(stored?.executionSafetyFailure).toBeUndefined();
      expect(reviewer).toHaveBeenCalledTimes(mode === "refresh" ? 1 : 0);
      expect(runOrder).not.toHaveBeenCalled();
      expect(createSafetyContext).not.toHaveBeenCalled();
    },
  );

  it.each([
    { mode: "full", refused: true },
    { mode: "available", refused: false },
    { mode: "cash", refused: false },
    { mode: "cash_reserve", refused: false },
    { mode: "cash_empty", refused: true },
    { mode: "cash_below_unit", refused: true },
    { mode: "invalid_cash", refused: false },
    { mode: "equality", refused: false },
    { mode: "reserve", refused: false },
    { mode: "reserve_equality", refused: false },
    { mode: "missing", refused: false },
    { mode: "stale", refused: false },
    { mode: "future", refused: false },
    { mode: "mismatched_source", refused: false },
    { mode: "mismatched_account", refused: false },
    { mode: "mismatched_time", refused: false },
    { mode: "invalid_gross", refused: false },
    { mode: "invalid_limit", refused: false },
    { mode: "invalid_reserve", refused: false },
    { mode: "mismatched_reserve", refused: false },
    { mode: "missing_readiness", refused: false },
    { mode: "malformed_readiness", refused: false },
    { mode: "final_capacity_changed", refused: false },
  ] as const)(
    "screens only trusted buy capacity before paid review ($mode)",
    async ({ mode, refused }) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-09-18T15:00:02.000Z"));
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "intraday-capacity-"));
      temporary.push(directory);
      const accountId = path.basename(directory);
      const strategyBinding = await activeRuleBinding(directory);
      const decision = (
        await appendFinanceIntradayDecision(directory, {
          signalId: `capacity-${mode}`,
          instrument: "SPY",
          sessionDate: "2026-09-18",
          action: "buy",
          reason: "opening_range_breakout",
          referencePrice: 100,
          referencePriceAt: "2026-09-18T15:00:01.000Z",
          stopPrice: 99,
          targetPrice: 102,
          datasetHeadRef: "c".repeat(64),
          strategyRule: "opening_range_breakout_long_next_bar_v1",
          strategyBinding,
        })
      ).record;
      const observedAt = "2026-09-18T15:00:01.000Z";
      const expiresAt = "2026-09-18T15:01:01.000Z";
      const reserve =
        mode === "reserve" || mode === "cash_reserve" ? 600 : mode === "reserve_equality" ? 500 : 0;
      const account: FinanceDailyAccountBook = {
        accountId,
        venue: "alpaca:paper",
        observedAt,
        expiresAt,
        equity: 100_000,
        positions: [],
        reconciliation: {
          status: reserve ? "restricted" : "ready",
          historyStatus: reserve ? "unresolved" : "reconciled",
          uncertaintyReserve: reserve,
          quarantinedInstruments: reserve ? ["BTC/USD"] : [],
          reasons: [],
        },
        executionCapacity: {
          source: "controller_account_safety_facts",
          accountId,
          venue: "alpaca:paper",
          observedAt,
          expiresAt,
          policyPlanId: "capacity-test",
          policyRevision: "current",
          maxGrossExposure: 10_000,
          grossExposure:
            mode === "available" ||
            mode === "cash" ||
            mode === "cash_empty" ||
            mode === "cash_below_unit" ||
            mode === "invalid_cash" ||
            mode === "final_capacity_changed"
              ? 4_000
              : mode === "equality"
                ? 5_000
                : reserve
                  ? 4_500
                  : 10_000,
          uncertaintyReserve: reserve,
          ...(mode === "cash" || mode === "cash_reserve" ? { availableCash: 1250 } : {}),
          ...(mode === "cash_empty" ? { availableCash: 0 } : {}),
          ...(mode === "cash_below_unit" ? { availableCash: 50 } : {}),
          ...(mode === "invalid_cash" ? { availableCash: Number.NaN } : {}),
        },
      };
      const capacity = account.executionCapacity!;
      const override: Partial<NonNullable<FinanceDailyAccountBook["executionCapacity"]>> =
        mode === "stale"
          ? { expiresAt: "2026-09-18T15:00:02.000Z" }
          : mode === "future"
            ? { observedAt: "2026-09-18T15:00:03.000Z" }
            : mode === "mismatched_source"
              ? { source: "foreign" as never }
              : mode === "mismatched_account"
                ? { accountId: "other-account" }
                : mode === "mismatched_time"
                  ? { observedAt: "2026-09-18T15:00:00.000Z" }
                  : mode === "invalid_gross"
                    ? { grossExposure: Number.NaN }
                    : mode === "invalid_limit"
                      ? { maxGrossExposure: 0 }
                      : mode === "invalid_reserve"
                        ? { uncertaintyReserve: -1 }
                        : mode === "mismatched_reserve"
                          ? { uncertaintyReserve: 10 }
                          : {};
      const book = {
        ...account,
        executionCapacity: mode === "missing" ? undefined : { ...capacity, ...override },
        ...(mode === "stale" ? { expiresAt: override.expiresAt! } : {}),
        ...(mode === "future" ? { observedAt: override.observedAt! } : {}),
        ...(mode === "missing_readiness" ? { reconciliation: undefined } : {}),
        ...(mode === "malformed_readiness"
          ? {
              reconciliation: {
                ...account.reconciliation!,
                quarantinedInstruments: undefined as never,
              },
            }
          : {}),
      };
      const reviewer = approvingReviewer();
      const venueExecute = vi.fn(async () => {
        throw new Error("must not dispatch beyond capacity");
      });
      const runOrder = vi.fn<typeof runFinanceAlpacaOrder>(async (request) => {
        if (mode !== "final_capacity_changed") {
          return { ok: false, stage: "place", refusals: ["fixture final gate"] };
        }
        const compiled = compileFinanceAlpacaOrderIntent(request);
        if (!compiled.ok) {
          throw new Error("fixture candidate must compile");
        }
        const context = createFinanceExecutionSafetyContext({
          stateDir: directory,
          accountId,
          adapterId: "alpaca-venue",
          venue: "alpaca:paper",
          intent: compiled.intent,
          budget: request.budget,
          policy: {
            planId: "capacity-test",
            revision: "current",
            riskModel: "fully_funded_unhedged_spot",
            authorizedSide: "buy",
            authorizedQuantity: compiled.intent.quantity,
            expiresAt,
            maxPortfolioDrawdownFraction: 0.2,
            maxGrossExposure: 10_000,
            maxAccountAgeMs: 60_000,
            maxQuoteAgeMs: 60_000,
            maxInstrumentEvidenceAgeMs: 60_000,
          },
          readFacts: async () => ({
            accountId,
            adapterId: "alpaca-venue",
            venue: "alpaca:paper",
            instrument: "SPY",
            snapshotId: "concurrent-current",
            source: "fixture",
            observedAt,
            expiresAt,
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
              grossExposure: 10_000,
            },
            quote: { source: "fixture", price: 100, observedAt, expiresAt, currency: "USD" },
            instrumentEvidence: {
              source: "fixture",
              observedAt,
              assetType: "spot_equity",
              fullyPaid: true,
              marginEnabled: false,
              hedged: false,
            },
          }),
        });
        const guarded = await withFinanceExecutionSafety({
          context,
          intent: compiled.intent,
          budget: request.budget,
          adapterId: "alpaca-venue",
          venue: "alpaca:paper",
          adapterKind: "venue",
          recordedAt: new Date().toISOString(),
          buildReceipt: (fill, recordedAt, ownerAccountId) =>
            buildFinanceExecutionReceipt({
              intent: compiled.intent,
              adapter: { id: "alpaca-venue", venue: "alpaca:paper", kind: "venue" },
              fill,
              recordedAt,
              accountId: ownerAccountId,
            }),
          execute: venueExecute,
        });
        if (guarded.ok) {
          throw new Error("final capacity must refuse");
        }
        return { ok: false, stage: "place", refusals: guarded.reasons };
      });
      const createSafetyContext = vi.fn(() => ({ kind: "controller_execution_safety" as const }));
      const quoteProvider = vi.fn(async () => ({
        referencePrice: 100,
        referencePriceAt: observedAt,
        bidPrice: 99.9,
        askPrice: 100,
        maxAgeMs: 30_000,
        sourceUrlOrArtifact: "fixture://quote",
      }));
      const accountBookProvider = vi.fn(async () => book);
      const result = await executeFinanceIntradayDecision({
        directory,
        decision,
        controller: {
          accountId,
          accountBookProvider,
          executionQuoteProvider: quoteProvider,
          createSafetyContext,
        },
        caps: { maxOrderNotional: 5_000, maxInstrumentNotional: 10_000, maxOrdersPerRun: 1 },
        tradeDecisionReviewer: reviewer,
        now: Date.now,
        runOrder,
      });
      expect(accountBookProvider).toHaveBeenCalledWith(expect.any(AbortSignal), {
        instrument: "SPY",
        side: "buy",
      });
      expect(reviewer).toHaveBeenCalledTimes(refused ? 0 : 1);
      expect(runOrder).toHaveBeenCalledTimes(refused ? 0 : 1);
      if (!refused) {
        const quantity =
          mode === "reserve" ? 49 : mode === "cash" ? 12 : mode === "cash_reserve" ? 6 : 50;
        const reviewedCandidate = reviewer.mock.calls[0][0].candidates[0];
        expect("plannedQuantity" in reviewedCandidate && reviewedCandidate.plannedQuantity).toBe(
          quantity,
        );
        const compiled = compileFinanceAlpacaOrderIntent(runOrder.mock.calls[0][0]);
        expect(compiled.ok && compiled.intent.quantity).toBe(quantity);
        expect(reviewer.mock.calls[0][0].caps.maxOrderNotional).toBe(5000);
      }
      expect(createSafetyContext).not.toHaveBeenCalled();
      expect(venueExecute).not.toHaveBeenCalled();
      if (refused) {
        expect(result.outcome.reasons).toEqual(
          mode === "cash_below_unit"
            ? ["refuse: computed size rounds to zero; refusing rather than trading a token"]
            : [
                "account_capacity_precheck_before_model_review",
                mode === "cash_empty"
                  ? "execution_safety_funding_and_survival_facts_required"
                  : "execution_safety_portfolio_exposure_exceeded",
                `observedAt=${observedAt};expiresAt=${expiresAt};gross=${capacity.grossExposure};notional=5000;reserve=${reserve};limit=10000`,
              ],
        );
        expect(result.outcome.tradeDecisionReview).toBeUndefined();
        expect(quoteProvider).toHaveBeenCalledTimes(1);
      } else {
        expect(result.outcome.reasons).toEqual([
          mode === "final_capacity_changed"
            ? "execution_safety_portfolio_exposure_exceeded"
            : "fixture final gate",
        ]);
        expect(quoteProvider).toHaveBeenCalledTimes(1);
      }
      expect(
        (await readFinanceIntradayOutcome(directory, decision.input.signalId))?.reasons,
      ).toEqual(result.outcome.reasons);
      expect(
        await readFinanceExecutionSafetyClaims({
          stateDir: directory,
          accountId,
          venue: "alpaca:paper",
        }),
      ).toHaveLength(0);
    },
  );

  it.each([
    "deadline_account",
    "caller_account",
    "deadline_quote",
    "caller_quote",
    "deadline_refresh",
    "caller_review",
    "model_deadline",
    "default_account",
    "caller_timeout_account",
    "pre_aborted",
    "provider_error",
    "late_rejection",
    "dispatch_uncertain",
  ] as const)("bounds preparation without racing dispatch (%s)", async (mode) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "intraday-deadline-"));
    temporary.push(directory);
    const strategyBinding = await activeRuleBinding(directory);
    const decision = (
      await appendFinanceIntradayDecision(directory, {
        signalId: `preparation-${mode}`,
        instrument: "SPY",
        sessionDate: "2026-09-18",
        action: "buy",
        reason: "opening_range_breakout",
        referencePrice: 100,
        referencePriceAt: "2026-09-18T15:00:00.000Z",
        stopPrice: 99,
        targetPrice: 102,
        datasetHeadRef: "c".repeat(64),
        strategyRule: FINANCE_INTRADAY_OPENING_RANGE_RULE,
        strategyBinding,
      })
    ).record;
    const caller = new AbortController();
    const deadline = new AbortController();
    const modelDeadline = new AbortController();
    const reviewWaitDeadline = new AbortController();
    const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation((ms) =>
        ms === 120_000
          ? deadline.signal
          : ms === 60_000
            ? modelDeadline.signal
            : ms === 65_000
              ? reviewWaitDeadline.signal
              : originalTimeout(ms),
      );
    const account = {
      accountId: "paper-account",
      venue: "alpaca:paper" as const,
      observedAt: "2026-09-18T15:00:01.000Z",
      expiresAt: "2026-09-18T15:01:01.000Z",
      equity: 100_000,
      positions: [],
    };
    const quote = {
      referencePrice: 100,
      referencePriceAt: "2026-09-18T15:00:01.000Z",
      sourceUrlOrArtifact: "fixture://quote",
      bidPrice: 99.9,
      askPrice: 100,
      maxAgeMs: 30_000,
    };
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let finish!: () => void;
    let fail!: (error: unknown) => void;
    const stalled = new Promise<void>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
    let combinedSignal: AbortSignal | undefined;
    let listenerWasRemoved = () => false;
    const stall = async (signal: AbortSignal) => {
      combinedSignal = signal;
      const removeListener = vi.spyOn(signal, "removeEventListener");
      listenerWasRemoved = () => removeListener.mock.calls.some(([event]) => event === "abort");
      entered();
      await stalled; // Deliberately ignores cancellation, like a broken provider.
    };
    const accountBookProvider = vi.fn(async (signal: AbortSignal) => {
      if (mode.includes("account") || mode === "late_rejection") {
        await stall(signal);
      }
      if (mode === "provider_error") {
        throw new Error("private-key-and-secret-response-body");
      }
      return account;
    });
    const executionQuoteProvider = vi.fn(async (_request: unknown, signal: AbortSignal) => {
      if (mode.endsWith("quote")) {
        await stall(signal);
      }
      return quote;
    });
    const prepareExecutionQuote = vi.fn(async (_request: unknown, signal: AbortSignal) => {
      await stall(signal);
      return quote;
    });
    const runOrder = vi.fn(async () => {
      if (mode === "model_deadline") {
        return { ok: false as const, refusals: ["fixture shared gate refusal"] };
      }
      entered();
      await stalled;
      throw new FinanceExecutionSafetyUncertainError(
        "fixture-claim",
        new Error("private dispatch body"),
        {
          phase: "execute",
          disposition: "outcome_unresolved",
        },
      );
    });
    if (mode === "pre_aborted") {
      caller.abort(new Error("private caller reason"));
    }
    let settled = false;
    const pending = executeFinanceIntradayDecision({
      directory,
      decision,
      controller: {
        accountId: "paper-account",
        accountBookProvider,
        executionQuoteProvider,
        ...(mode === "deadline_refresh" ? { prepareExecutionQuote } : {}),
        createSafetyContext: vi.fn(),
      },
      caps: { maxOrderNotional: 5_000, maxInstrumentNotional: 10_000, maxOrdersPerRun: 1 },
      tradeDecisionReviewer:
        mode.endsWith("review") || mode === "model_deadline"
          ? async (request, signal) => {
              await stall(signal);
              return approvingReviewer()(request);
            }
          : approvingReviewer(),
      ...(mode === "default_account" ? {} : { signal: caller.signal }),
      now: () => Date.parse("2026-09-18T15:00:02.000Z"),
      runOrder: runOrder as never,
    }).then((result) => {
      settled = true;
      return result;
    });
    if (mode !== "pre_aborted" && mode !== "provider_error") {
      await reached;
      if (mode.startsWith("caller") || mode === "late_rejection") {
        caller.abort(
          mode === "caller_timeout_account"
            ? new DOMException("private timeout reason", "TimeoutError")
            : new Error("private caller reason"),
        );
      } else if (mode === "model_deadline") {
        modelDeadline.abort();
        reviewWaitDeadline.abort();
      } else {
        deadline.abort(new Error("private deadline reason"));
      }
      if (mode === "dispatch_uncertain") {
        // The venue owner, not the preparation deadline, determines an in-flight outcome.
        await Promise.resolve();
        expect(settled).toBe(false);
        finish();
      }
    }
    const result = await pending;
    expect(timeoutSpy).toHaveBeenCalledWith(120_000);
    expect(result.status).toBe(mode === "dispatch_uncertain" ? "uncertain" : "refused");
    const stored = await readFinanceIntradayOutcome(directory, decision.input.signalId);
    if (mode === "dispatch_uncertain") {
      expect(stored?.executionFailure).toBeUndefined();
      expect(stored?.executionSafetyFailure?.attempt?.disposition).toBe("outcome_unresolved");
      expect(stored?.reasons).toEqual(["execution_outcome_unresolved"]);
    } else if (mode === "model_deadline") {
      expect(stored?.executionFailure).toBeUndefined();
      expect(stored?.tradeDecisionReview).toMatchObject({
        status: "failed",
        failureCode: "runtime_timeout",
      });
      expect(stored?.reasons).toEqual(["fixture shared gate refusal"]);
      expect(runOrder).toHaveBeenCalledTimes(1);
    } else {
      expect(stored?.reasons).toEqual([
        mode.endsWith("review")
          ? "intraday decision was cancelled before execution"
          : "intraday_execution_unexpected_error",
      ]);
      expect(stored?.executionFailure).toMatchObject({
        stage:
          mode === "pre_aborted"
            ? "safety_claims"
            : mode === "deadline_refresh"
              ? "refresh_quote"
              : mode.endsWith("review")
                ? "model_review"
                : mode.endsWith("quote")
                  ? "initial_quote"
                  : "account_book",
        category:
          mode === "provider_error"
            ? "unexpected"
            : mode.startsWith("caller") || mode === "pre_aborted" || mode === "late_rejection"
              ? "cancelled"
              : "deadline_exceeded",
        elapsedMs: expect.any(Number),
      });
      expect(runOrder).not.toHaveBeenCalled();
    }
    expect(JSON.stringify(stored)).not.toContain("private");
    expect(JSON.stringify(stored)).not.toContain("secret-response");
    if (mode === "pre_aborted") {
      expect(accountBookProvider).not.toHaveBeenCalled();
      expect(executionQuoteProvider).not.toHaveBeenCalled();
    }
    if (combinedSignal) {
      expect(combinedSignal).not.toBe(caller.signal);
      expect(combinedSignal.aborted).toBe(true);
      if (mode !== "caller_review" && mode !== "model_deadline") {
        expect(listenerWasRemoved()).toBe(true);
      }
      if (mode === "late_rejection") {
        fail(new Error("private late rejected provider"));
      } else {
        finish();
      }
      await Promise.resolve();
      await Promise.resolve();
      expect(runOrder).toHaveBeenCalledTimes(mode === "model_deadline" ? 1 : 0);
      expect(await readFinanceIntradayOutcome(directory, decision.input.signalId)).toEqual(stored);
    }
  });

  // Native WBD measured only the total and dispatch timestamps; phase durations below
  // are a representative controlled decomposition, not observed native phase latencies.
  it.each([
    "caller",
    "default",
    "stalled_stage",
    "stalled_refresh",
    "late_veto",
    "ignored_review",
  ] as const)(
    "preserves caller budgets and bounds physical preparation timers (%s)",
    async (mode) => {
      const withCaller = mode !== "default";
      const reviewMarginCase = mode === "late_veto" || mode === "ignored_review";
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "intraday-wbd-timing-"));
      temporary.push(directory);
      const strategyBinding = await activeRuleBinding(directory);
      const started = Date.parse("2026-09-18T15:08:42.350Z");
      strategyBinding.marketSession = {
        ...strategyBinding.marketSession!,
        observedAt: new Date(started).toISOString(),
      };
      const decision = (
        await appendFinanceIntradayDecision(directory, {
          signalId: `wbd-timing-${mode}`,
          instrument: "SPY",
          sessionDate: "2026-09-18",
          action: "buy",
          reason: "opening_range_breakout",
          referencePrice: 100,
          referencePriceAt: new Date(started).toISOString(),
          stopPrice: 99,
          targetPrice: 102,
          datasetHeadRef: "c".repeat(64),
          strategyRule: FINANCE_INTRADAY_OPENING_RANGE_RULE,
          strategyBinding,
        })
      ).record;
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
      vi.setSystemTime(started);
      const deadlines: number[] = [];
      vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
        deadlines.push(ms);
        const deadline = new AbortController();
        setTimeout(
          () => deadline.abort(new DOMException("fixture stage timeout", "TimeoutError")),
          ms,
        );
        return deadline.signal;
      });
      const caller = new AbortController();
      const accountBookProvider = vi.fn(async (signal: AbortSignal) => {
        expect(signal).not.toBe(caller.signal);
        await vi.advanceTimersByTimeAsync(
          mode === "stalled_stage" ? 120_001 : reviewMarginCase ? 0 : 80_000,
        );
        return {
          accountId: "paper-account",
          venue: "alpaca:paper" as const,
          observedAt: new Date(Date.now()).toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          equity: 100_000,
          positions: [],
        };
      });
      const executionQuoteProvider = vi.fn(async (_request: unknown, signal: AbortSignal) => {
        expect(signal).not.toBe(caller.signal);
        await vi.advanceTimersByTimeAsync(reviewMarginCase ? 0 : 8_000);
        return {
          referencePrice: 100,
          bidPrice: 99.9,
          askPrice: 100,
          referencePriceAt: new Date(Date.now()).toISOString(),
          sourceUrlOrArtifact: "fixture://quote",
          maxAgeMs: 30_000,
        };
      });
      const prepareExecutionQuote = vi.fn(async (_request: unknown, signal: AbortSignal) => {
        expect(signal).not.toBe(caller.signal);
        if (mode === "stalled_refresh") {
          await vi.advanceTimersByTimeAsync(15_000);
        }
        return {
          referencePrice: 100,
          bidPrice: 99.9,
          askPrice: 100,
          referencePriceAt: new Date(Date.now()).toISOString(),
          sourceUrlOrArtifact: "fixture://quote",
          maxAgeMs: 30_000,
        };
      });
      const reviewer: FinanceTradeDecisionReviewer = async (request, signal) => {
        expect(signal).not.toBe(caller.signal);
        await vi.advanceTimersByTimeAsync(
          mode === "late_veto" ? 61_000 : mode === "ignored_review" ? 66_000 : 45_789,
        );
        if (reviewMarginCase) {
          expect(signal.aborted).toBe(true); // Provider cancellation still happens at 60 seconds.
        }
        const approved = {
          ...(await approvingReviewer()(request)),
          latencyMs: mode === "late_veto" ? 61_000 : mode === "ignored_review" ? 66_000 : 45_789,
          ...(mode === "stalled_refresh"
            ? { quoteApprovalPolicy: FINANCE_INTRADAY_QUOTE_APPROVAL_POLICY }
            : {}),
        };
        return mode === "late_veto"
          ? {
              ...approved,
              decisions: [
                {
                  candidateId: request.candidates[0].candidateId,
                  decision: "veto" as const,
                  rationale: "fixture late veto",
                },
              ],
            }
          : approved;
      };
      let dispatchAt: number | undefined;
      const runOrder = vi.fn(async (request: Parameters<typeof runFinanceAlpacaOrder>[0]) => {
        dispatchAt = Date.now();
        expect(request.signal).toBe(caller.signal);
        await vi.advanceTimersByTimeAsync(reviewMarginCase ? 0 : 7_945);
        return { ok: false as const, refusals: ["fixture shared execution gate refusal"] };
      });
      const result = await executeFinanceIntradayDecision({
        directory,
        decision,
        controller: {
          accountId: "paper-account",
          accountBookProvider,
          executionQuoteProvider,
          prepareExecutionQuote,
          createSafetyContext: vi.fn(),
        },
        caps: { maxOrderNotional: 5_000, maxInstrumentNotional: 10_000, maxOrdersPerRun: 1 },
        tradeDecisionReviewer: reviewer,
        ...(withCaller ? { signal: caller.signal } : {}),
        now: Date.now,
        runOrder: runOrder as never,
      });
      if (mode === "stalled_stage") {
        expect(runOrder).not.toHaveBeenCalled();
        expect(executionQuoteProvider).not.toHaveBeenCalled();
        expect(caller.signal.aborted).toBe(false);
        expect(result.outcome.executionFailure).toMatchObject({
          stage: "account_book",
          category: "deadline_exceeded",
        });
        expect(result.outcome.executionFailure!.elapsedMs).toBeGreaterThanOrEqual(120_000);
        expect(result.outcome.reasons).toEqual(["intraday_execution_unexpected_error"]);
      } else if (mode === "stalled_refresh") {
        expect(runOrder).not.toHaveBeenCalled();
        expect(caller.signal.aborted).toBe(false);
        expect(result.outcome.executionFailure).toMatchObject({
          stage: "refresh_quote",
          category: "deadline_exceeded",
        });
        expect(deadlines).toContain(60_000 - 45_789);
      } else if (mode === "late_veto") {
        expect(runOrder).not.toHaveBeenCalled();
        expect(result.outcome.tradeDecisionReview).toMatchObject({
          status: "completed",
          latencyMs: 61_000,
          decision: { decision: "veto" },
        });
        expect(result.outcome.reasons).toEqual(["intraday model veto: fixture late veto"]);
      } else if (mode === "ignored_review") {
        expect(runOrder).toHaveBeenCalledTimes(1);
        expect(result.outcome.tradeDecisionReview).toMatchObject({
          status: "failed",
          failureCode: "runtime_timeout",
          latencyMs: 65_000,
        });
        expect(result.outcome.reasons).toEqual(["fixture shared execution gate refusal"]);
        await Promise.resolve();
        expect(runOrder).toHaveBeenCalledTimes(1);
      } else if (withCaller) {
        expect(runOrder).toHaveBeenCalledTimes(1);
        expect(dispatchAt! - started).toBe(133_789);
        expect(Date.now() - started).toBe(141_734);
        expect(result.outcome.reasons).toEqual(["fixture shared execution gate refusal"]);
        expect(caller.signal.aborted).toBe(false);
        expect(result.outcome.executionFailure).toBeUndefined();
      } else {
        expect(runOrder).not.toHaveBeenCalled();
        expect(result.outcome.executionFailure).toMatchObject({
          stage: "model_review",
          category: "deadline_exceeded",
        });
        expect(result.outcome.reasons).toEqual([
          "intraday decision was cancelled before execution",
        ]);
      }
      expect(deadlines).toContain(120_000);
      if (mode !== "stalled_stage") {
        expect(deadlines).toContain(60_000);
        expect(deadlines).toContain(65_000);
      }
    },
  );

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

    const recoveryCancellation = new AbortController();
    recoveryCancellation.abort();
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
      signal: recoveryCancellation.signal,
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
          reconciliation: {
            status: "ready" as const,
            historyStatus: "reconciled" as const,
            uncertaintyReserve: 0,
            quarantinedInstruments: [],
            reasons: [],
          },
          executionCapacity: {
            source: "controller_account_safety_facts" as const,
            accountId: "paper-account",
            venue: "alpaca:paper" as const,
            observedAt: "2026-09-18T15:00:01.000Z",
            expiresAt: "2026-09-18T15:01:01.000Z",
            policyPlanId: "capacity-test",
            policyRevision: "current",
            grossExposure: 20_000,
            maxGrossExposure: 10_000,
            uncertaintyReserve: 0,
          },
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
      const callProof = [
        {
          attempt: 1 as const,
          callId: "fixture-truncated-call",
          payloadSha256: "a".repeat(64),
          resultKind: "output_truncated" as const,
          attestation: { status: "unattested" as const },
        },
        {
          attempt: 2 as const,
          callId: "fixture-direct-retry",
          payloadSha256: "a".repeat(64),
          outputSha256: "b".repeat(64),
          resultKind: "decision" as const,
          attestation: { status: "unattested" as const },
        },
      ];
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
        const approved = await approvingReviewer()(request);
        return mode === "fresh"
          ? {
              ...approved,
              modelCalls: 2,
              modelCallEvidence: callProof,
              providerCallObserved: false,
              adapterAttested: false,
            }
          : approved;
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
      if (mode === "fresh" || mode === "prepared_same") {
        const stored = await readFinanceIntradayOutcome(directory, decision.input.signalId);
        expect(stored?.tradeDecisionReview?.modelCallEvidence).toEqual(
          mode === "fresh" ? callProof : undefined,
        );
        // A synthetic truncation retry stays unattested and is not a tool loop; old receipts stay compatible.
        expect(stored?.tradeDecisionReview?.decision?.decision).toBe("approve");
      }
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

  it.each([
    { mode: "approve", calls: 2, gate: true },
    { mode: "first_used_two", calls: 1, gate: false },
    { mode: "first_refresh_deadline", calls: 1, gate: false },
    { mode: "veto", calls: 2, gate: false },
    { mode: "failed", calls: 2, gate: false },
    { mode: "wrong_candidate", calls: 2, gate: false },
    { mode: "second_drift", calls: 2, gate: false },
    { mode: "resize", calls: 1, gate: false },
    { mode: "inside_resize", calls: 1, gate: false },
    { mode: "deadline", calls: 2, gate: false },
    { mode: "post_refresh_deadline", calls: 2, gate: false },
    { mode: "calendar_deadline", calls: 2, gate: false },
    { mode: "cancel", calls: 2, gate: false },
    { mode: "over_budget", calls: 2, gate: false },
  ])("bounds quote re-review on the original candidate ($mode)", async ({ mode, calls, gate }) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "intraday-rereview-"));
    temporary.push(directory);
    const strategyBinding = await activeRuleBinding(directory);
    const decision = (
      await appendFinanceIntradayDecision(directory, {
        signalId: `rereview-${mode}`,
        instrument: "SPY",
        sessionDate: "2026-09-18",
        action: "buy",
        reason: "opening_range_breakout",
        referencePrice: 500,
        referencePriceAt: "2026-09-18T15:00:00.000Z",
        stopPrice: 498,
        targetPrice: 504,
        datasetHeadRef: "a".repeat(64),
        strategyRule: FINANCE_INTRADAY_OPENING_RANGE_RULE,
        strategyBinding,
      })
    ).record;
    let clock = Date.parse("2026-09-18T15:00:02.000Z");
    const abort = new AbortController();
    const quoteProvider = vi.fn(async () => {
      const n = quoteProvider.mock.calls.length;
      if (mode === "first_refresh_deadline" && n === 2) {
        clock += 60_000;
      }
      if (mode === "post_refresh_deadline" && n === 3) {
        clock += 60_000;
      }
      const ask =
        n === 1
          ? 501
          : mode === "resize" || mode === "inside_resize"
            ? 499
            : mode === "second_drift" && n === 3
              ? 502
              : 501.2;
      return {
        referencePrice: ask,
        bidPrice: mode === "inside_resize" ? (n === 1 ? 490 : 499) : ask - 2,
        askPrice: ask,
        referencePriceAt: new Date(clock).toISOString(),
        sourceUrlOrArtifact: "fixture://quote",
        feed: "iex",
        priceBasis: "ask" as const,
        maxAgeMs: 30_000,
      };
    });
    let reviewerCalls = 0;
    const reviewer = vi.fn<FinanceTradeDecisionReviewer>(async (request, _signal, options) => {
      const second = ++reviewerCalls === 2;
      expect(options?.maxModelCalls).toBe(second ? 1 : 2);
      clock += second && mode === "deadline" ? 60_000 : 1_000;
      if (second && mode === "cancel") {
        abort.abort();
      }
      if (second && mode === "failed") {
        return {
          status: "failed",
          attempted: true,
          provider: "fixture-provider",
          modelId: "fixture-model",
          latencyMs: 5,
          providerCallObserved: false,
          adapterAttested: false,
          failureCode: "process_error",
          modelCalls: 1,
        };
      }
      const result = await approvingReviewer()(request);
      return {
        ...result,
        quoteApprovalPolicy: FINANCE_INTRADAY_QUOTE_APPROVAL_POLICY,
        modelCalls: mode === "first_used_two" || (second && mode === "over_budget") ? 2 : 1,
        decisions: [
          {
            ...result.decisions[0],
            candidateId:
              second && mode === "wrong_candidate" ? "other" : request.candidates[0].candidateId,
            decision: second && mode === "veto" ? "veto" : "approve",
          },
        ],
      };
    });
    const runOrder = vi.fn(async () => ({
      ok: false as const,
      stage: "place" as const,
      refusals: ["fixture shared gate refuses"],
    }));
    if (mode === "calendar_deadline") {
      const originalRead = strategyRules.readFinanceStrategyRuleLedger;
      vi.spyOn(strategyRules, "readFinanceStrategyRuleLedger").mockImplementation(
        async (...args) => {
          const value = await originalRead(...args);
          if (reviewerCalls === 2 && quoteProvider.mock.calls.length >= 3) {
            clock += 60_000;
          }
          return value;
        },
      );
    }
    const params = {
      directory,
      decision,
      controller: {
        accountId: "paper-account",
        accountBookProvider: async () => ({
          accountId: "paper-account",
          venue: "alpaca:paper" as const,
          observedAt: "2026-09-18T15:00:01.000Z",
          expiresAt: "2026-09-18T15:02:00.000Z",
          equity: 100_000,
          positions: [],
        }),
        executionQuoteProvider: quoteProvider,
        prepareExecutionQuote: quoteProvider,
        createSafetyContext: vi.fn(),
      },
      caps: { maxOrderNotional: 1000, maxInstrumentNotional: 5000, maxOrdersPerRun: 1 },
      tradeDecisionReviewer: reviewer,
      now: () => clock,
      signal: abort.signal,
      runOrder,
    };
    const result = await executeFinanceIntradayDecision(params);
    expect(result.status).toBe("refused");
    expect(
      "tradeDecisionReviewHistory" in result ? (result.tradeDecisionReviewHistory?.length ?? 0) : 0,
    ).toBe(calls === 2 ? 1 : 0);
    expect(reviewer).toHaveBeenCalledTimes(calls);
    expect(runOrder).toHaveBeenCalledTimes(gate ? 1 : 0);
    const stored = await readFinanceIntradayOutcome(directory, decision.input.signalId);
    expect(stored?.tradeDecisionReviewHistory?.length ?? 0).toBe(calls === 2 ? 1 : 0);
    if (mode === "first_refresh_deadline") {
      expect(stored?.executionFailure).toMatchObject({
        stage: "refresh_quote",
        category: "deadline_exceeded",
      });
    }
    if (mode === "first_used_two") {
      expect(stored?.reasons).toEqual([
        "intraday quote re-review refused: original candidate model-call budget exhausted",
      ]);
    }
    if (calls === 2) {
      const first = stored!.tradeDecisionReviewHistory![0];
      const last = stored!.tradeDecisionReview!;
      expect(first.request.candidates[0].plannedQuantity).toBe(
        last.request.candidates[0].plannedQuantity,
      );
      expect(first.request.candidates[0].candidateId).toBe(last.request.candidates[0].candidateId);
      expect(first.request.candidates[0].stopPrice).toBe(last.request.candidates[0].stopPrice);
      expect(first.executionQuoteValidation?.status).toBe("refused");
      expect(last.request.candidates[0].executionQuote.askPrice).toBe(501.2);
      if (gate) {
        expect(last.executionQuoteValidation?.status).toBe("unchanged");
      }
    }
    expect((await executeFinanceIntradayDecision(params)).status).toBe("already_terminal");
    expect(reviewer).toHaveBeenCalledTimes(calls);
    expect(runOrder).toHaveBeenCalledTimes(gate ? 1 : 0);
  });

  it.each([
    { name: "same prices, newer observation", bid: 499, ask: 501, reachesGate: true },
    {
      name: "first review calendar within original deadline",
      bid: 499,
      ask: 501,
      calendarDelayMs: 24_999,
      reachesGate: true,
    },
    {
      name: "first review calendar crosses original deadline",
      bid: 499,
      ask: 501,
      calendarDelayMs: 25_000,
      reachesGate: false,
    },
    {
      name: "legacy approval keeps its original calendar budget",
      bid: 499,
      ask: 501,
      calendarDelayMs: 25_000,
      legacy: true,
      reachesGate: true,
    },
    { name: "both sides improve", bid: 499.2, ask: 500.8, reachesGate: true },
    { name: "ask only improves", bid: 499, ask: 500.8, reachesGate: true },
    { name: "bid only improves", bid: 499.2, ask: 501, reachesGate: true },
    {
      name: "provider fallback also binds",
      bid: 499.2,
      ask: 500.8,
      fallback: true,
      reachesGate: true,
    },
    {
      name: "legacy approval stays exact",
      bid: 499.2,
      ask: 500.8,
      legacy: true,
      reachesGate: false,
    },
    {
      name: "fallback legacy approval stays exact",
      bid: 499.2,
      ask: 500.8,
      legacy: true,
      fallback: true,
      reachesGate: false,
    },
    { name: "ask worsens by any amount", bid: 499.2, ask: 501.000001, reachesGate: false },
    { name: "bid worsens by any amount", bid: 498.999999, ask: 500.8, reachesGate: false },
    { name: "upward shift is outside reviewed range", bid: 499.2, ask: 501.2, reachesGate: false },
    {
      name: "downward shift is outside reviewed range",
      bid: 498.8,
      ask: 500.8,
      reachesGate: false,
    },
    { name: "crossed quote", bid: 501, ask: 500.8, reachesGate: false },
    { name: "missing bid", bid: undefined, ask: 500.8, reachesGate: false },
    { name: "missing ask", bid: 499.2, ask: undefined, reachesGate: false },
    {
      name: "different source",
      bid: 499.2,
      ask: 500.8,
      source: "fixture://other",
      reachesGate: false,
    },
    { name: "different feed", bid: 499.2, ask: 500.8, feed: "sip", reachesGate: false },
    { name: "different basis", bid: 499.2, ask: 500.8, basis: "bid" as const, reachesGate: false },
    {
      name: "expanded freshness allowance",
      bid: 499.2,
      ask: 500.8,
      maxAge: 60_000,
      reachesGate: false,
    },
    {
      name: "future quote",
      bid: 499.2,
      ask: 500.8,
      time: "2026-09-18T15:00:38.000Z",
      reachesGate: false,
    },
    {
      name: "stale quote",
      bid: 499.2,
      ask: 500.8,
      time: "2026-09-18T15:00:01.000Z",
      reachesGate: false,
    },
    {
      name: "fresh timestamp rolls backward",
      bid: 499.2,
      ask: 500.8,
      shortReview: true,
      time: "2026-09-18T15:00:00.000Z",
      reachesGate: false,
    },
    {
      name: "improvement crosses stop",
      bid: 497,
      ask: 497.5,
      wideInitial: true,
      reachesGate: false,
    },
  ])(
    "revalidates explicit quote approval without relaxing the shared gate ($name)",
    async (fixture) => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "intraday-quote-scope-"));
      temporary.push(directory);
      const strategyBinding = await activeRuleBinding(directory);
      const decision = (
        await appendFinanceIntradayDecision(directory, {
          signalId: `quote-scope-${fixture.name}`,
          instrument: "SPY",
          sessionDate: "2026-09-18",
          action: "buy",
          reason: "opening_range_breakout",
          referencePrice: 500,
          referencePriceAt: "2026-09-18T15:00:00.000Z",
          stopPrice: 498,
          targetPrice: 504,
          datasetHeadRef: "a".repeat(64),
          strategyRule: FINANCE_INTRADAY_OPENING_RANGE_RULE,
          strategyBinding,
        })
      ).record;
      let clock = Date.parse("2026-09-18T15:00:02.000Z");
      const firstQuote = {
        referencePrice: 501,
        bidPrice: fixture.wideInitial ? 496 : 499,
        askPrice: 501,
        referencePriceAt: "2026-09-18T15:00:01.000Z",
        sourceUrlOrArtifact: "fixture://quote",
        feed: "iex",
        priceBasis: "ask" as const,
        maxAgeMs: 30_000,
      };
      const finalQuote = () => ({
        referencePrice: fixture.ask ?? 500.8,
        bidPrice: fixture.bid,
        askPrice: fixture.ask,
        referencePriceAt: fixture.time ?? new Date(clock).toISOString(),
        sourceUrlOrArtifact: fixture.source ?? firstQuote.sourceUrlOrArtifact,
        feed: fixture.feed ?? firstQuote.feed,
        priceBasis: fixture.basis ?? firstQuote.priceBasis,
        maxAgeMs: fixture.maxAge ?? firstQuote.maxAgeMs,
      });
      let refreshedQuoteAt: string | undefined;
      const quoteProvider = vi
        .fn()
        .mockResolvedValueOnce(firstQuote)
        .mockImplementation(async () => {
          const refreshed = finalQuote();
          refreshedQuoteAt = refreshed.referencePriceAt;
          return refreshed;
        });
      const reviewer = vi.fn(async (request: FinanceTradeDecisionReviewRequest) => {
        clock += fixture.shortReview ? 1_000 : 35_000;
        return {
          ...(await approvingReviewer()(request)),
          ...(fixture.legacy
            ? {}
            : { quoteApprovalPolicy: FINANCE_INTRADAY_QUOTE_APPROVAL_POLICY }),
        };
      });
      const runOrder = vi.fn(async () => ({
        ok: false as const,
        stage: "place" as const,
        refusals: ["fixture final fresh-account gate refuses"],
      }));
      if (fixture.calendarDelayMs !== undefined) {
        const originalRead = strategyRules.readFinanceStrategyRuleLedger;
        let delayed = false;
        vi.spyOn(strategyRules, "readFinanceStrategyRuleLedger").mockImplementation(
          async (...args) => {
            const records = await originalRead(...args);
            if (
              !delayed &&
              reviewer.mock.calls.length > 0 &&
              quoteProvider.mock.calls.length >= 2
            ) {
              delayed = true;
              clock += fixture.calendarDelayMs;
            }
            return records;
          },
        );
      }
      const result = await executeFinanceIntradayDecision({
        directory,
        decision,
        controller: {
          accountId: "paper-account",
          accountBookProvider: async () => ({
            accountId: "paper-account",
            venue: "alpaca:paper",
            observedAt: "2026-09-18T15:00:01.000Z",
            expiresAt: "2026-09-18T15:02:00.000Z",
            equity: 100_000,
            positions: [],
          }),
          executionQuoteProvider: quoteProvider,
          ...(fixture.fallback ? {} : { prepareExecutionQuote: quoteProvider }),
          createSafetyContext: vi.fn(),
        },
        caps: { maxOrderNotional: 1000, maxInstrumentNotional: 5000, maxOrdersPerRun: 1 },
        tradeDecisionReviewer: reviewer,
        now: () => clock,
        runOrder,
      });
      expect(result.status).toBe("refused");
      const reviewCount = [
        "ask worsens by any amount",
        "bid worsens by any amount",
        "upward shift is outside reviewed range",
        "downward shift is outside reviewed range",
      ].includes(fixture.name)
        ? 2
        : 1;
      expect(reviewer).toHaveBeenCalledTimes(reviewCount);
      expect(quoteProvider).toHaveBeenCalledTimes(2);
      expect(runOrder).toHaveBeenCalledTimes(fixture.reachesGate ? 1 : 0);
      const stored = await readFinanceIntradayOutcome(directory, decision.input.signalId);
      expect(stored?.tradeDecisionReview?.quoteApprovalPolicy).toBe(
        fixture.legacy ? undefined : FINANCE_INTRADAY_QUOTE_APPROVAL_POLICY,
      );
      if (fixture.name === "first review calendar crosses original deadline") {
        expect(stored?.executionFailure).toMatchObject({
          stage: "final_strategy_binding",
          category: "deadline_exceeded",
        });
      }
      if (fixture.calendarDelayMs !== undefined && fixture.reachesGate) {
        expect(stored?.executionFailure).toBeUndefined();
      }
      if (fixture.reachesGate) {
        expect(runOrder).toHaveBeenCalledWith(
          expect.objectContaining({
            market: {
              referencePrice: fixture.ask,
              referencePriceAt: refreshedQuoteAt,
            },
          }),
        );
        expect(stored?.reasons).toEqual(["fixture final fresh-account gate refuses"]);
        expect(stored?.tradeDecisionReview?.executionQuoteValidation).toMatchObject({
          status:
            fixture.bid === firstQuote.bidPrice && fixture.ask === firstQuote.askPrice
              ? "unchanged"
              : "inside_reviewed_bid_ask",
          policy: fixture.legacy ? "exact" : FINANCE_INTRADAY_QUOTE_APPROVAL_POLICY,
          quote: { bidPrice: fixture.bid, askPrice: fixture.ask },
        });
      }
      if (
        ["crossed quote", "missing bid", "missing ask", "future quote", "stale quote"].includes(
          fixture.name,
        )
      ) {
        expect(stored?.reasons).toEqual([
          expect.stringContaining("intraday execution quote refused:"),
        ]);
        expect(stored?.reasons.join()).not.toContain("unexpected_error");
        expect(stored?.tradeDecisionReview?.status).toBe("completed");
        expect(stored?.tradeDecisionReview?.executionQuoteValidation).toBeUndefined();
      }
      if (fixture.name === "improvement crosses stop") {
        expect(stored?.reasons.join()).toContain("stop price");
        expect(stored?.tradeDecisionReview?.executionQuoteValidation?.status).toBe(
          "inside_reviewed_bid_ask",
        );
      }
      // Final gate refusal is terminal and cannot spend another review or submit again.
      const repeat = await executeFinanceIntradayDecision({
        directory,
        decision,
        controller: {
          accountId: "paper-account",
          accountBookProvider: vi.fn(),
          executionQuoteProvider: quoteProvider,
          createSafetyContext: vi.fn(),
        },
        caps: { maxOrderNotional: 1000, maxInstrumentNotional: 5000, maxOrdersPerRun: 1 },
        tradeDecisionReviewer: reviewer,
        now: () => clock,
        runOrder,
      });
      expect(repeat.status).toBe("already_terminal");
      expect(reviewer).toHaveBeenCalledTimes(reviewCount);
      expect(runOrder).toHaveBeenCalledTimes(fixture.reachesGate ? 1 : 0);
    },
  );

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
