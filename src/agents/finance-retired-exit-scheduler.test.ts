import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  targets: vi.fn(),
  monitor: vi.fn(),
  execute: vi.fn(),
  controller: vi.fn(),
}));
vi.mock("./finance-intraday-position.js", () => ({
  readFinanceRetiredIntradayExitTargets: mocks.targets,
}));
vi.mock("./finance-intraday-monitor.js", () => ({ runFinanceIntradayMonitorTick: mocks.monitor }));
vi.mock("./finance-intraday-execution.js", () => ({
  executeFinanceIntradayDecision: mocks.execute,
}));
vi.mock("./finance-alpaca-cycle-controller.js", async (original) => ({
  ...(await original<typeof import("./finance-alpaca-cycle-controller.js")>()),
  createFinanceAlpacaCycleController: mocks.controller,
}));
import {
  parseFinanceSchedulerArgs,
  runFinanceRetiredIntradayExitTick,
} from "../../scripts/operator/lcx-finance-scheduler.js";
const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  for (const dir of directories.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
it.each(["sell", "buy"] as const)(
  "continues with no active strategy but only dispatches sells (%s)",
  async (action) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "retired-scheduler-"));
    directories.push(directory);
    const policyFile = path.join(directory, "policy.json");
    fs.writeFileSync(
      policyFile,
      JSON.stringify({
        schemaVersion: "lcx_alpaca_cycle_policy_v1",
        accountId: "paper",
        planId: "plan",
        revision: "v1",
        expiresAt: "2099-01-01T00:00:00Z",
        peakEquity: 10000,
        peakScope: "book",
        unhedged: true,
        maxPortfolioDrawdownFraction: 0.2,
        maxGrossExposure: 10000,
      }),
    );
    const options = parseFinanceSchedulerArgs([
      "--loop",
      "--intraday-monitor",
      "--intraday-place",
      "--place",
      "--venue",
      "alpaca",
      "--execution-policy",
      policyFile,
      "--execution-quote-feed",
      "iex",
      "--execution-max-age-ms",
      "30000",
      "--max-order-notional",
      "1000",
      "--max-instrument-notional",
      "5000",
      "--max-orders",
      "8",
    ]);
    if (!options.intraday) {
      throw new Error("missing intraday config");
    }
    options.intraday = {
      ...options.intraday,
      instrumentSource: "active_rule",
      instruments: [],
      executionInstruments: [],
      place: false,
      placementEligibility: "active_rule_unavailable",
    };
    const contract = {
      ruleId: "retired-rule",
      intervalSeconds: 300,
      feed: "iex",
      openingRangeBars: 6,
      rewardRisk: 2,
    };
    mocks.targets.mockResolvedValue([{ instrument: "SPY", quantity: 1, contract }]);
    mocks.controller.mockReturnValue({ accountId: "paper" });
    mocks.monitor.mockResolvedValue({
      status: "decision_pending_execution",
      decision: { input: { action } },
    });
    mocks.execute.mockResolvedValue({ status: "placed" });
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const context = {
      root: { directory, source: "explicit" as const },
      options,
      signal: AbortSignal.timeout(5000),
      resolveMarketSession: async () => null,
    };
    await runFinanceRetiredIntradayExitTick(context);
    expect(mocks.monitor).toHaveBeenCalledWith(
      expect.objectContaining({
        exitOnly: true,
        strategyContract: contract,
        accountId: "paper",
        scope: { kind: "strategy_universe" },
      }),
    );
    expect(mocks.execute).toHaveBeenCalledTimes(action === "sell" ? 1 : 0);
    mocks.monitor.mockClear();
    mocks.execute.mockClear();
    options.intraday = { ...options.intraday, placementRequested: false };
    await runFinanceRetiredIntradayExitTick(context);
    expect(mocks.monitor).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  },
);
