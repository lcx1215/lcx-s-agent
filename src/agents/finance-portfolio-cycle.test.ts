import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runFinanceDailyCycle } from "./finance-daily-cycle.js";
import type { FinancePortfolioPlan } from "./finance-portfolio-composition.js";
const mocks = vi.hoisted(() => ({ collect: vi.fn() }));
vi.mock("./finance-free-market-collection-adapters.js", () => ({
  createChinaReachableUsEodHistoryCollectionAdapter: () => ({ collect: mocks.collect }),
}));
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  vi.clearAllMocks();
});
function bars() {
  const start = Date.parse("2025-01-01T00:00:00Z");
  return Array.from({ length: 620 }, (_, i) => {
    const close = i < 420 ? 100 + i / 4 : 205 - (i - 420) * 0.15;
    const date = new Date(start + i * 86400_000).toISOString().slice(0, 10);
    return {
      data: { date, close, open: close, high: close + 1, low: close - 1, volume: 100 },
      sourceTimestamp: `${date}T20:00:00Z`,
      providerName: "fixture",
      sourceUrlOrArtifact: "fixture://bars",
    };
  });
}
async function run(policy: FinancePortfolioPlan["conflictPolicy"]) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "portfolio-cycle-"));
  dirs.push(directory);
  mocks.collect.mockResolvedValue(bars());
  const asOf = "2026-09-22T00:00:00Z";
  const portfolioPlan: FinancePortfolioPlan = {
    asOf,
    validUntil: "2026-09-23T00:00:00Z",
    accountId: "fixture",
    venue: "paper",
    conflictPolicy: policy,
    allocations: [
      { strategyId: "slow", budgetFraction: 0.4 },
      { strategyId: "fast", budgetFraction: 0.4 },
    ],
    candidates: [],
  };
  return runFinanceDailyCycle({
    directory,
    instruments: ["ACME"],
    asOf,
    equity: 100_000,
    caps: { maxOrderNotional: 10_000, maxInstrumentNotional: 20_000, maxOrdersPerRun: 2 },
    runAuthorizationId: "fixture",
    portfolioPlan,
    trendStrategies: [
      { ruleId: "slow", lookbackMonths: 12, instruments: ["ACME"] },
      { ruleId: "fast", lookbackMonths: 6, instruments: ["ACME"] },
    ],
    place: false,
  });
}
describe("portfolio targets reach the existing cycle drift consumer", () => {
  it("holds a conflicting symbol without turning a blocked candidate into a sell", async () => {
    const result = await run("block");
    expect(result.portfolio?.targets[0]).toMatchObject({
      instrument: "ACME",
      conflict: true,
      blocked: true,
    });
    expect(result.portfolio?.targets[0]?.weight).toBeCloseTo(0.68);
    expect(result.drift[0]).toMatchObject({ action: "none", notional: 0 });
    expect(result.placed).toEqual([]);
  });
  it("uses declared budget weighting only when explicitly chosen and retains cash", async () => {
    const result = await run("budget_weighted");
    expect(result.targets[0].weight).toBeCloseTo(0.68);
    expect(result.portfolio?.unallocatedCashWeight).toBeCloseTo(0.32);
    expect(result.drift[0]).toMatchObject({ action: "buy", notional: 10_000 });
    expect(result.portfolio?.targets[0].contributions.map((c) => c.strategyId)).toEqual([
      "slow",
      "fast",
    ]);
    expect(mocks.collect).toHaveBeenCalledOnce();
  });
});
