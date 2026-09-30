import { describe, expect, it } from "vitest";
import { createCalculationLedger } from "./finance-calculation-ledger.js";
import {
  diagnosePairSpread,
  replayPairSpreadReversion,
  type PairSpreadObservation,
} from "./quant-math-pair-spread.js";
import { createQuantLabTool } from "./tools/quant-lab-tool.js";

function observationsForSpread(spread: number[]): PairSpreadObservation[] {
  const start = Date.parse("2025-01-01T00:00:00.000Z");
  return spread.map((value, index) => {
    const priceB = 100 + index;
    return {
      timestamp: new Date(start + index * 86_400_000).toISOString(),
      priceA: value + 1.5 * priceB,
      priceB,
    };
  });
}

function fixedSpreadParams(spread: number[]) {
  return {
    pairId: "RB-HC-1",
    instrumentA: "SHFE.rb",
    instrumentB: "SHFE.hc",
    relationshipRationale: "Shared ferrous inputs; caller hypothesis",
    sourceRef: "dataset:manual-fixture-1",
    construction: "fixed_spread" as const,
    hedgeRatio: 1.5,
    lookbackWindow: 20,
    observations: observationsForSpread(spread),
  };
}

describe("diagnosePairSpread", () => {
  it("uses the declared fixed-spread formula and excludes the latest point from its z-score baseline", () => {
    const spread = [...Array.from({ length: 20 }, (_unused, index) => index + 1), 25];
    const result = diagnosePairSpread(fixedSpreadParams(spread));

    expect(result.construction.formula).toBe("priceA - hedgeRatio * priceB");
    expect(result.latestSpread).toBeCloseTo(25, 10);
    expect(result.latestObservationZScore).toBeCloseTo((25 - 10.5) / Math.sqrt(35), 10);
    expect(result.zScoreBaseline).toMatchObject({
      observations: 20,
      excludesLatestObservation: true,
      standardDeviation: "sample_n_minus_1",
    });
    expect(result.zScoreBaseline.lastTimestamp).toBe("2025-01-20T00:00:00.000Z");
    expect(result.signalProduced).toBe(false);
    expect(result.executionAuthority).toBe("none");
    expect(result.researchMode).toBe("research_only");
  });

  it("reports a descriptive half-life only for a positive AR(1) coefficient below one", () => {
    let state = 71;
    let level = 0;
    const spread = Array.from({ length: 500 }, () => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      level = 0.8 * level + state / 2 ** 32 - 0.5;
      return level;
    });
    const result = diagnosePairSpread(fixedSpreadParams(spread));

    expect(result.ar1Decay.coefficient).toBeGreaterThan(0.7);
    expect(result.ar1Decay.coefficient).toBeLessThan(0.9);
    expect(result.ar1Decay.halfLifeObservations).toBeCloseTo(
      Math.log(0.5) / Math.log(result.ar1Decay.coefficient!),
      10,
    );
    expect(result.ar1Decay.note).toContain("In-sample");
  });

  it("supports a price ratio and requires positive prices for that construction", () => {
    const params = fixedSpreadParams(Array.from({ length: 21 }, (_unused, index) => index + 1));
    const result = diagnosePairSpread({
      ...params,
      construction: "price_ratio",
      hedgeRatio: undefined,
      observations: params.observations.map((row) => ({
        ...row,
        priceA: row.priceA + 200,
        priceB: row.priceB + 100,
      })),
    });
    expect(result.construction.formula).toBe("priceA / priceB");
    expect(result.latestSpread).toBeCloseTo(
      (params.observations.at(-1)!.priceA + 200) / (params.observations.at(-1)!.priceB + 100),
      12,
    );

    expect(() =>
      diagnosePairSpread({
        ...params,
        construction: "price_ratio",
        hedgeRatio: undefined,
        observations: params.observations.map((row, index) => ({
          ...row,
          priceA: index === 2 ? 0 : row.priceA,
        })),
      }),
    ).toThrow(/priceA must be positive/u);
  });

  it("rejects unsorted or duplicate timestamps rather than silently shifting the legs", () => {
    const params = fixedSpreadParams(Array.from({ length: 21 }, (_unused, index) => index + 1));
    const reordered = [...params.observations];
    [reordered[2], reordered[3]] = [reordered[3], reordered[2]];
    expect(() => diagnosePairSpread({ ...params, observations: reordered })).toThrow(
      /strictly increasing/u,
    );

    const duplicate = [...params.observations];
    duplicate[3] = { ...duplicate[3], timestamp: duplicate[2].timestamp };
    expect(() => diagnosePairSpread({ ...params, observations: duplicate })).toThrow(
      /strictly increasing/u,
    );
  });

  it("rejects invalid windows and a zero-variation z-score baseline", () => {
    const params = fixedSpreadParams(Array.from({ length: 21 }, () => 4));
    expect(() => diagnosePairSpread({ ...params, lookbackWindow: 19 })).toThrow(/at least 20/u);
    expect(() =>
      diagnosePairSpread({
        ...params,
        construction: "price_ratio",
        hedgeRatio: undefined,
        observations: params.observations.map((row) => ({
          ...row,
          priceA: row.priceB * 2,
        })),
      }),
    ).toThrow(/no variation/u);
  });

  it("is available through Quant Lab and leaves an auditable research-only calculation", async () => {
    const ledger = createCalculationLedger();
    const tool = createQuantLabTool({ ledger });
    const result = (await tool.execute?.("pair-call-1", {
      action: "pair_spread_diagnostics",
      ...fixedSpreadParams([...Array.from({ length: 20 }, (_unused, index) => index + 1), 25]),
    } as never)) as { details?: Record<string, unknown> };
    const details = (result.details ?? result) as Record<string, unknown>;

    expect(details.calculationId).toMatch(/^calc-/u);
    expect(details.researchMode).toBe("research_only");
    expect(details.signalProduced).toBe(false);
    expect(details.executionAuthority).toBe("none");
    expect(ledger.list()).toHaveLength(1);
    expect(ledger.list()[0].action).toBe("pair_spread_diagnostics");
    expect(ledger.list()[0].inputs).toMatchObject({
      pairId: "RB-HC-1",
      sourceRef: "dataset:manual-fixture-1",
    });
  });
});

const replayContract = (
  overrides: Partial<{
    instrument: string;
    exchange: string;
    contractId: string;
    contractMonth: string;
    contracts: number;
    multiplier: number;
    settlementCurrency: string;
    commissionPerContractPerSide: number;
    bidAskSpreadPoints: number;
    slippagePointsPerSide: number;
    initialMarginPerContract: number;
  }> = {},
) => ({
  instrument: "SHFE.rb",
  exchange: "SHFE",
  contractId: "rb2601",
  contractMonth: "2026-01",
  contracts: 2,
  multiplier: 10,
  settlementCurrency: "CNY",
  commissionPerContractPerSide: 1,
  bidAskSpreadPoints: 0.2,
  slippagePointsPerSide: 0.05,
  initialMarginPerContract: 100,
  ...overrides,
});

function replayParams(spread: number[]) {
  const base = fixedSpreadParams(spread);
  return {
    ...base,
    entryZScore: 2,
    exitZScore: 0.5,
    maxHoldingObservations: 4,
    contractA: replayContract({ contracts: 2 }),
    contractB: replayContract({
      instrument: "SHFE.hc",
      exchange: "SHFE",
      contractId: "hc2601",
      contracts: 3,
      commissionPerContractPerSide: 2,
      bidAskSpreadPoints: 0.1,
      slippagePointsPerSide: 0.1,
      initialMarginPerContract: 80,
    }),
  };
}

describe("replayPairSpreadReversion", () => {
  it("records event recovery, next-observation fills, both-leg costs, and margin", () => {
    const spread = [
      ...Array.from({ length: 20 }, (_unused, index) => (index % 2 ? 1 : -1)),
      5,
      5,
      0.2,
      0.1,
    ];
    const result = replayPairSpreadReversion(replayParams(spread));

    expect(result.fillModel).toBe("next_observation_close_proxy");
    expect(result.observationWindow).toMatchObject({
      observations: 24,
      firstTimestamp: "2025-01-01T00:00:00.000Z",
      lastTimestamp: "2025-01-24T00:00:00.000Z",
      sampleFrequency: "caller_supplied_not_inferred",
    });
    expect(result.relationshipRationale).toContain("Shared ferrous inputs");
    expect(result.thresholds.eventPolicy).toEqual({
      entry: "first_threshold_touch_while_armed",
      rearm: "absolute_z_score_below_entry",
      overlappingEvents: false,
    });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      direction: "short_spread",
      status: "recovered",
      signalTimestamp: "2025-01-21T00:00:00.000Z",
      entryTimestamp: "2025-01-22T00:00:00.000Z",
      exitTimestamp: "2025-01-24T00:00:00.000Z",
      observationsHeld: 2,
      costsCurrency: { commission: 16, bidAsk: 7, slippage: 8, total: 31 },
      initialMarginEstimateCurrency: 440,
    });
    expect(result.events[0]?.grossPnlCurrency).toBeCloseTo(98, 10);
    expect(result.events[0]?.netPnlCurrency).toBeCloseTo(67, 10);
    expect(result.events[0]?.entryCostsCurrency).toMatchObject({
      commission: 8,
      bidAsk: 3.5,
      slippage: 4,
      total: 15.5,
    });
    expect(result.contracts.impliedPriceHedgeRatio).toBeCloseTo(1.5, 12);
    expect(result.summary).toMatchObject({
      signalEvents: 1,
      resolvedEvents: 1,
      recoveredEvents: 1,
      recoveryRateAmongResolved: 1,
      recoveryRateAmongAllSignals: 1,
      allSignalRecoveryInterpretation: "censored_and_unfilled_signals_count_as_not_recovered",
      totalCostsCurrency: 31,
      peakSingleTradeMarginEstimateCurrency: 440,
      pnlAccountingScope: "resolved_events_only",
      medianResolvedHoldingObservations: 2,
      meanResolvedHoldingObservations: 2,
    });
    expect(result.summary.grossPnlCurrency).toBeCloseTo(98, 10);
    expect(result.summary.netPnlCurrency).toBeCloseTo(67, 10);
    expect(result.liveSignalProduced).toBe(false);
    expect(result.executionAuthority).toBe("none");
  });

  it("closes a timed-out event once and does not re-enter a continuing excursion", () => {
    const spread = [
      ...Array.from({ length: 20 }, (_unused, index) => (index % 2 ? 1 : -1)),
      10,
      10,
      10,
      10,
      10,
    ];
    const result = replayPairSpreadReversion({
      ...replayParams(spread),
      exitZScore: 0,
      maxHoldingObservations: 3,
    });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      status: "timed_out",
      exitTrigger: "time_limit",
      observationsHeld: 3,
    });
    expect(result.summary.timedOutEvents).toBe(1);
    expect(result.summary.recoveryRateAmongResolved).toBe(0);
  });

  it("keeps end-of-sample events censored instead of treating them as recoveries or realized PnL", () => {
    const spread = [
      ...Array.from({ length: 20 }, (_unused, index) => (index % 2 ? 1 : -1)),
      5,
      5,
      5,
      5,
    ];
    const result = replayPairSpreadReversion(replayParams(spread));

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      status: "sample_censored",
      censorReason: "sample_ended",
    });
    expect(result.events[0]?.netPnlCurrency).toBeUndefined();
    expect(result.events[0]?.entryCostsCurrency?.total).toBeCloseTo(15.5, 10);
    expect(result.events[0]?.lastObservedMarkToMarketCurrency).toBeCloseTo(0, 10);
    expect(result.events[0]?.observationsObservedAfterEntry).toBe(2);
    expect(result.summary.recoveryRateAmongResolved).toBeNull();
    expect(result.summary.recoveryRateAmongAllSignals).toBe(0);
    expect(result.summary.netPnlCurrency).toBe(0);
    expect(result.summary).toMatchObject({
      openPositionEvents: 1,
      openPositionEntryCostsCurrency: 15.5,
      openPositionMarkToMarketCurrency: 0,
      peakSingleTradeMarginEstimateCurrency: 440,
    });
  });

  it("marks a signal on the last observation as unfilled and enforces a one-observation holding limit", () => {
    const prefix = Array.from({ length: 20 }, (_unused, index) => (index % 2 ? 1 : -1));
    const unfilled = replayPairSpreadReversion(replayParams([...prefix, 5]));
    expect(unfilled.events[0]).toMatchObject({
      status: "entry_unfilled_at_sample_end",
      censorReason: "no_next_observation_for_entry",
    });
    expect(unfilled.summary.openPositionEvents).toBe(0);

    const oneBar = replayPairSpreadReversion({
      ...replayParams([...prefix, 5, 5, 5, 5]),
      exitZScore: 0,
      maxHoldingObservations: 1,
    });
    expect(oneBar.events[0]).toMatchObject({
      status: "timed_out",
      exitTrigger: "time_limit",
      observationsHeld: 1,
    });
  });

  it("rejects fractional lots, mismatched settlement currencies, and invalid thresholds", () => {
    const spread = [...Array.from({ length: 20 }, (_unused, index) => index % 2), 5, 5];
    const params = replayParams(spread);

    expect(() =>
      replayPairSpreadReversion({
        ...params,
        contractA: { ...params.contractA, contracts: 1.5 },
      }),
    ).toThrow(/positive integer/u);
    expect(() =>
      replayPairSpreadReversion({
        ...params,
        contractB: { ...params.contractB, settlementCurrency: "USD" },
      }),
    ).toThrow(/currencies must match/u);
    expect(() => replayPairSpreadReversion({ ...params, exitZScore: 2 })).toThrow(
      /less than entryZScore/u,
    );
    expect(() =>
      replayPairSpreadReversion({
        ...params,
        contractA: { ...params.contractA, instrument: "SHFE.hc" },
      }),
    ).toThrow(/contractA.instrument must match/u);
    expect(() =>
      replayPairSpreadReversion({
        ...params,
        contractB: { ...params.contractB, contractId: params.contractA.contractId },
      }),
    ).toThrow(/different listed contracts/u);
  });

  it("is reachable through Quant Lab and leaves a ledger record", async () => {
    const ledger = createCalculationLedger();
    const tool = createQuantLabTool({ ledger });
    const result = (await tool.execute?.("pair-replay-1", {
      action: "pair_spread_reversion_replay",
      ...replayParams([
        ...Array.from({ length: 20 }, (_unused, index) => (index % 2 ? 1 : -1)),
        5,
        5,
        0.2,
        0.1,
      ]),
    } as never)) as { details?: Record<string, unknown> };
    const details = (result.details ?? result) as Record<string, unknown>;

    expect(details.calculationId).toMatch(/^calc-/u);
    expect(details.action).toBe("pair_spread_reversion_replay");
    expect(details.executionAuthority).toBe("none");
    expect(ledger.list()[0].action).toBe("pair_spread_reversion_replay");

    await expect(
      tool.execute?.("pair-replay-ratio", {
        action: "pair_spread_reversion_replay",
        ...replayParams([
          ...Array.from({ length: 20 }, (_unused, index) => (index % 2 ? 1 : -1)),
          5,
          5,
        ]),
        construction: "price_ratio",
      } as never),
    ).rejects.toThrow(/only supports construction=fixed_spread/u);
  });
});
