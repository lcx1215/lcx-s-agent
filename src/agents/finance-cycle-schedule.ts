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
 * The regular US equity session close as a UTC instant for a market-local calendar day.
 *
 * Daily history is sometimes available for the current date while its bar is still forming. A
 * consumer must not label that partial bar as a completed close; resolve 16:00 New York with the
 * IANA timezone database rather than assuming a fixed UTC offset across daylight-saving time.
 * Early-close holidays are intentionally not inferred here; callers that need an exact holiday
 * close need an exchange calendar.
 */
export function financeUsEquityRegularCloseInstant(date: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) {
    return undefined;
  }
  const midnight = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(midnight) || new Date(midnight).toISOString().slice(0, 10) !== date) {
    return undefined;
  }
  const [year, month, day] = date.split("-").map(Number);
  const utcCandidate = Date.UTC(year, month - 1, day, 16);
  const easternClock = financeEtClock(new Date(utcCandidate));
  if (easternClock.date !== date) {
    return undefined;
  }
  const easternAsUtc = Date.UTC(
    year,
    month - 1,
    day,
    Math.floor(easternClock.minutes / 60),
    easternClock.minutes % 60,
  );
  const easternOffsetMs = easternAsUtc - utcCandidate;
  return new Date(Date.UTC(year, month - 1, day, 16) - easternOffsetMs).toISOString();
}

/** Whether a US equity EOD bar may be treated as complete at the supplied instant. */
export function isFinanceUsEquityDailyBarComplete(date: string, asOf: string): boolean {
  const asOfMs = Date.parse(asOf);
  if (!Number.isFinite(asOfMs) || financeUsEquityRegularCloseInstant(date) === undefined) {
    return false;
  }
  const marketDate = financeEtClock(new Date(asOfMs)).date;
  if (date < marketDate) {
    return true;
  }
  if (date > marketDate) {
    return false;
  }
  const close = financeUsEquityRegularCloseInstant(date);
  return close !== undefined && Date.parse(close) <= asOfMs;
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
