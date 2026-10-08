import {
  AlpacaIntradayBarsUnavailableError,
  syncAlpacaIntradayBars,
} from "./finance-alpaca-intraday.js";
import {
  financeAlpacaMarketSessionIssue,
  type FinanceAlpacaMarketSession,
  type FinanceAlpacaMarketSessionResolver,
} from "./finance-alpaca-market-calendar.js";
import { caseflowFingerprint } from "./finance-caseflow.js";
import {
  financeEtClock,
  financeUsEquityLocalTimeInstant,
  FINANCE_TRADING_WEEKDAYS,
} from "./finance-cycle-schedule.js";
import {
  appendFinanceIntradayDecision,
  readFinanceIntradayDecisions,
  readFinanceIntradayOutcome,
} from "./finance-intraday-control-ledger.js";
import { readFinanceIntradayLedger } from "./finance-intraday-ledger.js";
import {
  FINANCE_INTRADAY_OPENING_RANGE_FORM,
  FINANCE_INTRADAY_OPENING_RANGE_RULE_V2,
  FINANCE_INTRADAY_OPENING_RANGE_RULE_V3,
  financeIntradayPreCloseExitBarMinute,
  resolveFinanceIntradayActiveRuleContract,
  type FinanceIntradayActiveRuleContract,
  type FinanceIntradayMonitorScope,
} from "./finance-intraday-paper.js";
import {
  readFinanceIntradayOwnedPositions,
  receiptsForIntradayStrategy,
} from "./finance-intraday-position.js";
import { evaluateFinanceIntradaySignal } from "./finance-intraday-signal.js";
import { readFinancePositionRecords } from "./finance-position-ledger.js";
import { readFinanceResearchEquityUniverseSnapshot } from "./finance-research-runner.js";
import { readFinanceStrategyRuleLedger } from "./finance-strategy-rule-ledger.js";
import {
  normalizeUsEquityProtectionPrices,
  type UsEquityPriceNormalizationProvenance,
} from "./finance-us-equity-price-normalization.js";

function decisionForOpenIntradayPosition(params: {
  decisions: Awaited<ReturnType<typeof readFinanceIntradayDecisions>>;
  openLots: Awaited<ReturnType<typeof readFinanceIntradayOwnedPositions>>["openLots"];
  instrument: string;
  quantity: number;
}) {
  const byIntent = new Map<string, { intentId: string; quantity: number }>();
  for (const lot of params.openLots) {
    if (lot.instrument !== params.instrument || lot.quantity <= 1e-6) {
      continue;
    }
    const current = byIntent.get(lot.intentId) ?? { intentId: lot.intentId, quantity: 0 };
    current.quantity += lot.quantity;
    byIntent.set(lot.intentId, current);
  }
  const openLots = [...byIntent.values()];
  if (
    openLots.length !== 1 ||
    Math.abs(openLots[0].quantity - params.quantity) > 1e-6 ||
    !openLots[0].intentId.startsWith("intent:")
  ) {
    return null;
  }
  const signalId = openLots[0].intentId.slice("intent:".length);
  return params.decisions.find((record) => record.input.signalId === signalId) ?? null;
}

export type FinanceIntradayMonitorOptions = Readonly<{
  directory: string;
  accountId?: string;
  exitOnly?: boolean;
  instrument: string;
  intervalSeconds: 60 | 300 | 900;
  feed: "iex" | "sip";
  openingRangeBars: number;
  rewardRisk: number;
  strategyContract?: FinanceIntradayActiveRuleContract;
  scope?: FinanceIntradayMonitorScope;
  now?: Date;
  signal?: AbortSignal;
  sync?: typeof syncAlpacaIntradayBars;
  resolveMarketSession?: FinanceAlpacaMarketSessionResolver;
}>;

/** Resolve the existing cash-session gate before constructing expensive stock targets. */
export async function resolveFinanceIntradayCashSession(
  options: Pick<FinanceIntradayMonitorOptions, "now" | "signal" | "resolveMarketSession">,
) {
  let now = options.now ?? new Date();
  let clock = financeEtClock(now);
  if (!FINANCE_TRADING_WEEKDAYS.includes(clock.weekday)) {
    return Object.freeze({ status: "outside_cash_session" as const, clock });
  }
  if (!options.resolveMarketSession) {
    return Object.freeze({ status: "blocked_missing_market_calendar" as const, clock });
  }
  let marketSession: FinanceAlpacaMarketSession | null;
  try {
    marketSession = await options.resolveMarketSession(clock.date, options.signal);
  } catch {
    return Object.freeze({ status: "blocked_market_calendar_unavailable" as const, clock });
  }
  if (options.now === undefined) {
    now = new Date();
    clock = financeEtClock(now);
    if (!FINANCE_TRADING_WEEKDAYS.includes(clock.weekday)) {
      return Object.freeze({ status: "outside_cash_session" as const, clock });
    }
  }
  if (!marketSession) {
    return Object.freeze({ status: "market_closed" as const, clock });
  }
  const marketOpenAt = Date.parse(marketSession.openAt);
  const marketCloseAt = Date.parse(marketSession.closeAt);
  const marketSessionIssue = financeAlpacaMarketSessionIssue(marketSession, {
    asOf: now.toISOString(),
    maxObservedAgeMs: 5 * 60_000,
  });
  if (marketSession.date !== clock.date || marketSessionIssue !== null) {
    return Object.freeze({ status: "blocked_invalid_market_calendar" as const, clock });
  }
  if (now.getTime() < marketOpenAt || now.getTime() >= marketCloseAt) {
    return Object.freeze({ status: "outside_cash_session" as const, clock });
  }
  return Object.freeze({ status: "cash_session_open" as const, now, clock, marketSession });
}

export async function runFinanceIntradayMonitorTick(options: FinanceIntradayMonitorOptions) {
  const session = await resolveFinanceIntradayCashSession(options);
  if (session.status !== "cash_session_open") {
    return session;
  }
  const { now, clock, marketSession } = session;
  const marketOpenAt = Date.parse(marketSession.openAt);
  const marketCloseAt = Date.parse(marketSession.closeAt);
  if (!options.strategyContract || !options.scope) {
    return Object.freeze({ status: "blocked_missing_strategy_binding" as const, clock });
  }
  const instrument = options.instrument.trim().toUpperCase();
  const strategyRead = await readFinanceStrategyRuleLedger(options.directory);
  const activeRules = strategyRead.ledger.rules.filter(
    (rule) =>
      rule.form === FINANCE_INTRADAY_OPENING_RANGE_FORM &&
      (options.exitOnly
        ? rule.ruleId === options.strategyContract?.ruleId &&
          (rule.state === "retired" ||
            (rule.state === "active" &&
              rule.body.paperUniverseScope === "fresh_us_equity_selection_v1"))
        : rule.state === "active"),
  );
  if (activeRules.length !== 1) {
    return Object.freeze({
      status: "blocked_active_strategy_missing_or_ambiguous" as const,
      clock,
    });
  }
  let activeContract: FinanceIntradayActiveRuleContract;
  try {
    activeContract = resolveFinanceIntradayActiveRuleContract(activeRules[0], {
      allowRetiredExit: options.exitOnly,
    });
  } catch {
    return Object.freeze({ status: "blocked_incompatible_active_strategy" as const, clock });
  }
  if (
    options.strategyContract.ruleId !== activeContract.ruleId ||
    options.strategyContract.formVersion !== activeContract.formVersion ||
    options.strategyContract.preCloseExitEnabled !== activeContract.preCloseExitEnabled ||
    activeContract.declarationRef !== options.strategyContract.declarationRef ||
    activeContract.activationRef !== options.strategyContract.activationRef ||
    JSON.stringify([...activeContract.instruments].toSorted()) !==
      JSON.stringify([...options.strategyContract.instruments].toSorted()) ||
    activeContract.openingRangeBars !== options.openingRangeBars ||
    activeContract.rewardRisk !== options.rewardRisk ||
    activeContract.intervalSeconds !== options.intervalSeconds ||
    activeContract.feed !== options.feed ||
    activeContract.openingRangeBars !== options.strategyContract.openingRangeBars ||
    activeContract.rewardRisk !== options.strategyContract.rewardRisk ||
    activeContract.intervalSeconds !== options.strategyContract.intervalSeconds ||
    activeContract.feed !== options.strategyContract.feed ||
    activeContract.paperUniverseScope !== options.strategyContract.paperUniverseScope ||
    activeContract.eligibility.status !== options.strategyContract.eligibility.status ||
    activeContract.eligibility.automatedPaperPlacementAllowed !==
      options.strategyContract.eligibility.automatedPaperPlacementAllowed
  ) {
    return Object.freeze({
      status: "blocked_stale_or_incompatible_strategy_contract" as const,
      clock,
    });
  }
  if (
    options.scope.kind === "strategy_universe" &&
    !activeContract.instruments.includes(instrument)
  ) {
    return Object.freeze({ status: "blocked_outside_strategy_universe" as const, clock });
  }
  if (
    options.scope.kind === "system_universe" &&
    (!/^[a-f0-9]{64}$/u.test(options.scope.universeSnapshotRef ?? "") ||
      (!options.scope.selectedInstruments?.includes(instrument) &&
        !(
          options.exitOnly && activeContract.paperUniverseScope === "fresh_us_equity_selection_v1"
        )))
  ) {
    return Object.freeze({ status: "blocked_invalid_system_universe_snapshot" as const, clock });
  }
  if (options.scope.kind === "system_universe") {
    try {
      const snapshot = readFinanceResearchEquityUniverseSnapshot(
        options.directory,
        now.toISOString(),
      );
      if (
        caseflowFingerprint(snapshot) !== options.scope.universeSnapshotRef ||
        JSON.stringify(snapshot.selected) !== JSON.stringify(options.scope.selectedInstruments) ||
        (!snapshot.selected.includes(instrument) &&
          !(
            options.exitOnly && activeContract.paperUniverseScope === "fresh_us_equity_selection_v1"
          ))
      ) {
        return Object.freeze({
          status: "blocked_invalid_system_universe_snapshot" as const,
          clock,
        });
      }
    } catch {
      return Object.freeze({
        status: "blocked_invalid_system_universe_snapshot" as const,
        clock,
      });
    }
  }
  if (
    options.scope.kind === "explicit_diagnostic" &&
    options.scope.universeSnapshotRef !== undefined
  ) {
    return Object.freeze({ status: "blocked_invalid_monitor_scope" as const, clock });
  }
  if (
    options.scope.kind === "managed_position_exit" &&
    (!options.exitOnly ||
      activeContract.paperUniverseScope !== "fresh_us_equity_selection_v1" ||
      !options.accountId?.trim())
  ) {
    return Object.freeze({ status: "blocked_invalid_monitor_scope" as const, clock });
  }
  if (
    activeContract.paperUniverseScope === "fresh_us_equity_selection_v1" &&
    options.scope.kind !== "system_universe" &&
    options.scope.kind !== "managed_position_exit"
  ) {
    return Object.freeze({ status: "blocked_invalid_monitor_scope" as const, clock });
  }
  const sync = options.sync ?? syncAlpacaIntradayBars;
  // Resume at the first missing session bar, not a rolling twelve-hour replay.
  // Feed-scoped reads prevent a previous feed from satisfying this feed's coverage.
  const priorBars = await readFinanceIntradayLedger(options.directory, {
    instrument,
    feed: options.feed,
  });
  const intervalMs = options.intervalSeconds * 1_000;
  const starts = new Set(
    priorBars.bars
      .filter((bar) => bar.intervalSeconds === options.intervalSeconds)
      .map((bar) => Date.parse(bar.startAt)),
  );
  let syncStart = marketOpenAt;
  while (syncStart + intervalMs <= now.getTime() && starts.has(syncStart)) {
    syncStart += intervalMs;
  }
  let syncReceipt: Awaited<ReturnType<typeof syncAlpacaIntradayBars>> | null;
  try {
    syncReceipt =
      syncStart + intervalMs > now.getTime()
        ? null
        : await sync({
            directory: options.directory,
            instrument,
            start: new Date(syncStart).toISOString(),
            end: now.toISOString(),
            intervalSeconds: options.intervalSeconds,
            feed: options.feed,
            now: () => now,
            signal: options.signal,
          });
  } catch (error) {
    options.signal?.throwIfAborted();
    if (!(error instanceof AlpacaIntradayBarsUnavailableError)) {
      throw error;
    }
    // Stop this tick even if cached bars exist. An empty fresh read cannot admit
    // a decision from old prices; the original unavailable status carries its scope.
    return Object.freeze({
      status: "no_closed_session_bar" as const,
      clock,
      syncReceipt: error.observation,
      datasetHeadRef: priorBars.headRef,
    });
  }
  const intraday = await readFinanceIntradayLedger(options.directory, {
    instrument,
    feed: options.feed,
  });
  if (!intraday.headRef) {
    return Object.freeze({ status: "no_intraday_head" as const, clock, syncReceipt });
  }
  const sessionBars = intraday.bars.filter((bar) => {
    const barStartAt = Date.parse(bar.startAt);
    return (
      financeEtClock(new Date(bar.startAt)).date === clock.date &&
      barStartAt >= marketOpenAt &&
      barStartAt < marketCloseAt &&
      bar.intervalSeconds === options.intervalSeconds &&
      Date.parse(bar.endAt) <= now.getTime()
    );
  });
  if (sessionBars.length === 0) {
    return Object.freeze({ status: "no_closed_session_bar" as const, clock, syncReceipt });
  }

  const dynamicSystemEntry =
    options.scope.kind === "system_universe" &&
    activeContract.paperUniverseScope === "fresh_us_equity_selection_v1" &&
    options.scope.selectedInstruments?.includes(instrument) === true;
  const managedDynamicExit =
    options.exitOnly &&
    options.scope.kind === "managed_position_exit" &&
    activeContract.paperUniverseScope === "fresh_us_equity_selection_v1";
  if (
    !activeContract.instruments.includes(instrument) &&
    !dynamicSystemEntry &&
    !managedDynamicExit
  ) {
    return Object.freeze({
      status: "research_only" as const,
      clock,
      syncReceipt,
      signal: evaluateFinanceIntradaySignal({
        bars: sessionBars,
        openingRangeBars: options.openingRangeBars,
        rewardRisk: options.rewardRisk,
        ...(activeContract.preCloseExitEnabled ? { marketOpenAt: marketSession.openAt } : {}),
      }),
      datasetHeadRef: intraday.headRef,
      executionAuthority: "none" as const,
    });
  }
  const positionRecords = await readFinancePositionRecords(options.directory);
  const intradayBook = await readFinanceIntradayOwnedPositions({
    directory: options.directory,
    accountId: options.accountId,
    instrument,
    receipts: positionRecords.receipts,
  });
  const position = intradayBook.positions.find(
    (item) => item.instrument === instrument && item.quantity !== 0,
  );
  if (options.exitOnly && (!options.accountId || !position)) {
    return Object.freeze({ status: "exit_only_no_owned_position" as const, clock, syncReceipt });
  }
  if (position && position.quantity < 0) {
    return Object.freeze({ status: "blocked_short_position" as const, clock, syncReceipt });
  }
  const decisions = await readFinanceIntradayDecisions(options.directory, { instrument });
  const sessionDecisions = decisions.filter((record) => record.input.sessionDate === clock.date);
  const sessionBuys = sessionDecisions.filter((record) => record.input.action === "buy");
  const sessionSells = sessionDecisions.filter((record) => record.input.action === "sell");
  const latestBar = sessionBars.at(-1)!;
  let entryDecision: (typeof decisions)[number] | null = null;
  let managedExitProof:
    | {
        accountId: string;
        entryDecisionRef: string;
        entryReceiptId: string;
        positionQuantity: number;
      }
    | undefined;

  if (position) {
    const strategyReceipts = receiptsForIntradayStrategy(
      positionRecords.receipts,
      options.accountId,
    );
    entryDecision = decisionForOpenIntradayPosition({
      decisions,
      openLots: intradayBook.openLots,
      instrument,
      quantity: position.quantity,
    });
    if (managedDynamicExit && entryDecision && options.accountId?.trim()) {
      const entryReceipt = strategyReceipts.find(
        (receipt) =>
          receipt.accountId === options.accountId &&
          receipt.venue === "alpaca:paper" &&
          receipt.instrument === instrument &&
          receipt.intentId === `intent:${entryDecision!.input.signalId}` &&
          receipt.side === "buy" &&
          receipt.fill.filledQuantity > 0 &&
          receipt.fill.terminalOrderIdentity?.terminal === true &&
          Boolean(receipt.fill.terminalOrderIdentity.orderId.trim()),
      );
      if (
        entryReceipt &&
        entryDecision.input.strategyRule === activeContract.ruleId &&
        entryDecision.input.strategyBinding?.declarationRef === activeContract.declarationRef &&
        entryDecision.input.strategyBinding?.activationRef === activeContract.activationRef &&
        entryDecision.input.strategyBinding?.scope === "system_universe"
      ) {
        managedExitProof = {
          accountId: options.accountId,
          entryDecisionRef: entryDecision.ref,
          entryReceiptId: entryReceipt.receiptId,
          positionQuantity: position.quantity,
        };
      }
    }
    if (
      !entryDecision ||
      (options.exitOnly &&
        (entryDecision.input.strategyRule !== activeContract.ruleId ||
          entryDecision.input.strategyBinding?.declarationRef !== activeContract.declarationRef ||
          entryDecision.input.strategyBinding?.activationRef !== activeContract.activationRef)) ||
      !entryDecision.input.stopPrice ||
      !entryDecision.input.targetPrice ||
      !entryDecision.input.strategyBinding ||
      entryDecision.input.strategyBinding.parameters.intervalSeconds !== options.intervalSeconds
    ) {
      return Object.freeze({
        status: "blocked_position_without_strategy_state" as const,
        clock,
        syncReceipt,
      });
    }
    if (managedDynamicExit && !managedExitProof) {
      return Object.freeze({
        status: "blocked_position_without_strategy_state" as const,
        clock,
        syncReceipt,
      });
    }
    const priorOpenSell = decisions
      .filter(
        (record) => record.sequence > entryDecision!.sequence && record.input.action === "sell",
      )
      .at(-1);
    if (priorOpenSell) {
      const outcome = await readFinanceIntradayOutcome(
        options.directory,
        priorOpenSell.input.signalId,
      );
      const recoveredSellReceipt =
        typeof options.accountId === "string" && options.accountId.trim()
          ? strategyReceipts.find(
              (receipt) =>
                receipt.accountId === options.accountId &&
                receipt.venue === "alpaca:paper" &&
                receipt.instrument === priorOpenSell.input.instrument &&
                receipt.intentId === `intent:${priorOpenSell.input.signalId}` &&
                receipt.side === "sell" &&
                receipt.fill.filledQuantity > 0 &&
                receipt.fill.filledQuantity <= receipt.quantity &&
                receipt.fill.terminalOrderIdentity?.terminal === true &&
                Boolean(receipt.fill.terminalOrderIdentity.orderId.trim()),
            )
          : undefined;
      const completedPartialExit =
        recoveredSellReceipt !== undefined &&
        (outcome?.status === "uncertain" ||
          (outcome?.status === "placed" && recoveredSellReceipt.receiptId === outcome.receiptId));
      if (!outcome || (outcome.status !== "refused" && !completedPartialExit)) {
        return Object.freeze({
          status: outcome
            ? ("sell_already_terminal" as const)
            : ("decision_pending_execution" as const),
          clock,
          syncReceipt,
          decision: priorOpenSell,
          ...(outcome ? { outcome } : {}),
        });
      }
      if (Date.parse(latestBar.endAt) <= Date.parse(priorOpenSell.input.referencePriceAt)) {
        return Object.freeze({
          status: "sell_refused_waiting_for_new_bar" as const,
          clock,
          syncReceipt,
          decision: priorOpenSell,
          outcome,
        });
      }
    }
  } else {
    const priorSell = sessionSells.at(-1);
    if (priorSell) {
      const outcome = await readFinanceIntradayOutcome(options.directory, priorSell.input.signalId);
      if (!outcome || outcome.status !== "refused") {
        return Object.freeze({
          status: outcome
            ? ("sell_already_terminal" as const)
            : ("decision_pending_execution" as const),
          clock,
          syncReceipt,
          decision: priorSell,
          ...(outcome ? { outcome } : {}),
        });
      }
      if (Date.parse(latestBar.endAt) <= Date.parse(priorSell.input.referencePriceAt)) {
        return Object.freeze({
          status: "sell_refused_waiting_for_new_bar" as const,
          clock,
          syncReceipt,
          decision: priorSell,
          outcome,
        });
      }
    }
    const priorBuy = sessionBuys.at(-1);
    if (priorBuy) {
      const outcome = await readFinanceIntradayOutcome(options.directory, priorBuy.input.signalId);
      if (!outcome || outcome.status !== "refused") {
        return Object.freeze({
          status: outcome
            ? ("buy_already_terminal" as const)
            : ("decision_pending_execution" as const),
          clock,
          syncReceipt,
          decision: priorBuy,
          ...(outcome ? { outcome } : {}),
        });
      }
      if (Date.parse(latestBar.endAt) <= Date.parse(priorBuy.input.referencePriceAt)) {
        return Object.freeze({
          status: "buy_refused_waiting_for_new_bar" as const,
          clock,
          syncReceipt,
          decision: priorBuy,
          outcome,
        });
      }
    }
  }

  const preCloseBarMinute = financeIntradayPreCloseExitBarMinute(
    options.intervalSeconds,
    marketSession.closeMinute,
  );
  const preCloseBarStartAt = financeUsEquityLocalTimeInstant(clock.date, preCloseBarMinute);
  if (!preCloseBarStartAt) {
    return Object.freeze({ status: "blocked_invalid_market_calendar" as const, clock });
  }
  const preCloseBarStartAtMs = Date.parse(preCloseBarStartAt);
  const preCloseBarEndAtMs = preCloseBarStartAtMs + options.intervalSeconds * 1_000;
  const entryCutoffDue =
    activeContract.preCloseExitEnabled && now.getTime() >= preCloseBarStartAtMs;
  const positionUsesPreCloseExit =
    entryDecision?.input.strategyRule === FINANCE_INTRADAY_OPENING_RANGE_RULE_V2 ||
    entryDecision?.input.strategyRule === FINANCE_INTRADAY_OPENING_RANGE_RULE_V3;
  const positionPreCloseDue = positionUsesPreCloseExit && now.getTime() >= preCloseBarStartAtMs;
  const preCloseBarAvailable =
    positionPreCloseDue &&
    sessionBars.some((bar) => Date.parse(bar.startAt) === preCloseBarStartAtMs);
  const preCloseBarEndMinute = financeEtClock(new Date(preCloseBarEndAtMs)).minutes;

  let signal = evaluateFinanceIntradaySignal({
    bars: sessionBars,
    openingRangeBars: options.openingRangeBars,
    rewardRisk: options.rewardRisk,
    ...(activeContract.preCloseExitEnabled ? { marketOpenAt: marketSession.openAt } : {}),
    ...(position && entryDecision
      ? {
          position: {
            instrument,
            enteredAt: entryDecision.input.referencePriceAt,
            entryPrice: position.averageCost,
            stopPrice: entryDecision.input.stopPrice!,
            targetPrice: entryDecision.input.targetPrice!,
            quantity: position.quantity,
          },
        }
      : {}),
    preCloseExit: positionPreCloseDue && preCloseBarAvailable,
  });
  let priceNormalization: UsEquityPriceNormalizationProvenance | undefined;
  if (signal.action === "buy" && signal.stopPrice !== undefined) {
    const normalized = normalizeUsEquityProtectionPrices({
      instrument,
      assetClass: "us_equity",
      side: "buy",
      entryPrice: signal.referencePrice,
      stopPrice: signal.stopPrice,
      ...(signal.targetPrice === undefined ? {} : { targetPrice: signal.targetPrice }),
      rewardRisk: options.rewardRisk,
    });
    if (!normalized.ok) {
      return Object.freeze({
        status: "research_only" as const,
        reason: `price_contract_refused: ${normalized.refusal}`,
        clock,
        syncReceipt,
        executionAuthority: "none" as const,
      });
    }
    priceNormalization = normalized.provenance;
    signal = {
      ...signal,
      stopPrice: normalized.stopPrice,
      ...(normalized.targetPrice === undefined ? {} : { targetPrice: normalized.targetPrice }),
    };
  }
  if (signal.action === "hold") {
    if (signal.openingRangeGap) {
      return Object.freeze({
        status: "blocked_incomplete_opening_range" as const,
        clock,
        syncReceipt,
        signal,
      });
    }
    if (positionPreCloseDue && !preCloseBarAvailable) {
      return Object.freeze({
        status:
          clock.minutes < preCloseBarEndMinute
            ? ("session_exit_bar_pending" as const)
            : ("session_exit_bar_missing" as const),
        clock,
        syncReceipt,
        signal,
      });
    }
    if (entryCutoffDue) {
      return Object.freeze({ status: "entry_cutoff_reached" as const, clock, syncReceipt, signal });
    }
    return Object.freeze({ status: "no_signal" as const, clock, syncReceipt, signal });
  }
  if (options.exitOnly && signal.action !== "sell") {
    return Object.freeze({ status: "exit_only_no_exit_signal" as const, clock, syncReceipt });
  }
  if (signal.action === "buy" && entryCutoffDue) {
    return Object.freeze({ status: "entry_cutoff_reached" as const, clock, syncReceipt, signal });
  }
  if (signal.reason === "no_trigger") {
    throw new Error("actionable intraday signal cannot have no_trigger reason");
  }
  const appended = await appendFinanceIntradayDecision(options.directory, {
    signalId: signal.signalId,
    instrument,
    sessionDate: clock.date,
    action: signal.action,
    reason: signal.reason,
    referencePrice: signal.referencePrice,
    referencePriceAt: signal.referencePriceAt,
    ...(signal.stopPrice === undefined ? {} : { stopPrice: signal.stopPrice }),
    ...(signal.targetPrice === undefined ? {} : { targetPrice: signal.targetPrice }),
    datasetHeadRef: intraday.headRef,
    strategyRule: activeContract.ruleId,
    strategyBinding: {
      declarationRef: activeContract.declarationRef,
      activationRef: activeContract.activationRef,
      declaredInstruments: [...activeContract.instruments],
      parameters: {
        openingRangeBars: activeContract.openingRangeBars,
        rewardRisk: activeContract.rewardRisk,
        intervalSeconds: activeContract.intervalSeconds,
        feed: activeContract.feed,
      },
      marketSession,
      scope: options.scope.kind,
      ...(options.scope.universeSnapshotRef
        ? { universeSnapshotRef: options.scope.universeSnapshotRef }
        : {}),
      ...(managedExitProof ? { managedExitProof } : {}),
      ...(priceNormalization ? { priceNormalization } : {}),
    },
  });
  return Object.freeze({
    status: appended.appended ? ("decision_recorded" as const) : ("decision_replayed" as const),
    clock,
    syncReceipt,
    signal,
    decision: appended.record,
    executionAuthority: "none" as const,
  });
}
