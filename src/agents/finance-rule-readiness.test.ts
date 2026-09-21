import { describe, expect, it } from "vitest";
import type { FinancePositionMark } from "./finance-position-ledger.js";
import {
  buildFinanceRuleReadiness,
  FINANCE_ADVERSITY_KINDS,
  FINANCE_RULE_READINESS_SCHEMA,
  type FinanceAdversityKind,
  type FinanceAdversityObservation,
  type FinanceReadinessThresholds,
} from "./finance-rule-readiness.js";
import type { FinanceReadinessBar } from "./finance-rule-readiness.js";
import type { FinanceStrategyRule } from "./finance-strategy-rule-ledger.js";

const AS_OF = "2026-09-20T00:00:00Z";

/**
 * In a fixture the two clocks normally agree; only tests that care about the difference set
 * `startObservedAt` / `activeObservedAt` explicitly. Anything that does not keeps describing
 * the rule by its write time, which stays true to what those tests are actually about.
 */
function rule(overrides: Partial<FinanceStrategyRule> = {}): FinanceStrategyRule {
  const declaredAt = overrides.declaredAt ?? "2026-08-01T00:00:00Z";
  const activatedAt =
    overrides.activatedAt === undefined ? "2026-08-01T00:00:00Z" : overrides.activatedAt;
  return {
    ruleId: "r1",
    state: "active",
    form: "python",
    formVersion: null,
    displayName: null,
    instruments: ["AAA"],
    emits: "orders",
    schedule: { kind: "daily" },
    body: {},
    provenance: null,
    declaredAt,
    activatedAt,
    retiredAt: null,
    startObservedAt: declaredAt,
    activeObservedAt: activatedAt,
    transitions: [],
    ...overrides,
  };
}

function mark(instrument: string, price: number, at: string): FinancePositionMark {
  return { instrument, price, at };
}

/** An exchange-aggregated bar: `sampleCount` null is what licenses high/low as the true range. */
function bar(
  date: string,
  prices: { open: number; high: number; low: number; close: number },
  instrument = "AAA",
): FinanceReadinessBar {
  return {
    instrument,
    at: date,
    open: prices.open,
    high: prices.high,
    low: prices.low,
    close: prices.close,
    sampleCount: null,
  };
}

/** A bar built from point observations: the range is observed, not traded. */
function pointBar(
  date: string,
  close: number,
  samples = 1,
  instrument = "AAA",
): FinanceReadinessBar {
  return {
    instrument,
    at: date,
    open: close,
    high: close,
    low: close,
    close,
    sampleCount: samples,
  };
}

function find(
  entry: { adversity: readonly FinanceAdversityObservation[] },
  kind: FinanceAdversityKind,
): FinanceAdversityObservation | undefined {
  return entry.adversity.find((item) => item.kind === kind);
}

const ALL: FinanceReadinessThresholds = {
  minPaperDays: 30,
  reversalDrawdownPercent: 8,
  chopMinFlips: 3,
  gapMovePercent: 4,
};

describe("buildFinanceRuleReadiness", () => {
  it("reports numbers with no verdict when no threshold is declared", () => {
    const result = buildFinanceRuleReadiness({
      rules: [rule()],
      marks: [mark("AAA", 100, "2026-08-05T00:00:00Z"), mark("AAA", 108, "2026-08-06T00:00:00Z")],
      asOf: AS_OF,
    });
    const entry = result.rules[0];
    expect(entry?.ready).toBeNull();
    expect(entry?.readyUnavailableReason).toContain("minPaperDays was not declared");
    for (const kind of FINANCE_ADVERSITY_KINDS) {
      expect(find(entry, kind)?.observed).toBeNull();
    }
  });

  it("names the undeclared threshold for each regime separately", () => {
    const result = buildFinanceRuleReadiness({
      rules: [rule()],
      marks: [mark("AAA", 100, "2026-08-05T00:00:00Z"), mark("AAA", 90, "2026-08-06T00:00:00Z")],
      asOf: AS_OF,
      thresholds: { minPaperDays: 30 },
    });
    const entry = result.rules[0];
    expect(find(entry, "chop")?.unavailableReason).toContain("chopMinFlips");
    expect(find(entry, "reversal")?.unavailableReason).toContain("reversalDrawdownPercent");
    expect(find(entry, "gap")?.unavailableReason).toContain("gapMovePercent");
  });

  it("marks every regime covered when the market actually moved", () => {
    const result = buildFinanceRuleReadiness({
      rules: [rule()],
      marks: [
        mark("AAA", 100, "2026-08-05T00:00:00Z"),
        mark("AAA", 96, "2026-08-06T00:00:00Z"),
        mark("AAA", 104, "2026-08-07T00:00:00Z"),
        mark("AAA", 92, "2026-08-08T00:00:00Z"),
        mark("AAA", 100, "2026-08-09T00:00:00Z"),
        mark("AAA", 88, "2026-08-10T00:00:00Z"),
      ],
      asOf: AS_OF,
      thresholds: ALL,
    });
    const entry = result.rules[0];
    expect(find(entry, "gap")?.observed).toBe(true);
    expect(find(entry, "reversal")?.observed).toBe(true);
    expect(find(entry, "chop")?.observed).toBe(true);
    expect(entry?.covered).toEqual([...FINANCE_ADVERSITY_KINDS]);
    expect(entry?.uncovered).toEqual([]);
    expect(entry?.ready).toBe(true);
  });

  it("does not call a flat window ready even when duration is met", () => {
    const result = buildFinanceRuleReadiness({
      rules: [rule()],
      marks: [
        mark("AAA", 100, "2026-08-05T00:00:00Z"),
        mark("AAA", 100.1, "2026-08-06T00:00:00Z"),
        mark("AAA", 100.05, "2026-08-07T00:00:00Z"),
      ],
      asOf: AS_OF,
      thresholds: ALL,
    });
    const entry = result.rules[0];
    expect(entry?.durationMet).toBe(true);
    expect(entry?.ready).toBe(false);
    expect(entry?.uncovered).toEqual([...FINANCE_ADVERSITY_KINDS]);
  });

  it("treats an unjudgeable condition as uncovered rather than covered", () => {
    const result = buildFinanceRuleReadiness({
      rules: [rule()],
      marks: [mark("AAA", 100, "2026-08-05T00:00:00Z"), mark("AAA", 80, "2026-08-06T00:00:00Z")],
      asOf: AS_OF,
      thresholds: { ...ALL, chopMinFlips: undefined },
    });
    const entry = result.rules[0];
    expect(find(entry, "chop")?.observed).toBeNull();
    expect(entry?.uncovered).toContain("chop");
    expect(entry?.ready).toBeNull();
    expect(entry?.readyUnavailableReason).toContain("chop");
  });

  it("reads the market, not the rule's PnL: no marks means unjudgeable, never 'nothing happened'", () => {
    const result = buildFinanceRuleReadiness({
      rules: [rule()],
      marks: [],
      asOf: AS_OF,
      thresholds: ALL,
    });
    const entry = result.rules[0];
    expect(entry?.observationCount).toBe(0);
    expect(entry?.durationMet).toBe(true);
    for (const kind of FINANCE_ADVERSITY_KINDS) {
      expect(find(entry, kind)?.observed).toBeNull();
    }
    expect(entry?.ready).toBeNull();
  });

  it("ignores marks outside the rule's instruments", () => {
    const result = buildFinanceRuleReadiness({
      rules: [rule({ instruments: ["AAA"] })],
      marks: [mark("BBB", 100, "2026-08-05T00:00:00Z"), mark("BBB", 60, "2026-08-06T00:00:00Z")],
      asOf: AS_OF,
      thresholds: ALL,
    });
    expect(result.rules[0]?.observationCount).toBe(0);
    expect(result.rules[0]?.ready).toBeNull();
  });

  it("counts the rule's exposure from activation, falling back to declaration", () => {
    const activated = buildFinanceRuleReadiness({
      rules: [rule({ declaredAt: "2026-01-01T00:00:00Z", activatedAt: "2026-09-01T00:00:00Z" })],
      marks: [],
      asOf: AS_OF,
      thresholds: ALL,
    });
    expect(activated.rules[0]?.since).toBe("2026-09-01T00:00:00Z");
    expect(activated.rules[0]?.elapsedDays).toBe(19);

    const draft = buildFinanceRuleReadiness({
      rules: [rule({ declaredAt: "2026-09-01T00:00:00Z", activatedAt: null, state: "draft" })],
      marks: [],
      asOf: AS_OF,
      thresholds: ALL,
    });
    expect(draft.rules[0]?.since).toBe("2026-09-01T00:00:00Z");
  });

  it("treats the window as closed at both ends", () => {
    const result = buildFinanceRuleReadiness({
      rules: [rule({ declaredAt: "2026-08-05T00:00:00Z", activatedAt: "2026-08-05T00:00:00Z" })],
      marks: [
        mark("AAA", 100, "2026-08-05T00:00:00Z"),
        mark("AAA", 96, "2026-08-06T00:00:00Z"),
        mark("AAA", 104, AS_OF),
      ],
      asOf: AS_OF,
      thresholds: { ...ALL, minObservations: 3 },
    });
    expect(result.rules[0]?.observationCount).toBe(3);
  });

  it("honours requiredAdversity, defaulting to all three", () => {
    // A steady slide: reversal and jump are covered, chop is not.
    const marks = [
      mark("AAA", 100, "2026-08-05T00:00:00Z"),
      mark("AAA", 96, "2026-08-06T00:00:00Z"),
      mark("AAA", 90, "2026-08-07T00:00:00Z"),
    ];
    const narrow = buildFinanceRuleReadiness({
      rules: [rule()],
      marks,
      asOf: AS_OF,
      thresholds: { ...ALL, requiredAdversity: ["reversal"] },
    });
    expect(narrow.requiredAdversity).toEqual(["reversal"]);
    expect(narrow.rules[0]?.covered).toContain("reversal");
    expect(narrow.rules[0]?.ready).toBe(true);

    // Same market, but the default requires all three, and chop was never seen.
    const full = buildFinanceRuleReadiness({
      rules: [rule()],
      marks,
      asOf: AS_OF,
      thresholds: ALL,
    });
    expect(full.requiredAdversity).toEqual([...FINANCE_ADVERSITY_KINDS]);
    expect(full.rules[0]?.covered).toContain("reversal");
    expect(full.rules[0]?.uncovered).toContain("chop");
    expect(full.rules[0]?.ready).toBe(false);
  });

  it("reports too few observations instead of guessing", () => {
    const result = buildFinanceRuleReadiness({
      rules: [rule()],
      marks: [mark("AAA", 100, "2026-08-05T00:00:00Z"), mark("AAA", 90, "2026-08-06T00:00:00Z")],
      asOf: AS_OF,
      thresholds: { ...ALL, minObservations: 5 },
    });
    const entry = result.rules[0];
    expect(find(entry, "gap")?.unavailableReason).toContain("below the 5 required");
    expect(entry?.ready).toBeNull();
  });

  it("refuses ready when duration is short even though every regime was seen", () => {
    const result = buildFinanceRuleReadiness({
      rules: [rule({ declaredAt: "2026-09-15T00:00:00Z", activatedAt: "2026-09-15T00:00:00Z" })],
      marks: [
        mark("AAA", 100, "2026-09-15T00:00:00Z"),
        mark("AAA", 96, "2026-09-16T00:00:00Z"),
        mark("AAA", 104, "2026-09-17T00:00:00Z"),
        mark("AAA", 92, "2026-09-18T00:00:00Z"),
        mark("AAA", 100, "2026-09-19T00:00:00Z"),
        mark("AAA", 88, "2026-09-20T00:00:00Z"),
      ],
      asOf: AS_OF,
      thresholds: { ...ALL, minPaperDays: 60 },
    });
    const entry = result.rules[0];
    expect(entry?.covered).toEqual([...FINANCE_ADVERSITY_KINDS]);
    expect(entry?.durationMet).toBe(false);
    expect(entry?.ready).toBe(false);
  });

  it("windows history from the owner's declared clock, not from the writer's wall clock", () => {
    // `declaredAt`/`activatedAt` are write times. A replay to a past `asOf` would then start the
    // window *after* it ends, drop every mark, and read as "nothing adverse happened".
    const lateWrite = buildFinanceRuleReadiness({
      rules: [
        rule({
          declaredAt: "2026-09-19T18:00:00Z",
          activatedAt: "2026-09-19T18:00:00Z",
          startObservedAt: "2026-08-01T00:00:00Z",
          activeObservedAt: "2026-08-01T00:00:00Z",
        }),
      ],
      marks: [
        mark("AAA", 100, "2026-08-05T00:00:00Z"),
        mark("AAA", 104, "2026-08-06T00:00:00Z"),
        mark("AAA", 98, "2026-08-07T00:00:00Z"),
        mark("AAA", 101, "2026-08-08T00:00:00Z"),
        mark("AAA", 80, "2026-08-09T00:00:00Z"),
      ],
      asOf: AS_OF,
      thresholds: ALL,
    });
    expect(lateWrite.rules[0]?.since).toBe("2026-08-01T00:00:00Z");
    expect(lateWrite.rules[0]?.observationCount).toBe(5);
    expect(lateWrite.rules[0]?.ready).toBe(true);
  });

  it("is a pure projection: same input, same output", () => {
    const input = {
      rules: [rule()],
      marks: [mark("AAA", 100, "2026-08-05T00:00:00Z"), mark("AAA", 88, "2026-08-06T00:00:00Z")],
      asOf: AS_OF,
      thresholds: ALL,
    };
    expect(buildFinanceRuleReadiness(input)).toEqual(buildFinanceRuleReadiness(input));
  });

  it("never presents itself as advice", () => {
    const result = buildFinanceRuleReadiness({ rules: [rule()], marks: [], asOf: AS_OF });
    expect(result.advice).toBe(false);
    expect(result.schemaVersion).toBe(FINANCE_RULE_READINESS_SCHEMA);
    expect(result.interpretationBoundary).toContain("not investment advice");
  });

  it("reads a reversal off the traded range, which a close series cannot see", () => {
    // The closes are 100 → 99 → 100: a 1% close-to-close fall. The instrument actually traded
    // 101 down to 88 inside the window, a 12.9% fall off the peak high. A rule whose stop sits
    // inside that range was tested by it, and a close-only reading would answer "not adverse".
    const bars = [
      bar("2026-09-01", { open: 100, high: 100, low: 100, close: 100 }),
      bar("2026-09-02", { open: 100, high: 101, low: 88, close: 99 }),
      bar("2026-09-03", { open: 99, high: 100, low: 98, close: 100 }),
    ];
    const withBars = buildFinanceRuleReadiness({
      rules: [rule()],
      marks: [],
      bars,
      asOf: AS_OF,
      thresholds: { ...ALL, chopMinFlips: 0 },
    });
    const reversal = find(withBars.rules[0], "reversal");
    expect(reversal?.basis).toBe("ohlc");
    expect(reversal?.observed).toBe(true);
    expect(reversal?.detail["drawdownPercent"]).toBeCloseTo(12.87, 1);

    const closesOnly = buildFinanceRuleReadiness({
      rules: [rule()],
      marks: [
        mark("AAA", 100, "2026-09-01T00:00:00Z"),
        mark("AAA", 99, "2026-09-02T00:00:00Z"),
        mark("AAA", 100, "2026-09-03T00:00:00Z"),
      ],
      asOf: AS_OF,
      thresholds: { ...ALL, chopMinFlips: 0 },
    });
    expect(find(closesOnly.rules[0], "reversal")?.basis).toBe("close");
    expect(find(closesOnly.rules[0], "reversal")?.observed).toBe(false);
  });

  it("reads a jump as the opening gap when bars carry one", () => {
    // Opens 100 → 92 → 100 while closes are 100 → 100 → 100: nothing in the close series moves
    // at all, and a holder who was long through the gap was still gapped.
    const bars = [
      bar("2026-09-01", { open: 100, high: 100, low: 92, close: 100 }),
      bar("2026-09-02", { open: 92, high: 100, low: 92, close: 100 }),
      bar("2026-09-03", { open: 100, high: 100, low: 100, close: 100 }),
    ];
    const result = buildFinanceRuleReadiness({
      rules: [rule()],
      marks: [],
      bars,
      asOf: AS_OF,
      thresholds: { ...ALL, chopMinFlips: 0, reversalDrawdownPercent: 0 },
    });
    const gap = find(result.rules[0], "gap");
    expect(gap?.basis).toBe("ohlc");
    expect(gap?.observed).toBe(true);
    expect(gap?.detail["maxJumpPercent"]).toBeCloseTo(8, 6);

    const closesOnly = buildFinanceRuleReadiness({
      rules: [rule()],
      marks: [
        mark("AAA", 100, "2026-09-01T00:00:00Z"),
        mark("AAA", 100, "2026-09-02T00:00:00Z"),
        mark("AAA", 100, "2026-09-03T00:00:00Z"),
      ],
      asOf: AS_OF,
      thresholds: { ...ALL, chopMinFlips: 0, reversalDrawdownPercent: 0 },
    });
    expect(find(closesOnly.rules[0], "gap")?.observed).toBe(false);
  });

  it("declines point-derived bars instead of reporting an understated range", () => {
    // These closes fall 1%. The bars cannot say how far the instrument actually traded, so the
    // honest answer is "unjudgeable" — which counts as uncovered — not "a 1% fall".
    const bars = [
      pointBar("2026-09-01", 100),
      pointBar("2026-09-02", 99),
      pointBar("2026-09-03", 99),
    ];
    const result = buildFinanceRuleReadiness({
      rules: [rule()],
      marks: [],
      bars,
      asOf: AS_OF,
      thresholds: { ...ALL, chopMinFlips: 0 },
    });
    const reversal = find(result.rules[0], "reversal");
    expect(reversal?.observed).toBeNull();
    expect(reversal?.unavailableReason).toContain("point-derived");
    expect(reversal?.detail["drawdownPercent"]).toBeNull();
    expect(find(result.rules[0], "gap")?.observed).toBeNull();
    expect(result.rules[0]?.ready).toBeNull();
  });

  it("does not read a change of instrument as a move the market made", () => {
    // Two instruments, each up 1%. Concatenating them into one series puts a 900% "return" at
    // the seam, which would answer "gap covered" for a market that never moved.
    const result = buildFinanceRuleReadiness({
      rules: [rule({ instruments: ["AAA", "BBB"] })],
      marks: [
        mark("AAA", 100, "2026-08-05T00:00:00Z"),
        mark("BBB", 1000, "2026-08-06T00:00:00Z"),
        mark("AAA", 101, "2026-08-07T00:00:00Z"),
        mark("BBB", 1010, "2026-08-08T00:00:00Z"),
      ],
      asOf: AS_OF,
      thresholds: { ...ALL, chopMinFlips: 0, reversalDrawdownPercent: 0 },
    });
    const gap = find(result.rules[0], "gap");
    expect(gap?.observed).toBe(false);
    expect(gap?.detail["maxJumpPercent"]).toBeCloseTo(1, 6);
    expect(result.rules[0]?.observationCount).toBe(4);
  });

  it("windows bars by date, so the bar dated the window's first day is inside it", () => {
    // `since` is an instant ("2026-08-05T00:00:00Z") and a bar period is a date ("2026-08-05").
    // Comparing raw strings would put the bar before the window and drop it.
    const result = buildFinanceRuleReadiness({
      rules: [
        rule({
          declaredAt: "2026-08-05T00:00:00Z",
          activatedAt: "2026-08-05T00:00:00Z",
          startObservedAt: "2026-08-05T00:00:00Z",
          activeObservedAt: "2026-08-05T00:00:00Z",
        }),
      ],
      marks: [],
      bars: [
        bar("2026-08-05", { open: 100, high: 100, low: 100, close: 100 }),
        bar("2026-08-06", { open: 100, high: 100, low: 90, close: 95 }),
        bar("2026-08-07", { open: 95, high: 96, low: 94, close: 96 }),
      ],
      asOf: AS_OF,
      thresholds: { ...ALL, chopMinFlips: 0 },
    });
    expect(result.rules[0]?.observationCount).toBe(3);
    expect(find(result.rules[0], "reversal")?.detail["drawdownPercent"]).toBeCloseTo(10, 6);
  });

  it("says when a bar book exists but the window misses it, instead of just answering 'close'", () => {
    // A rule declared today and a rule with no supply at all both read `basis: "close"`. One
    // resolves itself tomorrow; the other needs somebody to fetch data. The note is the half of
    // the answer that says which.
    const withOutsideBars = buildFinanceRuleReadiness({
      rules: [rule({ declaredAt: "2026-09-20T00:00:00Z", activatedAt: "2026-09-20T00:00:00Z" })],
      marks: [mark("AAA", 100, "2026-09-20T12:00:00Z")],
      bars: [bar("2026-09-01", { open: 100, high: 100, low: 90, close: 95 })],
      asOf: AS_OF,
      thresholds: { ...ALL, chopMinFlips: 0 },
    });
    expect(withOutsideBars.rules[0]?.barWindowNote).toContain("none inside the window");
    expect(withOutsideBars.rules[0]?.barWindowNote).toContain("newest bar 2026-09-01");

    const noSupplyAtAll = buildFinanceRuleReadiness({
      rules: [rule()],
      marks: [],
      asOf: AS_OF,
      thresholds: { ...ALL, chopMinFlips: 0 },
    });
    expect(noSupplyAtAll.rules[0]?.barWindowNote).toBeNull();

    const barsInside = buildFinanceRuleReadiness({
      rules: [rule()],
      marks: [],
      bars: [
        bar("2026-09-01", { open: 100, high: 100, low: 90, close: 95 }),
        bar("2026-09-02", { open: 95, high: 96, low: 94, close: 96 }),
      ],
      asOf: AS_OF,
      thresholds: { ...ALL, chopMinFlips: 0 },
    });
    expect(barsInside.rules[0]?.barWindowNote).toBeNull();
  });

  it("falls back to marks, unchanged, when no bar supply is passed", () => {
    const result = buildFinanceRuleReadiness({
      rules: [rule()],
      marks: [
        mark("AAA", 100, "2026-08-05T00:00:00Z"),
        mark("AAA", 96, "2026-08-06T00:00:00Z"),
        mark("AAA", 104, "2026-08-07T00:00:00Z"),
        mark("AAA", 92, "2026-08-08T00:00:00Z"),
        mark("AAA", 100, "2026-08-09T00:00:00Z"),
        mark("AAA", 88, "2026-08-10T00:00:00Z"),
      ],
      asOf: AS_OF,
      thresholds: ALL,
    });
    expect(result.barCount).toBe(0);
    expect(result.rules[0]?.adversity.every((item) => item.basis === "close")).toBe(true);
    expect(result.rules[0]?.ready).toBe(true);
  });
});
/**
 * An empty `requiredAdversity` set.
 *
 * It is not "no preference", it is the measure cancelling itself: with nothing required,
 * `uncovered` is empty by construction and duration alone answers `ready`. Measured: a rule on a
 * steadily rising series — no chop, no reversal, no gap — reported `ready: true` under
 * `requiredAdversity: []`, while leaving it undeclared, or naming one regime, reported `false`.
 */
describe("an empty required adversity set does not satisfy readiness", () => {
  /** Steadily rising: no direction flip, no drawdown, no jump. */
  const calm = [100, 101, 102, 103, 104].map((price, index) =>
    mark("AAA", price, `2026-09-0${index + 1}T00:00:00Z`),
  );
  const base = {
    minPaperDays: 1,
    chopMinFlips: 3,
    reversalDrawdownPercent: 5,
    gapMovePercent: 5,
  };

  it("leaves readiness unjudged instead of letting duration answer it", () => {
    const readiness = buildFinanceRuleReadiness({
      rules: [rule()],
      marks: calm,
      asOf: AS_OF,
      thresholds: { ...base, requiredAdversity: [] },
    });
    expect(readiness.requiredAdversity).toEqual([]);
    expect(readiness.rules[0]?.ready).toBeNull();
    expect(readiness.rules[0]?.readyUnavailableReason).toMatch(/requiredAdversity is empty/);
  });

  it("still reports not ready when a named regime is uncovered", () => {
    for (const requiredAdversity of [["chop"], ["chop", "gap"]] as FinanceAdversityKind[][]) {
      const readiness = buildFinanceRuleReadiness({
        rules: [rule()],
        marks: calm,
        asOf: AS_OF,
        thresholds: { ...base, requiredAdversity },
      });
      expect(readiness.rules[0]?.ready).toBe(false);
    }
  });

  it("still reports not ready when the set is left undeclared", () => {
    const readiness = buildFinanceRuleReadiness({
      rules: [rule()],
      marks: calm,
      asOf: AS_OF,
      thresholds: base,
    });
    expect(readiness.requiredAdversity).toEqual([...FINANCE_ADVERSITY_KINDS]);
    expect(readiness.rules[0]?.ready).toBe(false);
  });
});
