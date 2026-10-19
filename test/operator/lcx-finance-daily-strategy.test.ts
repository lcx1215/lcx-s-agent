import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runFinanceDailyCycleOperator } from "../../scripts/operator/lcx-finance-daily-cycle.js";
import {
  bindFinanceDailyStrategy,
  financeMonthlyTrendReturn,
} from "../../src/agents/finance-daily-strategy.js";
import type { FinanceResearchEquityUniverseSnapshot } from "../../src/agents/finance-research-runner.js";
import { FINANCE_RESEARCH_SAMPLES_FILENAME } from "../../src/agents/finance-state-dir.js";
import {
  DEFAULT_UNIVERSE_THRESHOLDS,
  FINANCE_UNIVERSE_SELECTION_FRESHNESS_BASIS,
  FINANCE_UNIVERSE_SELECTION_SCHEMA,
  FINANCE_UNIVERSE_SELECTION_SOURCES,
  FINANCE_UNIVERSE_SELECTION_SNAPSHOT_FILENAME,
} from "../../src/agents/finance-universe-selection.js";
const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  cycle: vi.fn(),
  readiness: vi.fn(),
  eodRefresh: vi.fn(),
}));
vi.mock("../../src/agents/finance-strategy-rule-ledger.js", () => ({
  readFinanceStrategyRuleLedger: mocks.read,
}));
vi.mock("../../src/agents/finance-daily-cycle.js", () => ({
  refreshFinanceEodBarsAndMarks: mocks.eodRefresh,
  runFinanceDailyCycle: mocks.cycle,
}));
vi.mock("../../src/agents/finance-rule-readiness-state.js", () => ({
  readFinanceRuleReadinessState: mocks.readiness,
  financeRuleReadinessSection: (state: { readiness: unknown }) => ({
    readiness: state.readiness,
  }),
}));
vi.mock("../../src/agents/finance-scoped-override.js", () => ({
  resolveScopedOverride: async ({ fallback }: { fallback: number }) => ({ value: fallback }),
}));
vi.mock("../../src/agents/finance-link-health.js", () => ({
  readFinanceLinkHealth: async () => ({ ok: true }),
}));
const rule = {
  ruleId: "trend",
  state: "active" as const,
  form: "cross_asset_trend",
  formVersion: "1",
  emits: "target_weights",
  instruments: ["SPY"],
  schedule: { kind: "monthly", at: "last_trading_day", timezone: "America/New_York" },
  body: { frozenRule: { lookbackMonths: 6 } },
};
const fixtureDirectories: string[] = [];
afterEach(async () => {
  vi.resetAllMocks();
  await Promise.all(
    fixtureDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});
beforeEach(() => {
  mocks.readiness.mockResolvedValue({
    readiness: { rules: [{ ruleId: "trend", ready: true }] },
  });
  mocks.eodRefresh.mockResolvedValue({
    barsFiled: [],
    marksFiled: [],
    unpricedHoldings: [],
    dataIssues: [],
  });
});

async function writeValidatedUniverse(directory: string): Promise<void> {
  const asOf = "2026-09-21T20:00:00.000Z";
  const snapshot: FinanceResearchEquityUniverseSnapshot = {
    schemaVersion: FINANCE_UNIVERSE_SELECTION_SCHEMA,
    asOf,
    generatedAt: asOf,
    sources: FINANCE_UNIVERSE_SELECTION_SOURCES,
    freshnessBasis: FINANCE_UNIVERSE_SELECTION_FRESHNESS_BASIS,
    selected: ["SPY"],
    screenLimit: 120,
    candidateCount: 1,
    screenedCount: 1,
    eligibleCount: 1,
    assetCount: 1,
    unreadableCount: 0,
    selectedMetrics: [
      {
        symbol: "SPY",
        bars: 800,
        firstDate: "2023-07-01",
        lastDate: "2026-09-21",
        medianDollarVolume: 10_000_000,
        annualisedVol: 0.2,
        outlierCount: 0,
        maxGapDays: 4,
      },
    ],
    thresholds: DEFAULT_UNIVERSE_THRESHOLDS,
    liquidityPreScreen: {
      basis: "latest_completed_regular_session",
      source: "alpaca_snapshot.dailyBar_or_prevDailyBar.close_times_volume",
      sessionDate: "2026-09-21",
    },
    selectionEvidence: {
      method: "liquidity_seed_then_iterative_minimum_worst_correlation",
      maxCorrelation: 0.9,
      selected: [{ symbol: "SPY", rank: 1, reason: "highest_liquidity_eligible_seed" }],
      excluded: [],
    },
    rejected: [],
  };
  await fs.writeFile(
    path.join(directory, FINANCE_UNIVERSE_SELECTION_SNAPSHOT_FILENAME),
    JSON.stringify(snapshot),
  );
}

async function createUniverseDirectory(prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  fixtureDirectories.push(directory);
  await writeValidatedUniverse(directory);
  return directory;
}
describe("declared strategy to daily execution", () => {
  it("binds the declared horizon and refuses another strategy form or ambiguous composition", () => {
    expect(bindFinanceDailyStrategy([rule])).toMatchObject({ ruleId: "trend", lookbackMonths: 6 });
    expect(() => bindFinanceDailyStrategy([{ ...rule, form: "mean_reversion" }])).toThrow(
      "refusing to substitute trend logic",
    );
    expect(() => bindFinanceDailyStrategy([rule, { ...rule, ruleId: "second" }])).toThrow(
      "portfolio composition",
    );
    expect(() => bindFinanceDailyStrategy([{ ...rule, body: {} }])).toThrow("lookbackMonths");
    expect(() => bindFinanceDailyStrategy([{ ...rule, schedule: { kind: "daily" } }])).toThrow(
      "month-end",
    );
  });
  it("different lookbacks actually change the signal and a missing month does not shift the horizon", () => {
    const months = [
      { date: "2025-08-29", close: 100 },
      { date: "2026-02-27", close: 140 },
      { date: "2026-08-31", close: 120 },
    ];
    const anchor = months[2];
    expect(financeMonthlyTrendReturn(months, anchor, 12)).toBeCloseTo(0.2);
    expect(financeMonthlyTrendReturn(months, anchor, 6)).toBeLessThan(0);
    expect(financeMonthlyTrendReturn(months, anchor, 9)).toBeUndefined();
  });
  it("passes bound parameters through the real operator and exposes the executed strategy", async () => {
    const directory = await createUniverseDirectory("daily-strategy-bound-");
    mocks.read.mockResolvedValue({ ledger: { rules: [rule] } });
    mocks.cycle.mockResolvedValue({
      ok: true,
      modelCalls: 0,
      targets: [],
      drift: [],
      placed: [],
      refusals: [],
      dataIssues: [],
    });
    const result = await runFinanceDailyCycleOperator([
      "--mode",
      "day",
      "--dir",
      directory,
      "--as-of",
      "2026-09-21T20:00:00Z",
      "--json",
    ]);
    expect(mocks.cycle).toHaveBeenCalledWith(
      expect.objectContaining({ instruments: ["SPY"], lookbackMonths: 6, place: false }),
    );
    expect(result).toMatchObject({
      ok: true,
      strategyExecution: { ruleId: "trend", lookbackMonths: 6 },
    });
  });
  it("refreshes active rules, not draft-only instruments", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "night-strategy-"));
    mocks.read.mockResolvedValue({
      ledger: { rules: [rule, { ...rule, ruleId: "draft", state: "draft", instruments: ["QQQ"] }] },
    });
    try {
      const result = await runFinanceDailyCycleOperator([
        "--mode",
        "night",
        "--dir",
        directory,
        "--json",
      ]);
      expect(result.mode).toBe("night");
      expect(mocks.eodRefresh).toHaveBeenCalledWith({
        directory,
        asOf: expect.any(String),
        instruments: ["SPY"],
      });
      expect(mocks.cycle).not.toHaveBeenCalled();
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
  it("settles when the strategy ledger is unreadable and skips EOD refresh", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "night-strategy-unreadable-"));
    mocks.read.mockRejectedValue(new Error("rule book unavailable"));
    try {
      await fs.writeFile(path.join(directory, FINANCE_RESEARCH_SAMPLES_FILENAME), "");
      const result = await runFinanceDailyCycleOperator([
        "--mode",
        "night",
        "--dir",
        directory,
        "--json",
      ]);
      expect(result).toMatchObject({
        mode: "night",
        ok: true,
        sampleSource: { status: "available", bytes: 0, parsedCount: 0 },
        sampleCount: 0,
        eodRefreshWarnings: ["strategy rule ledger unavailable; EOD refresh skipped"],
      });
      expect(mocks.eodRefresh).not.toHaveBeenCalled();
      expect(mocks.cycle).not.toHaveBeenCalled();
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
  it("does not dispatch unsupported rules into the fixed trend engine", async () => {
    const directory = await createUniverseDirectory("daily-strategy-unsupported-");
    mocks.read.mockResolvedValue({ ledger: { rules: [{ ...rule, form: "mean_reversion" }] } });
    const result = await runFinanceDailyCycleOperator([
      "--mode",
      "day",
      "--dir",
      directory,
      "--as-of",
      "2026-09-21T20:00:00.000Z",
      "--json",
    ]);
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("refusing to substitute trend logic"),
    });
    expect(mocks.cycle).not.toHaveBeenCalled();
  });
  it("returns a structured paper-readiness block before any execution dispatch", async () => {
    const directory = await createUniverseDirectory("daily-strategy-readiness-");
    mocks.read.mockResolvedValue({ ledger: { rules: [rule] } });
    mocks.readiness.mockResolvedValue({
      readiness: { rules: [{ ruleId: "trend", ready: false }] },
    });

    const result = await runFinanceDailyCycleOperator([
      "--mode",
      "day",
      "--dir",
      directory,
      "--as-of",
      "2026-09-21T20:00:00Z",
      "--place",
      "--json",
    ]);

    expect(result).toMatchObject({
      ok: false,
      failureKind: "execution_readiness_gate",
      error: expect.stringContaining("execution refused"),
    });
    expect(mocks.cycle).not.toHaveBeenCalled();
  });
});

it("passes multiple declared horizons and explicit budgets into one daily cycle", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "multi-strategy-"));
  try {
    await writeValidatedUniverse(directory);
    const planPath = path.join(directory, "plan.json");
    await fs.writeFile(
      planPath,
      JSON.stringify({
        asOf: "2026-09-21T00:00:00Z",
        validUntil: "2026-09-22T00:00:00Z",
        venue: "paper",
        accountId: "fixture",
        conflictPolicy: "block",
        allocations: [
          { strategyId: "trend", budgetFraction: 0.4 },
          { strategyId: "slow", budgetFraction: 0.3 },
        ],
        candidates: [],
      }),
    );
    mocks.read.mockResolvedValue({
      ledger: {
        rules: [rule, { ...rule, ruleId: "slow", body: { frozenRule: { lookbackMonths: 12 } } }],
      },
    });
    mocks.cycle.mockResolvedValue({
      ok: true,
      modelCalls: 0,
      targets: [],
      drift: [],
      placed: [],
      refusals: [],
      dataIssues: [],
    });
    const result = await runFinanceDailyCycleOperator([
      "--mode",
      "day",
      "--dir",
      directory,
      "--as-of",
      "2026-09-21T20:00:00Z",
      "--portfolio-plan",
      planPath,
    ]);
    expect(result.ok).toBe(true);
    expect(mocks.cycle).toHaveBeenCalledOnce();
    expect(mocks.cycle).toHaveBeenCalledWith(
      expect.objectContaining({
        instruments: ["SPY"],
        trendStrategies: [
          expect.objectContaining({ ruleId: "trend", lookbackMonths: 6 }),
          expect.objectContaining({ ruleId: "slow", lookbackMonths: 12 }),
        ],
        portfolioPlan: expect.objectContaining({
          allocations: [
            { strategyId: "trend", budgetFraction: 0.4 },
            { strategyId: "slow", budgetFraction: 0.3 },
          ],
        }),
      }),
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
