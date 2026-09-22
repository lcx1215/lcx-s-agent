import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runFinanceDailyCycleOperator } from "../../scripts/operator/lcx-finance-daily-cycle.js";
import {
  bindFinanceDailyStrategy,
  financeMonthlyTrendReturn,
} from "../../src/agents/finance-daily-strategy.js";
const mocks = vi.hoisted(() => ({ read: vi.fn(), cycle: vi.fn(), readiness: vi.fn() }));
vi.mock("../../src/agents/finance-strategy-rule-ledger.js", () => ({
  readFinanceStrategyRuleLedger: mocks.read,
}));
vi.mock("../../src/agents/finance-daily-cycle.js", () => ({ runFinanceDailyCycle: mocks.cycle }));
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
afterEach(() => vi.resetAllMocks());
beforeEach(() => {
  mocks.readiness.mockResolvedValue({
    readiness: { rules: [{ ruleId: "trend", ready: true }] },
  });
});
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
      "/unused-fixture-book",
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
  it("settles the night independently of active strategy binding", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "night-strategy-"));
    mocks.read.mockRejectedValue(new Error("rule book unavailable"));
    try {
      const result = await runFinanceDailyCycleOperator([
        "--mode",
        "night",
        "--dir",
        directory,
        "--json",
      ]);
      expect(result.mode).toBe("night");
      expect(mocks.read).not.toHaveBeenCalled();
      expect(mocks.cycle).not.toHaveBeenCalled();
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
  it("does not dispatch unsupported rules into the fixed trend engine", async () => {
    mocks.read.mockResolvedValue({ ledger: { rules: [{ ...rule, form: "mean_reversion" }] } });
    const result = await runFinanceDailyCycleOperator([
      "--mode",
      "day",
      "--dir",
      "/unused-fixture-book",
      "--json",
    ]);
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("refusing to substitute trend logic"),
    });
    expect(mocks.cycle).not.toHaveBeenCalled();
  });
});

it("passes multiple declared horizons and explicit budgets into one daily cycle", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "multi-strategy-"));
  try {
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
