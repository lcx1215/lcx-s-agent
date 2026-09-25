import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { caseflowFingerprint } from "./finance-caseflow.js";
import { appendFinanceIntradayBars } from "./finance-intraday-ledger.js";
import { runFinanceIntradayMonitorTick } from "./finance-intraday-monitor.js";
import {
  resolveFinanceIntradayActiveRuleContract,
  FINANCE_INTRADAY_OPENING_RANGE_EMITS,
  FINANCE_INTRADAY_OPENING_RANGE_FORM,
  FINANCE_INTRADAY_OPENING_RANGE_FORM_VERSION,
  FINANCE_INTRADAY_OPENING_RANGE_RULE,
} from "./finance-intraday-paper.js";
import {
  activateFinanceStrategyRule,
  declareFinanceStrategyRule,
  readFinanceStrategyRuleLedger,
} from "./finance-strategy-rule-ledger.js";

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

async function seed(directory: string): Promise<void> {
  const closes = [100, 100.5, 100.2, 100.4, 100.1, 100.3, 101];
  const start = Date.parse("2026-09-18T13:30:00Z");
  await appendFinanceIntradayBars(directory, {
    instrument: "SPY",
    intervalSeconds: 300,
    observedAt: "2026-09-18T15:00:00.000Z",
    provenance: { origin: "monitor fixture" },
    bars: closes.map((close, index) => {
      const open = index === 0 ? close : closes[index - 1];
      return {
        startAt: new Date(start + index * 300_000).toISOString(),
        open,
        high: Math.max(open, close),
        low: Math.min(open, close),
        close,
        volume: 100,
      };
    }),
  });
}

async function activeContract(
  directory: string,
  body: Record<string, unknown> = {
    measuredResult: { status: "paper_contract_only", executionAuthority: "none" },
  },
) {
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
      ...body,
    },
    observedAt: "2026-09-17T00:00:00Z",
  });
  await activateFinanceStrategyRule(directory, {
    kind: "activated",
    ruleId: FINANCE_INTRADAY_OPENING_RANGE_RULE,
    reason: "generic Paper activation must not override machine eligibility",
    observedAt: "2026-09-17T00:01:00Z",
  });
  const read = await readFinanceStrategyRuleLedger(directory);
  const rule = read.ledger.rules[0];
  if (!rule) {
    throw new Error("expected active ORB fixture");
  }
  return resolveFinanceIntradayActiveRuleContract(rule);
}

describe("resident intraday monitor tick", () => {
  it("records one durable buy decision and does not repeat it after restart", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "intraday-monitor-"));
    temporary.push(directory);
    await seed(directory);
    const strategyContract = await activeContract(directory);
    const sync = vi.fn(async () => ({}) as never);
    const options = {
      directory,
      instrument: "SPY",
      intervalSeconds: 300 as const,
      feed: "iex" as const,
      openingRangeBars: 6,
      rewardRisk: 2,
      strategyContract,
      scope: { kind: "strategy_universe" as const },
      now: new Date("2026-09-18T15:00:00.000Z"),
      sync,
    };
    expect(await runFinanceIntradayMonitorTick(options)).toMatchObject({
      status: "decision_recorded",
      signal: { action: "buy", reason: "opening_range_breakout" },
      executionAuthority: "none",
    });
    expect(await runFinanceIntradayMonitorTick(options)).toMatchObject({
      status: "decision_pending_execution",
      decision: { input: { signalId: expect.stringMatching(/^intraday-/) } },
    });
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it("does not touch the data source outside the cash session", async () => {
    const sync = vi.fn(async () => ({}) as never);
    const result = await runFinanceIntradayMonitorTick({
      directory: "/not-used",
      instrument: "SPY",
      intervalSeconds: 300,
      feed: "iex",
      openingRangeBars: 6,
      rewardRisk: 2,
      now: new Date("2026-09-19T15:00:00.000Z"),
      sync,
    });
    expect(result.status).toBe("outside_cash_session");
    expect(sync).not.toHaveBeenCalled();
  });

  it("fails closed before syncing when the active declaration is missing or ambiguous", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "intraday-monitor-rule-"));
    temporary.push(directory);
    const sync = vi.fn(async () => ({}) as never);
    const base = {
      directory,
      instrument: "SPY",
      intervalSeconds: 300 as const,
      feed: "iex" as const,
      openingRangeBars: 6,
      rewardRisk: 2,
      now: new Date("2026-09-18T15:00:00.000Z"),
      sync,
    };
    await expect(runFinanceIntradayMonitorTick(base)).resolves.toMatchObject({
      status: "blocked_missing_strategy_binding",
    });
    expect(sync).not.toHaveBeenCalled();
    const contract = await activeContract(directory);
    await declareFinanceStrategyRule(directory, {
      kind: "declared",
      ruleId: "ambiguous_orb",
      form: FINANCE_INTRADAY_OPENING_RANGE_FORM,
      formVersion: FINANCE_INTRADAY_OPENING_RANGE_FORM_VERSION,
      instruments: ["SPY"],
      emits: FINANCE_INTRADAY_OPENING_RANGE_EMITS,
      schedule: { kind: "intraday" },
      body: {
        universe: ["SPY"],
        frozenRule: { openingRangeBars: 6, rewardRisk: 2 },
        data: { intervalSeconds: 300, feed: "iex" },
      },
      observedAt: "2026-09-17T00:00:00Z",
    });
    await activateFinanceStrategyRule(directory, {
      kind: "activated",
      ruleId: "ambiguous_orb",
      observedAt: "2026-09-17T00:01:00Z",
    });
    await expect(
      runFinanceIntradayMonitorTick({
        ...base,
        strategyContract: contract,
        scope: { kind: "strategy_universe" },
      }),
    ).resolves.toMatchObject({ status: "blocked_active_strategy_missing_or_ambiguous" });
    expect(sync).not.toHaveBeenCalled();
  });

  it("refuses a stale parameter snapshot even if an active ORB rule remains available", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "intraday-monitor-stale-"));
    temporary.push(directory);
    const contract = await activeContract(directory);
    const sync = vi.fn(async () => ({}) as never);
    const result = await runFinanceIntradayMonitorTick({
      directory,
      instrument: "SPY",
      intervalSeconds: 300,
      feed: "iex",
      openingRangeBars: 6,
      rewardRisk: 2,
      strategyContract: { ...contract, rewardRisk: 3 },
      scope: { kind: "strategy_universe" },
      now: new Date("2026-09-18T15:00:00.000Z"),
      sync,
    });
    expect(result.status).toBe("blocked_stale_or_incompatible_strategy_contract");
    expect(sync).not.toHaveBeenCalled();
  });

  it("allows dynamic-universe research monitoring without granting the static ORB rule new execution scope", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "intraday-monitor-universe-"));
    temporary.push(directory);
    const contract = await activeContract(directory);
    const snapshot = { selected: ["SPY", "QQQ"] } as never;
    readerMocks.readUniverse.mockReturnValue(snapshot);
    const sync = vi.fn(async () => ({}) as never);
    const result = await runFinanceIntradayMonitorTick({
      directory,
      instrument: "QQQ",
      intervalSeconds: 300,
      feed: "iex",
      openingRangeBars: 6,
      rewardRisk: 2,
      strategyContract: contract,
      scope: {
        kind: "system_universe",
        universeSnapshotRef: caseflowFingerprint(snapshot),
        selectedInstruments: ["SPY", "QQQ"],
      },
      now: new Date("2026-09-18T15:00:00.000Z"),
      sync,
    });
    expect(result.status).toBe("no_intraday_head");
    expect(sync).toHaveBeenCalledOnce();
  });

  it("rejects malformed or out-of-snapshot system candidates before data sync", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "intraday-monitor-snapshot-"));
    temporary.push(directory);
    const contract = await activeContract(directory);
    const sync = vi.fn(async () => ({}) as never);
    const result = await runFinanceIntradayMonitorTick({
      directory,
      instrument: "QQQ",
      intervalSeconds: 300,
      feed: "iex",
      openingRangeBars: 6,
      rewardRisk: 2,
      strategyContract: contract,
      scope: {
        kind: "system_universe",
        universeSnapshotRef: "bad-ref",
        selectedInstruments: ["SPY"],
      },
      now: new Date("2026-09-18T15:00:00.000Z"),
      sync,
    });
    expect(result.status).toBe("blocked_invalid_system_universe_snapshot");
    expect(sync).not.toHaveBeenCalled();
  });

  it("fails closed when the validated dynamic snapshot reader is stale or unavailable", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "intraday-monitor-stale-universe-"));
    temporary.push(directory);
    const contract = await activeContract(directory);
    readerMocks.readUniverse.mockImplementation(() => {
      throw new Error("equity universe snapshot is stale");
    });
    const sync = vi.fn(async () => ({}) as never);
    const result = await runFinanceIntradayMonitorTick({
      directory,
      instrument: "SPY",
      intervalSeconds: 300,
      feed: "iex",
      openingRangeBars: 6,
      rewardRisk: 2,
      strategyContract: contract,
      scope: {
        kind: "system_universe",
        universeSnapshotRef: "a".repeat(64),
        selectedInstruments: ["SPY"],
      },
      now: new Date("2026-09-18T15:00:00.000Z"),
      sync,
    });
    expect(result.status).toBe("blocked_invalid_system_universe_snapshot");
    expect(sync).not.toHaveBeenCalled();
  });
});
