import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("./finance-scheduler-process.js", () => ({
  DEFAULT_FINANCE_CYCLE_TIMEOUT_MS: 900000,
  runFinanceCycleProcess: mocks.run,
}));
vi.mock("../config/config.js", () => ({
  loadConfig: () => {
    throw new Error("unexpected config read");
  },
}));
import {
  cycleOutputSucceeded,
  parseFinanceSchedulerArgs,
  runFinanceScheduler,
} from "../../scripts/operator/lcx-finance-scheduler.js";
import { readFinancePaperPromotions } from "./finance-paper-promotion.js";
import {
  financeResearchPortfolioContextSchema,
  type FinanceResearchPortfolioContext,
} from "./finance-research-portfolio-plan.js";
import { readFinanceSchedulerState } from "./finance-scheduler-state.js";
import { financeResearchScoredPath } from "./finance-state-dir.js";
let root: string;
const researchContext: FinanceResearchPortfolioContext = {
  accountId: "fixture-account",
  venue: "alpaca",
  validityMinutes: 60,
  conflictPolicy: "block",
  activeStrategyIds: ["fixture-strategy"],
  requiredInstruments: ["AAPL"],
};
function writeResearchContext(): string {
  const filename = path.join(root, "context.json");
  fs.writeFileSync(
    filename,
    JSON.stringify(financeResearchPortfolioContextSchema.parse(researchContext)),
  );
  return filename;
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "finance-scheduler-"));
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-22T19:30:00Z"));
  mocks.run.mockReset().mockResolvedValue({
    exitCode: 0,
    signal: null,
    status: "succeeded",
    ok: true,
    stdout: '{"ok":true}',
    stderr: "",
    outputTruncated: false,
  });
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});
describe("durable scheduler claims on the unified lifecycle", () => {
  it("requires JSON success, not merely exit zero", async () => {
    expect(cycleOutputSucceeded('{"ok":true}')).toBe(true);
    for (const stdout of ['{"ok":false}', "{}", "not json"]) {
      expect(cycleOutputSucceeded(stdout)).toBe(false);
    }
    mocks.run.mockResolvedValue({
      exitCode: 0,
      status: "succeeded",
      ok: true,
      stdout: '{"ok":false}',
      stderr: "",
    });
    expect(await runFinanceScheduler(["--once", "day", "--dir", root])).toBe(1);
    const state = readFinanceSchedulerState(root);
    expect(state.lastFired.day).toBe("2026-09-22");
    expect(state.lastSucceeded.day).toBeUndefined();
    expect(state.lastStatus.day).toBe("failed");
    expect(await runFinanceScheduler(["--once", "day", "--dir", root])).toBe(1);
    expect(mocks.run).toHaveBeenCalledTimes(1);
  });
  it.each(["rejected", "candidate"])(
    "does not turn unaccepted research %s into a successful trading cycle",
    async (status) => {
      const contextPath = writeResearchContext();
      mocks.run.mockResolvedValue({
        exitCode: 0,
        status: "succeeded",
        ok: true,
        stdout: JSON.stringify({
          ok: true,
          status,
          portfolioPlanWritten: "wrong-plan.json",
          placed: [{}],
        }),
        stderr: "",
        outputTruncated: false,
      });
      expect(
        await runFinanceScheduler([
          "--once",
          "day",
          "--dir",
          root,
          "--research-portfolio-context",
          contextPath,
          "--research-ask",
          "Review opportunities",
        ]),
      ).toBe(1);
      expect(mocks.run).toHaveBeenCalledTimes(1);
      const state = readFinanceSchedulerState(root);
      expect(state.lastSucceeded.day).toBeUndefined();
      expect(state.lastStatus.day).toBe("failed");
      expect(state.lastRun?.execution).toMatchObject({
        outcome: "not_run",
        blockReason: "research_plan_not_accepted",
        reportedPlacements: null,
      });
    },
  );
  it("runs the trading cycle after an accepted research plan", async () => {
    const contextPath = writeResearchContext();
    mocks.run.mockResolvedValueOnce({
      exitCode: 0,
      status: "succeeded",
      ok: true,
      stdout: JSON.stringify({
        status: "candidate",
        plan: { asOf: "2026-09-22T19:30:00.000Z" },
        gates: ["source", "committee", "quality", "module_execution"].map((id) => ({
          id,
          passed: true,
        })),
        portfolioPlanWritten: path.join(root, "research-portfolio-plan-latest.json"),
      }),
      stderr: "",
      outputTruncated: false,
    });
    expect(
      await runFinanceScheduler([
        "--once",
        "day",
        "--dir",
        root,
        "--research-portfolio-context",
        contextPath,
        "--research-ask",
        "Review opportunities",
      ]),
    ).toBe(0);
    expect(mocks.run).toHaveBeenCalledTimes(2);
    const researchArgs: readonly string[] = mocks.run.mock.calls[0][0].argv;
    const frozenContextPath = researchArgs[researchArgs.indexOf("--portfolio-context") + 1];
    expect(frozenContextPath).not.toBe(contextPath);
    expect(JSON.parse(fs.readFileSync(frozenContextPath, "utf8"))).toEqual(researchContext);
    const executionArgs: readonly string[] = mocks.run.mock.calls[1][0].argv;
    expect(executionArgs).toContain(path.join(root, "research-portfolio-plan-latest.json"));
    expect(readFinanceSchedulerState(root).lastSucceeded.day).toBe("2026-09-22");
  });
  it.each([
    { body: undefined, reason: "controller_evidence_read_failed" },
    { body: "{invalid", reason: "controller_evidence_invalid_scope" },
    {
      body: JSON.stringify({ ...researchContext, venue: "live" }),
      reason: "controller_evidence_invalid_scope",
    },
  ])(
    "refuses invalid research context before child dispatch: $reason $body",
    async ({ body, reason }) => {
      const contextPath = path.join(root, "context.json");
      if (body !== undefined) {
        fs.writeFileSync(contextPath, body);
      }
      expect(
        await runFinanceScheduler([
          "--once",
          "day",
          "--dir",
          root,
          "--research-portfolio-context",
          contextPath,
          "--research-ask",
          "Review opportunities",
        ]),
      ).toBe(1);
      expect(mocks.run).not.toHaveBeenCalled();
      const state = readFinanceSchedulerState(root);
      expect(state.lastSucceeded.day).toBeUndefined();
      expect(state.lastRun?.execution).toMatchObject({ outcome: "not_run", blockReason: reason });
    },
  );
  it("preserves old interrupted claim without dispatch", async () => {
    fs.writeFileSync(
      path.join(root, "daily-cycle-2026-09-22-day.json"),
      JSON.stringify({ status: "started" }),
    );
    expect(await runFinanceScheduler(["--once", "day", "--dir", root])).toBe(1);
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it("does not overwrite an interrupted attempt from an earlier day", async () => {
    fs.writeFileSync(
      path.join(root, "daily-cycle-scheduler.json"),
      JSON.stringify({
        lastFired: { day: "2026-09-21" },
        lastStatus: { day: "running" },
        lastSucceeded: {},
      }),
    );
    expect(await runFinanceScheduler(["--once", "day", "--dir", root])).toBe(1);
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it("forwards explicit quote authorization through the unified argument parser and cycle", async () => {
    const flags = ["--execution-quote-feed", "sip", "--execution-max-age-ms", "1500"];
    expect(parseFinanceSchedulerArgs(["--loop", ...flags]).extraArgs).toEqual(flags);
    expect(await runFinanceScheduler(["--once", "day", "--dir", root, ...flags])).toBe(0);
    expect(mocks.run.mock.calls[0][0].argv).toEqual(
      expect.arrayContaining([...flags, "--dir", root]),
    );
    expect(() =>
      parseFinanceSchedulerArgs(["--loop", "--execution-quote-feed", "delayed"]),
    ).toThrow();
    expect(() => parseFinanceSchedulerArgs(["--loop", "--execution-max-age-ms", "0"])).toThrow();
  });
  it("uses --place as the only placement switch while retaining intraday scope and caps", () => {
    const boundedAlpacaPlacement = [
      "--place",
      "--venue",
      "alpaca",
      "--execution-policy",
      path.join(root, "policy.json"),
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
    ];
    const withoutLegacySwitch = parseFinanceSchedulerArgs([
      "--loop",
      "--intraday-monitor",
      ...boundedAlpacaPlacement,
    ]);
    expect(withoutLegacySwitch.intraday).toMatchObject({
      place: true,
      placementRequested: true,
      placementEligibility: "eligibility_missing",
    });

    const withLegacySwitch = parseFinanceSchedulerArgs([
      "--loop",
      "--intraday-monitor",
      "--intraday-place",
      ...boundedAlpacaPlacement,
    ]);
    expect(withLegacySwitch.intraday).toMatchObject({
      place: true,
      placementRequested: true,
    });

    expect(() =>
      parseFinanceSchedulerArgs(["--loop", "--intraday-monitor", "--intraday-place"]),
    ).toThrow("--intraday-place requires the shared --place authorization");
    expect(parseFinanceSchedulerArgs(["--loop", "--intraday-monitor"]).intraday).toMatchObject({
      place: false,
      placementRequested: false,
    });
  });
  it("allows only one concurrent owner to dispatch", async () => {
    let release!: () => void;
    mocks.run.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              exitCode: 0,
              status: "succeeded",
              ok: true,
              stdout: '{"ok":true}',
              stderr: "",
            });
        }),
    );
    const first = runFinanceScheduler(["--once", "day", "--dir", root]);
    await expect(runFinanceScheduler(["--once", "day", "--dir", root])).rejects.toThrow(
      "lock exists",
    );
    release();
    expect(await first).toBe(0);
    expect(mocks.run).toHaveBeenCalledTimes(1);
  });
  it("dispatches directional tuning without promoting a paper execution gate", async () => {
    fs.writeFileSync(
      financeResearchScoredPath(root),
      Array.from({ length: 5 }, () => JSON.stringify({ conviction: 0.7, outcome: 1 })).join("\n") +
        "\n",
    );
    mocks.run.mockResolvedValue({
      exitCode: 0,
      signal: null,
      status: "succeeded",
      ok: true,
      stdout: JSON.stringify({
        ok: true,
        scoredFiled: { appended: 1, skipped: 0 },
        reflection: {},
        pending: [],
        declined: [],
        issues: [],
      }),
      stderr: "",
      outputTruncated: false,
    });

    expect(await runFinanceScheduler(["--once", "night", "--dir", root])).toBe(0);
    expect(readFinancePaperPromotions(root)).toHaveLength(0);
    expect(readFinanceSchedulerState(root).lastRun?.tuningLifecycle).toMatchObject({
      ok: true,
      status: "completed",
      result: {
        paperExecutionPromotion: {
          status: "blocked",
          reason: "directional_forecast_outcomes_are_not_net_trade_pnl",
        },
      },
    });
  });
});
