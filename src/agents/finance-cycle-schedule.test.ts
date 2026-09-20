import { describe, expect, it } from "vitest";
import {
  DEFAULT_FINANCE_CYCLE_SLOTS,
  financeEtClock,
  isFinanceCycleSlotDue,
  type FinanceCycleSlot,
} from "./finance-cycle-schedule.js";

const DAY_SLOT = DEFAULT_FINANCE_CYCLE_SLOTS.find(
  (slot) => slot.mode === "day",
) as FinanceCycleSlot;
const NIGHT_SLOT = DEFAULT_FINANCE_CYCLE_SLOTS.find(
  (slot) => slot.mode === "night",
) as FinanceCycleSlot;

describe("financeEtClock", () => {
  it("renders an instant as America/New_York wall clock", () => {
    // 2026-09-21 is a Monday, still in EDT (UTC-4).
    expect(financeEtClock(new Date("2026-09-21T19:30:00Z"))).toEqual({
      date: "2026-09-21",
      weekday: "Mon",
      minutes: 15 * 60 + 30,
    });
  });

  it("follows DST instead of a fixed UTC offset", () => {
    // Same UTC wall time, four months earlier: January is EST (UTC-5), so 19:30Z is 14:30.
    const winter = financeEtClock(new Date("2026-01-21T19:30:00Z"));
    expect(winter.minutes).toBe(14 * 60 + 30);
    expect(winter.weekday).toBe("Wed");
  });

  it("normalises midnight to zero minutes", () => {
    // Guard against `hour12: false` rendering midnight as 24 and producing 1440.
    expect(financeEtClock(new Date("2026-09-21T04:30:00Z")).minutes).toBe(30);
  });
});

describe("isFinanceCycleSlotDue", () => {
  const mondayAfternoon: Parameters<typeof isFinanceCycleSlotDue>[1] = {
    date: "2026-09-21",
    weekday: "Mon",
    minutes: 15 * 60 + 30,
  };

  it("is due on a trading weekday once the slot time is reached", () => {
    expect(isFinanceCycleSlotDue(DAY_SLOT, mondayAfternoon, {})).toBe(true);
  });

  it("is not due on a weekend even when the time has passed", () => {
    const saturday = { ...mondayAfternoon, date: "2026-09-26", weekday: "Sat" };
    expect(isFinanceCycleSlotDue(DAY_SLOT, saturday, {})).toBe(false);
  });

  it("is not due before the slot time on the same day", () => {
    const early = { ...mondayAfternoon, minutes: 9 * 60 };
    expect(isFinanceCycleSlotDue(DAY_SLOT, early, {})).toBe(false);
  });

  it("is not due twice on the same market date", () => {
    // This is what makes a restart safe: without it, every process start replays the slot.
    expect(isFinanceCycleSlotDue(DAY_SLOT, mondayAfternoon, { day: "2026-09-21" })).toBe(false);
  });

  it("is due again on the next market date", () => {
    const tuesday = { ...mondayAfternoon, date: "2026-09-22", weekday: "Tue" };
    expect(isFinanceCycleSlotDue(DAY_SLOT, tuesday, { day: "2026-09-21" })).toBe(true);
  });

  it("keeps the night slot due after only the day slot has fired", () => {
    const late = { ...mondayAfternoon, minutes: 17 * 60 + 30 };
    // Per-mode keying: recording `day` must not consume `night`.
    expect(isFinanceCycleSlotDue(NIGHT_SLOT, late, { day: "2026-09-21" })).toBe(true);
    expect(
      isFinanceCycleSlotDue(NIGHT_SLOT, late, { day: "2026-09-21", night: "2026-09-21" }),
    ).toBe(false);
  });

  it("fires at most once per market date when swept across a whole day", () => {
    const lastFired: Record<string, string> = {};
    let fires = 0;
    for (let minutes = 0; minutes < 24 * 60; minutes += 1) {
      const clock = { date: "2026-09-21", weekday: "Mon", minutes };
      if (!isFinanceCycleSlotDue(DAY_SLOT, clock, lastFired)) {
        continue;
      }
      lastFired[DAY_SLOT.mode] = clock.date;
      fires += 1;
    }
    expect(fires).toBe(1);
  });
});
