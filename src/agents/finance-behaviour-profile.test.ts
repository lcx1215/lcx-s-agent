import { describe, expect, it } from "vitest";
import {
  buildFinanceBehaviourProfile,
  FINANCE_BEHAVIOUR_DIMENSIONS,
  FINANCE_BEHAVIOUR_PROFILE_SCHEMA,
  parseFinanceBehaviourThresholds,
  type FinanceBehaviourDimensionId,
  type FinanceBehaviourFinding,
  type FinanceBehaviourProfile,
} from "./finance-behaviour-profile.js";
import {
  FINANCE_EXECUTION_RECEIPT_SCHEMA,
  type FinanceExecutionReceipt,
} from "./finance-execution-adapter.js";
import type { FinancePositionMark } from "./finance-position-ledger.js";

let sequence = 0;

function receipt(overrides: Partial<FinanceExecutionReceipt> = {}): FinanceExecutionReceipt {
  sequence += 1;
  const at = overrides.recordedAt ?? `2026-09-18T00:00:${String(sequence).padStart(2, "0")}Z`;
  const side = overrides.side ?? "buy";
  const quantity = overrides.quantity ?? 10;
  const fillPrice = overrides.fill?.fillPrice ?? 100;
  return {
    schemaVersion: FINANCE_EXECUTION_RECEIPT_SCHEMA,
    receiptId: `r${sequence}`,
    intentId: `i${sequence}`,
    runAuthorizationId: "run-1",
    adapterId: "paper",
    adapterKind: "paper",
    venue: "paper",
    instrument: "AAPL",
    side,
    orderType: "market",
    quantity,
    referencePrice: fillPrice,
    referencePriceAt: at,
    notional: fillPrice * quantity,
    fill: { filledQuantity: quantity, fillPrice, filledAt: at, venueRef: "paper" },
    executionAuthority: "declared_execution_adapter_required",
    recordedAt: at,
    ...overrides,
  };
}

function fill(
  side: "buy" | "sell",
  quantity: number,
  fillPrice: number,
  at: string,
  instrument = "AAPL",
): FinanceExecutionReceipt {
  return receipt({
    side,
    quantity,
    instrument,
    recordedAt: at,
    referencePrice: fillPrice,
    referencePriceAt: at,
    notional: fillPrice * quantity,
    fill: { filledQuantity: quantity, fillPrice, filledAt: at, venueRef: "paper" },
  });
}

function mark(instrument: string, price: number, at: string): FinancePositionMark {
  return { instrument, price, at };
}

function findingOf(
  profile: FinanceBehaviourProfile,
  dimension: FinanceBehaviourDimensionId,
): FinanceBehaviourFinding {
  const found = profile.dimensions.find((item) => item.dimension === dimension);
  if (found === undefined) {
    throw new Error(`no finding for ${dimension}`);
  }
  return found;
}

/**
 * Three closed round trips and two open positions, one up and one down.
 *
 * The numbers are chosen so both denominators exist and the gap is unambiguous:
 * PGR 2/3, PLR 1/2, gap 1/6. A reader can re-derive every figure from the fills alone.
 */
function dispositionStream(): {
  receipts: FinanceExecutionReceipt[];
  marks: FinancePositionMark[];
} {
  return {
    receipts: [
      fill("buy", 10, 100, "2026-09-18T01:00:00Z", "AAA"),
      fill("sell", 10, 120, "2026-09-18T01:01:00Z", "AAA"),
      fill("buy", 10, 100, "2026-09-18T02:00:00Z", "BBB"),
      fill("sell", 10, 130, "2026-09-18T02:01:00Z", "BBB"),
      fill("buy", 10, 100, "2026-09-18T03:00:00Z", "CCC"),
      fill("sell", 10, 90, "2026-09-18T03:01:00Z", "CCC"),
      fill("buy", 10, 100, "2026-09-18T04:00:00Z", "DDD"),
      fill("buy", 10, 100, "2026-09-18T05:00:00Z", "EEE"),
    ],
    marks: [mark("DDD", 120, "2026-09-18T06:00:00Z"), mark("EEE", 90, "2026-09-18T06:00:00Z")],
  };
}

describe("finance behaviour profile", () => {
  describe("disposition effect", () => {
    it("labels a realised-versus-paper gap that clears the declared threshold", () => {
      const { receipts, marks } = dispositionStream();
      const profile = buildFinanceBehaviourProfile({
        receipts,
        marks,
        thresholds: { dispositionGapThreshold: 0.1 },
      });
      const finding = findingOf(profile, "disposition_effect");

      expect(finding.unavailableReason).toBeNull();
      expect(finding.label?.id).toBe("realized_gains_kept_losers");
      expect(finding.label?.evidence).toEqual({ pgr: 0.666667, plr: 0.5, gap: 0.166667 });
      expect(finding.observations).toEqual({
        realizedGains: 2,
        realizedLosses: 1,
        paperGains: 1,
        paperLosses: 1,
        openPositionsWithoutMark: 0,
      });
    });

    it("reports the numbers but withholds the label when no threshold was declared", () => {
      const { receipts, marks } = dispositionStream();
      const finding = findingOf(
        buildFinanceBehaviourProfile({ receipts, marks }),
        "disposition_effect",
      );

      expect(finding.label).toBeNull();
      expect(finding.unavailableReason).toContain("thresholds.dispositionGapThreshold");
      // The measurement still happened; only the reading is withheld.
      expect(finding.observations.realizedGains).toBe(2);
      expect(finding.observations.paperLosses).toBe(1);
    });

    it("names the missing denominator instead of inventing a zero", () => {
      const receipts = [
        fill("buy", 10, 100, "2026-09-18T01:00:00Z", "AAA"),
        fill("sell", 10, 120, "2026-09-18T01:01:00Z", "AAA"),
        fill("buy", 10, 100, "2026-09-18T02:00:00Z", "BBB"),
      ];
      const finding = findingOf(
        buildFinanceBehaviourProfile({
          receipts,
          marks: [mark("BBB", 120, "2026-09-18T03:00:00Z")],
          thresholds: { dispositionGapThreshold: 0.1 },
        }),
        "disposition_effect",
      );

      expect(finding.label).toBeNull();
      expect(finding.unavailableReason).toContain("PLR has no denominator");
      expect(finding.observations.realizedLosses).toBe(0);
      expect(finding.observations.paperLosses).toBe(0);
      expect(finding.observations.paperGains).toBe(1);
    });

    it("excludes an open position that has no mark and reports the exclusion", () => {
      const receipts = [
        // Open, never marked. Counting it as either a paper gain or a paper loss would
        // require inventing a price, so it must be excluded from both denominators.
        fill("buy", 10, 100, "2026-09-18T01:00:00Z", "AAA"),
        fill("buy", 10, 100, "2026-09-18T02:00:00Z", "BBB"),
        fill("sell", 10, 120, "2026-09-18T02:01:00Z", "BBB"),
        fill("buy", 10, 100, "2026-09-18T03:00:00Z", "CCC"),
      ];
      const profile = buildFinanceBehaviourProfile({
        receipts,
        marks: [mark("CCC", 90, "2026-09-18T04:00:00Z")],
        thresholds: { dispositionGapThreshold: 0.5 },
        minObservations: 1,
      });
      const finding = findingOf(profile, "disposition_effect");

      expect(finding.observations).toEqual({
        realizedGains: 1,
        realizedLosses: 0,
        paperGains: 0,
        paperLosses: 1,
        openPositionsWithoutMark: 1,
      });
      // The exclusion is visible in the instrument list rather than silent.
      expect(profile.instruments).toContain("AAA");
      expect(finding.label?.id).toBe("realized_gains_kept_losers");
    });
  });

  describe("turnover", () => {
    it("labels a fills-per-day rate above the declared budget", () => {
      const receipts = [
        fill("buy", 10, 100, "2026-09-18T00:00:00Z"),
        fill("buy", 10, 100, "2026-09-18T08:00:00Z"),
        fill("buy", 10, 100, "2026-09-18T16:00:00Z"),
        fill("buy", 10, 100, "2026-09-19T00:00:00Z"),
      ];
      const finding = findingOf(
        buildFinanceBehaviourProfile({ receipts, thresholds: { maxFillsPerDay: 2 } }),
        "turnover",
      );

      expect(finding.unavailableReason).toBeNull();
      expect(finding.label?.id).toBe("turnover_above_declared_budget");
      expect(finding.label?.evidence).toEqual({ fillsPerDay: 4, spanDays: 1 });
      expect(finding.observations.notionalTurnover).toBe(4000);
    });

    it("refuses a per-day rate when every fill shares one instant", () => {
      const at = "2026-09-18T12:00:00Z";
      const receipts = [
        fill("buy", 10, 100, at),
        fill("buy", 10, 100, at),
        fill("buy", 10, 100, at),
        fill("buy", 10, 100, at),
      ];
      const finding = findingOf(
        buildFinanceBehaviourProfile({ receipts, thresholds: { maxFillsPerDay: 2 } }),
        "turnover",
      );

      expect(finding.label).toBeNull();
      expect(finding.unavailableReason).toContain("one timestamp");
      // Notional turnover is still a real number; only the rate lacks a denominator.
      expect(finding.observations.notionalTurnover).toBe(4000);
      expect(finding.observations.fillsPerDay).toBeUndefined();
    });
  });

  describe("momentum chasing", () => {
    it("labels buys that filled above the last mark seen before them", () => {
      const receipts = [
        fill("buy", 10, 105, "2026-09-18T01:00:00Z"),
        fill("buy", 10, 106, "2026-09-18T02:00:00Z"),
        fill("buy", 10, 107, "2026-09-18T03:00:00Z"),
      ];
      const finding = findingOf(
        buildFinanceBehaviourProfile({
          receipts,
          marks: [mark("AAPL", 100, "2026-09-18T00:00:00Z")],
          thresholds: { momentumMovePercent: 4, momentumShareThreshold: 0.6 },
        }),
        "momentum_chasing",
      );

      expect(finding.unavailableReason).toBeNull();
      expect(finding.label?.id).toBe("buys_follow_a_prior_rise");
      expect(finding.label?.evidence).toEqual({
        shareIntoStrength: 1,
        buysIntoStrength: 3,
        measuredBuys: 3,
      });
    });

    it("uses a mark stamped at the fill instant", () => {
      const at = "2026-09-18T01:00:00Z";
      const finding = findingOf(
        buildFinanceBehaviourProfile({
          receipts: [fill("buy", 10, 110, at)],
          marks: [mark("AAPL", 100, at)],
          thresholds: { momentumMovePercent: 10, momentumShareThreshold: 1 },
          minObservations: 1,
        }),
        "momentum_chasing",
      );

      // The rule is "at or before": a mark stamped at the same instant is still usable.
      expect(finding.observations.buysWithPriorMark).toBe(1);
      expect(finding.observations.buysWithoutPriorMark).toBe(0);
      expect(finding.label?.id).toBe("buys_follow_a_prior_rise");
    });

    it("does not use a mark that postdates the fill as the prior price", () => {
      const receipts = [
        fill("buy", 10, 105, "2026-09-18T01:00:00Z"),
        fill("buy", 10, 106, "2026-09-18T02:00:00Z"),
        fill("buy", 10, 107, "2026-09-18T03:00:00Z"),
      ];
      const finding = findingOf(
        buildFinanceBehaviourProfile({
          receipts,
          // Ten hours after every buy. A later price cannot say what the buy moved against.
          marks: [mark("AAPL", 100, "2026-09-18T10:00:00Z")],
          thresholds: { momentumMovePercent: 4, momentumShareThreshold: 0.6 },
        }),
        "momentum_chasing",
      );

      expect(finding.label).toBeNull();
      expect(finding.unavailableReason).toContain("at or before its fill time");
      expect(finding.observations).toEqual({
        buys: 3,
        buysWithPriorMark: 0,
        buysWithoutPriorMark: 3,
        sellsWithPriorMark: 0,
        sellsIntoWeakness: 0,
      });
    });
  });

  describe("anchoring", () => {
    const anchoringReceipts = [
      fill("buy", 10, 100, "2026-09-18T01:00:00Z", "AAA"),
      fill("buy", 10, 200, "2026-09-18T02:00:00Z", "BBB"),
      fill("buy", 10, 307, "2026-09-18T03:00:00Z", "CCC"),
    ];

    it("labels fills that cluster on round levels", () => {
      const finding = findingOf(
        buildFinanceBehaviourProfile({
          receipts: anchoringReceipts,
          thresholds: { roundLevelTolerancePercent: 0.5, anchorShareThreshold: 0.6 },
        }),
        "anchoring",
      );

      expect(finding.unavailableReason).toBeNull();
      expect(finding.label?.id).toBe("fills_cluster_on_round_levels");
      expect(finding.label?.evidence).toEqual({
        shareOnRoundLevel: 0.666667,
        onRoundLevel: 2,
        measurableFills: 3,
      });
      expect(finding.observations.meanDistancePercent).toBeCloseTo(0.325733, 6);
    });

    it("measures the same relative distance at a different price scale", () => {
      const at = "2026-09-18T01:00:00Z";
      const thresholds = { roundLevelTolerancePercent: 1, anchorShareThreshold: 0 };
      const low = findingOf(
        buildFinanceBehaviourProfile({
          receipts: [fill("buy", 1, 12.3, at)],
          thresholds,
          minObservations: 1,
        }),
        "anchoring",
      );
      const high = findingOf(
        buildFinanceBehaviourProfile({
          receipts: [fill("buy", 1, 123, at)],
          thresholds,
          minObservations: 1,
        }),
        "anchoring",
      );

      // The grid is one order of magnitude below the price, so both sit 0.3 steps off it.
      expect(low.observations.meanDistancePercent).toBe(2.439024);
      expect(high.observations.meanDistancePercent).toBe(2.439024);
    });

    it("reports the mean distance but withholds the label when tolerance was not declared", () => {
      const finding = findingOf(
        buildFinanceBehaviourProfile({
          receipts: anchoringReceipts,
          thresholds: { anchorShareThreshold: 0.6 },
        }),
        "anchoring",
      );

      expect(finding.label).toBeNull();
      expect(finding.unavailableReason).toContain("thresholds.roundLevelTolerancePercent");
      expect(finding.observations.measurableFills).toBe(3);
      expect(finding.observations.meanDistancePercent).toBeCloseTo(0.325733, 6);
    });
  });

  describe("profile contract", () => {
    it("yields one profile regardless of the order the stream was collected in", () => {
      const { receipts, marks } = dispositionStream();
      const forward = buildFinanceBehaviourProfile({
        receipts,
        marks,
        thresholds: { dispositionGapThreshold: 0.1 },
      });
      const reversed = buildFinanceBehaviourProfile({
        receipts: receipts.toReversed(),
        marks: marks.toReversed(),
        thresholds: { dispositionGapThreshold: 0.1 },
      });

      expect(reversed).toEqual(forward);
      expect(reversed.instruments).toEqual(["AAA", "BBB", "CCC", "DDD", "EEE"]);
    });

    it("states all four dimensions, echoes the declared thresholds, and never advises", () => {
      const { receipts, marks } = dispositionStream();
      const profile = buildFinanceBehaviourProfile({
        receipts,
        marks,
        thresholds: { dispositionGapThreshold: 0.1 },
      });

      expect(profile.schemaVersion).toBe(FINANCE_BEHAVIOUR_PROFILE_SCHEMA);
      expect(profile.dimensions.map((item) => item.dimension)).toEqual([
        ...FINANCE_BEHAVIOUR_DIMENSIONS,
      ]);
      expect(profile.advice).toBe(false);
      expect(profile.interpretationBoundary).toContain("not investment advice");
      expect(profile.minObservations).toBe(3);
      expect(profile.declaredThresholds).toEqual({
        dispositionGapThreshold: 0.1,
        maxFillsPerDay: null,
        momentumMovePercent: null,
        momentumShareThreshold: null,
        roundLevelTolerancePercent: null,
        anchorShareThreshold: null,
      });
      expect(profile.observedFrom).toBe("2026-09-18T01:00:00Z");
      expect(profile.observedTo).toBe("2026-09-18T05:00:00Z");
    });

    it("carries the paper/venue split so a simulated stream is not read as a real one", () => {
      const receipts = [
        fill("buy", 10, 100, "2026-09-18T01:00:00Z"),
        fill("sell", 10, 110, "2026-09-18T02:00:00Z"),
        receipt({
          side: "buy",
          quantity: 5,
          instrument: "MSFT",
          adapterId: "venue-x",
          adapterKind: "venue",
          venue: "NYSE",
          recordedAt: "2026-09-18T03:00:00Z",
          fill: {
            filledQuantity: 5,
            fillPrice: 50,
            filledAt: "2026-09-18T03:00:00Z",
            venueRef: "venue-x",
          },
        }),
      ];
      const profile = buildFinanceBehaviourProfile({ receipts });

      expect(profile.receiptCount).toBe(3);
      expect(profile.paperFillCount).toBe(2);
      expect(profile.venueFillCount).toBe(1);
    });

    it("counts the marks it discarded instead of folding them into markCount", () => {
      const profile = buildFinanceBehaviourProfile({
        receipts: [fill("buy", 10, 100, "2026-09-18T01:00:00Z")],
        marks: [
          mark("AAPL", 110, "2026-09-18T02:00:00Z"),
          // A non-positive price is not a mark. The ledger drops it, and the count says so.
          mark("AAPL", 0, "2026-09-18T02:00:00Z"),
        ],
      });

      expect(profile.markCount).toBe(2);
      expect(profile.rejectedMarkCount).toBe(1);
    });

    it("gives an empty stream one shared reason rather than four separate blanks", () => {
      const profile = buildFinanceBehaviourProfile({ receipts: [] });

      expect(profile.receiptCount).toBe(0);
      expect(profile.markCount).toBe(0);
      expect(profile.rejectedMarkCount).toBe(0);
      expect(profile.paperFillCount).toBe(0);
      expect(profile.venueFillCount).toBe(0);
      expect(profile.instruments).toEqual([]);
      expect(profile.observedFrom).toBeNull();
      expect(profile.observedTo).toBeNull();
      expect(profile.advice).toBe(false);

      const reasons = profile.dimensions.map((item) => item.unavailableReason);
      expect(reasons.every((reason) => reason !== null && reason.length > 0)).toBe(true);
      expect(new Set(reasons).size).toBe(1);
      expect(reasons[0]).toContain("no receipts were supplied");
      expect(profile.dimensions.every((item) => item.label === null)).toBe(true);
    });
  });

  describe("declared thresholds parser", () => {
    it("accepts the declared subset and freezes it", () => {
      const parsed = parseFinanceBehaviourThresholds(
        { roundLevelTolerancePercent: 0.5, anchorShareThreshold: 0.6 },
        "thresholds.json",
      );

      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.thresholds).toEqual({
          roundLevelTolerancePercent: 0.5,
          anchorShareThreshold: 0.6,
        });
      }
    });

    it("refuses an unknown key and names both the offender and the known set", () => {
      const parsed = parseFinanceBehaviourThresholds({ dispositionGap: 0.1 }, "thresholds.json");

      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.error).toContain("thresholds.json");
        expect(parsed.error).toContain("dispositionGap");
        // The known set is listed so the typo can be corrected without reading the source.
        expect(parsed.error).toContain("dispositionGapThreshold");
      }
    });

    it("refuses a value the module could not compare against", () => {
      for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "0.5", null]) {
        const parsed = parseFinanceBehaviourThresholds({ maxFillsPerDay: bad }, "thresholds.json");
        expect(parsed.ok).toBe(false);
        if (!parsed.ok) {
          expect(parsed.error).toContain("maxFillsPerDay");
          expect(parsed.error).toContain("positive finite number");
        }
      }
    });

    it("refuses a payload that is not an object of thresholds", () => {
      for (const bad of [null, [], 3, "0.5"]) {
        const parsed = parseFinanceBehaviourThresholds(bad, "thresholds.json");
        expect(parsed.ok).toBe(false);
      }
    });
  });
});
