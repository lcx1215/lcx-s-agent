import { describe, expect, it } from "vitest";
import { caseflowFingerprint } from "./finance-caseflow.js";
import { buildFinanceOpportunityContext } from "./finance-expectation-gap.js";
import type {
  FinanceDailyTradeDecisionReviewRequest,
  FinanceIntradayTradeDecisionCandidate,
  FinanceIntradayTradeDecisionReviewRequest,
} from "./finance-trade-decision-review.js";

// Prices and session times are from recorded NKE seq850. Identity/portfolio are offline fixtures,
// not an original native packet, a model observation, or evidence of profitable execution.
const originalSession = {
  date: "2026-10-02",
  openAt: "2026-10-02T13:30:00.000Z",
  closeAt: "2026-10-02T20:00:00.000Z",
  openMinute: 570,
  closeMinute: 960,
  observedAt: "2026-10-02T19:38:42.146Z",
  calendarRef: "fbf0f659dffc6b1b5ff2619dec2c1c09eb5d1266ad118047a5e1a141cd79c6dd",
  sourceUrlOrArtifact:
    "https://paper-api.alpaca.markets/v2/calendar?start=2026-10-02&end=2026-10-02&date_type=TRADING",
};
const originalCandidate: FinanceIntradayTradeDecisionCandidate = {
  candidateId: "offline-nke-geometry",
  instrument: "NKE",
  side: "buy",
  strategyRule: "opening_range_breakout_long_dynamic_universe_v3",
  signalReason: "opening_range_breakout",
  signalReferencePrice: 33.86,
  signalReferencePriceAt: "2026-10-02T19:35:00.000Z",
  stopPrice: 31.98,
  targetPrice: 37.62,
  datasetHeadRef: "c".repeat(64),
  marketSession: originalSession,
  intradayOwnedQuantity: 0,
  brokerPositionQuantity: 0,
  executionQuote: {
    referencePrice: 33.85,
    referencePriceAt: "2026-10-02T19:39:15.094833916Z",
    bidPrice: 33.84,
    askPrice: 33.85,
    feed: "iex",
    sourceUrlOrArtifact: "https://data.alpaca.markets;feed=iex;latest-quote-ask",
    ageMs: 1033,
    maxAgeMs: 30_000,
  },
};
const originalRequest: FinanceIntradayTradeDecisionReviewRequest = {
  schemaVersion: "lcx_finance_intraday_trade_decision_review_v1",
  venue: "alpaca:paper",
  asOf: "2026-10-02T19:39:16.127Z",
  signalAnchor: originalCandidate.candidateId,
  ruleIds: [originalCandidate.strategyRule],
  equity: 100_000,
  caps: { maxOrderNotional: 1000, maxInstrumentNotional: 5000, maxOrdersPerRun: 8 },
  positionBookObservedAt: "2026-10-02T19:39:13.350Z",
  reconciliation: { status: "ready" },
  positions: [],
  candidates: [originalCandidate],
};

function context(candidate: Partial<FinanceIntradayTradeDecisionCandidate> = {}, asOf?: string) {
  return buildFinanceOpportunityContext({
    ...originalRequest,
    ...(asOf ? { asOf } : {}),
    candidates: [{ ...originalCandidate, ...candidate }],
  })[0];
}

describe("deterministic opportunity geometry", () => {
  it("binds each candidate's quote geometry to its own packet fields", () => {
    const dailyCandidate: FinanceDailyTradeDecisionReviewRequest["candidates"][number] = {
      candidateId: "daily-first",
      instrument: "NKE",
      side: "buy",
      targetWeight: 0.1,
      currentWeight: 0,
      weightDelta: 0.1,
      notional: 1000,
      strategySignal: "hold",
      annualisedVol: 0.2,
      researchClose: 35.4,
      lastBarDate: "2026-09-30",
      executionQuote: originalCandidate.executionQuote,
    };
    const contexts = buildFinanceOpportunityContext({
      ...originalRequest,
      schemaVersion: "lcx_finance_trade_decision_review_v1",
      rebalanceBand: 0.05,
      candidates: [dailyCandidate, { ...dailyCandidate, candidateId: "daily-second" }],
    });
    for (const [index, actual] of contexts.entries()) {
      expect(actual.sourceBindings).toEqual({
        spreadPerUnit: [
          `/candidates/${index}/executionQuote/bidPrice`,
          `/candidates/${index}/executionQuote/askPrice`,
        ],
        conditionalUpsidePerUnit: [],
        plannedStopDistancePerUnit: [],
      });
    }
    expect(context().sourceBindings).toMatchObject({
      conditionalUpsidePerUnit: [
        "/candidates/0/executionQuote/askPrice",
        "/candidates/0/targetPrice",
      ],
      plannedStopDistancePerUnit: [
        "/candidates/0/executionQuote/askPrice",
        "/candidates/0/stopPrice",
      ],
    });
  });

  it("does not turn a tight spread or Paper venue into volume, slippage or cost evidence", () => {
    const before = JSON.stringify(originalRequest);
    const actual = context();
    expect(actual.measurementCoverage).toEqual({
      scope: "initial_decision_packet_only",
      currentVolume: "not_supplied",
      fillSlippage: "not_supplied",
      commissionAndFees: "not_supplied",
      fullRoundTripCost: "not_supplied",
      continuationProbability: "not_supplied",
      additionalEvidence: "completed_tool_results_require_separate_source_and_scope",
    });
    expect(actual.spreadPerUnit).toBeCloseTo(0.01);
    expect(actual.totalRoundTripCost).toBeNull();
    expect(actual.netExpectedValue).toBeNull();
    expect(JSON.stringify(originalRequest)).toBe(before);
  });

  it("does not attach arithmetic source proofs when an input is absent", () => {
    const actual = context({
      executionQuote: { ...originalCandidate.executionQuote, bidPrice: undefined },
    });
    expect(actual.sourceBindings).toEqual({
      spreadPerUnit: [],
      conditionalUpsidePerUnit: [],
      plannedStopDistancePerUnit: [],
    });
    expect(actual.measurementCoverage.fullRoundTripCost).toBe("not_supplied");
  });

  it("exposes the recorded NKE target/time tension without estimating profits or a holding deadline", () => {
    const before = JSON.stringify(originalRequest);
    const actual = buildFinanceOpportunityContext(originalRequest)[0];
    expect(actual.conditionalUpsideFraction).toBeCloseTo(0.11137370753323483, 14);
    expect(actual.plannedStopLossFraction).toBeCloseTo(0.05524372230428365, 14);
    expect(actual.sessionRemainingMinutes).toBeCloseTo(20.73121666666667, 12);
    expect(actual).toMatchObject({
      origin: "packet_arithmetic",
      candidateId: originalCandidate.candidateId,
      conditionalUpsidePerUnit: 3.769999999999996,
      plannedStopDistancePerUnit: 1.870000000000001,
      plannedHoldingHorizonMinutes: null,
      holdingHorizonStatus: "not_declared_in_packet",
      totalRoundTripCost: null,
      netExpectedValue: null,
    });
    expect(actual.boundary).toContain("session_remaining_is_not_holding_horizon");
    expect(JSON.stringify(originalRequest)).toBe(before);
  });

  it("preserves negative wrong-side geometry instead of hiding it or adding a gate", () => {
    const actual = context({ targetPrice: 30, stopPrice: 35 });
    expect(actual.conditionalUpsideFraction).toBeCloseTo(-0.11373707533234856, 14);
    expect(actual.plannedStopLossFraction).toBeCloseTo(-0.03397341211225924, 14);
    expect(actual.conditionalUpsidePerUnit).toBeLessThan(0);
    expect(actual.plannedStopDistancePerUnit).toBeLessThan(0);
    expect(actual.netExpectedValue).toBeNull();
  });

  it.each([
    ["missing bid", undefined, 33.85],
    ["missing ask", 33.84, undefined],
    ["crossed quote", 34, 33],
    ["zero quote", 0, 0],
    ["nonfinite bid", Number.NaN, 33.85],
    ["nonfinite ask", 33.84, Number.POSITIVE_INFINITY],
  ])("leaves buy geometry unknown for %s", (_label, bidPrice, askPrice) => {
    expect(
      context({ executionQuote: { ...originalCandidate.executionQuote, bidPrice, askPrice } }),
    ).toMatchObject({
      spreadPerUnit: null,
      conditionalUpsidePerUnit: null,
      plannedStopDistancePerUnit: null,
      conditionalUpsideFraction: null,
      plannedStopLossFraction: null,
      netExpectedValue: null,
    });
  });

  it("does not project buy targets or stops onto a protective sell", () => {
    expect(context({ side: "sell", signalReason: "opening_range_stop" })).toMatchObject({
      conditionalUpsidePerUnit: null,
      plannedStopDistancePerUnit: null,
      conditionalUpsideFraction: null,
      plannedStopLossFraction: null,
      plannedHoldingHorizonMinutes: null,
      holdingHorizonStatus: "not_declared_in_packet",
    });
  });

  it.each([
    ["nonfinite target", Number.POSITIVE_INFINITY, 31.98, 33.84, 33.85],
    ["nonfinite stop", 37.62, Number.NaN, 33.84, 33.85],
    ["overflowing target difference", -Number.MAX_VALUE, 0, Number.MAX_VALUE, Number.MAX_VALUE],
    ["overflowing stop difference", 0, -Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE],
    ["overflowing fractions", 1, -1, Number.MIN_VALUE, Number.MIN_VALUE],
  ])(
    "never publishes nonfinite derived geometry: %s",
    (_label, targetPrice, stopPrice, bidPrice, askPrice) => {
      const actual = context({
        targetPrice,
        stopPrice,
        executionQuote: { ...originalCandidate.executionQuote, bidPrice, askPrice },
      });
      for (const key of [
        "conditionalUpsidePerUnit",
        "plannedStopDistancePerUnit",
        "conditionalUpsideFraction",
        "plannedStopLossFraction",
      ] as const) {
        expect(actual[key] === null || Number.isFinite(actual[key])).toBe(true);
      }
    },
  );
});

describe("official session clock without a declared holding horizon", () => {
  it.each([
    ["before open", "2026-10-02T13:29:59.999Z"],
    ["after close", "2026-10-02T20:00:00.001Z"],
    ["different day", "2026-10-03T19:39:16.127Z"],
    ["malformed asOf", "not-a-time"],
  ])("keeps the remaining clock unknown for %s", (_label, asOf) => {
    expect(context({}, asOf).sessionRemainingMinutes).toBeNull();
  });

  it.each([
    ["absent session", undefined],
    ["invalid close", { ...originalSession, closeAt: "not-a-time" }],
    ["wrong calendar fingerprint", { ...originalSession, calendarRef: "d".repeat(64) }],
    ["mismatched session date", { ...originalSession, date: "2026-10-03" }],
    ["future capture", { ...originalSession, observedAt: "2026-10-02T19:39:16.128Z" }],
  ])("keeps only the time field unknown for %s", (_label, marketSession) => {
    const actual = context({ marketSession });
    expect(actual.sessionRemainingMinutes).toBeNull();
    expect(actual.conditionalUpsideFraction).toBeCloseTo(0.11137370753323483, 14);
    expect(actual.netExpectedValue).toBeNull();
  });

  it("uses the actual early close clock without turning it into an exit commitment", () => {
    const sourceUrlOrArtifact =
      "https://paper-api.alpaca.markets/v2/calendar?start=2026-11-27&end=2026-11-27&date_type=TRADING";
    const earlySession = {
      ...originalSession,
      date: "2026-11-27",
      openAt: "2026-11-27T14:30:00.000Z",
      closeAt: "2026-11-27T18:00:00.000Z",
      closeMinute: 780,
      observedAt: "2026-11-27T17:00:00.000Z",
      sourceUrlOrArtifact,
    };
    earlySession.calendarRef = caseflowFingerprint({
      source: "alpaca_paper_market_calendar",
      sourceUrlOrArtifact,
      date: earlySession.date,
      openAt: earlySession.openAt,
      closeAt: earlySession.closeAt,
    });
    expect(context({ marketSession: earlySession }, "2026-11-27T17:30:00.000Z")).toMatchObject({
      sessionRemainingMinutes: 30,
      plannedHoldingHorizonMinutes: null,
    });
    expect(context({}, originalSession.closeAt).sessionRemainingMinutes).toBe(0);
  });

  it("does not infer a session or holding clock for a daily allocation candidate", () => {
    const request: FinanceDailyTradeDecisionReviewRequest = {
      ...originalRequest,
      schemaVersion: "lcx_finance_trade_decision_review_v1",
      rebalanceBand: 0.05,
      candidates: [
        {
          candidateId: "offline-daily-nke",
          instrument: "NKE",
          side: "buy",
          targetWeight: 0.1,
          currentWeight: 0,
          weightDelta: 0.1,
          notional: 1000,
          strategySignal: "hold",
          annualisedVol: 0.2,
          researchClose: 35.4,
          lastBarDate: "2026-09-30",
          executionQuote: originalCandidate.executionQuote,
        },
      ],
    };
    expect(buildFinanceOpportunityContext(request)[0]).toMatchObject({
      conditionalUpsideFraction: null,
      plannedStopLossFraction: null,
      sessionRemainingMinutes: null,
      plannedHoldingHorizonMinutes: null,
      netExpectedValue: null,
    });
  });
});
