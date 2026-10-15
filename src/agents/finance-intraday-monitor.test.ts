import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { syncAlpacaIntradayBars } from "./finance-alpaca-intraday.js";
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
  FINANCE_INTRADAY_OPENING_RANGE_RULE_V3,
  FINANCE_INTRADAY_OPENING_RANGE_EMITS,
  FINANCE_INTRADAY_OPENING_RANGE_FORM,
  FINANCE_INTRADAY_OPENING_RANGE_FORM_VERSION,
  FINANCE_INTRADAY_OPENING_RANGE_FORM_VERSION_V2,
  FINANCE_INTRADAY_OPENING_RANGE_FORM_VERSION_V3,
  FINANCE_INTRADAY_OPENING_RANGE_RULE,
} from "./finance-intraday-paper.js";
import {
  readFinanceDynamicIntradayExitTargets,
  readFinanceRetiredIntradayExitTargets,
} from "./finance-intraday-position.js";
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

const readerMocks = vi.hoisted(() => ({ readUniverse: vi.fn() }));
vi.mock("./finance-research-runner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./finance-research-runner.js")>();
  return { ...actual, readFinanceResearchEquityUniverseSnapshot: readerMocks.readUniverse };
});

const temporary: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
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

it("stops on an observed empty data response rather than deciding from cached session prices", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "intraday-empty-source-"));
  temporary.push(directory);
  const strategyContract = await activeContract(directory);
  await seed(directory);
  const result = await monitorTickWithFixtureCalendar({
    directory,
    instrument: "SPY",
    intervalSeconds: 300,
    feed: "iex",
    openingRangeBars: 6,
    rewardRisk: 2,
    strategyContract,
    scope: { kind: "strategy_universe" },
    now: new Date("2026-09-18T15:15:00.000Z"),
    sync: (options) =>
      syncAlpacaIntradayBars({
        ...options,
        credentials: { apiKeyId: "key", apiSecretKey: "secret" },
        read: vi.fn().mockResolvedValue({
          status: 200,
          body: JSON.stringify({ bars: null, symbol: "SPY", next_page_token: null }),
        }),
      }),
  });
  expect(result).toMatchObject({
    status: "no_closed_session_bar",
    syncReceipt: { status: "unavailable", reason: "no_closed_bars", append: null },
  });
  expect(result).not.toHaveProperty("decision");
  expect(result).not.toHaveProperty("signal");
  expect(await readFinanceIntradayDecisions(directory)).toEqual([]);
});

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
    ruleId: string;
    formVersion:
      | typeof FINANCE_INTRADAY_OPENING_RANGE_FORM_VERSION
      | typeof FINANCE_INTRADAY_OPENING_RANGE_FORM_VERSION_V2
      | typeof FINANCE_INTRADAY_OPENING_RANGE_FORM_VERSION_V3;
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

async function seedUncertainPartialSell(
  receiptAccountId?: string,
  outcomeStatus: "uncertain" | "placed" = "uncertain",
  receiptInstrument = "SPY",
  receiptVenue = "alpaca:paper",
) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "intraday-uncertain-partial-sell-"));
  temporary.push(directory);
  const contract = await activeContract(
    directory,
    {
      paperExecutionEligibility: "paper_execution_eligible",
    },
    {
      ruleId: FINANCE_INTRADAY_OPENING_RANGE_RULE_V2,
      formVersion: FINANCE_INTRADAY_OPENING_RANGE_FORM_VERSION_V2,
    },
  );
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
  const entrySignalId = "intraday-partial-entry";
  await appendFinanceIntradayDecision(directory, {
    signalId: entrySignalId,
    instrument: "SPY",
    sessionDate: "2026-09-17",
    action: "buy",
    reason: "opening_range_breakout",
    referencePrice: 100,
    referencePriceAt: "2026-09-17T19:55:00.000Z",
    stopPrice: 99,
    targetPrice: 110,
    datasetHeadRef: "b".repeat(64),
    strategyRule: contract.ruleId,
    strategyBinding,
  });
  const entryReceipt = buildFinanceExecutionReceipt({
    intent: {
      intentId: `intent:${entrySignalId}`,
      instrument: "SPY",
      side: "buy",
      orderType: "market",
      quantity: 1,
      referencePrice: 100,
      referencePriceAt: "2026-09-17T19:55:00.000Z",
      runAuthorizationId: "uncertain-partial-exit-fixture",
      rationale: "fixture entry",
    },
    adapter: { id: "alpaca-venue", venue: "alpaca:paper", kind: "venue" },
    fill: {
      filledQuantity: 1,
      fillPrice: 100,
      filledAt: "2026-09-17T19:55:01.000Z",
      venueRef: "alpaca:paper:entry",
      terminalOrderIdentity: { orderId: "entry", terminal: true },
    },
    recordedAt: "2026-09-17T19:55:01.000Z",
    accountId: "paper-account",
  });
  await appendFinanceExecutionReceipt(directory, entryReceipt);
  await appendSession(directory, "2026-09-18", regularSessionBars("2026-09-18", 76));
  const baseOptions = {
    directory,
    accountId: "paper-account",
    instrument: "SPY",
    intervalSeconds: 300 as const,
    feed: "iex" as const,
    openingRangeBars: 6,
    rewardRisk: 2,
    strategyContract: contract,
    scope: { kind: "strategy_universe" as const },
    sync: vi.fn(async () => ({}) as never),
  };
  await monitorTickWithFixtureCalendar({
    ...baseOptions,
    now: new Date("2026-09-18T19:50:00.000Z"),
  });
  await appendSession(directory, "2026-09-18", [regularSessionBars("2026-09-18", 77).at(-1)!]);
  const exit = await monitorTickWithFixtureCalendar({
    ...baseOptions,
    now: new Date("2026-09-18T19:55:00.000Z"),
  });
  if (!("decision" in exit) || exit.decision.input.action !== "sell") {
    throw new Error(`fixture should record a pre-close sell: ${JSON.stringify(exit)}`);
  }
  let recoveredReceiptId: string | undefined;
  if (receiptAccountId !== undefined) {
    const receipt = buildFinanceExecutionReceipt({
      intent: {
        intentId: `intent:${exit.decision.input.signalId}`,
        instrument: receiptInstrument,
        side: "sell",
        orderType: "market",
        quantity: 0.5,
        referencePrice: 100,
        referencePriceAt: "2026-09-18T19:55:00.000Z",
        runAuthorizationId: "uncertain-partial-exit-fixture",
        rationale: "fixture partial sell",
      },
      adapter: { id: "alpaca-venue", venue: receiptVenue, kind: "venue" },
      fill: {
        filledQuantity: 0.5,
        fillPrice: 100,
        filledAt: "2026-09-18T19:55:01.000Z",
        venueRef: `${receiptVenue}:partial-exit`,
        terminalOrderIdentity: { orderId: "partial-exit", terminal: true },
      },
      recordedAt: "2026-09-18T19:55:01.000Z",
      accountId: receiptAccountId,
    });
    await appendFinanceExecutionReceipt(directory, receipt);
    recoveredReceiptId = receipt.receiptId;
  }
  await appendFinanceIntradayOutcome(directory, {
    signalId: exit.decision.input.signalId,
    status: outcomeStatus,
    ...(outcomeStatus === "placed" && recoveredReceiptId ? { receiptId: recoveredReceiptId } : {}),
    reasons: ["fixture broker terminal fill recovered later"],
  });
  return { directory, baseOptions, sellDecision: exit.decision };
}

describe("resident intraday monitor tick", () => {
  it("requires a versioned v3 declaration before dynamic-universe Paper scope is accepted", async () => {
    const legacyDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "intraday-dynamic-v2-refusal-"),
    );
    temporary.push(legacyDirectory);
    await expect(
      activeContract(
        legacyDirectory,
        { paperUniverseScope: "fresh_us_equity_selection_v1" },
        {
          ruleId: FINANCE_INTRADAY_OPENING_RANGE_RULE_V2,
          formVersion: FINANCE_INTRADAY_OPENING_RANGE_FORM_VERSION_V2,
        },
      ),
    ).rejects.toThrow(/version\/scope mismatch/u);

    const dynamicDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "intraday-dynamic-v3-"));
    temporary.push(dynamicDirectory);
    const contract = await activeContract(
      dynamicDirectory,
      { paperUniverseScope: "fresh_us_equity_selection_v1" },
      {
        ruleId: FINANCE_INTRADAY_OPENING_RANGE_RULE_V3,
        formVersion: FINANCE_INTRADAY_OPENING_RANGE_FORM_VERSION_V3,
      },
    );
    expect(contract).toMatchObject({
      ruleId: FINANCE_INTRADAY_OPENING_RANGE_RULE_V3,
      formVersion: FINANCE_INTRADAY_OPENING_RANGE_FORM_VERSION_V3,
      preCloseExitEnabled: true,
      paperUniverseScope: "fresh_us_equity_selection_v1",
    });
    const notExitOnly = await monitorTickWithFixtureCalendar({
      directory: dynamicDirectory,
      instrument: "SPY",
      intervalSeconds: 300,
      feed: "iex",
      openingRangeBars: 6,
      rewardRisk: 2,
      strategyContract: contract,
      scope: { kind: "managed_position_exit" },
      now: new Date("2026-09-18T15:00:00.000Z"),
    });
    expect(notExitOnly.status).toBe("blocked_invalid_monitor_scope");
    const seedIsNotSelection = await monitorTickWithFixtureCalendar({
      directory: dynamicDirectory,
      instrument: "SPY",
      intervalSeconds: 300,
      feed: "iex",
      openingRangeBars: 6,
      rewardRisk: 2,
      strategyContract: contract,
      scope: { kind: "strategy_universe" },
      now: new Date("2026-09-18T15:00:00.000Z"),
    });
    expect(seedIsNotSelection.status).toBe("blocked_invalid_monitor_scope");
  });

  it("retains only same-account canonical positions outside the fresh dynamic entry snapshot", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "intraday-dynamic-exit-target-"));
    temporary.push(directory);
    const contract = await activeContract(
      directory,
      {
        paperUniverseScope: "fresh_us_equity_selection_v1",
        paperExecutionEligibility: "paper_execution_eligible",
      },
      {
        ruleId: FINANCE_INTRADAY_OPENING_RANGE_RULE_V3,
        formVersion: FINANCE_INTRADAY_OPENING_RANGE_FORM_VERSION_V3,
      },
    );
    const oldSnapshotRef = caseflowFingerprint({ selected: ["QQQ"] });
    const entry = await appendFinanceIntradayDecision(directory, {
      signalId: "intraday-dynamic-position-entry",
      instrument: "QQQ",
      sessionDate: "2026-09-17",
      action: "buy",
      reason: "opening_range_breakout",
      referencePrice: 100,
      referencePriceAt: "2026-09-17T19:55:00.000Z",
      stopPrice: 99,
      targetPrice: 102,
      datasetHeadRef: "e".repeat(64),
      strategyRule: contract.ruleId,
      strategyBinding: {
        declarationRef: contract.declarationRef,
        activationRef: contract.activationRef,
        declaredInstruments: [...contract.instruments],
        parameters: {
          openingRangeBars: contract.openingRangeBars,
          rewardRisk: contract.rewardRisk,
          intervalSeconds: contract.intervalSeconds,
          feed: contract.feed,
        },
        scope: "system_universe",
        universeSnapshotRef: oldSnapshotRef,
      },
    });
    const receipt = buildFinanceExecutionReceipt({
      intent: {
        intentId: `intent:${entry.record.input.signalId}`,
        instrument: "QQQ",
        side: "buy",
        orderType: "market",
        quantity: 2,
        referencePrice: 100,
        referencePriceAt: "2026-09-17T19:55:00.000Z",
        runAuthorizationId: "dynamic-exit-fixture",
        rationale: "fixture confirmed entry",
      },
      adapter: { id: "alpaca-venue", venue: "alpaca:paper", kind: "venue" },
      fill: {
        filledQuantity: 2,
        fillPrice: 100,
        filledAt: "2026-09-17T19:55:01.000Z",
        venueRef: "alpaca:paper:dynamic-entry",
        terminalOrderIdentity: { orderId: "dynamic-entry", terminal: true },
      },
      recordedAt: "2026-09-17T19:55:01.000Z",
      accountId: "paper-account",
    });
    await appendFinanceExecutionReceipt(directory, receipt);
    expect(
      await readFinanceDynamicIntradayExitTargets(directory, "paper-account", ["MSFT"]),
    ).toEqual([{ instrument: "QQQ", quantity: 2, contract }]);
    expect(
      await readFinanceDynamicIntradayExitTargets(directory, "other-account", ["MSFT"]),
    ).toEqual([]);
    expect(
      await readFinanceDynamicIntradayExitTargets(directory, "paper-account", ["QQQ"]),
    ).toEqual([]);
    expect(await readFinanceDynamicIntradayExitTargets(directory, "paper-account", [])).toEqual([
      { instrument: "QQQ", quantity: 2, contract },
    ]);
    await retireFinanceStrategyRule(directory, {
      kind: "retired",
      ruleId: contract.ruleId,
      observedAt: "2026-09-18T20:00:00.000Z",
      reason: "fixture retirement keeps owned position managed",
    });
    const liveSignalId = "intraday-dynamic-live-not-paper";
    await appendFinanceIntradayDecision(directory, {
      signalId: liveSignalId,
      instrument: "QQQ",
      sessionDate: "2026-09-17",
      action: "buy",
      reason: "opening_range_breakout",
      referencePrice: 100,
      referencePriceAt: "2026-09-17T19:55:00.000Z",
      stopPrice: 99,
      targetPrice: 102,
      datasetHeadRef: "f".repeat(64),
      strategyRule: contract.ruleId,
      strategyBinding: {
        declarationRef: contract.declarationRef,
        activationRef: contract.activationRef,
        declaredInstruments: [...contract.instruments],
        parameters: {
          openingRangeBars: contract.openingRangeBars,
          rewardRisk: contract.rewardRisk,
          intervalSeconds: contract.intervalSeconds,
          feed: contract.feed,
        },
        scope: "system_universe",
        universeSnapshotRef: oldSnapshotRef,
      },
    });
    await appendFinanceExecutionReceipt(
      directory,
      buildFinanceExecutionReceipt({
        intent: {
          intentId: `intent:${liveSignalId}`,
          instrument: "QQQ",
          side: "buy",
          orderType: "market",
          quantity: 20,
          referencePrice: 100,
          referencePriceAt: "2026-09-17T19:55:00.000Z",
          runAuthorizationId: "dynamic-live-not-paper",
          rationale: "same account live receipt must not be borrowed by Paper exit ownership",
        },
        adapter: { id: "alpaca-venue", venue: "alpaca:live", kind: "venue" },
        fill: {
          filledQuantity: 20,
          fillPrice: 100,
          filledAt: "2026-09-17T19:55:01.000Z",
          venueRef: "alpaca:live:dynamic-entry",
          terminalOrderIdentity: { orderId: "dynamic-live-entry", terminal: true },
        },
        recordedAt: "2026-09-17T19:55:01.000Z",
        accountId: "paper-account",
      }),
    );
    expect(await readFinanceRetiredIntradayExitTargets(directory, "paper-account")).toEqual([
      { instrument: "QQQ", quantity: 2, contract },
    ]);
  });

  it.each([0, 1, 2])(
    "updates managed exits after a native stop fills %s of 2 owned shares",
    async (stoppedQuantity) => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "intraday-dynamic-managed-exit-"));
      temporary.push(directory);
      const contract = await activeContract(
        directory,
        { paperUniverseScope: "fresh_us_equity_selection_v1" },
        {
          ruleId: FINANCE_INTRADAY_OPENING_RANGE_RULE_V3,
          formVersion: FINANCE_INTRADAY_OPENING_RANGE_FORM_VERSION_V3,
        },
      );
      const priorSnapshotRef = caseflowFingerprint({ selected: ["QQQ"] });
      const entry = await appendFinanceIntradayDecision(directory, {
        signalId: "intraday-dynamic-exit-entry",
        instrument: "QQQ",
        sessionDate: "2026-09-18",
        action: "buy",
        reason: "opening_range_breakout",
        referencePrice: 100,
        referencePriceAt: "2026-09-18T13:55:00.000Z",
        stopPrice: 99,
        targetPrice: 102,
        datasetHeadRef: "d".repeat(64),
        strategyRule: contract.ruleId,
        strategyBinding: {
          declarationRef: contract.declarationRef,
          activationRef: contract.activationRef,
          declaredInstruments: [...contract.instruments],
          parameters: {
            openingRangeBars: contract.openingRangeBars,
            rewardRisk: contract.rewardRisk,
            intervalSeconds: contract.intervalSeconds,
            feed: contract.feed,
          },
          scope: "system_universe",
          universeSnapshotRef: priorSnapshotRef,
        },
      });
      const entryReceipt = buildFinanceExecutionReceipt({
        intent: {
          intentId: `intent:${entry.record.input.signalId}`,
          instrument: "QQQ",
          side: "buy",
          orderType: "market",
          quantity: 2,
          referencePrice: 100,
          referencePriceAt: "2026-09-18T13:55:00.000Z",
          runAuthorizationId: "dynamic-exit-entry",
          rationale: "fixture entry",
        },
        adapter: { id: "alpaca-venue", venue: "alpaca:paper", kind: "venue" },
        fill: {
          filledQuantity: 2,
          fillPrice: 100,
          filledAt: "2026-09-18T13:56:00.000Z",
          venueRef: "alpaca:paper:dynamic-exit-entry",
          terminalOrderIdentity: { orderId: "dynamic-exit-entry", terminal: true },
        },
        recordedAt: "2026-09-18T13:56:00.000Z",
        accountId: "paper-account",
      });
      await appendFinanceExecutionReceipt(directory, entryReceipt);
      if (stoppedQuantity > 0) {
        const child = {
          id: "dynamic-native-stop",
          symbol: "QQQ",
          side: "sell",
          type: "stop",
          order_class: "oto",
          status: stoppedQuantity === 2 ? "filled" : "partially_filled",
          qty: "2",
          filled_qty: String(stoppedQuantity),
          filled_at: "2026-09-18T14:00:00.000Z",
          updated_at: "2026-09-18T14:00:00.000Z",
        };
        await appendFinanceBrokerHistory(directory, {
          kind: "broker_history",
          accountId: "paper-account",
          venue: "alpaca:paper",
          query: "orders:native-stop-fixture",
          cursor: "",
          payload: [
            {
              id: "dynamic-exit-entry",
              symbol: "QQQ",
              side: "buy",
              type: "market",
              order_class: "oto",
              status: "filled",
              qty: "2",
              filled_qty: "2",
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
          query: "activities:native-stop-fixture",
          cursor: "",
          payload: [
            {
              id: "dynamic-stop-fill",
              activity_type: "FILL",
              type: stoppedQuantity === 2 ? "fill" : "partial_fill",
              order_id: child.id,
              symbol: "QQQ",
              side: "sell",
              qty: String(stoppedQuantity),
              price: "98",
              transaction_time: child.filled_at,
            },
          ],
        });
      }
      const bars = regularSessionBars("2026-09-18", 7, { lastLow: 98 });
      const observedAt = new Date(Date.parse(bars.at(-1)!.startAt) + 300_000).toISOString();
      await appendFinanceIntradayBars(directory, {
        instrument: "QQQ",
        intervalSeconds: 300,
        observedAt,
        provenance: { origin: "dynamic managed-exit fixture", feed: "iex" },
        bars,
      });
      const result = await monitorTickWithFixtureCalendar({
        directory,
        instrument: "QQQ",
        intervalSeconds: 300,
        feed: "iex",
        openingRangeBars: 6,
        rewardRisk: 2,
        strategyContract: contract,
        scope: { kind: "managed_position_exit" },
        accountId: "paper-account",
        exitOnly: true,
        now: new Date("2026-09-18T15:00:00.000Z"),
        sync: vi.fn(async () => ({}) as never),
      });
      if (stoppedQuantity === 2) {
        expect(result.status).toBe("exit_only_no_owned_position");
        expect(await readFinanceDynamicIntradayExitTargets(directory, "paper-account", [])).toEqual(
          [],
        );
        await retireFinanceStrategyRule(directory, {
          kind: "retired",
          ruleId: contract.ruleId,
          observedAt: "2026-09-18T15:01:00.000Z",
          reason: "fixture terminal native stop already closed owned position",
        });
        expect(await readFinanceRetiredIntradayExitTargets(directory, "paper-account")).toEqual([]);
        return;
      }
      expect(await readFinanceDynamicIntradayExitTargets(directory, "paper-account", [])).toEqual([
        { instrument: "QQQ", quantity: 2 - stoppedQuantity, contract },
      ]);
      expect(result).toMatchObject({
        status: "decision_recorded",
        signal: { action: "sell", reason: "opening_range_stop" },
        decision: {
          input: {
            instrument: "QQQ",
            strategyBinding: {
              managedExitProof: {
                accountId: "paper-account",
                entryDecisionRef: entry.record.ref,
                entryReceiptId: entryReceipt.receiptId,
                positionQuantity: 2 - stoppedQuantity,
              },
            },
          },
        },
      });
    },
  );

  it("uses the post-resolution time for an unpinned live clock", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "intraday-calendar-clock-race-"));
    temporary.push(directory);
    const strategyContract = await activeContract(directory);
    const initial = new Date("2026-09-18T15:00:00.000Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(initial);
    const sync = vi.fn(async () => ({}) as never);
    const result = await runFinanceIntradayMonitorTick({
      directory,
      instrument: "SPY",
      intervalSeconds: 300,
      feed: "iex",
      openingRangeBars: 6,
      rewardRisk: 2,
      strategyContract,
      scope: { kind: "strategy_universe" },
      sync,
      resolveMarketSession: async (date) => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        vi.setSystemTime(new Date(initial.getTime() + 100));
        return fixtureMarketSession(date, new Date().toISOString());
      },
    });
    expect(result.status).toBe("no_intraday_head");
    expect(sync).toHaveBeenCalledOnce();
  });

  it("keeps an explicit offline as-of when the calendar resolves later", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "intraday-calendar-explicit-asof-"));
    temporary.push(directory);
    const strategyContract = await activeContract(directory);
    const explicitAsOf = new Date("2026-09-18T15:00:00.000Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(explicitAsOf);
    const sync = vi.fn(async () => ({}) as never);
    const result = await runFinanceIntradayMonitorTick({
      directory,
      instrument: "SPY",
      intervalSeconds: 300,
      feed: "iex",
      openingRangeBars: 6,
      rewardRisk: 2,
      strategyContract,
      scope: { kind: "strategy_universe" },
      now: explicitAsOf,
      sync,
      resolveMarketSession: async (date) => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        vi.setSystemTime(new Date(explicitAsOf.getTime() + 100));
        return fixtureMarketSession(date, new Date().toISOString());
      },
    });
    expect(result.status).toBe("blocked_invalid_market_calendar");
    expect(sync).not.toHaveBeenCalled();
  });

  it("still rejects a genuinely future calendar observation", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "intraday-calendar-future-asof-"));
    temporary.push(directory);
    const strategyContract = await activeContract(directory);
    const now = new Date("2026-09-18T15:00:00.000Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    const sync = vi.fn(async () => ({}) as never);
    const result = await runFinanceIntradayMonitorTick({
      directory,
      instrument: "SPY",
      intervalSeconds: 300,
      feed: "iex",
      openingRangeBars: 6,
      rewardRisk: 2,
      strategyContract,
      scope: { kind: "strategy_universe" },
      sync,
      resolveMarketSession: async (date) =>
        fixtureMarketSession(date, new Date(now.getTime() + 100).toISOString()),
    });
    expect(result.status).toBe("blocked_invalid_market_calendar");
    expect(sync).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "canonical partial receipt",
      receiptAccountId: "paper-account",
      nextBar: true,
      expected: "decision_recorded",
    },
    {
      label: "placed partial receipt",
      receiptAccountId: "paper-account",
      outcomeStatus: "placed" as const,
      nextBar: true,
      expected: "decision_recorded",
    },
    {
      label: "no receipt",
      receiptAccountId: undefined,
      nextBar: true,
      expected: "sell_already_terminal",
    },
    {
      label: "wrong-account receipt",
      receiptAccountId: "other-account",
      nextBar: true,
      expected: "sell_already_terminal",
    },
    {
      label: "wrong-instrument receipt",
      receiptAccountId: "paper-account",
      receiptInstrument: "MSFT",
      nextBar: true,
      expected: "sell_already_terminal",
    },
    {
      label: "non-paper receipt",
      receiptAccountId: "paper-account",
      receiptVenue: "alpaca:live",
      nextBar: true,
      expected: "sell_already_terminal",
    },
    {
      label: "unbound monitor account",
      receiptAccountId: "paper-account",
      omitAccountId: true,
      nextBar: true,
      expected: "sell_already_terminal",
    },
    {
      label: "same bar",
      receiptAccountId: "paper-account",
      nextBar: false,
      expected: "sell_refused_waiting_for_new_bar",
    },
  ])(
    "continues residual-position exit management after uncertain sell only with $label",
    async (scenario) => {
      const f = await seedUncertainPartialSell(
        scenario.receiptAccountId,
        scenario.outcomeStatus,
        scenario.receiptInstrument,
        scenario.receiptVenue,
      );
      if (scenario.nextBar) {
        await appendSession(
          f.directory,
          "2026-09-21",
          regularSessionBars("2026-09-21", 5, { lastLow: 98 }),
        );
      }
      const { accountId: _accountId, ...unboundOptions } = f.baseOptions;
      const result = await monitorTickWithFixtureCalendar({
        ...(scenario.omitAccountId ? unboundOptions : f.baseOptions),
        now: new Date(scenario.nextBar ? "2026-09-21T13:55:00.000Z" : "2026-09-18T19:55:00.000Z"),
      });
      expect(result.status).toBe(scenario.expected);
      if (scenario.expected === "decision_recorded") {
        expect(result).toMatchObject({ signal: { action: "sell", reason: "opening_range_stop" } });
      }
      expect(await readFinanceIntradayDecisions(f.directory)).toHaveLength(
        scenario.expected === "decision_recorded" ? 3 : 2,
      );
    },
  );

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

  it.each([false, true])(
    "blocks incomplete fixed opening evidence for calendar-bound dynamic=$0",
    async (dynamic) => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "intraday-opening-gap-"));
      temporary.push(directory);
      const contract = await activeContract(
        directory,
        dynamic ? { paperUniverseScope: "fresh_us_equity_selection_v1" } : undefined,
        dynamic
          ? {
              ruleId: FINANCE_INTRADAY_OPENING_RANGE_RULE_V3,
              formVersion: FINANCE_INTRADAY_OPENING_RANGE_FORM_VERSION_V3,
            }
          : {
              ruleId: FINANCE_INTRADAY_OPENING_RANGE_RULE_V2,
              formVersion: FINANCE_INTRADAY_OPENING_RANGE_FORM_VERSION_V2,
            },
      );
      await appendSession(
        directory,
        "2026-09-18",
        regularSessionBars("2026-09-18", 8, { breakout: true }).filter((_, index) => index !== 5),
      );
      const snapshot = { selected: ["SPY"] } as never;
      readerMocks.readUniverse.mockReturnValue(snapshot);
      const result = await monitorTickWithFixtureCalendar({
        directory,
        instrument: "SPY",
        intervalSeconds: 300,
        feed: "iex",
        openingRangeBars: 6,
        rewardRisk: 2,
        strategyContract: contract,
        scope: dynamic
          ? {
              kind: "system_universe",
              universeSnapshotRef: caseflowFingerprint(snapshot),
              selectedInstruments: ["SPY"],
            }
          : { kind: "strategy_universe" },
        now: new Date("2026-09-18T14:10:00.000Z"),
        sync: vi.fn(async () => ({}) as never),
      });
      expect(result).toMatchObject({
        status: "blocked_incomplete_opening_range",
        signal: {
          action: "hold",
          openingRangeGap: { missingBarStarts: ["2026-09-18T13:55:00.000Z"] },
        },
      });
      expect(await readFinanceIntradayDecisions(directory)).toHaveLength(0);
    },
  );

  it("keeps a calendar-bound owned-position stop actionable with a missing opening slot", async () => {
    const fixture = await seedUncertainPartialSell("paper-account");
    await appendSession(
      fixture.directory,
      "2026-09-21",
      regularSessionBars("2026-09-21", 8, { lastLow: 98 }).filter((_, index) => index !== 5),
    );
    const result = await monitorTickWithFixtureCalendar({
      ...fixture.baseOptions,
      now: new Date("2026-09-21T14:10:00.000Z"),
    });
    expect(result).toMatchObject({
      status: "decision_recorded",
      signal: { action: "sell", reason: "opening_range_stop" },
    });
    if ("signal" in result) {
      expect(result.signal.openingRangeGap).toBeUndefined();
    }
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

  it.each([
    { retired: false, ruleId: FINANCE_INTRADAY_OPENING_RANGE_RULE_V2 },
    { retired: true, ruleId: FINANCE_INTRADAY_OPENING_RANGE_RULE_V2 },
    { retired: false, ruleId: "research_new_timing_identity" },
    { retired: true, ruleId: "research_new_timing_identity" },
  ])(
    "restores inventory across sessions and retirement, pre-close and retry ($ruleId retired=$retired)",
    async ({ retired, ruleId }) => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "intraday-monitor-v2-recovery-"));
      temporary.push(directory);
      const contract = await activeContract(
        directory,
        { paperExecutionEligibility: "paper_execution_eligible" },
        {
          ruleId,
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
        strategyRule: ruleId,
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
        decision: { input: { strategyRule: ruleId } },
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

  it("records a fresh-snapshot symbol only for an explicitly dynamic Paper rule and persists normalized protection", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "intraday-monitor-dynamic-paper-"));
    temporary.push(directory);
    const contract = await activeContract(
      directory,
      {
        paperUniverseScope: "fresh_us_equity_selection_v1",
      },
      {
        ruleId: FINANCE_INTRADAY_OPENING_RANGE_RULE_V3,
        formVersion: FINANCE_INTRADAY_OPENING_RANGE_FORM_VERSION_V3,
      },
    );
    const bars = regularSessionBars("2026-09-18", 7, { breakout: true });
    const observedAt = new Date(Date.parse(bars.at(-1)!.startAt) + 300_000).toISOString();
    await appendFinanceIntradayBars(directory, {
      instrument: "QQQ",
      intervalSeconds: 300,
      observedAt,
      provenance: { origin: "dynamic-universe fixture", feed: "iex" },
      bars,
    });
    const snapshot = { selected: ["QQQ"] } as never;
    readerMocks.readUniverse.mockReturnValue(snapshot);
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
        selectedInstruments: ["QQQ"],
      },
      now: new Date("2026-09-18T15:00:00.000Z"),
      sync: vi.fn(async () => ({}) as never),
    });
    expect(result).toMatchObject({
      status: "decision_recorded",
      signal: { action: "buy", reason: "opening_range_breakout" },
      decision: {
        input: {
          instrument: "QQQ",
          strategyBinding: {
            declaredInstruments: ["SPY"],
            scope: "system_universe",
            universeSnapshotRef: caseflowFingerprint(snapshot),
            priceNormalization: {
              policyVersion: "alpaca_us_equity_stop_precision_v1",
              instrument: "QQQ",
            },
          },
        },
      },
    });
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
