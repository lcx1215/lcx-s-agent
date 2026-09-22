import { syncAlpacaIntradayBars } from "./finance-alpaca-intraday.js";
import { financeEtClock, FINANCE_TRADING_WEEKDAYS } from "./finance-cycle-schedule.js";
import {
  appendFinanceIntradayDecision,
  readFinanceIntradayDecisions,
  readFinanceIntradayOutcome,
} from "./finance-intraday-control-ledger.js";
import { readFinanceIntradayLedger } from "./finance-intraday-ledger.js";
import { FINANCE_INTRADAY_OPENING_RANGE_RULE } from "./finance-intraday-paper.js";
import { receiptsForIntradayStrategy } from "./finance-intraday-position.js";
import { evaluateFinanceIntradaySignal } from "./finance-intraday-signal.js";
import { projectFinancePositions, readFinancePositionLedger } from "./finance-position-ledger.js";

export type FinanceIntradayMonitorOptions = Readonly<{
  directory: string;
  accountId?: string;
  instrument: string;
  intervalSeconds: 60 | 300 | 900;
  feed: "iex" | "sip";
  openingRangeBars: number;
  rewardRisk: number;
  now?: Date;
  signal?: AbortSignal;
  sync?: typeof syncAlpacaIntradayBars;
}>;

export async function runFinanceIntradayMonitorTick(options: FinanceIntradayMonitorOptions) {
  const now = options.now ?? new Date();
  const clock = financeEtClock(now);
  if (
    !FINANCE_TRADING_WEEKDAYS.includes(clock.weekday) ||
    clock.minutes < 570 ||
    clock.minutes >= 960
  ) {
    return Object.freeze({ status: "outside_cash_session" as const, clock });
  }
  const instrument = options.instrument.trim().toUpperCase();
  const sync = options.sync ?? syncAlpacaIntradayBars;
  const syncReceipt = await sync({
    directory: options.directory,
    instrument,
    start: new Date(now.getTime() - 12 * 60 * 60 * 1_000).toISOString(),
    end: now.toISOString(),
    intervalSeconds: options.intervalSeconds,
    feed: options.feed,
    now: () => now,
    signal: options.signal,
  });
  const intraday = await readFinanceIntradayLedger(options.directory, { instrument });
  if (!intraday.headRef) {
    return Object.freeze({ status: "no_intraday_head" as const, clock, syncReceipt });
  }
  const sessionBars = intraday.bars.filter((bar) => {
    const barClock = financeEtClock(new Date(bar.startAt));
    return (
      barClock.date === clock.date &&
      barClock.minutes >= 570 &&
      barClock.minutes < 960 &&
      Date.parse(bar.endAt) <= now.getTime()
    );
  });
  if (sessionBars.length === 0) {
    return Object.freeze({ status: "no_closed_session_bar" as const, clock, syncReceipt });
  }

  const positionRecords = await readFinancePositionLedger(options.directory);
  const intradayBook = projectFinancePositions({
    receipts: receiptsForIntradayStrategy(positionRecords.receipts, options.accountId),
    marks: positionRecords.marks,
  });
  const position = intradayBook.positions.find(
    (item) => item.instrument === instrument && item.quantity !== 0,
  );
  if (position && position.quantity < 0) {
    return Object.freeze({ status: "blocked_short_position" as const, clock, syncReceipt });
  }
  const decisions = await readFinanceIntradayDecisions(options.directory, {
    instrument,
    sessionDate: clock.date,
  });
  const priorBuy = decisions.find((record) => record.input.action === "buy");
  const priorSell = decisions.find((record) => record.input.action === "sell");
  if (priorSell) {
    const outcome = await readFinanceIntradayOutcome(options.directory, priorSell.input.signalId);
    return Object.freeze(
      outcome
        ? {
            status: "sell_already_terminal" as const,
            clock,
            syncReceipt,
            decision: priorSell,
            outcome,
          }
        : {
            status: "decision_pending_execution" as const,
            clock,
            syncReceipt,
            decision: priorSell,
          },
    );
  }
  if (!position && priorBuy) {
    const outcome = await readFinanceIntradayOutcome(options.directory, priorBuy.input.signalId);
    return Object.freeze(
      outcome
        ? {
            status: "buy_already_terminal" as const,
            clock,
            syncReceipt,
            decision: priorBuy,
            outcome,
          }
        : { status: "decision_pending_execution" as const, clock, syncReceipt, decision: priorBuy },
    );
  }
  if (position && (!priorBuy?.input.stopPrice || !priorBuy.input.targetPrice)) {
    return Object.freeze({
      status: "blocked_position_without_strategy_state" as const,
      clock,
      syncReceipt,
    });
  }

  const signal = evaluateFinanceIntradaySignal({
    bars: sessionBars,
    openingRangeBars: options.openingRangeBars,
    rewardRisk: options.rewardRisk,
    ...(position && priorBuy
      ? {
          position: {
            instrument,
            enteredAt: priorBuy.input.referencePriceAt,
            entryPrice: position.averageCost,
            stopPrice: priorBuy.input.stopPrice!,
            targetPrice: priorBuy.input.targetPrice!,
            quantity: position.quantity,
          },
        }
      : {}),
  });
  if (signal.action === "hold") {
    return Object.freeze({ status: "no_signal" as const, clock, syncReceipt, signal });
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
    strategyRule: FINANCE_INTRADAY_OPENING_RANGE_RULE,
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
