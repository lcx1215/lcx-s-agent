import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FINANCE_ALPACA_MARKET_CALENDAR_SOURCE,
  FINANCE_ALPACA_MARKET_CALENDAR_URL,
  type FinanceAlpacaMarketSession,
} from "./finance-alpaca-market-calendar.js";
import { caseflowFingerprint } from "./finance-caseflow.js";
import { financeUsEquityLocalTimeInstant } from "./finance-cycle-schedule.js";
import { buildFinanceExecutionReceipt } from "./finance-execution-adapter.js";
import {
  appendFinanceIntradayDecision,
  appendFinanceIntradayOutcome,
  readFinanceIntradayDecisions,
} from "./finance-intraday-control-ledger.js";
import { appendFinanceIntradayBars } from "./finance-intraday-ledger.js";
import {
  runFinanceIntradayMonitorTick,
  type FinanceIntradayMonitorOptions,
} from "./finance-intraday-monitor.js";
import {
  resolveFinanceIntradayActiveRuleContract,
  FINANCE_INTRADAY_OPENING_RANGE_RULE_V2,
  FINANCE_INTRADAY_OPENING_RANGE_EMITS,
  FINANCE_INTRADAY_OPENING_RANGE_FORM,
  FINANCE_INTRADAY_OPENING_RANGE_FORM_VERSION,
  FINANCE_INTRADAY_OPENING_RANGE_FORM_VERSION_V2,
  FINANCE_INTRADAY_OPENING_RANGE_RULE,
} from "./finance-intraday-paper.js";
import { readFinanceRetiredIntradayExitTargets } from "./finance-intraday-position.js";
import { appendFinanceExecutionReceipt } from "./finance-position-ledger.js";
import {
  activateFinanceStrategyRule,
  declareFinanceStrategyRule,
  readFinanceStrategyRuleLedger,
  retireFinanceStrategyRule,
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

function fixtureMarketSession(date: string, observedAt: string): FinanceAlpacaMarketSession {
  const openMinute = 570;
  const closeMinute = 960;
  const openAt = financeUsEquityLocalTimeInstant(date, openMinute)!;
  const closeAt = financeUsEquityLocalTimeInstant(date, closeMinute)!;
  const sourceUrlOrArtifact = `${FINANCE_ALPACA_MARKET_CALENDAR_URL}?start=${date}&end=${date}&date_type=TRADING`;
  return {
    date,
    openAt,
    closeAt,
    openMinute,
    closeMinute,
    observedAt,
    calendarRef: caseflowFingerprint({
      source: FINANCE_ALPACA_MARKET_CALENDAR_SOURCE,
      sourceUrlOrArtifact,
      date,
      openAt,
      closeAt,
    }),
    sourceUrlOrArtifact,
  };
}

async function monitorTickWithFixtureCalendar(options: FinanceIntradayMonitorOptions) {
  const asOf = (options.now ?? new Date()).toISOString();
  return runFinanceIntradayMonitorTick({
    ...options,
    resolveMarketSession:
      options.resolveMarketSession ?? (async (date) => fixtureMarketSession(date, asOf)),
  });
}

async function seed(directory: string): Promise<void> {
  const closes = [100, 100.5, 100.2, 100.4, 100.1, 100.3, 101];
  const start = Date.parse("2026-09-18T13:30:00Z");
  await appendFinanceIntradayBars(directory, {
    instrument: "SPY",
    intervalSeconds: 300,
    observedAt: "2026-09-18T15:00:00.000Z",
    provenance: { origin: "monitor fixture", feed: "iex" },
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

function regularSessionBars(
  day: string,
  count = 77,
  options: { breakout?: boolean; lastLow?: number } = {},
) {
  const start = Date.parse(`${day}T13:30:00.000Z`);
  const closes = Array.from({ length: count }, (_, index) => {
    if (index < 6) {
      return index === 1 ? 100.5 : 100;
    }
    return options.breakout ? 101 : 100;
  });
  return closes.map((close, index) => {
    const open = index === 0 ? close : closes[index - 1];
    return {
      startAt: new Date(start + index * 300_000).toISOString(),
      open,
      high: Math.max(open, close),
      low:
        index === count - 1 && options.lastLow !== undefined
          ? options.lastLow
          : Math.min(open, close),
      close,
      volume: 100,
    };
  });
}

async function appendSession(
  directory: string,
  day: string,
  bars = regularSessionBars(day),
): Promise<void> {
  const lastEndAt = new Date(Date.parse(bars.at(-1)!.startAt) + 300_000).toISOString();
  await appendFinanceIntradayBars(directory, {
    instrument: "SPY",
    intervalSeconds: 300,
    observedAt: lastEndAt,
    provenance: { origin: "monitor fixture", feed: "iex" },
    bars,
  });
}

async function activeContract(
  directory: string,
  body: Record<string, unknown> = {
    measuredResult: { status: "paper_contract_only", executionAuthority: "none" },
  },
  requestedRule: {
    ruleId:
      | typeof FINANCE_INTRADAY_OPENING_RANGE_RULE
      | typeof FINANCE_INTRADAY_OPENING_RANGE_RULE_V2;
    formVersion:
      | typeof FINANCE_INTRADAY_OPENING_RANGE_FORM_VERSION
      | typeof FINANCE_INTRADAY_OPENING_RANGE_FORM_VERSION_V2;
  } = {
    ruleId: FINANCE_INTRADAY_OPENING_RANGE_RULE,
    formVersion: FINANCE_INTRADAY_OPENING_RANGE_FORM_VERSION,
  },
) {
  await declareFinanceStrategyRule(directory, {
    kind: "declared",
    ruleId: requestedRule.ruleId,
    form: FINANCE_INTRADAY_OPENING_RANGE_FORM,
    formVersion: requestedRule.formVersion,
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
    ruleId: requestedRule.ruleId,
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
    expect(await monitorTickWithFixtureCalendar(options)).toMatchObject({
      status: "decision_recorded",
      signal: { action: "buy", reason: "opening_range_breakout" },
      executionAuthority: "none",
    });
    expect(await monitorTickWithFixtureCalendar(options)).toMatchObject({
      status: "decision_pending_execution",
      decision: { input: { signalId: expect.stringMatching(/^intraday-/) } },
    });
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it("resumes missing bars and skips a fully collected closed interval, including after restart", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "intraday-incremental-"));
    temporary.push(directory);
    const strategyContract = await activeContract(directory);
    const bars = regularSessionBars("2026-09-18", 7);
    await appendFinanceIntradayBars(directory, {
      instrument: "SPY",
      intervalSeconds: 300,
      observedAt: "2026-09-18T14:05:00Z",
      provenance: { origin: "fixture", feed: "iex" },
      bars: bars.slice(0, 6),
    });
    const sync = vi.fn(async () => {
      await appendFinanceIntradayBars(directory, {
        instrument: "SPY",
        intervalSeconds: 300,
        observedAt: "2026-09-18T14:05:00Z",
        provenance: { origin: "fixture", feed: "iex" },
        bars: bars.slice(6),
      });
      return {} as never;
    });
    const options = {
      directory,
      instrument: "SPY",
      intervalSeconds: 300 as const,
      feed: "iex" as const,
      openingRangeBars: 6,
      rewardRisk: 2,
      strategyContract,
      scope: { kind: "strategy_universe" as const },
      now: new Date("2026-09-18T14:05:30Z"),
      sync,
    };
    await monitorTickWithFixtureCalendar(options);
    expect(sync).toHaveBeenCalledWith(
      expect.objectContaining({ start: "2026-09-18T14:00:00.000Z" }),
    );
    await monitorTickWithFixtureCalendar({ ...options, now: new Date("2026-09-18T14:06:30Z") });
    expect(sync).toHaveBeenCalledOnce();
    await monitorTickWithFixtureCalendar({ ...options, now: new Date("2026-09-18T14:10:30Z") });
    expect(sync).toHaveBeenCalledTimes(2);
    expect(sync).toHaveBeenLastCalledWith(
      expect.objectContaining({ start: "2026-09-18T14:05:00.000Z" }),
    );
  });

  it("keeps out-of-scope research signals out of the execution decision ledger", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "intraday-research-split-"));
    temporary.push(directory);
    const strategyContract = await activeContract(directory);
    const snapshot = { selected: ["SPY", "QQQ"] };
    readerMocks.readUniverse.mockReturnValue(snapshot);
    await appendFinanceIntradayBars(directory, {
      instrument: "QQQ",
      intervalSeconds: 300,
      observedAt: "2026-09-18T14:05:00Z",
      provenance: { origin: "fixture", feed: "iex" },
      bars: regularSessionBars("2026-09-18", 7, { breakout: true }),
    });
    const result = await monitorTickWithFixtureCalendar({
      directory,
      instrument: "QQQ",
      intervalSeconds: 300,
      feed: "iex",
      openingRangeBars: 6,
      rewardRisk: 2,
      strategyContract,
      scope: {
        kind: "system_universe",
        selectedInstruments: snapshot.selected,
        universeSnapshotRef: caseflowFingerprint(snapshot),
      },
      now: new Date("2026-09-18T14:05:30Z"),
      sync: vi.fn(async () => ({}) as never),
    });
    expect(result).toMatchObject({
      status: "research_only",
      executionAuthority: "none",
      signal: { action: "buy" },
    });
    expect(await readFinanceIntradayDecisions(directory)).toEqual([]);
  });

  it("keeps v1 unchanged and blocks v2 entries once the pre-close window starts", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "intraday-monitor-v2-cutoff-"));
    temporary.push(directory);
    const strategyContract = await activeContract(directory, undefined, {
      ruleId: FINANCE_INTRADAY_OPENING_RANGE_RULE_V2,
      formVersion: FINANCE_INTRADAY_OPENING_RANGE_FORM_VERSION_V2,
    });
    await appendSession(
      directory,
      "2026-09-18",
      regularSessionBars("2026-09-18", 77, { breakout: true }),
    );
    const result = await monitorTickWithFixtureCalendar({
      directory,
      instrument: "SPY",
      intervalSeconds: 300 as const,
      feed: "iex" as const,
      openingRangeBars: 6,
      rewardRisk: 2,
      strategyContract,
      scope: { kind: "strategy_universe" as const },
      now: new Date("2026-09-18T19:55:00.000Z"),
      sync: vi.fn(async () => ({}) as never),
    });
    expect(strategyContract).toMatchObject({
      ruleId: FINANCE_INTRADAY_OPENING_RANGE_RULE_V2,
      formVersion: FINANCE_INTRADAY_OPENING_RANGE_FORM_VERSION_V2,
      preCloseExitEnabled: true,
    });
    expect(result).toMatchObject({
      status: "entry_cutoff_reached",
      signal: { action: "buy", reason: "opening_range_breakout" },
    });
    expect(await readFinanceIntradayDecisions(directory)).toHaveLength(0);
  });

  it.each([false, true])(
    "restores inventory across sessions and retirement, pre-close and retry (retired=%s)",
    async (retired) => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "intraday-monitor-v2-recovery-"));
      temporary.push(directory);
      const contract = await activeContract(
        directory,
        { paperExecutionEligibility: "paper_execution_eligible" },
        {
          ruleId: FINANCE_INTRADAY_OPENING_RANGE_RULE_V2,
          formVersion: FINANCE_INTRADAY_OPENING_RANGE_FORM_VERSION_V2,
        },
      );
      const signalId = "intraday-v2-historical-entry";
      const strategyBinding = {
        declarationRef: contract.declarationRef,
        activationRef: contract.activationRef,
        declaredInstruments: [...contract.instruments],
        parameters: {
          openingRangeBars: contract.openingRangeBars,
          rewardRisk: contract.rewardRisk,
          intervalSeconds: contract.intervalSeconds,
          feed: contract.feed,
        },
        scope: "strategy_universe" as const,
      };
      await appendFinanceIntradayDecision(directory, {
        signalId,
        instrument: "SPY",
        sessionDate: "2026-09-17",
        action: "buy",
        reason: "opening_range_breakout",
        referencePrice: 100,
        referencePriceAt: "2026-09-17T19:55:00.000Z",
        stopPrice: 99,
        targetPrice: 110,
        datasetHeadRef: "a".repeat(64),
        strategyRule: FINANCE_INTRADAY_OPENING_RANGE_RULE_V2,
        strategyBinding,
      });
      const entryReceipt = buildFinanceExecutionReceipt({
        intent: {
          intentId: `intent:${signalId}`,
          instrument: "SPY",
          side: "buy",
          orderType: "market",
          quantity: 1,
          referencePrice: 100,
          referencePriceAt: "2026-09-17T19:55:00.000Z",
          runAuthorizationId: "intraday-monitor-v2-fixture",
          rationale: "historical intraday entry fixture",
        },
        adapter: { id: "alpaca-venue", venue: "alpaca:paper", kind: "venue" },
        fill: {
          filledQuantity: 1,
          fillPrice: 100,
          filledAt: "2026-09-17T19:55:01.000Z",
          venueRef: "alpaca:paper:intraday-entry-fixture",
          terminalOrderIdentity: { orderId: "intraday-entry-fixture", terminal: true },
        },
        recordedAt: "2026-09-17T19:55:01.000Z",
        accountId: "paper-account",
      });
      await appendFinanceExecutionReceipt(directory, entryReceipt);
      expect(await readFinanceRetiredIntradayExitTargets(directory, "paper-account")).toEqual([]);
      if (retired) {
        await retireFinanceStrategyRule(directory, {
          kind: "retired",
          ruleId: contract.ruleId,
          observedAt: "2026-09-18T12:00:00.000Z",
        });
        expect(
          await readFinanceRetiredIntradayExitTargets(directory, "paper-account"),
        ).toMatchObject([
          { instrument: "SPY", quantity: 1, contract: { ruleId: contract.ruleId } },
        ]);
        expect(await readFinanceRetiredIntradayExitTargets(directory, "other-account")).toEqual([]);
      }

      await appendSession(directory, "2026-09-18", regularSessionBars("2026-09-18", 76));

      const baseOptions = {
        directory,
        accountId: "paper-account",
        exitOnly: retired,
        instrument: "SPY",
        intervalSeconds: 300 as const,
        feed: "iex" as const,
        openingRangeBars: 6,
        rewardRisk: 2,
        strategyContract: contract,
        scope: { kind: "strategy_universe" as const },
        sync: vi.fn(async () => ({}) as never),
      };
      const pending = await monitorTickWithFixtureCalendar({
        ...baseOptions,
        now: new Date("2026-09-18T19:50:00.000Z"),
      });
      expect(pending.status).toBe("session_exit_bar_pending");
      if (retired) {
        const noOwned = await monitorTickWithFixtureCalendar({
          ...baseOptions,
          accountId: "other-account",
          now: new Date("2026-09-18T19:50:00.000Z"),
        });
        expect(noOwned.status).toBe("exit_only_no_owned_position");
      }
      const missing = await monitorTickWithFixtureCalendar({
        ...baseOptions,
        now: new Date("2026-09-18T19:55:00.000Z"),
      });
      expect(missing.status).toBe("session_exit_bar_missing");

      await appendSession(directory, "2026-09-18", [regularSessionBars("2026-09-18", 77).at(-1)!]);
      const first = await monitorTickWithFixtureCalendar({
        ...baseOptions,
        now: new Date("2026-09-18T19:55:00.000Z"),
      });
      expect(first).toMatchObject({
        status: "decision_recorded",
        signal: { action: "sell", reason: "pre_close" },
        decision: { input: { strategyRule: FINANCE_INTRADAY_OPENING_RANGE_RULE_V2 } },
      });
      if (!("decision" in first)) {
        throw new Error("expected the pre-close decision to be recorded");
      }
      await appendFinanceIntradayOutcome(directory, {
        signalId: first.decision.input.signalId,
        status: "refused",
        reasons: ["fixture refusal"],
      });

      await appendSession(
        directory,
        "2026-09-21",
        regularSessionBars("2026-09-21", 5, { lastLow: 98 }),
      );
      const retry = await monitorTickWithFixtureCalendar({
        directory,
        accountId: "paper-account",
        exitOnly: retired,
        instrument: "SPY",
        intervalSeconds: 300,
        feed: "iex",
        openingRangeBars: 6,
        rewardRisk: 2,
        strategyContract: contract,
        scope: { kind: "strategy_universe" },
        now: new Date("2026-09-21T13:55:00.000Z"),
        sync: vi.fn(async () => ({}) as never),
      });
      expect(retry).toMatchObject({
        status: "decision_recorded",
        signal: { action: "sell", reason: "opening_range_stop" },
      });
      if (retired && "decision" in retry) {
        const fillExit = async (signalId: string, date: string) => {
          const receipt = buildFinanceExecutionReceipt({
            intent: {
              intentId: `intent:${signalId}`,
              instrument: "SPY",
              side: "sell",
              orderType: "market",
              quantity: 0.5,
              referencePrice: 98,
              referencePriceAt: `${date}T13:55:00.000Z`,
              runAuthorizationId: "fixture-exit",
              rationale: "fixture exit",
            },
            adapter: { id: "alpaca-venue", venue: "alpaca:paper", kind: "venue" },
            fill: {
              filledQuantity: 0.5,
              fillPrice: 98,
              filledAt: `${date}T13:55:01.000Z`,
              venueRef: `alpaca:paper:${date}`,
              terminalOrderIdentity: { orderId: date, terminal: true },
            },
            recordedAt: `${date}T13:55:01.000Z`,
            accountId: "paper-account",
          });
          await appendFinanceExecutionReceipt(directory, receipt);
          await appendFinanceIntradayOutcome(directory, {
            signalId,
            status: "placed",
            receiptId: receipt.receiptId,
            reasons: [],
          });
        };
        await fillExit(retry.decision.input.signalId, "2026-09-21");
        expect(
          await readFinanceRetiredIntradayExitTargets(directory, "paper-account"),
        ).toMatchObject([{ instrument: "SPY", quantity: 0.5 }]);
        await appendSession(
          directory,
          "2026-09-22",
          regularSessionBars("2026-09-22", 5, { lastLow: 98 }),
        );
        const remaining = await monitorTickWithFixtureCalendar({
          ...baseOptions,
          now: new Date("2026-09-22T13:55:00.000Z"),
        });
        expect(remaining).toMatchObject({
          status: "decision_recorded",
          signal: { action: "sell", reason: "opening_range_stop" },
        });
        if (!("decision" in remaining)) {
          throw new Error("missing residual exit");
        }
        await fillExit(remaining.decision.input.signalId, "2026-09-22");
        expect(await readFinanceRetiredIntradayExitTargets(directory, "paper-account")).toEqual([]);
      }
    },
  );

  it("does not touch the data source outside the cash session", async () => {
    const sync = vi.fn(async () => ({}) as never);
    const result = await monitorTickWithFixtureCalendar({
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
    await expect(monitorTickWithFixtureCalendar(base)).resolves.toMatchObject({
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
      monitorTickWithFixtureCalendar({
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
    const result = await monitorTickWithFixtureCalendar({
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
    const result = await monitorTickWithFixtureCalendar({
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
    const result = await monitorTickWithFixtureCalendar({
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
    const result = await monitorTickWithFixtureCalendar({
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
