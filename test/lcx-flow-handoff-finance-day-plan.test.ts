import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeFinanceBarLedger, readFinanceBarLedger } from "../src/agents/finance-bar-ledger.js";
import { runFinanceDailyCycle } from "../src/agents/finance-daily-cycle.js";
import { bindFinanceDailyStrategy } from "../src/agents/finance-daily-strategy.js";
import { financePortfolioPlanSchema } from "../src/agents/finance-portfolio-composition.js";
import { closeFinancePositionLedger } from "../src/agents/finance-position-ledger.js";
import { privateDayHistory } from "./fixtures/lcx-waterflow-finance-day-plan-probe.js";
import { probeOriginalFinanceModuleMain } from "./fixtures/lcx-waterflow-finance-module-main-probe.js";
import { probeOriginalFinanceSchedulerPlan } from "./fixtures/lcx-waterflow-finance-scheduler-plan-probe.js";
const seam = vi.hoisted(() => ({
  fetchImpl: undefined as ReturnType<typeof privateDayHistory>["fetchImpl"] | undefined,
}));
vi.mock("../src/agents/finance-free-market-collection-adapters.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../src/agents/finance-free-market-collection-adapters.js")
    >();
  return {
    ...actual,
    createChinaReachableUsEodHistoryCollectionAdapter: () => {
      if (!seam.fetchImpl) {
        throw new Error("unconfigured private HTTP seam");
      }
      return actual.createChinaReachableUsEodHistoryCollectionAdapter({
        fetchImpl: seam.fetchImpl,
      });
    },
  };
});
const roots: string[] = [];
afterEach(async () => {
  for (const dir of roots.splice(0)) {
    closeFinanceBarLedger(path.join(dir, "finance-book"));
    closeFinancePositionLedger(path.join(dir, "finance-book"));
    await fs.rm(dir, { recursive: true, force: true });
  }
  vi.unstubAllGlobals();
  seam.fetchImpl = undefined;
});
async function native(name: string, allocation = 0.4, missing = false) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "native-day-plan-"));
  roots.push(directory);
  const network = vi.fn(() => {
    throw new Error("external network forbidden");
  });
  vi.stubGlobal("fetch", network);
  const producer = await probeOriginalFinanceModuleMain({
    directory,
    allocation,
    dailyExecutableRule: true,
  });
  const plan = producer.planReadback!;
  const prices = privateDayHistory(plan.asOf, missing);
  seam.fetchImpl = prices.fetchImpl;
  const input = {
    instruments: ["SPY"],
    equity: 100000,
    asOf: plan.asOf,
    caps: { maxOrderNotional: 10000, maxInstrumentNotional: 50000, maxOrdersPerRun: 2 },
    runAuthorizationId: `private-preview:${plan.provenance!.receiptId}`,
    portfolioPlan: plan,
    trendStrategies: [bindFinanceDailyStrategy(producer.ruleRead.ledger.rules)],
    directory: producer.book,
    place: false,
    venue: "paper" as const,
  };
  async function retain(result: unknown) {
    await fs.writeFile(
      path.join(directory, "captured-day-consumption.json"),
      JSON.stringify(
        {
          input,
          result,
          priceHttpCalls: prices.calls,
          externalFetchCalls: network.mock.calls.length,
          proof: "original direct day consumer; no scheduler operator or execution authority",
        },
        null,
        2,
      ) + "\n",
    );
    if (result && typeof result === "object" && "schemaVersion" in result) {
      await fs.writeFile(
        path.join(directory, "native-day-report.json"),
        JSON.stringify(result, null, 2) + "\n",
      );
    }
    const target = process.env.LCX_FINANCE_DAY_PLAN_PROOF_DIR;
    if (target) {
      await fs.mkdir(target, { recursive: true });
      await fs.cp(directory, path.join(target, name), { recursive: true });
    }
    expect(network).not.toHaveBeenCalled();
  }
  return { producer, prices, input, retain };
}
describe("original reviewed plan -> actual daily portfolio consumer", () => {
  it.each([0.4, 0.2])(
    "uses original rule budget %s in actual account target weights",
    async (allocation) => {
      const p = await native(`budget-${allocation}`, allocation);
      const result = await runFinanceDailyCycle(p.input);
      await p.retain(result);
      expect(result.ok).toBe(true);
      expect(result.portfolio?.accountId).toBe(p.input.portfolioPlan.accountId);
      expect(result.targets[0].weight).toBeCloseTo(allocation);
      expect(result.placed).toEqual([]);
      expect(result.modelCalls).toBe(0);
      expect(p.prices.calls.length).toBeGreaterThan(0);
      const ledger = await readFinanceBarLedger(p.producer.book);
      expect(ledger.bars.length).toBeGreaterThan(400);
    },
  );
  it.each([0.4, 0.2])(
    "consumes budget %s through the original same-cycle scheduler plan path",
    async (allocation) => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "native-scheduled-day-"));
      roots.push(directory);
      const network = vi.fn(() => {
        throw new Error("external network forbidden");
      });
      vi.stubGlobal("fetch", network);
      const result = await probeOriginalFinanceSchedulerPlan({
        directory,
        allocation,
        dailyExecutableRule: true,
        dayChildConsumer: async ({ directory: book, planPath, nativeProducer, signal }) => {
          signal.throwIfAborted();
          const plan = financePortfolioPlanSchema.parse(
            JSON.parse(await fs.readFile(planPath, "utf8")),
          );
          expect(plan).toEqual(nativeProducer.planReadback);
          const rule = nativeProducer.ruleRead.ledger.rules.find(
            (entry) => entry.ruleId === "private-trend",
          )!;
          const strategy = bindFinanceDailyStrategy([rule]);
          const prices = privateDayHistory(plan.asOf);
          seam.fetchImpl = prices.fetchImpl;
          const report = await runFinanceDailyCycle({
            instruments: strategy.instruments,
            equity: 100000,
            asOf: plan.asOf,
            caps: { maxOrderNotional: 10000, maxInstrumentNotional: 50000, maxOrdersPerRun: 2 },
            runAuthorizationId: `private-preview:${plan.provenance!.receiptId}`,
            portfolioPlan: plan,
            trendStrategies: [strategy],
            directory: book,
            venue: "paper",
            place: false,
          });
          signal.throwIfAborted();
          await fs.writeFile(
            path.join(directory, "native-scheduled-day-report.json"),
            JSON.stringify(report, null, 2) + "\n",
          );
          await fs.writeFile(
            path.join(directory, "captured-price-io.json"),
            JSON.stringify(prices.calls) + "\n",
          );
          expect(report.targets[0].weight).toBeCloseTo(allocation);
          expect(report.placed).toEqual([]);
          return {
            ok: report.ok,
            status: report.ok ? "succeeded" : "failed",
            exitCode: report.ok ? 0 : 2,
            signal: null,
            stdout: JSON.stringify(report) + "\n",
            stderr: "",
            outputTruncated: false,
          };
        },
      });
      const debugTarget = process.env.LCX_FINANCE_DAY_PLAN_PROOF_DIR;
      if (debugTarget) {
        await fs.mkdir(debugTarget, { recursive: true });
        await fs.cp(directory, path.join(debugTarget, `scheduler-budget-${allocation}`), {
          recursive: true,
        });
      }
      expect(result.accepted, JSON.stringify(result.record)).toBe(true);
      expect(result.record.researchPlanRefresh.planPath).toBe(result.planPath);
      expect(result.children).toHaveLength(2);
      expect(network).not.toHaveBeenCalled();
      const target = process.env.LCX_FINANCE_DAY_PLAN_PROOF_DIR;
      if (target) {
        await fs.mkdir(target, { recursive: true });
        await fs.cp(directory, path.join(target, `scheduler-budget-${allocation}`), {
          recursive: true,
        });
      }
    },
  );

  it("refuses incomplete price evidence without redistributing the reviewed budget", async () => {
    const p = await native("missing-prices", 0.4, true);
    const error = await runFinanceDailyCycle(p.input).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("incomplete evidence cannot redistribute");
    await p.retain({ capturedOriginalException: (error as Error).message });
  });
  it("refuses a portfolio bound to another account before any placement price IO", async () => {
    const p = await native("account-conflict");
    const error = await runFinanceDailyCycle({
      ...p.input,
      place: true,
      venue: "alpaca",
      portfolioPlan: { ...p.input.portfolioPlan, venue: "alpaca" },
      accountId: "different-private-account",
      accountBookProvider: async () => {
        throw new Error("account IO must not run");
      },
      createSafetyContext: () => {
        throw new Error("order IO must not run");
      },
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("account does not match");
    expect(p.prices.calls).toEqual([]);
    await p.retain({ capturedOriginalException: (error as Error).message });
  });
  it.each(["expired", "venue"] as const)("refuses %s plan before market IO", async (fault) => {
    const p = await native(fault);
    const plan = {
      ...p.input.portfolioPlan,
      ...(fault === "expired"
        ? { validUntil: new Date(Date.parse(p.input.asOf) - 1).toISOString() }
        : { venue: "alpaca" as const }),
    };
    const error = await runFinanceDailyCycle({ ...p.input, portfolioPlan: plan }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("stale, future-dated or belongs to another venue");
    expect(p.prices.calls).toEqual([]);
    await p.retain({ capturedOriginalException: (error as Error).message });
  });
});
