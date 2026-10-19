import { adfTest, type AdfResult } from "./quant-math-foundations.js";

export type PairSpreadObservation = {
  timestamp: string;
  priceA: number;
  priceB: number;
};

export type PairSpreadConstruction = "fixed_spread" | "price_ratio";

export type PairSpreadDiagnosticsParams = {
  pairId: string;
  instrumentA: string;
  instrumentB: string;
  relationshipRationale: string;
  sourceRef: string;
  construction: PairSpreadConstruction;
  hedgeRatio?: number;
  lookbackWindow: number;
  observations: PairSpreadObservation[];
};

export type PairSpreadDiagnostics = {
  researchMode: "research_only";
  pairId: string;
  instrumentA: string;
  instrumentB: string;
  relationshipRationale: string;
  sourceRef: string;
  construction: {
    kind: PairSpreadConstruction;
    formula: string;
    hedgeRatio?: number;
  };
  observations: number;
  firstTimestamp: string;
  lastTimestamp: string;
  sampleFrequency: "caller_supplied_not_inferred";
  latestSpread: number;
  latestObservationZScore: number;
  zScoreBaseline: {
    observations: number;
    firstTimestamp: string;
    lastTimestamp: string;
    standardDeviation: "sample_n_minus_1";
    excludesLatestObservation: true;
  };
  ar1Decay: {
    coefficient: number | null;
    halfLifeObservations: number | null;
    note: string;
  };
  stationarityTest:
    | { status: "assessed"; result: AdfResult }
    | { status: "not_assessed"; reason: string };
  signalProduced: false;
  executionAuthority: "none";
  limitations: string[];
};

export type PairSpreadReplayContract = {
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
};

export type PairSpreadReversionReplayParams = Omit<
  PairSpreadDiagnosticsParams,
  "construction" | "hedgeRatio"
> & {
  hedgeRatio: number;
  entryZScore: number;
  exitZScore: number;
  stopZScore?: number;
  maxHoldingObservations: number;
  contractA: PairSpreadReplayContract;
  contractB: PairSpreadReplayContract;
};

export type PairSpreadReversionEvent = {
  signalTimestamp: string;
  signalZScore: number;
  direction: "short_spread" | "long_spread";
  status:
    | "recovered"
    | "stopped"
    | "timed_out"
    | "sample_censored"
    | "entry_unfilled_at_sample_end";
  entryTimestamp?: string;
  exitTimestamp?: string;
  exitTrigger?: "mean_reversion" | "adverse_stop" | "time_limit";
  censorReason?: "no_next_observation_for_entry" | "no_next_observation_for_exit" | "sample_ended";
  observationsHeld?: number;
  observationsObservedAfterEntry?: number;
  entryPriceA?: number;
  entryPriceB?: number;
  entryCostsCurrency?: {
    commission: number;
    bidAsk: number;
    slippage: number;
    total: number;
  };
  exitPriceA?: number;
  exitPriceB?: number;
  lastObservedMarkToMarketCurrency?: number;
  grossPnlCurrency?: number;
  costsCurrency?: {
    commission: number;
    bidAsk: number;
    slippage: number;
    total: number;
  };
  netPnlCurrency?: number;
  initialMarginEstimateCurrency?: number;
  maxAdverseLossCurrency?: number;
};

export type PairSpreadReversionReplay = {
  researchMode: "research_only";
  pairId: string;
  relationshipRationale: string;
  sourceRef: string;
  observationWindow: {
    observations: number;
    firstTimestamp: string;
    lastTimestamp: string;
    sampleFrequency: "caller_supplied_not_inferred";
  };
  construction: {
    formula: "priceA - hedgeRatio * priceB";
    hedgeRatio: number;
  };
  thresholds: {
    entryZScore: number;
    exitZScore: number;
    stopZScore?: number;
    maxHoldingObservations: number;
    lookbackWindow: number;
    eventPolicy: {
      entry: "first_threshold_touch_while_armed";
      rearm: "absolute_z_score_below_entry";
      overlappingEvents: false;
    };
  };
  fillModel: "next_observation_close_proxy";
  contracts: {
    contractA: PairSpreadReplayContract;
    contractB: PairSpreadReplayContract;
    impliedPriceHedgeRatio: number;
    priceHedgeRatioDifference: number;
  };
  summary: {
    pnlAccountingScope: "resolved_events_only";
    signalEvents: number;
    resolvedEvents: number;
    recoveredEvents: number;
    stoppedEvents: number;
    timedOutEvents: number;
    censoredEvents: number;
    recoveryRateAmongResolved: number | null;
    recoveryRateAmongAllSignals: number | null;
    allSignalRecoveryInterpretation: "censored_and_unfilled_signals_count_as_not_recovered";
    medianRecoveryObservations: number | null;
    meanRecoveryObservations: number | null;
    medianResolvedHoldingObservations: number | null;
    meanResolvedHoldingObservations: number | null;
    grossPnlCurrency: number;
    commissionCurrency: number;
    bidAskCurrency: number;
    slippageCurrency: number;
    totalCostsCurrency: number;
    netPnlCurrency: number;
    openPositionEvents: number;
    openPositionEntryCostsCurrency: number;
    openPositionMarkToMarketCurrency: number;
    peakSingleTradeMarginEstimateCurrency: number;
    worstObservedAdverseLossCurrency: number;
  };
  events: PairSpreadReversionEvent[];
  liveSignalProduced: false;
  executionAuthority: "none";
  limitations: string[];
};

function requireNonEmptyString(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function timestampMilliseconds(value: string, index: number): number {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
  ) {
    throw new Error(`observations[${index}].timestamp must be an ISO timestamp with a timezone`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new Error(`observations[${index}].timestamp is invalid`);
  }
  return milliseconds;
}

function sampleMean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sampleStandardDeviation(values: readonly number[]): number {
  const mean = sampleMean(values);
  const squaredDeviations = values.reduce((sum, value) => sum + (value - mean) ** 2, 0);
  return Math.sqrt(squaredDeviations / (values.length - 1));
}

function zScoreAt(spread: readonly number[], index: number, lookbackWindow: number): number | null {
  const baseline = spread.slice(index - lookbackWindow, index);
  const deviation = sampleStandardDeviation(baseline);
  if (!(deviation > 0) || !Number.isFinite(deviation)) {
    return null;
  }
  const zScore = (spread[index] - sampleMean(baseline)) / deviation;
  return Number.isFinite(zScore) ? zScore : null;
}

function requirePositiveFinite(value: number, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive finite number`);
  }
  return value;
}

function requireNonNegativeFinite(value: number, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative finite number`);
  }
  return value;
}

function requireFiniteCalculation(value: number, label: string): number {
  if (!Number.isFinite(value)) {
    throw new Error(`${label} calculation is not finite`);
  }
  return value;
}

function validateReplayContract(contract: PairSpreadReplayContract, label: string) {
  if (!contract || typeof contract !== "object") {
    throw new Error(`${label} is required`);
  }
  const instrument = requireNonEmptyString(contract.instrument, `${label}.instrument`);
  const exchange = requireNonEmptyString(contract.exchange, `${label}.exchange`);
  const contractId = requireNonEmptyString(contract.contractId, `${label}.contractId`);
  const contractMonth = requireNonEmptyString(contract.contractMonth, `${label}.contractMonth`);
  const settlementCurrency = requireNonEmptyString(
    contract.settlementCurrency,
    `${label}.settlementCurrency`,
  );
  if (!Number.isInteger(contract.contracts) || contract.contracts <= 0) {
    throw new Error(`${label}.contracts must be a positive integer`);
  }
  requirePositiveFinite(contract.multiplier, `${label}.multiplier`);
  requireNonNegativeFinite(
    contract.commissionPerContractPerSide,
    `${label}.commissionPerContractPerSide`,
  );
  requireNonNegativeFinite(contract.bidAskSpreadPoints, `${label}.bidAskSpreadPoints`);
  requireNonNegativeFinite(contract.slippagePointsPerSide, `${label}.slippagePointsPerSide`);
  requirePositiveFinite(contract.initialMarginPerContract, `${label}.initialMarginPerContract`);
  return { instrument, exchange, contractId, contractMonth, settlementCurrency };
}

function estimateAr1Decay(values: readonly number[]): PairSpreadDiagnostics["ar1Decay"] {
  const previous = values.slice(0, -1);
  const next = values.slice(1);
  const previousMean = sampleMean(previous);
  const nextMean = sampleMean(next);
  let covarianceNumerator = 0;
  let varianceDenominator = 0;
  for (let index = 0; index < previous.length; index += 1) {
    const priorDeviation = previous[index] - previousMean;
    covarianceNumerator += priorDeviation * (next[index] - nextMean);
    varianceDenominator += priorDeviation ** 2;
  }
  if (
    !(varianceDenominator > 0) ||
    !Number.isFinite(varianceDenominator) ||
    !Number.isFinite(covarianceNumerator)
  ) {
    return {
      coefficient: null,
      halfLifeObservations: null,
      note: "AR(1) coefficient is not assessed because the lagged spread has no variation or the calculation is not finite.",
    };
  }

  const coefficient = covarianceNumerator / varianceDenominator;
  if (!Number.isFinite(coefficient)) {
    return {
      coefficient: null,
      halfLifeObservations: null,
      note: "AR(1) coefficient is not assessed because the estimate is not finite.",
    };
  }
  if (!(coefficient > 0 && coefficient < 1)) {
    return {
      coefficient,
      halfLifeObservations: null,
      note: "The conventional positive-phi AR(1) decay half-life is undefined for this estimate; this alone does not establish stationarity or nonstationarity.",
    };
  }

  return {
    coefficient,
    halfLifeObservations: Math.log(0.5) / Math.log(coefficient),
    note: "In-sample AR(1) descriptor only; the count is in supplied observations, not calendar time, and has no confidence interval or forecast meaning.",
  };
}

/**
 * Diagnose a caller-defined, timestamp-aligned two-instrument spread.
 * This is deliberately a research calculator: it does not choose a pair, infer a hedge ratio,
 * convert prices into exchange P&L, run a backtest, or produce an entry/exit signal.
 */
export function diagnosePairSpread(params: PairSpreadDiagnosticsParams): PairSpreadDiagnostics {
  const pairId = requireNonEmptyString(params.pairId, "pairId");
  const instrumentA = requireNonEmptyString(params.instrumentA, "instrumentA");
  const instrumentB = requireNonEmptyString(params.instrumentB, "instrumentB");
  const relationshipRationale = requireNonEmptyString(
    params.relationshipRationale,
    "relationshipRationale",
  );
  const sourceRef = requireNonEmptyString(params.sourceRef, "sourceRef");
  if (instrumentA.toLowerCase() === instrumentB.toLowerCase()) {
    throw new Error("instrumentA and instrumentB must be different instruments");
  }
  if (params.construction !== "fixed_spread" && params.construction !== "price_ratio") {
    throw new Error("construction must be one of fixed_spread, price_ratio");
  }
  if (!Number.isInteger(params.lookbackWindow) || params.lookbackWindow < 20) {
    throw new Error("lookbackWindow must be an integer of at least 20 observations");
  }
  if (!Array.isArray(params.observations) || params.observations.length <= params.lookbackWindow) {
    throw new Error("observations must contain at least lookbackWindow + 1 rows");
  }

  let hedgeRatio: number | undefined;
  if (params.construction === "fixed_spread") {
    if (
      typeof params.hedgeRatio !== "number" ||
      !Number.isFinite(params.hedgeRatio) ||
      params.hedgeRatio <= 0
    ) {
      throw new Error("hedgeRatio must be a positive finite number for fixed_spread");
    }
    hedgeRatio = params.hedgeRatio;
  } else if (params.hedgeRatio !== undefined) {
    throw new Error("hedgeRatio is only valid with fixed_spread");
  }

  const timestamps: number[] = [];
  const spread: number[] = [];
  for (let index = 0; index < params.observations.length; index += 1) {
    const observation = params.observations[index];
    if (
      !observation ||
      typeof observation !== "object" ||
      typeof observation.timestamp !== "string" ||
      typeof observation.priceA !== "number" ||
      !Number.isFinite(observation.priceA) ||
      typeof observation.priceB !== "number" ||
      !Number.isFinite(observation.priceB)
    ) {
      throw new Error(`observations[${index}] must contain a timestamp and finite prices`);
    }
    const milliseconds = timestampMilliseconds(observation.timestamp, index);
    if (timestamps.length > 0 && milliseconds <= timestamps[timestamps.length - 1]) {
      throw new Error("observation timestamps must be strictly increasing and unique");
    }
    timestamps.push(milliseconds);

    if (params.construction === "price_ratio" && observation.priceB <= 0) {
      throw new Error(`observations[${index}].priceB must be positive for price_ratio`);
    }
    if (params.construction === "price_ratio" && observation.priceA <= 0) {
      throw new Error(`observations[${index}].priceA must be positive for price_ratio`);
    }
    let value: number;
    if (params.construction === "fixed_spread") {
      if (hedgeRatio === undefined) {
        throw new Error("hedgeRatio is required for fixed_spread");
      }
      value = observation.priceA - hedgeRatio * observation.priceB;
    } else {
      value = observation.priceA / observation.priceB;
    }
    if (!Number.isFinite(value)) {
      throw new Error(`constructed spread is not finite at observations[${index}]`);
    }
    spread.push(value);
  }

  const latestIndex = spread.length - 1;
  const baselineStartIndex = latestIndex - params.lookbackWindow;
  const baseline = spread.slice(baselineStartIndex, latestIndex);
  const baselineMean = sampleMean(baseline);
  const baselineDeviation = sampleStandardDeviation(baseline);
  if (!Number.isFinite(baselineMean) || !Number.isFinite(baselineDeviation)) {
    throw new Error("z-score baseline calculation is not finite");
  }
  if (!(baselineDeviation > 0)) {
    throw new Error("z-score baseline has no variation; latestObservationZScore is undefined");
  }
  const latestObservationZScore = (spread[latestIndex] - baselineMean) / baselineDeviation;
  if (!Number.isFinite(latestObservationZScore)) {
    throw new Error("latestObservationZScore is not finite");
  }

  let stationarityTest: PairSpreadDiagnostics["stationarityTest"];
  try {
    stationarityTest = { status: "assessed", result: adfTest({ values: spread }) };
  } catch (error) {
    stationarityTest = {
      status: "not_assessed",
      reason: error instanceof Error ? error.message : "ADF calculation failed",
    };
  }

  const construction =
    params.construction === "fixed_spread"
      ? {
          kind: params.construction,
          formula: "priceA - hedgeRatio * priceB",
          hedgeRatio,
        }
      : { kind: params.construction, formula: "priceA / priceB" };

  return {
    researchMode: "research_only",
    pairId,
    instrumentA,
    instrumentB,
    relationshipRationale,
    sourceRef,
    construction,
    observations: spread.length,
    firstTimestamp: params.observations[0].timestamp,
    lastTimestamp: params.observations[latestIndex].timestamp,
    sampleFrequency: "caller_supplied_not_inferred",
    latestSpread: spread[latestIndex],
    latestObservationZScore,
    zScoreBaseline: {
      observations: baseline.length,
      firstTimestamp: params.observations[baselineStartIndex].timestamp,
      lastTimestamp: params.observations[latestIndex - 1].timestamp,
      standardDeviation: "sample_n_minus_1",
      excludesLatestObservation: true,
    },
    ar1Decay: estimateAr1Decay(spread),
    stationarityTest,
    signalProduced: false,
    executionAuthority: "none",
    limitations: [
      "The pair, rationale, source reference, timestamp alignment, and completed-bar status are caller supplied and are not independently verified.",
      "The reported spread is a price formula, not exchange-currency P&L or a contract-multiplier and lot-size-neutral hedge; margin, fees, bid-ask spread, slippage, rolls, and legging risk are excluded.",
      "ADF tests the supplied formula as a univariate series using asymptotic Fuller critical values. It is not proof of future convergence; if hedgeRatio was estimated from this sample, these critical values are not Engle-Granger/MacKinnon cointegration calibration.",
      "The AR(1) half-life and latest z-score are in-sample descriptors; no confidence interval, regime break analysis, multiple-testing correction, walk-forward test, or execution backtest is performed.",
      "No trading signal, position size, portfolio risk aggregation, margin estimate, or order is produced.",
    ],
  };
}

/**
 * Replay caller-defined spread thresholds against aligned closes and explicit contract/cost
 * assumptions. This is a close-price research replay, not an exchange fill simulation.
 */
export function replayPairSpreadReversion(
  params: PairSpreadReversionReplayParams,
): PairSpreadReversionReplay {
  const pairId = requireNonEmptyString(params.pairId, "pairId");
  const instrumentA = requireNonEmptyString(params.instrumentA, "instrumentA");
  const instrumentB = requireNonEmptyString(params.instrumentB, "instrumentB");
  const sourceRef = requireNonEmptyString(params.sourceRef, "sourceRef");
  const relationshipRationale = requireNonEmptyString(
    params.relationshipRationale,
    "relationshipRationale",
  );
  if (instrumentA.toLowerCase() === instrumentB.toLowerCase()) {
    throw new Error("instrumentA and instrumentB must be different instruments");
  }
  const hedgeRatio = requirePositiveFinite(params.hedgeRatio, "hedgeRatio");
  if (!Number.isInteger(params.lookbackWindow) || params.lookbackWindow < 20) {
    throw new Error("lookbackWindow must be an integer of at least 20 observations");
  }
  if (!Number.isInteger(params.maxHoldingObservations) || params.maxHoldingObservations < 1) {
    throw new Error("maxHoldingObservations must be a positive integer");
  }
  const entryZScore = requirePositiveFinite(params.entryZScore, "entryZScore");
  if (
    typeof params.exitZScore !== "number" ||
    !Number.isFinite(params.exitZScore) ||
    params.exitZScore < 0 ||
    params.exitZScore >= entryZScore
  ) {
    throw new Error("exitZScore must be finite, non-negative, and less than entryZScore");
  }
  const stopZScore =
    params.stopZScore === undefined
      ? undefined
      : requirePositiveFinite(params.stopZScore, "stopZScore");
  if (stopZScore !== undefined && stopZScore <= entryZScore) {
    throw new Error("stopZScore must be greater than entryZScore");
  }
  if (
    !Array.isArray(params.observations) ||
    params.observations.length < params.lookbackWindow + 1
  ) {
    throw new Error("observations must contain at least lookbackWindow + 1 rows");
  }

  const contractA = validateReplayContract(params.contractA, "contractA");
  const contractB = validateReplayContract(params.contractB, "contractB");
  if (contractA.instrument.toLowerCase() !== instrumentA.toLowerCase()) {
    throw new Error("contractA.instrument must match instrumentA");
  }
  if (contractB.instrument.toLowerCase() !== instrumentB.toLowerCase()) {
    throw new Error("contractB.instrument must match instrumentB");
  }
  if (
    contractA.exchange.toLowerCase() === contractB.exchange.toLowerCase() &&
    contractA.contractId.toLowerCase() === contractB.contractId.toLowerCase()
  ) {
    throw new Error("contractA and contractB must identify different listed contracts");
  }
  if (contractA.settlementCurrency.toUpperCase() !== contractB.settlementCurrency.toUpperCase()) {
    throw new Error("contract settlement currencies must match; FX conversion is not modeled");
  }

  const timestamps: number[] = [];
  const spread: number[] = [];
  for (let index = 0; index < params.observations.length; index += 1) {
    const observation = params.observations[index];
    if (
      !observation ||
      typeof observation !== "object" ||
      typeof observation.timestamp !== "string" ||
      typeof observation.priceA !== "number" ||
      !Number.isFinite(observation.priceA) ||
      typeof observation.priceB !== "number" ||
      !Number.isFinite(observation.priceB)
    ) {
      throw new Error(`observations[${index}] must contain a timestamp and finite prices`);
    }
    const milliseconds = timestampMilliseconds(observation.timestamp, index);
    if (timestamps.length > 0 && milliseconds <= timestamps[timestamps.length - 1]) {
      throw new Error("observation timestamps must be strictly increasing and unique");
    }
    timestamps.push(milliseconds);
    const value = observation.priceA - hedgeRatio * observation.priceB;
    if (!Number.isFinite(value)) {
      throw new Error(`constructed spread is not finite at observations[${index}]`);
    }
    spread.push(value);
  }

  const contractAFull = params.contractA;
  const contractBFull = params.contractB;
  const impliedPriceHedgeRatio =
    (contractBFull.contracts * contractBFull.multiplier) /
    (contractAFull.contracts * contractAFull.multiplier);
  requirePositiveFinite(impliedPriceHedgeRatio, "impliedPriceHedgeRatio");
  const priceHedgeRatioDifference = requireFiniteCalculation(
    impliedPriceHedgeRatio - hedgeRatio,
    "priceHedgeRatioDifference",
  );
  const directionFor = (signalZScore: number): PairSpreadReversionEvent["direction"] =>
    signalZScore > 0 ? "short_spread" : "long_spread";
  const sideSigns = (direction: PairSpreadReversionEvent["direction"]) =>
    direction === "short_spread" ? { a: -1, b: 1 } : { a: 1, b: -1 };
  const markToMarket = (
    direction: PairSpreadReversionEvent["direction"],
    entryA: number,
    entryB: number,
    index: number,
  ) => {
    const sides = sideSigns(direction);
    return requireFiniteCalculation(
      sides.a *
        contractAFull.contracts *
        contractAFull.multiplier *
        (params.observations[index].priceA - entryA) +
        sides.b *
          contractBFull.contracts *
          contractBFull.multiplier *
          (params.observations[index].priceB - entryB),
      "markToMarket",
    );
  };
  // bidAskSpreadPoints is the full quoted width: half at entry and half at exit.
  const entryBidAskCost = requireFiniteCalculation(
    (contractAFull.contracts * contractAFull.multiplier * contractAFull.bidAskSpreadPoints +
      contractBFull.contracts * contractBFull.multiplier * contractBFull.bidAskSpreadPoints) /
      2,
    "entryBidAskCost",
  );
  const entrySlippageCost = requireFiniteCalculation(
    contractAFull.contracts * contractAFull.multiplier * contractAFull.slippagePointsPerSide +
      contractBFull.contracts * contractBFull.multiplier * contractBFull.slippagePointsPerSide,
    "entrySlippageCost",
  );
  const entryCommission = requireFiniteCalculation(
    contractAFull.contracts * contractAFull.commissionPerContractPerSide +
      contractBFull.contracts * contractBFull.commissionPerContractPerSide,
    "entryCommission",
  );
  const roundTripBidAskCost = requireFiniteCalculation(entryBidAskCost * 2, "roundTripBidAskCost");
  const roundTripSlippageCost = requireFiniteCalculation(
    entrySlippageCost * 2,
    "roundTripSlippageCost",
  );
  const roundTripCommission = requireFiniteCalculation(entryCommission * 2, "roundTripCommission");
  const roundTripCosts = requireFiniteCalculation(
    roundTripCommission + roundTripBidAskCost + roundTripSlippageCost,
    "roundTripCosts",
  );
  const initialMarginEstimate = requirePositiveFinite(
    contractAFull.contracts * contractAFull.initialMarginPerContract +
      contractBFull.contracts * contractBFull.initialMarginPerContract,
    "initialMarginEstimate",
  );
  const events: PairSpreadReversionEvent[] = [];
  let armed = true;
  let signalIndex = params.lookbackWindow;

  while (signalIndex < params.observations.length) {
    const signalZScore = zScoreAt(spread, signalIndex, params.lookbackWindow);
    if (signalZScore === null) {
      signalIndex += 1;
      continue;
    }
    if (Math.abs(signalZScore) < entryZScore) {
      armed = true;
      signalIndex += 1;
      continue;
    }
    if (!armed) {
      signalIndex += 1;
      continue;
    }

    armed = false;
    const direction = directionFor(signalZScore);
    const event: PairSpreadReversionEvent = {
      signalTimestamp: params.observations[signalIndex].timestamp,
      signalZScore,
      direction,
      status: "sample_censored",
    };
    const entryIndex = signalIndex + 1;
    if (entryIndex >= params.observations.length) {
      events.push({
        ...event,
        status: "entry_unfilled_at_sample_end",
        censorReason: "no_next_observation_for_entry",
      });
      break;
    }

    const entryObservation = params.observations[entryIndex];
    event.entryTimestamp = entryObservation.timestamp;
    event.entryPriceA = entryObservation.priceA;
    event.entryPriceB = entryObservation.priceB;
    event.entryCostsCurrency = {
      commission: entryCommission,
      bidAsk: entryBidAskCost,
      slippage: entrySlippageCost,
      total: requireFiniteCalculation(
        entryCommission + entryBidAskCost + entrySlippageCost,
        "entryCosts",
      ),
    };
    event.initialMarginEstimateCurrency = initialMarginEstimate;
    const maxTestIndex = entryIndex + params.maxHoldingObservations - 1;
    let exitIndex: number | undefined;
    let exitTrigger: PairSpreadReversionEvent["exitTrigger"];
    let observedAdversePnl = 0;
    let lastObservedMarkToMarket = 0;
    let lastObservedIndex = entryIndex;

    if (maxTestIndex < entryIndex + 1) {
      exitTrigger = "time_limit";
      if (entryIndex + 1 < params.observations.length) {
        exitIndex = entryIndex + 1;
        event.status = "timed_out";
      } else {
        event.censorReason = "no_next_observation_for_exit";
      }
    }

    for (
      let testIndex = entryIndex + 1;
      exitIndex === undefined && testIndex <= maxTestIndex;
      testIndex += 1
    ) {
      if (testIndex >= params.observations.length) {
        event.censorReason = "sample_ended";
        break;
      }
      lastObservedIndex = testIndex;
      lastObservedMarkToMarket = markToMarket(
        direction,
        entryObservation.priceA,
        entryObservation.priceB,
        testIndex,
      );
      observedAdversePnl = Math.min(observedAdversePnl, lastObservedMarkToMarket);

      const zScore = zScoreAt(spread, testIndex, params.lookbackWindow);
      const meanReverted =
        zScore !== null &&
        (direction === "short_spread" ? zScore <= params.exitZScore : zScore >= -params.exitZScore);
      const stopped =
        stopZScore !== undefined &&
        zScore !== null &&
        (direction === "short_spread" ? zScore >= stopZScore : zScore <= -stopZScore);
      const timedOut = testIndex === maxTestIndex;
      if (!meanReverted && !stopped && !timedOut) {
        continue;
      }

      exitTrigger = meanReverted ? "mean_reversion" : stopped ? "adverse_stop" : "time_limit";
      if (testIndex + 1 >= params.observations.length) {
        event.censorReason = "no_next_observation_for_exit";
        break;
      }
      exitIndex = testIndex + 1;
      event.status = meanReverted ? "recovered" : stopped ? "stopped" : "timed_out";
      break;
    }

    if (exitIndex !== undefined) {
      const exitObservation = params.observations[exitIndex];
      event.exitTimestamp = exitObservation.timestamp;
      event.exitPriceA = exitObservation.priceA;
      event.exitPriceB = exitObservation.priceB;
      event.exitTrigger = exitTrigger;
      event.observationsHeld = exitIndex - entryIndex;
      observedAdversePnl = Math.min(
        observedAdversePnl,
        markToMarket(direction, entryObservation.priceA, entryObservation.priceB, exitIndex),
      );
      const sides = sideSigns(direction);
      const grossPnlCurrency =
        sides.a *
          contractAFull.contracts *
          contractAFull.multiplier *
          (exitObservation.priceA - entryObservation.priceA) +
        sides.b *
          contractBFull.contracts *
          contractBFull.multiplier *
          (exitObservation.priceB - entryObservation.priceB);
      const totalCostsCurrency = roundTripCosts;
      requireFiniteCalculation(grossPnlCurrency, "grossPnlCurrency");
      event.grossPnlCurrency = grossPnlCurrency;
      event.costsCurrency = {
        commission: roundTripCommission,
        bidAsk: roundTripBidAskCost,
        slippage: roundTripSlippageCost,
        total: totalCostsCurrency,
      };
      event.netPnlCurrency = requireFiniteCalculation(
        grossPnlCurrency - totalCostsCurrency,
        "netPnlCurrency",
      );
      event.lastObservedMarkToMarketCurrency = markToMarket(
        direction,
        entryObservation.priceA,
        entryObservation.priceB,
        exitIndex,
      );
      event.maxAdverseLossCurrency = requireFiniteCalculation(
        Math.max(0, -observedAdversePnl + roundTripCosts),
        "maxAdverseLoss",
      );
      signalIndex = exitIndex;
      const exitZScore = zScoreAt(spread, exitIndex, params.lookbackWindow);
      armed = exitZScore !== null && Math.abs(exitZScore) < entryZScore;
    } else {
      event.exitTrigger = exitTrigger;
      event.observationsObservedAfterEntry = lastObservedIndex - entryIndex;
      event.lastObservedMarkToMarketCurrency = lastObservedMarkToMarket;
      event.maxAdverseLossCurrency = requireFiniteCalculation(
        Math.max(0, -observedAdversePnl + roundTripCosts),
        "maxAdverseLoss",
      );
      event.status = "sample_censored";
      signalIndex = params.observations.length;
    }
    events.push(event);
  }

  const resolvedEvents = events.filter((event) =>
    ["recovered", "stopped", "timed_out"].includes(event.status),
  );
  const recoveredEvents = resolvedEvents.filter((event) => event.status === "recovered");
  const stoppedEvents = resolvedEvents.filter((event) => event.status === "stopped");
  const timedOutEvents = resolvedEvents.filter((event) => event.status === "timed_out");
  const holdingTimes = recoveredEvents.flatMap((event) =>
    event.observationsHeld === undefined ? [] : [event.observationsHeld],
  );
  const resolvedHoldingTimes = resolvedEvents.flatMap((event) =>
    event.observationsHeld === undefined ? [] : [event.observationsHeld],
  );
  const completedEvents = resolvedEvents;
  const sum = (pick: (event: PairSpreadReversionEvent) => number | undefined) =>
    requireFiniteCalculation(
      completedEvents.reduce((total, event) => total + (pick(event) ?? 0), 0),
      "summary total",
    );
  const openPositionEvents = events.filter((event) => event.status === "sample_censored");
  const recoveryDurations = holdingTimes.toSorted((left, right) => left - right);
  const resolvedHoldingDurations = resolvedHoldingTimes.toSorted((left, right) => left - right);
  const recoveryMidpoint = Math.floor(recoveryDurations.length / 2);
  const medianRecoveryObservations =
    recoveryDurations.length === 0
      ? null
      : recoveryDurations.length % 2 === 1
        ? recoveryDurations[recoveryMidpoint]
        : (recoveryDurations[recoveryMidpoint - 1] + recoveryDurations[recoveryMidpoint]) / 2;
  const resolvedHoldingMidpoint = Math.floor(resolvedHoldingDurations.length / 2);
  const medianResolvedHoldingObservations =
    resolvedHoldingDurations.length === 0
      ? null
      : resolvedHoldingDurations.length % 2 === 1
        ? resolvedHoldingDurations[resolvedHoldingMidpoint]
        : (resolvedHoldingDurations[resolvedHoldingMidpoint - 1] +
            resolvedHoldingDurations[resolvedHoldingMidpoint]) /
          2;
  const currency = contractA.settlementCurrency.toUpperCase();

  return {
    researchMode: "research_only",
    pairId,
    relationshipRationale,
    sourceRef,
    observationWindow: {
      observations: params.observations.length,
      firstTimestamp: params.observations[0].timestamp,
      lastTimestamp: params.observations.at(-1)!.timestamp,
      sampleFrequency: "caller_supplied_not_inferred",
    },
    construction: {
      formula: "priceA - hedgeRatio * priceB",
      hedgeRatio,
    },
    thresholds: {
      entryZScore,
      exitZScore: params.exitZScore,
      ...(stopZScore !== undefined ? { stopZScore } : {}),
      maxHoldingObservations: params.maxHoldingObservations,
      lookbackWindow: params.lookbackWindow,
      eventPolicy: {
        entry: "first_threshold_touch_while_armed",
        rearm: "absolute_z_score_below_entry",
        overlappingEvents: false,
      },
    },
    fillModel: "next_observation_close_proxy",
    contracts: {
      contractA: {
        ...params.contractA,
        instrument: contractA.instrument,
        exchange: contractA.exchange,
        contractId: contractA.contractId,
        contractMonth: contractA.contractMonth,
        settlementCurrency: currency,
      },
      contractB: {
        ...params.contractB,
        instrument: contractB.instrument,
        exchange: contractB.exchange,
        contractId: contractB.contractId,
        contractMonth: contractB.contractMonth,
        settlementCurrency: currency,
      },
      impliedPriceHedgeRatio,
      priceHedgeRatioDifference,
    },
    summary: {
      pnlAccountingScope: "resolved_events_only",
      signalEvents: events.length,
      resolvedEvents: resolvedEvents.length,
      recoveredEvents: recoveredEvents.length,
      stoppedEvents: stoppedEvents.length,
      timedOutEvents: timedOutEvents.length,
      censoredEvents: events.length - resolvedEvents.length,
      recoveryRateAmongResolved:
        resolvedEvents.length === 0 ? null : recoveredEvents.length / resolvedEvents.length,
      recoveryRateAmongAllSignals:
        events.length === 0 ? null : recoveredEvents.length / events.length,
      allSignalRecoveryInterpretation: "censored_and_unfilled_signals_count_as_not_recovered",
      medianRecoveryObservations,
      meanRecoveryObservations:
        holdingTimes.length === 0
          ? null
          : holdingTimes.reduce((total, value) => total + value, 0) / holdingTimes.length,
      medianResolvedHoldingObservations,
      meanResolvedHoldingObservations:
        resolvedHoldingTimes.length === 0
          ? null
          : resolvedHoldingTimes.reduce((total, value) => total + value, 0) /
            resolvedHoldingTimes.length,
      grossPnlCurrency: sum((event) => event.grossPnlCurrency),
      commissionCurrency: sum((event) => event.costsCurrency?.commission),
      bidAskCurrency: sum((event) => event.costsCurrency?.bidAsk),
      slippageCurrency: sum((event) => event.costsCurrency?.slippage),
      totalCostsCurrency: sum((event) => event.costsCurrency?.total),
      netPnlCurrency: sum((event) => event.netPnlCurrency),
      openPositionEvents: openPositionEvents.length,
      openPositionEntryCostsCurrency: requireFiniteCalculation(
        openPositionEvents.reduce(
          (total, event) => total + (event.entryCostsCurrency?.total ?? 0),
          0,
        ),
        "openPositionEntryCostsCurrency",
      ),
      openPositionMarkToMarketCurrency: requireFiniteCalculation(
        openPositionEvents.reduce(
          (total, event) => total + (event.lastObservedMarkToMarketCurrency ?? 0),
          0,
        ),
        "openPositionMarkToMarketCurrency",
      ),
      peakSingleTradeMarginEstimateCurrency: events.reduce(
        (peak, event) => Math.max(peak, event.initialMarginEstimateCurrency ?? 0),
        0,
      ),
      worstObservedAdverseLossCurrency: events.reduce(
        (worst, event) => Math.max(worst, event.maxAdverseLossCurrency ?? 0),
        0,
      ),
    },
    events,
    liveSignalProduced: false,
    executionAuthority: "none",
    limitations: [
      "This is a non-overlapping single-pair threshold replay with caller-chosen thresholds; no parameter search, out-of-sample split, regime conditioning, failed-year analysis, or multiple-testing correction is performed. Holding times are observation counts; irregular gaps are not converted to calendar duration.",
      "Signals are computed on completed supplied observations and modeled entry/exit at the next supplied close. This is a price proxy, not a confirmed next-tradable fill; intrabar ordering, order-book depth, queue position, latency, partial fills, and legging are not modeled.",
      "An event starts on the first threshold touch while armed, does not overlap an existing event, and rearms after the absolute z-score returns below the entry threshold. With a one-observation holding limit, a scheduled time exit takes precedence over evaluating a same-close mean-reversion or stop trigger.",
      `Prices and cost inputs are caller-supplied. Commission, bid-ask width, slippage, multiplier, currency, and per-contract margin were not independently verified; zero cost assumptions are not evidence of zero costs. All reported currency amounts use ${currency}.`,
      "bidAskSpreadPoints is interpreted as the full quoted width, with half charged on entry and half on exit; slippage and commissions are charged for both sides.",
      "Commission assumes a fixed amount per contract per side, and all cost inputs plus initialMarginPerContract stay constant across the replay. Turnover-priced commission schedules, changing bid-ask/slippage, and historical margin changes are not modeled. Maximum adverse loss adds the supplied full round-trip cost assumptions to observed gross adverse mark-to-market.",
      "The two contract quantities may not match the spread hedge ratio; see impliedPriceHedgeRatio and priceHedgeRatioDifference. Margin is a gross sum with no exchange/broker offsets, variation margin, or FX conversion.",
      "Only one contract month per leg is modeled. Contract rolls, expiry handling, daily price limits, taxes, settlement cashflows, and portfolio-level shared factor/margin risk are excluded.",
      "P&L and round-trip cost totals include resolved events only. Still-open sample-censored entries report entry friction and last-observation gross mark-to-market separately; those values are not folded into closed-trade net P&L. A censored event is not counted as a resolved recovery. Recovery rates describe this selected historical sample, not future convergence or profitability.",
    ],
  };
}
