/**
 * Wall-clock scheduling for the unattended finance cycle.
 *
 * Kept free of I/O and of the operator script so it can be tested directly: the two decisions
 * that matter are "what time is it in the market's time zone" and "is this slot due", and both
 * are easy to get wrong in a way that only shows up months later (DST, weekends, double-fire).
 *
 * Scheduling is expressed in America/New_York wall clock and resolved through `Intl`, so DST
 * transitions are the runtime's problem rather than a hard-coded UTC offset.
 */

export const FINANCE_MARKET_TZ = "America/New_York";

export const FINANCE_TRADING_WEEKDAYS = Object.freeze(["Mon", "Tue", "Wed", "Thu", "Fri"]);

export type FinanceCycleSlot = Readonly<{
  mode: "day" | "night";
  hour: number;
  minute: number;
}>;

/**
 * `day` sits inside the US cash session (09:30-16:00 ET) so a rebalance can still be filled the
 * same day; `night` sits after the close, which is where matured outcomes are settled.
 */
export const DEFAULT_FINANCE_CYCLE_SLOTS: readonly FinanceCycleSlot[] = Object.freeze([
  Object.freeze({ mode: "day", hour: 15, minute: 30 }),
  Object.freeze({ mode: "night", hour: 17, minute: 30 }),
]);

export type FinanceEtClock = Readonly<{
  /** Calendar date in the market time zone, `YYYY-MM-DD`. */
  date: string;
  /** Short weekday in the market time zone, e.g. `Mon`. */
  weekday: string;
  /** Minutes past midnight in the market time zone. */
  minutes: number;
}>;

export function financeEtClock(at: Date, timeZone: string = FINANCE_MARKET_TZ): FinanceEtClock {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  }).formatToParts(at);
  const value = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
  // `hour12: false` renders midnight as "24" in some ICU versions; normalise it.
  const hour = Number(value("hour")) % 24;
  return {
    date: `${value("year")}-${value("month")}-${value("day")}`,
    weekday: value("weekday"),
    minutes: hour * 60 + Number(value("minute")),
  };
}

/**
 * A slot is due when it is a trading weekday, the market's wall clock has reached the slot, and
 * the slot has not already fired on that market date.
 *
 * The "same date" guard is what makes a restart safe: without it, every process start would
 * replay every slot whose time of day has already passed.
 */
export function isFinanceCycleSlotDue(
  slot: FinanceCycleSlot,
  clock: FinanceEtClock,
  lastFired: Readonly<Record<string, string>>,
): boolean {
  if (!FINANCE_TRADING_WEEKDAYS.includes(clock.weekday)) {
    return false;
  }
  if (clock.minutes < slot.hour * 60 + slot.minute) {
    return false;
  }
  return lastFired[slot.mode] !== clock.date;
}
