import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  account: vi.fn(),
  cycle: vi.fn(),
  backfill: vi.fn(),
  reconcile: vi.fn(),
  ruleReadiness: vi.fn(),
  eodRefresh: vi.fn(),
  universe: vi.fn(),
  positionLedger: vi.fn(),
}));
vi.mock("./finance-alpaca-history-sync.js", () => ({
  syncConfiguredAlpacaPaperHistory: vi.fn(() => {
    throw new Error("unexpected history provider");
  }),
}));
vi.mock("./finance-alpaca-run.js", () => ({ fetchAlpacaAccountSnapshot: mocks.account }));
vi.mock("./finance-alpaca-history-reconciliation.js", () => ({
  reconcileFinanceBrokerHistory: mocks.reconcile,
}));
vi.mock("./finance-daily-cycle.js", () => ({
  refreshFinanceEodBarsAndMarks: mocks.eodRefresh,
  runFinanceDailyCycle: mocks.cycle,
}));
vi.mock("./finance-link-health.js", () => ({ readFinanceLinkHealth: vi.fn() }));
vi.mock("./finance-outcome-backfill.js", () => ({ backfillOutcomes: mocks.backfill }));
vi.mock("./finance-reflection.js", () => ({ buildReflection: vi.fn() }));
vi.mock("./finance-rule-readiness-state.js", () => ({
  readFinanceRuleReadinessState: mocks.ruleReadiness,
  financeRuleReadinessSection: (state: { readiness: unknown }) => ({
    readiness: state.readiness,
  }),
}));
vi.mock("./finance-research-runner.js", () => ({
  readFinanceResearchEquityUniverseSnapshot: mocks.universe,
}));
vi.mock("./finance-position-ledger.js", () => ({
  readFinancePositionLedger: mocks.positionLedger,
}));
vi.mock("./finance-scoped-override.js", () => ({
  resolveScopedOverride: vi.fn(async () => ({ value: 8 })),
}));
vi.mock("./finance-state-dir.js", () => ({
  FINANCE_RESEARCH_SAMPLES_FILENAME: "samples.jsonl",
  FINANCE_RESEARCH_SCORED_FILENAME: "scored.jsonl",
  resolveFinanceStateDir: () => {
    throw new Error("unexpected global root");
  },
}));
vi.mock("./finance-strategy-rule-ledger.js", () => ({
  readFinanceStrategyRuleLedger: vi.fn(async () => ({
    ledger: {
      rules: [
        {
          state: "active",
          instruments: ["AAPL"],
          ruleId: "fixture",
          form: "cross_asset_trend",
          formVersion: "1",
          emits: "target_weights",
          schedule: { kind: "monthly", at: "last_trading_day", timezone: "America/New_York" },
          body: { frozenRule: { lookbackMonths: 12 } },
        },
        { state: "draft", instruments: ["DRAFT"], ruleId: "draft" },
        { state: "retired", instruments: ["RETIRED"], ruleId: "retired" },
        {
          state: "active",
          instruments: ["AAPL"],
          ruleId: "intraday",
          form: "opening_range",
          formVersion: "1",
          emits: "trade_signals",
          schedule: { kind: "intraday", timezone: "America/New_York" },
          body: {},
        },
      ],
    },
  })),
}));
import { runFinanceDailyCycleOperator } from "../../scripts/operator/lcx-finance-daily-cycle.js";
import {
  FINANCE_TRADE_DECISION_REVIEW_SCHEMA,
  type FinanceTradeDecisionReviewer,
} from "./finance-trade-decision-review.js";
const args = [
  "--json",
  "--dir",
  "/synthetic/finance",
  "--place",
  "--venue",
  "alpaca",
  "--execution-quote-feed",
  "iex",
  "--execution-max-age-ms",
  "1000",
];
const account = { equity: 2000, status: "ACTIVE", tradingBlocked: false };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.universe.mockReturnValue({
    schemaVersion: "lcx_finance_universe_selection_v1",
    asOf: "2026-09-24T20:00:00.000Z",
    generatedAt: "2026-09-24T20:15:00.000Z",
    sources: {},
    freshnessBasis: "latest_completed_weekday_16_00_et_without_holiday_calendar",
    selected: ["MSFT", "NVDA"],
    screenLimit: 120,
    candidateCount: 100,
    screenedCount: 50,
    eligibleCount: 12,
    assetCount: 100,
    unreadableCount: 0,
    selectedMetrics: [],
    thresholds: {},
    liquidityPreScreen: {
      basis: "latest_completed_regular_session",
      source: "alpaca_snapshot.dailyBar_or_prevDailyBar.close_times_volume",
      sessionDate: "2026-09-24",
    },
    selectionEvidence: {
      method: "liquidity_seed_then_iterative_minimum_worst_correlation",
      maxCorrelation: 0.85,
      selected: [],
      excluded: [],
    },
    rejected: [],
  });
  mocks.cycle.mockResolvedValue({ ok: true });
  mocks.positionLedger.mockResolvedValue({
    ledger: {
      positions: [
        { instrument: "AAPL", quantity: 1 },
        { instrument: "BTC/USD", quantity: 0.01 },
      ],
    },
  });
  mocks.reconcile.mockResolvedValue({ historyStatus: "reconciled" });
  mocks.ruleReadiness.mockResolvedValue({
    thresholdsDeclared: true,
    thresholdsError: null,
    readiness: {
      declaredThresholds: { minObservations: 3 },
      rules: [
        {
          ruleId: "fixture",
          ready: true,
          durationMet: true,
          observationCount: 3,
          barConflicts: [],
        },
      ],
    },
  });
  mocks.eodRefresh.mockResolvedValue({
    barsFiled: [],
    marksFiled: [],
    unpricedHoldings: [],
    dataIssues: [],
  });
});
describe("account gate before unattended placement", () => {
  it.each([{ extra: [] }, { extra: ["--equity-from-venue"] }, { extra: ["--equity", "500000"] }])(
    "blocks failed verification with %j",
    async ({ extra }) => {
      mocks.account.mockResolvedValue({ ok: false, reason: "synthetic unavailable" });
      const result = await runFinanceDailyCycleOperator([...args, ...extra]);
      expect(result.ok).toBe(false);
      expect(result.equitySource).toBe("venue-failed");
      expect(mocks.cycle).not.toHaveBeenCalled();
    },
  );
  it.each([{ tradingBlocked: true }, { status: "UNKNOWN" }, { equity: 0 }, { equity: Number.NaN }])(
    "blocks unusable account %j",
    async (change) => {
      mocks.account.mockResolvedValue({ ok: true, account: { ...account, ...change } });
      expect((await runFinanceDailyCycleOperator(args)).ok).toBe(false);
      expect(mocks.cycle).not.toHaveBeenCalled();
    },
  );
  it("uses verified venue equity when requested", async () => {
    mocks.account.mockResolvedValue({ ok: true, account });
    await runFinanceDailyCycleOperator([...args, "--equity-from-venue"]);
    expect(mocks.cycle).toHaveBeenCalledWith(
      expect.objectContaining({ equity: 2000, place: true }),
    );
  });
  it("binds the active daily method and all execution seams to the validated dynamic universe", async () => {
    mocks.account.mockResolvedValue({ ok: true, account });
    const result = await runFinanceDailyCycleOperator(args);
    expect(result).toMatchObject({
      strategyUniverse: {
        source: "finance-universe-selection-latest.json",
        selected: ["MSFT", "NVDA"],
        selectedCount: 2,
      },
    });
    expect(mocks.ruleReadiness).toHaveBeenCalledWith(
      expect.objectContaining({
        rules: [expect.objectContaining({ ruleId: "fixture", instruments: ["MSFT", "NVDA"] })],
      }),
    );
    expect(mocks.cycle).toHaveBeenCalledWith(
      expect.objectContaining({ instruments: ["MSFT", "NVDA"], lookbackMonths: 12 }),
    );
    expect(mocks.eodRefresh).toHaveBeenCalledWith(
      expect.objectContaining({
        directory: "/synthetic/finance",
        instruments: ["AAPL", "MSFT", "NVDA"],
      }),
    );
  });
  it("fails closed before provider sync or cycle work when the selector snapshot is missing or stale", async () => {
    mocks.universe.mockImplementationOnce(() => {
      throw new Error("equity universe snapshot not found");
    });
    const syncHistory = vi.fn();
    const result = await runFinanceDailyCycleOperator([...args, "--sync-alpaca-history"], {
      syncHistory,
    });
    expect(result).toMatchObject({ ok: false, failureKind: "universe_selection_gate" });
    expect(result.error).toContain("snapshot not found");
    expect(syncHistory).not.toHaveBeenCalled();
    expect(mocks.account).not.toHaveBeenCalled();
    expect(mocks.cycle).not.toHaveBeenCalled();
  });
  it("does not revive the ledger tickers when a valid selection is empty", async () => {
    mocks.universe.mockReturnValueOnce({
      ...mocks.universe(),
      selected: [],
    });
    const result = await runFinanceDailyCycleOperator(args);
    expect(result).toMatchObject({ ok: false, failureKind: "universe_selection_gate" });
    expect(result.error).toContain("no strategy fallback");
    expect(mocks.account).not.toHaveBeenCalled();
    expect(mocks.cycle).not.toHaveBeenCalled();
  });
  it.each([
    { monthly: 0.3, intraday: 0.2, executes: true },
    { monthly: 0.3, intraday: 0, executes: true },
    { monthly: 0, intraday: 0.2, executes: false },
  ])(
    "routes controller budgets to their declared executor: %j",
    async ({ monthly, intraday, executes }) => {
      const fs = await import("node:fs/promises");
      const os = await import("node:os");
      const path = await import("node:path");
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "daily-budget-routing-"));
      try {
        const filename = path.join(directory, "plan.json");
        const asOf = new Date().toISOString();
        await fs.writeFile(
          filename,
          JSON.stringify({
            asOf,
            validUntil: new Date(Date.now() + 60_000).toISOString(),
            venue: "paper",
            accountId: "synthetic",
            conflictPolicy: "block",
            allocations: [
              { strategyId: "fixture", budgetFraction: monthly },
              { strategyId: "intraday", budgetFraction: intraday },
            ],
            candidates: [
              {
                strategyId: "intraday",
                basis: "price_strategy",
                evidenceReceiptId: "intraday-evidence",
                targets: [{ instrument: "AAPL", weight: 0.5, stance: "accumulate" }],
              },
            ],
          }),
        );
        const result = await runFinanceDailyCycleOperator([
          "--json",
          "--dir",
          "/synthetic/finance",
          "--as-of",
          asOf,
          "--portfolio-plan",
          filename,
        ]);
        expect(result.ok).toBe(true);
        if (executes) {
          expect(mocks.cycle).toHaveBeenCalledWith(
            expect.objectContaining({
              portfolioPlan: expect.objectContaining({
                allocations: [{ strategyId: "fixture", budgetFraction: monthly }],
                candidates: [],
              }),
              trendStrategies: [expect.objectContaining({ ruleId: "fixture" })],
            }),
          );
          expect(mocks.ruleReadiness).toHaveBeenCalledWith(
            expect.objectContaining({ rules: [expect.objectContaining({ ruleId: "fixture" })] }),
          );
        } else {
          expect(result).toMatchObject({
            boundary: "portfolio_no_daily_capital_allocated",
            ordersSubmitted: 0,
          });
          expect(mocks.cycle).not.toHaveBeenCalled();
          expect(mocks.ruleReadiness).not.toHaveBeenCalled();
        }
      } finally {
        await fs.rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("rejects a research portfolio plan that escapes the selected universe", async () => {
    mocks.account.mockResolvedValue({ ok: true, account });
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "daily-universe-plan-"));
    try {
      const filename = path.join(directory, "plan.json");
      const now = Date.now();
      await fs.writeFile(
        filename,
        JSON.stringify({
          asOf: new Date(now).toISOString(),
          validUntil: new Date(now + 60_000).toISOString(),
          venue: "alpaca",
          accountId: "synthetic",
          conflictPolicy: "block",
          allocations: [{ strategyId: "fixture", budgetFraction: 1 }],
          candidates: [
            {
              strategyId: "fixture",
              basis: "price_strategy",
              evidenceReceiptId: "plan-evidence",
              targets: [{ instrument: "AAPL", weight: 0.5, stance: "neutral" }],
            },
          ],
        }),
      );
      const result = await runFinanceDailyCycleOperator([...args, "--portfolio-plan", filename]);
      expect(result).toMatchObject({ ok: false });
      expect(result.error).toContain("outside the validated selected universe: AAPL");
      expect(mocks.cycle).not.toHaveBeenCalled();
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
  it("sizes an undeclared allocation from the verified small account", async () => {
    mocks.account.mockResolvedValue({ ok: true, account });
    await runFinanceDailyCycleOperator(args);
    expect(mocks.cycle).toHaveBeenCalledWith(expect.objectContaining({ equity: 2000 }));
  });
  it("rejects a declared allocation larger than account equity", async () => {
    mocks.account.mockResolvedValue({ ok: true, account });
    const result = await runFinanceDailyCycleOperator([...args, "--equity", "3000"]);
    expect(result.ok).toBe(false);
    expect(mocks.cycle).not.toHaveBeenCalled();
  });
  it("preserves a smaller explicit strategy allocation", async () => {
    mocks.account.mockResolvedValue({ ok: true, account });
    await runFinanceDailyCycleOperator([...args, "--equity", "500"]);
    expect(mocks.cycle).toHaveBeenCalledWith(expect.objectContaining({ equity: 500 }));
  });
  it("blocks missing quote authorization before account or factory access", async () => {
    const factory = vi.fn();
    const result = await runFinanceDailyCycleOperator(
      ["--json", "--dir", "/synthetic/finance", "--place", "--venue", "alpaca"],
      { createExecutionQuoteProvider: factory },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("--execution-quote-feed");
    expect(factory).not.toHaveBeenCalled();
    expect(mocks.account).not.toHaveBeenCalled();
  });
  it("injects the explicitly authorized quote factory", async () => {
    mocks.account.mockResolvedValue({ ok: true, account });
    const provider = vi.fn();
    const factory = vi.fn(() => provider);
    await runFinanceDailyCycleOperator(args, { createExecutionQuoteProvider: factory });
    expect(factory).toHaveBeenCalledWith({ feed: "iex", maxAgeMs: 1000 });
    expect(mocks.cycle).toHaveBeenCalledWith(
      expect.objectContaining({ executionQuoteProvider: provider }),
    );
  });
  it("lazily wires the configured reviewer only for an eligible Alpaca Paper placement", async () => {
    mocks.account.mockResolvedValue({ ok: true, account });
    const reviewer = vi.fn(async () => ({
      status: "completed" as const,
      attempted: true,
      provider: "fixture-provider",
      modelId: "fixture-model",
      latencyMs: 3,
      providerCallObserved: true,
      adapterAttested: true,
      decisions: [],
    }));
    const factory = vi.fn(() => reviewer as FinanceTradeDecisionReviewer);

    await runFinanceDailyCycleOperator(args, { createTradeDecisionReviewer: factory });

    expect(factory).not.toHaveBeenCalled();
    const cycleParams = mocks.cycle.mock.calls[0]?.[0];
    expect(cycleParams).toEqual(expect.objectContaining({ venue: "alpaca", place: true }));
    expect(typeof cycleParams.tradeDecisionReviewer).toBe("function");
    const reviewRequest = {
      schemaVersion: FINANCE_TRADE_DECISION_REVIEW_SCHEMA,
      venue: "alpaca:paper",
      asOf: "2026-09-23T19:30:00.000Z",
      signalAnchor: "2026-08-31",
      ruleIds: ["fixture"],
      equity: 2000,
      rebalanceBand: 0.05,
      caps: { maxOrderNotional: 1000, maxInstrumentNotional: 2000, maxOrdersPerRun: 8 },
      reconciliation: { status: "reconciled" },
      positions: [],
      candidates: [],
    } as const;
    await cycleParams.tradeDecisionReviewer(reviewRequest, AbortSignal.timeout(1000));

    expect(factory).toHaveBeenCalledTimes(1);
    expect(reviewer).toHaveBeenCalledWith(reviewRequest, expect.any(AbortSignal));
  });
  it("allows Paper execution while adversity evidence remains promotion-only", async () => {
    mocks.account.mockResolvedValue({ ok: true, account });
    mocks.ruleReadiness.mockResolvedValueOnce({
      thresholdsDeclared: true,
      thresholdsError: null,
      readiness: {
        declaredThresholds: { minObservations: 3 },
        rules: [
          {
            ruleId: "fixture",
            ready: false,
            readyUnavailableReason: null,
            durationMet: true,
            observationCount: 3,
            barConflicts: [],
            uncovered: ["chop", "reversal", "gap"],
          },
        ],
      },
    });
    const createController = vi.fn();
    const createTradeDecisionReviewer = vi.fn();
    const result = await runFinanceDailyCycleOperator(args, {
      createController,
      createTradeDecisionReviewer,
    });
    expect(result).toMatchObject({
      ok: true,
      readiness: { rules: [{ ruleId: "fixture", ready: false }] },
    });
    expect(mocks.cycle).toHaveBeenCalledWith(expect.objectContaining({ place: true }));
    expect(createTradeDecisionReviewer).not.toHaveBeenCalled();
  });
  it("fails closed when the other readiness gates cannot be judged", async () => {
    mocks.account.mockResolvedValue({ ok: true, account });
    mocks.ruleReadiness.mockResolvedValueOnce({
      thresholdsDeclared: false,
      thresholdsError: "missing promotion thresholds",
      readiness: {
        declaredThresholds: { minObservations: 3 },
        rules: [
          {
            ruleId: "fixture",
            ready: null,
            durationMet: false,
            observationCount: 0,
            barConflicts: [],
            uncovered: ["reversal", "gap"],
          },
        ],
      },
    });

    const result = await runFinanceDailyCycleOperator(args);

    expect(result).toMatchObject({
      ok: false,
      failureKind: "execution_readiness_gate",
      error: expect.stringContaining("lacks determinable evidence or fails the declared duration"),
      readiness: { rules: [{ ready: null }] },
    });
    expect(mocks.cycle).not.toHaveBeenCalled();
  });
  it("keeps research runs independent of account access", async () => {
    mocks.ruleReadiness.mockResolvedValueOnce({
      readiness: { rules: [{ ruleId: "fixture", ready: null }] },
    });
    const result = await runFinanceDailyCycleOperator(args.filter((arg) => arg !== "--place"));
    expect(mocks.account).not.toHaveBeenCalled();
    expect(mocks.cycle).toHaveBeenCalledWith(expect.objectContaining({ place: false }));
    expect(result).toMatchObject({
      ok: true,
      readiness: { rules: [{ ruleId: "fixture", ready: null }] },
    });
  });
});

describe("explicit history sync before daily business", () => {
  const accountReconciliation = {
    status: "reconciled" as const,
    quantities: [],
    fees: [],
    cashFromActivities: 0,
    cashComponents: { fillCash: 0, feeCash: 0, otherCash: 0 },
    brokerCash: 0,
    cashDifference: 0,
    differences: [],
    issues: [],
    feesInterpreted: true,
    accountObservation: {
      accountId: "synthetic",
      currency: "USD" as const,
      source: "https://paper-api.alpaca.markets/v2/account",
      observedAt: "2025-02-01T00:00:00Z",
      equity: null,
      cash: 0,
      buyingPower: null,
      portfolioValue: null,
      boundary:
        "observed_account_values_not_execution_authority; buying_power_is_not_cash" as const,
      unknownValueMeaning: "missing_or_invalid" as const,
    },
    protection: {
      protective: [],
      unresolved: [],
      coverage: [],
      coverageBasis: "recognized_working_sell_stops" as const,
    },
    observedAt: "2025-02-01T00:00:00Z",
    positions: [],
    openOrders: [],
    historyHeadRef: null,
  };
  const history = {
    accountReconciliation,
    accountId: "synthetic",
    venue: "alpaca:paper",
    after: "2025-01-01T00:00:00Z",
    until: "2025-02-01T00:00:00Z",
    status: "raw_history_synced",
    streams: [],
    positionsReconciled: false,
    executionReceiptsCreated: 0,
  } as const;
  it.each(["day", "night"])("blocks %s on incomplete sync before business", async (mode) => {
    const syncHistory = vi.fn(async () => ({
      ...history,
      streams: [],
      status: "incomplete" as const,
    }));
    const result = await runFinanceDailyCycleOperator(
      ["--json", "--dir", "/synthetic/finance", "--mode", mode, "--sync-alpaca-history"],
      { syncHistory },
    );
    expect(result.ok).toBe(false);
    expect(result.historySync).toEqual(expect.objectContaining({ status: "incomplete" }));
    expect(mocks.cycle).not.toHaveBeenCalled();
    expect(syncHistory).toHaveBeenCalledWith({ directory: "/synthetic/finance" });
  });
  it("settles at night despite unresolved economics when placement flags were inherited", async () => {
    mocks.backfill.mockResolvedValueOnce({ scored: [], issues: [] });
    const syncHistory = vi.fn(async () => ({
      ...history,
      streams: [],
      accountReconciliation: {
        ...accountReconciliation,
        status: "unresolved" as const,
      },
    }));
    const result = await runFinanceDailyCycleOperator(
      [
        "--json",
        "--dir",
        "/synthetic/finance",
        "--mode",
        "night",
        "--venue",
        "alpaca",
        "--place",
        "--sync-alpaca-history",
      ],
      { syncHistory },
    );
    expect(result.ok).toBe(true);
    expect(mocks.backfill).toHaveBeenCalledOnce();
    expect(mocks.cycle).not.toHaveBeenCalled();
    expect(mocks.account).not.toHaveBeenCalled();
  });

  it("refreshes close-of-day bars and re-prices marks at night with the active rule instruments", async () => {
    mocks.backfill.mockResolvedValueOnce({ scored: [], issues: [] });
    mocks.positionLedger.mockResolvedValueOnce({
      ledger: {
        positions: [
          { instrument: "MSFT", quantity: 2 },
          { instrument: "BTC/USD", quantity: 1 },
        ],
      },
    });
    const result = await runFinanceDailyCycleOperator(
      [
        "--json",
        "--dir",
        "/synthetic/finance",
        "--mode",
        "night",
        "--as-of",
        "2026-09-22T21:30:00.000Z",
      ],
      {
        syncHistory: vi.fn(async () => ({ ...history, streams: [] })),
      },
    );
    expect(mocks.eodRefresh).toHaveBeenCalledWith({
      directory: "/synthetic/finance",
      asOf: "2026-09-22T21:30:00.000Z",
      instruments: ["AAPL", "MSFT"],
    });
    expect(result.ok).toBe(true);
    expect(result.eodRefresh).toEqual({
      barsFiled: [],
      marksFiled: [],
      unpricedHoldings: [],
      dataIssues: [],
    });
    expect(mocks.backfill).toHaveBeenCalledOnce();
  });

  it("does not sync by default and never enables placement", async () => {
    const syncHistory = vi.fn(async () => ({ ...history, streams: [] }));
    await runFinanceDailyCycleOperator(["--json", "--dir", "/synthetic/finance"], { syncHistory });
    expect(syncHistory).not.toHaveBeenCalled();
    const result = await runFinanceDailyCycleOperator(
      ["--json", "--dir", "/synthetic/finance", "--sync-alpaca-history"],
      { syncHistory },
    );
    expect(result.historySync).toEqual(history);
    expect(mocks.cycle).toHaveBeenLastCalledWith(expect.objectContaining({ place: false }));
  });
});

describe("human-readable daily summary", () => {
  it("shows refusal and reviewer failure details instead of misattributing zero fills", async () => {
    mocks.account.mockResolvedValue({ ok: true, account });
    mocks.cycle.mockResolvedValue({
      ok: false,
      modelCalls: 1,
      tradeDecisionReview: {
        status: "failed",
        candidateCount: 1,
        modelCalls: 1,
        failureCode: "output_truncated",
      },
      drift: [{ instrument: "AAPL", action: "buy", notional: 500 }],
      placed: [],
      refusals: [
        "AAPL: execution quote unavailable (alpaca_safety_quote_expired)",
        ...Array.from({ length: 8 }, (_, index) => `ETF${index + 1}: provider quote unavailable`),
      ],
      dataIssues: [],
    });
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    let output = "";
    try {
      await runFinanceDailyCycleOperator(args.filter((arg) => arg !== "--json"));
      output = stdout.mock.calls.map(([chunk]) => String(chunk)).join("");
    } finally {
      stdout.mockRestore();
    }
    expect(output).toContain("执行场所: Alpaca Paper");
    expect(output).toContain("--place: 已提供");
    expect(output).toContain("动态标的范围: selected=2 / eligible=12 / candidates=100");
    expect(output).toContain("数据筛选不代表策略表现验证");
    expect(output).toContain("已记录成交: 无");
    expect(output).toContain("执行拒绝: 9");
    expect(output).toContain("alpaca_safety_quote_expired");
    expect(output).toContain("ETF8: provider quote unavailable");
    expect(output).toContain("ETF1: provider quote unavailable");
    expect(output).not.toContain("其余");
    expect(output).toContain("失败码: output_truncated");
    expect(output).not.toContain("未给 --place 或无需动作");
  });

  it("distinguishes the local Paper simulator when placement was not requested", async () => {
    mocks.cycle.mockResolvedValue({
      ok: true,
      modelCalls: 0,
      tradeDecisionReview: { status: "not_needed", candidateCount: 0, modelCalls: 0 },
      drift: [],
      placed: [],
      refusals: [],
      dataIssues: [],
    });
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    let output = "";
    try {
      await runFinanceDailyCycleOperator(["--dir", "/synthetic/finance", "--venue", "paper"]);
      output = stdout.mock.calls.map(([chunk]) => String(chunk)).join("");
    } finally {
      stdout.mockRestore();
    }
    expect(output).toContain("执行场所: LCX Paper 模拟器");
    expect(output).toContain("--place: 未提供");
    expect(output).toContain("已记录成交: 无");
  });
});

it("installs the account controller from the explicit execution policy at the daily seam", async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "daily-policy-"));
  try {
    const filename = path.join(directory, "policy.json");
    await fs.writeFile(filename, JSON.stringify({ synthetic: true }));
    const accountBookProvider = vi.fn();
    const executionQuoteProvider = vi.fn();
    const createSafetyContext = vi.fn();
    const createController = vi.fn(() => ({
      accountId: "bound-account",
      executionPolicyExpiresAt: "2026-09-22T00:00:00.000Z",
      executionPolicyAuthorizationMode: "until_expiry" as const,
      inspectReconciliation: vi.fn(),
      accountBookProvider,
      executionQuoteProvider,
      prepareExecutionQuote: vi.fn(),
      createSafetyContext,
    }));
    const result = await runFinanceDailyCycleOperator([...args, "--execution-policy", filename], {
      createController,
    });
    expect(result.ok).toBe(true);
    expect(createController).toHaveBeenCalledWith(
      expect.objectContaining({
        directory: "/synthetic/finance",
        instruments: ["MSFT", "NVDA"],
        policy: { synthetic: true },
      }),
    );
    expect(mocks.cycle).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "bound-account",
        accountBookProvider,
        executionQuoteProvider,
        createSafetyContext,
      }),
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

it("checks reconciliation without collecting quotes or entering the trading cycle", async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "daily-inspection-"));
  try {
    mocks.ruleReadiness.mockResolvedValue({
      readiness: { rules: [{ ruleId: "fixture", ready: false }] },
    });
    const filename = path.join(directory, "policy.json");
    await fs.writeFile(filename, "{}");
    const inspectReconciliation = vi.fn(async () => ({
      observedAt: new Date().toISOString(),
      readiness: {
        status: "restricted" as const,
        historyStatus: "unresolved" as const,
        quarantinedInstruments: ["BTC/USD"],
        uncertaintyReserve: 0.1,
        reasons: [],
      },
    }));
    const executionQuoteProvider = vi.fn();
    const createController = vi.fn(() => ({
      accountId: "synthetic",
      executionPolicyExpiresAt: "2026-09-22T00:00:00.000Z",
      executionPolicyAuthorizationMode: "until_expiry" as const,
      inspectReconciliation,
      executionQuoteProvider,
      prepareExecutionQuote: vi.fn(),
      accountBookProvider: vi.fn(),
      createSafetyContext: vi.fn(),
    }));
    const result = await runFinanceDailyCycleOperator(
      [
        ...args.filter((arg) => arg !== "--place"),
        "--check-execution",
        "--execution-policy",
        filename,
      ],
      { createController },
    );
    expect(result).toMatchObject({
      ok: true,
      boundary: "broker_reconciliation_readiness_only",
      strategyRuleReadiness: { rules: [{ ruleId: "fixture", ready: false }] },
      quotesVerified: false,
      executionVerified: false,
      ordersSubmitted: 0,
    });
    expect(inspectReconciliation).toHaveBeenCalledOnce();
    expect(executionQuoteProvider).not.toHaveBeenCalled();
    expect(mocks.cycle).not.toHaveBeenCalled();
    await expect(
      runFinanceDailyCycleOperator([...args, "--check-execution", "--execution-policy", filename], {
        createController,
      }),
    ).rejects.toThrow("without --place");
    expect(inspectReconciliation).toHaveBeenCalledOnce();
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
