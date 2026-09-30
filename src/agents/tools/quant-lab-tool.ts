/**
 * One entry point for the full quant toolkit: portfolio construction, risk decomposition,
 * attribution, and association testing.
 *
 * Why one tool with many actions rather than many tools: the model should be able to reach for
 * whichever calculation the question needs without learning a tool taxonomy first. Each action is
 * a deterministic function in `quant-math-advanced.ts` / `quant-math-inference.ts`; this file is
 * only input handling and dispatch.
 *
 * Every call is recorded to the calculation ledger when one is supplied, and the record id is
 * returned. That id is what lets a later claim of "I derived this number" be checked against a
 * calculation that actually ran.
 */

import { Type } from "@sinclair/typebox";
import {
  type CalculationLedger,
  getSharedCalculationLedger,
} from "../finance-calculation-ledger.js";
import {
  blackLitterman,
  brinsonAttribution,
  componentVar,
  cornishFisherVar,
  autocorrelationFunction,
  durbinWatson,
  partialAutocorrelationFunction,
  ewmaCovariance,
  jarqueBera,
  maxDiversificationPortfolio,
  maxSharpePortfolio,
  minVariancePortfolio,
  moments,
  neweyWestMean,
  riskParityPortfolio,
  stressTest,
  turnoverAndCost,
} from "../quant-math-advanced.js";
import {
  adfTest,
  adjustPValues,
  correlationMatrix,
  covarianceMatrix,
  grangerCausality,
  rollingCorrelation,
  shrinkCovariance,
  type AdfRegression,
  type MultipleTestingMethod,
} from "../quant-math-foundations.js";
import {
  correlationTest,
  eventStudy,
  leadLagCorrelation,
  regressionDiagnostics,
  spuriousRegressionCheck,
} from "../quant-math-inference.js";
import {
  diagnosePairSpread,
  replayPairSpreadReversion,
  type PairSpreadConstruction,
  type PairSpreadObservation,
  type PairSpreadReplayContract,
} from "../quant-math-pair-spread.js";
import type { AnyAgentTool } from "./common.js";
import { ToolInputError, jsonResult, readStringParam } from "./common.js";

const NumberArray = Type.Array(Type.Number());
const NumberMatrix = Type.Array(NumberArray);

const QuantLabSchema = Type.Object({
  action: Type.String(),
  series: Type.Optional(NumberArray),
  benchmark: Type.Optional(NumberArray),
  cov: Type.Optional(NumberMatrix),
  returnsMatrix: Type.Optional(NumberMatrix),
  P: Type.Optional(NumberMatrix),
  Q: Type.Optional(NumberArray),
  omega: Type.Optional(NumberArray),
  weights: Type.Optional(NumberArray),
  currentWeights: Type.Optional(NumberArray),
  targetWeights: Type.Optional(NumberArray),
  marketWeights: Type.Optional(NumberArray),
  portfolioWeights: Type.Optional(NumberArray),
  benchmarkWeights: Type.Optional(NumberArray),
  expectedReturns: Type.Optional(NumberArray),
  portfolioReturns: Type.Optional(NumberArray),
  benchmarkReturns: Type.Optional(NumberArray),
  sectors: Type.Optional(Type.Array(Type.String())),
  scenarios: Type.Optional(Type.Array(Type.Object({ name: Type.String(), shocks: NumberArray }))),
  observations: Type.Optional(
    Type.Array(
      Type.Object({
        timestamp: Type.String(),
        priceA: Type.Number(),
        priceB: Type.Number(),
      }),
    ),
  ),
  contractA: Type.Optional(
    Type.Object({
      instrument: Type.String(),
      exchange: Type.String(),
      contractId: Type.String(),
      contractMonth: Type.String(),
      contracts: Type.Number(),
      multiplier: Type.Number(),
      settlementCurrency: Type.String(),
      commissionPerContractPerSide: Type.Number(),
      bidAskSpreadPoints: Type.Number(),
      slippagePointsPerSide: Type.Number(),
      initialMarginPerContract: Type.Number(),
    }),
  ),
  contractB: Type.Optional(
    Type.Object({
      instrument: Type.String(),
      exchange: Type.String(),
      contractId: Type.String(),
      contractMonth: Type.String(),
      contracts: Type.Number(),
      multiplier: Type.Number(),
      settlementCurrency: Type.String(),
      commissionPerContractPerSide: Type.Number(),
      bidAskSpreadPoints: Type.Number(),
      slippagePointsPerSide: Type.Number(),
      initialMarginPerContract: Type.Number(),
    }),
  ),
  pairId: Type.Optional(Type.String()),
  instrumentA: Type.Optional(Type.String()),
  instrumentB: Type.Optional(Type.String()),
  relationshipRationale: Type.Optional(Type.String()),
  sourceRef: Type.Optional(Type.String()),
  construction: Type.Optional(Type.String()),
  hedgeRatio: Type.Optional(Type.Number()),
  lookbackWindow: Type.Optional(Type.Number()),
  entryZScore: Type.Optional(Type.Number()),
  exitZScore: Type.Optional(Type.Number()),
  stopZScore: Type.Optional(Type.Number()),
  maxHoldingObservations: Type.Optional(Type.Number()),
  estimationWindow: Type.Optional(NumberArray),
  eventWindow: Type.Optional(NumberArray),
  lower: Type.Optional(Type.Number()),
  upper: Type.Optional(Type.Number()),
  riskFreeRate: Type.Optional(Type.Number()),
  confidenceLevel: Type.Optional(Type.Number()),
  lambda: Type.Optional(Type.Number()),
  tau: Type.Optional(Type.Number()),
  riskAversion: Type.Optional(Type.Number()),
  lags: Type.Optional(Type.Number()),
  maxLag: Type.Optional(Type.Number()),
  costBasisPoints: Type.Optional(Type.Number()),
  window: Type.Optional(Type.Number()),
  unstableRangeThreshold: Type.Optional(Type.Number()),
  alpha: Type.Optional(Type.Number()),
  pValues: Type.Optional(NumberArray),
  method: Type.Optional(Type.String()),
  regression: Type.Optional(Type.String()),
});

type Params = Record<string, unknown>;

function numbers(params: Params, key: string): number[] {
  const value = params[key];
  if (!Array.isArray(value) || value.length === 0) {
    throw new ToolInputError(`${key} is required`);
  }
  return value.map((item) => {
    if (typeof item !== "number" || !Number.isFinite(item)) {
      throw new ToolInputError(`${key} must contain finite numbers`);
    }
    return item;
  });
}

function optionalNumbers(params: Params, key: string): number[] | undefined {
  const value = params[key];
  if (value === undefined) {
    return undefined;
  }
  return numbers(params, key);
}

function finiteNumber(params: Params, key: string): number {
  const value = params[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ToolInputError(`${key} must be a finite number`);
  }
  return value;
}

function replayContract(params: Params, key: string): PairSpreadReplayContract {
  const value = params[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ToolInputError(`${key} is required for pair_spread_reversion_replay`);
  }
  return value as PairSpreadReplayContract;
}

function matrix(params: Params, key: string): number[][] {
  const value = params[key];
  if (!Array.isArray(value) || value.length === 0) {
    throw new ToolInputError(`${key} is required`);
  }
  return value.map((row) => {
    if (!Array.isArray(row)) {
      throw new ToolInputError(`${key} must be an array of arrays`);
    }
    return row.map((item) => {
      if (typeof item !== "number" || !Number.isFinite(item)) {
        throw new ToolInputError(`${key} must contain finite numbers`);
      }
      return item;
    });
  });
}

function optionalMatrix(params: Params, key: string): number[][] | undefined {
  const value = params[key];
  return value === undefined ? undefined : matrix(params, key);
}

function boundsOf(params: Params): { lower?: number; upper?: number } | undefined {
  const lower = params.lower;
  const upper = params.upper;
  if (typeof lower !== "number" && typeof upper !== "number") {
    return undefined;
  }
  return {
    ...(typeof lower === "number" ? { lower } : {}),
    ...(typeof upper === "number" ? { upper } : {}),
  };
}

function pair(params: Params, key: string): [number, number] {
  const value = numbers(params, key);
  if (value.length !== 2) {
    throw new ToolInputError(`${key} must be [start, end]`);
  }
  return [value[0], value[1]];
}

function pairSpreadObservations(params: Params): PairSpreadObservation[] {
  const value = params.observations;
  if (!Array.isArray(value) || value.length === 0) {
    throw new ToolInputError("observations is required for pair_spread_diagnostics");
  }
  return value.map((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new ToolInputError(`observations[${index}] must be an object`);
    }
    const observation = row as Record<string, unknown>;
    if (
      typeof observation.timestamp !== "string" ||
      typeof observation.priceA !== "number" ||
      !Number.isFinite(observation.priceA) ||
      typeof observation.priceB !== "number" ||
      !Number.isFinite(observation.priceB)
    ) {
      throw new ToolInputError(`observations[${index}] must contain a timestamp and finite prices`);
    }
    return {
      timestamp: observation.timestamp,
      priceA: observation.priceA,
      priceB: observation.priceB,
    };
  });
}

export const QUANT_LAB_ACTIONS = [
  "min_variance",
  "max_sharpe",
  "risk_parity",
  "max_diversification",
  "black_litterman",
  "component_var",
  "cornish_fisher_var",
  "ewma_covariance",
  "stress_test",
  "brinson_attribution",
  "newey_west_mean",
  "jarque_bera",
  "moments",
  "durbin_watson",
  "acf",
  "pacf",
  "turnover_cost",
  "correlation_test",
  "regression_diagnostics",
  "spurious_regression_check",
  "lead_lag_correlation",
  "event_study",
  "covariance_matrix",
  "correlation_matrix",
  "adf_test",
  "adjust_p_values",
  "granger_causality",
  "rolling_correlation",
  "shrink_covariance",
  "pair_spread_diagnostics",
  "pair_spread_reversion_replay",
] as const;

export function createQuantLabTool(options: { ledger?: CalculationLedger } = {}): AnyAgentTool {
  // Default to the process-wide ledger. Leaving this optional-but-unwired means a number the model
  // says it computed leaves no trace, which is exactly the claim the ledger exists to settle.
  const ledger = options.ledger ?? getSharedCalculationLedger();

  return {
    label: "Quant Lab",
    name: "quant_lab",
    description:
      "Full quantitative toolkit: portfolio construction (min variance, max Sharpe, risk parity, max diversification, Black-Litterman), risk decomposition (component VaR, Cornish-Fisher VaR, EWMA covariance, stress tests), attribution (Brinson), association testing (correlation with p-values, regression diagnostics, spurious-regression guard, lead-lag, event study), foundational statistics, research-only pair_spread_diagnostics, and pair_spread_reversion_replay. Pair diagnostics report a caller-defined formula, latest z-score, descriptive AR(1), and ADF with limitations; they do not select pairs or prove cointegration, convergence, or profit. The bounded replay accepts only fixed spreads and requires synchronized observations, caller-chosen thresholds, contract legs matched to the named instruments, and per-leg integer lots, multipliers, currency, commission per contract per side, full quoted bid-ask width, slippage per side, and initial margin. Its event policy is first threshold touch while armed, no overlap, and rearm after z-score returns inside the entry threshold. It uses next-observation close prices as a proxy, includes P&L and round-trip costs only for resolved events, reports open censored entry costs and mark-to-market separately, does not model actual order-book fills, rolls, or legging, and has no execution authority. Use these instead of computing portfolio maths or claiming a relationship in prose: each result includes a checkable calculation or stated statistical test, with statistical significance reported only where calculated. Run adf_test before regression on price levels, and adjust_p_values whenever more than one hypothesis was screened. When a portfolio action rejects the covariance as not positive definite, run shrink_covariance on the same returns matrix first: that is the usual consequence of having as many assets as observations. A solution that comes back with illConditioned true needs the same treatment even though nothing was rejected — it means two holdings are nearly the same asset, the weights are an artefact of that dependency, and grossExposure will be far above 1 as a result. Always read grossExposure before quoting weights: it is 1 for a fully invested long-only book and larger as soon as the solution is levered or short.",
    parameters: QuantLabSchema,
    execute: async (_toolCallId, params) => {
      const action = readStringParam(params, "action", { required: true });
      const typed = params as Params;

      const run = (): { output: Record<string, unknown>; inputs: Record<string, unknown> } => {
        switch (action) {
          case "min_variance": {
            const inputs = { cov: matrix(typed, "cov"), bounds: boundsOf(typed) };
            return { inputs, output: minVariancePortfolio(inputs.cov, inputs.bounds) as never };
          }
          case "max_sharpe": {
            const inputs = {
              expectedReturns: numbers(typed, "expectedReturns"),
              cov: matrix(typed, "cov"),
              riskFreeRate: typed.riskFreeRate as number | undefined,
              bounds: boundsOf(typed),
            };
            return {
              inputs,
              output: maxSharpePortfolio({
                expectedReturns: inputs.expectedReturns,
                cov: inputs.cov,
                ...(inputs.riskFreeRate !== undefined ? { riskFreeRate: inputs.riskFreeRate } : {}),
                ...(inputs.bounds ? { bounds: inputs.bounds } : {}),
              }) as never,
            };
          }
          case "risk_parity": {
            const inputs = { cov: matrix(typed, "cov") };
            return { inputs, output: riskParityPortfolio(inputs.cov) as never };
          }
          case "max_diversification": {
            const inputs = { cov: matrix(typed, "cov") };
            return { inputs, output: maxDiversificationPortfolio(inputs.cov) as never };
          }
          case "black_litterman": {
            const inputs = {
              cov: matrix(typed, "cov"),
              marketWeights: numbers(typed, "marketWeights"),
              P: optionalMatrix(typed, "P"),
              Q: optionalNumbers(typed, "Q"),
              omega: optionalNumbers(typed, "omega"),
              tau: typed.tau as number | undefined,
              riskAversion: typed.riskAversion as number | undefined,
            };
            return {
              inputs,
              output: blackLitterman({
                cov: inputs.cov,
                marketWeights: inputs.marketWeights,
                ...(inputs.P ? { P: inputs.P } : {}),
                ...(inputs.Q ? { Q: inputs.Q } : {}),
                ...(inputs.omega ? { omega: inputs.omega } : {}),
                ...(inputs.tau !== undefined ? { tau: inputs.tau } : {}),
                ...(inputs.riskAversion !== undefined ? { riskAversion: inputs.riskAversion } : {}),
              }) as never,
            };
          }
          case "component_var": {
            const inputs = {
              weights: numbers(typed, "weights"),
              cov: matrix(typed, "cov"),
              confidenceLevel: typed.confidenceLevel as number | undefined,
            };
            return {
              inputs,
              output: componentVar({
                weights: inputs.weights,
                cov: inputs.cov,
                ...(inputs.confidenceLevel !== undefined
                  ? { confidenceLevel: inputs.confidenceLevel }
                  : {}),
              }) as never,
            };
          }
          case "cornish_fisher_var": {
            const inputs = {
              returns: numbers(typed, "series"),
              confidenceLevel: typed.confidenceLevel as number | undefined,
            };
            return {
              inputs,
              output: cornishFisherVar({
                returns: inputs.returns,
                ...(inputs.confidenceLevel !== undefined
                  ? { confidenceLevel: inputs.confidenceLevel }
                  : {}),
              }) as never,
            };
          }
          case "ewma_covariance": {
            const inputs = {
              returnsMatrix: matrix(typed, "returnsMatrix"),
              lambda: typed.lambda as number | undefined,
            };
            return {
              inputs,
              output: ewmaCovariance({
                returnsMatrix: inputs.returnsMatrix,
                ...(inputs.lambda !== undefined ? { lambda: inputs.lambda } : {}),
              }) as never,
            };
          }
          case "stress_test": {
            const scenarios = typed.scenarios;
            if (!Array.isArray(scenarios) || scenarios.length === 0) {
              throw new ToolInputError("scenarios is required for stress_test");
            }
            const inputs = {
              weights: numbers(typed, "weights"),
              scenarios: scenarios as Array<{ name: string; shocks: number[] }>,
            };
            return { inputs, output: { results: stressTest(inputs) } as never };
          }
          case "brinson_attribution": {
            const sectors = typed.sectors;
            if (!Array.isArray(sectors) || sectors.length === 0) {
              throw new ToolInputError("sectors is required for brinson_attribution");
            }
            const inputs = {
              sectors: sectors as string[],
              portfolioWeights: numbers(typed, "portfolioWeights"),
              portfolioReturns: numbers(typed, "portfolioReturns"),
              benchmarkWeights: numbers(typed, "benchmarkWeights"),
              benchmarkReturns: numbers(typed, "benchmarkReturns"),
            };
            return { inputs, output: brinsonAttribution(inputs) as never };
          }
          case "newey_west_mean": {
            const inputs = {
              values: numbers(typed, "series"),
              lags: typed.lags as number | undefined,
            };
            return {
              inputs,
              output: neweyWestMean({
                values: inputs.values,
                ...(inputs.lags !== undefined ? { lags: inputs.lags } : {}),
              }) as never,
            };
          }
          case "acf": {
            const inputs = {
              values: numbers(typed, "series"),
              maxLag: typed.maxLag as number | undefined,
            };
            return {
              inputs,
              output: autocorrelationFunction({
                values: inputs.values,
                ...(inputs.maxLag !== undefined ? { maxLag: inputs.maxLag } : {}),
              }) as never,
            };
          }
          case "pacf": {
            const inputs = {
              values: numbers(typed, "series"),
              maxLag: typed.maxLag as number | undefined,
            };
            return {
              inputs,
              output: partialAutocorrelationFunction({
                values: inputs.values,
                ...(inputs.maxLag !== undefined ? { maxLag: inputs.maxLag } : {}),
              }) as never,
            };
          }
          case "jarque_bera": {
            const inputs = { values: numbers(typed, "series") };
            return { inputs, output: jarqueBera(inputs.values) as never };
          }
          case "moments": {
            const inputs = { values: numbers(typed, "series") };
            return { inputs, output: moments(inputs.values) as never };
          }
          case "durbin_watson": {
            const inputs = { residuals: numbers(typed, "series") };
            return { inputs, output: { durbinWatson: durbinWatson(inputs.residuals) } as never };
          }
          case "turnover_cost": {
            const inputs = {
              currentWeights: numbers(typed, "currentWeights"),
              targetWeights: numbers(typed, "targetWeights"),
              costBasisPoints: typed.costBasisPoints as number | undefined,
            };
            return {
              inputs,
              output: turnoverAndCost({
                currentWeights: inputs.currentWeights,
                targetWeights: inputs.targetWeights,
                ...(inputs.costBasisPoints !== undefined
                  ? { costBasisPoints: inputs.costBasisPoints }
                  : {}),
              }) as never,
            };
          }
          case "correlation_test": {
            const inputs = {
              a: numbers(typed, "series"),
              b: numbers(typed, "benchmark"),
            };
            return { inputs, output: correlationTest(inputs.a, inputs.b) as never };
          }
          case "regression_diagnostics": {
            const inputs = {
              x: numbers(typed, "series"),
              y: numbers(typed, "benchmark"),
            };
            return { inputs, output: regressionDiagnostics(inputs.x, inputs.y) as never };
          }
          case "spurious_regression_check": {
            const inputs = {
              series: numbers(typed, "series"),
              other: numbers(typed, "benchmark"),
            };
            return {
              inputs,
              output: spuriousRegressionCheck(inputs.series, inputs.other) as never,
            };
          }
          case "lead_lag_correlation": {
            const inputs = {
              series: numbers(typed, "series"),
              other: numbers(typed, "benchmark"),
              maxLag: typed.maxLag as number | undefined,
            };
            return {
              inputs,
              output: leadLagCorrelation(inputs.series, inputs.other, inputs.maxLag ?? 5) as never,
            };
          }
          case "event_study": {
            const inputs = {
              returns: numbers(typed, "series"),
              marketReturns: numbers(typed, "benchmark"),
              estimationWindow: pair(typed, "estimationWindow"),
              eventWindow: pair(typed, "eventWindow"),
            };
            return {
              inputs,
              output: eventStudy({
                returns: inputs.returns,
                marketReturns: inputs.marketReturns,
                estimationWindow: inputs.estimationWindow,
                eventWindow: inputs.eventWindow,
              }) as never,
            };
          }
          case "shrink_covariance": {
            const inputs = { returnsMatrix: matrix(typed, "returnsMatrix") };
            return { inputs, output: shrinkCovariance(inputs) as never };
          }
          case "covariance_matrix": {
            const inputs = { returnsMatrix: matrix(typed, "returnsMatrix") };
            return {
              inputs,
              output: { covariance: covarianceMatrix(inputs.returnsMatrix) } as never,
            };
          }
          case "correlation_matrix": {
            const inputs = { returnsMatrix: matrix(typed, "returnsMatrix") };
            return {
              inputs,
              output: { correlation: correlationMatrix(inputs.returnsMatrix) } as never,
            };
          }
          case "adf_test": {
            const regression = typed.regression as AdfRegression | undefined;
            if (regression !== undefined && !["none", "drift", "trend"].includes(regression)) {
              throw new ToolInputError("regression must be one of none, drift, trend");
            }
            const inputs = {
              values: numbers(typed, "series"),
              ...(regression ? { regression } : {}),
              maxLag: typed.maxLag as number | undefined,
            };
            return { inputs, output: adfTest(inputs) as never };
          }
          case "adjust_p_values": {
            const method = typed.method as MultipleTestingMethod | undefined;
            if (method !== undefined && !["bonferroni", "benjamini_hochberg"].includes(method)) {
              throw new ToolInputError("method must be one of bonferroni, benjamini_hochberg");
            }
            const inputs = {
              pValues: numbers(typed, "pValues"),
              ...(method ? { method } : {}),
              alpha: typed.alpha as number | undefined,
            };
            return { inputs, output: adjustPValues(inputs) as never };
          }
          case "granger_causality": {
            const inputs = {
              y: numbers(typed, "series"),
              x: numbers(typed, "benchmark"),
              lags: typed.lags as number | undefined,
            };
            return { inputs, output: grangerCausality(inputs) as never };
          }
          case "rolling_correlation": {
            const inputs = {
              a: numbers(typed, "series"),
              b: numbers(typed, "benchmark"),
              window: typed.window as number | undefined,
              unstableRangeThreshold: typed.unstableRangeThreshold as number | undefined,
            };
            if (inputs.window === undefined) {
              throw new ToolInputError("window is required");
            }
            return {
              inputs,
              output: rollingCorrelation({
                a: inputs.a,
                b: inputs.b,
                window: inputs.window,
                ...(inputs.unstableRangeThreshold !== undefined
                  ? { unstableRangeThreshold: inputs.unstableRangeThreshold }
                  : {}),
              }) as never,
            };
          }
          case "pair_spread_diagnostics": {
            const construction = typed.construction;
            if (construction !== "fixed_spread" && construction !== "price_ratio") {
              throw new ToolInputError("construction must be one of fixed_spread, price_ratio");
            }
            const lookbackWindow = typed.lookbackWindow;
            if (typeof lookbackWindow !== "number" || !Number.isFinite(lookbackWindow)) {
              throw new ToolInputError("lookbackWindow is required");
            }
            const hedgeRatio = typed.hedgeRatio;
            if (
              hedgeRatio !== undefined &&
              (typeof hedgeRatio !== "number" || !Number.isFinite(hedgeRatio))
            ) {
              throw new ToolInputError("hedgeRatio must be finite when supplied");
            }
            const inputs = {
              pairId: readStringParam(typed, "pairId", { required: true }),
              instrumentA: readStringParam(typed, "instrumentA", { required: true }),
              instrumentB: readStringParam(typed, "instrumentB", { required: true }),
              relationshipRationale: readStringParam(typed, "relationshipRationale", {
                required: true,
              }),
              sourceRef: readStringParam(typed, "sourceRef", { required: true }),
              construction: construction as PairSpreadConstruction,
              ...(hedgeRatio !== undefined ? { hedgeRatio } : {}),
              lookbackWindow,
              observations: pairSpreadObservations(typed),
            };
            return { inputs, output: diagnosePairSpread(inputs) as never };
          }
          case "pair_spread_reversion_replay": {
            const construction = typed.construction;
            if (construction !== undefined && construction !== "fixed_spread") {
              throw new ToolInputError(
                "pair_spread_reversion_replay only supports construction=fixed_spread",
              );
            }
            const stopZScore = typed.stopZScore;
            if (
              stopZScore !== undefined &&
              (typeof stopZScore !== "number" || !Number.isFinite(stopZScore))
            ) {
              throw new ToolInputError("stopZScore must be finite when supplied");
            }
            const inputs = {
              pairId: readStringParam(typed, "pairId", { required: true }),
              instrumentA: readStringParam(typed, "instrumentA", { required: true }),
              instrumentB: readStringParam(typed, "instrumentB", { required: true }),
              relationshipRationale: readStringParam(typed, "relationshipRationale", {
                required: true,
              }),
              sourceRef: readStringParam(typed, "sourceRef", { required: true }),
              hedgeRatio: finiteNumber(typed, "hedgeRatio"),
              lookbackWindow: finiteNumber(typed, "lookbackWindow"),
              entryZScore: finiteNumber(typed, "entryZScore"),
              exitZScore: finiteNumber(typed, "exitZScore"),
              ...(stopZScore !== undefined ? { stopZScore } : {}),
              maxHoldingObservations: finiteNumber(typed, "maxHoldingObservations"),
              contractA: replayContract(typed, "contractA"),
              contractB: replayContract(typed, "contractB"),
              observations: pairSpreadObservations(typed),
            };
            return { inputs, output: replayPairSpreadReversion(inputs) as never };
          }
          default:
            throw new ToolInputError(`action must be one of ${QUANT_LAB_ACTIONS.join(", ")}`);
        }
      };

      const { inputs, output } = run();
      const record = ledger.record({ action, inputs, output });

      return jsonResult({
        action,
        ...output,
        calculationId: record.id,
        ledgerSize: ledger.list().length,
      });
    },
  };
}
