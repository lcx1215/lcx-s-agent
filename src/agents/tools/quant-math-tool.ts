import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "./common.js";
import { ToolInputError, jsonResult, readNumberParam, readStringParam } from "./common.js";

const QuantMathSchema = Type.Object({
  action: Type.String(),
  series: Type.Optional(Type.Array(Type.Number())),
  benchmark: Type.Optional(Type.Array(Type.Number())),
  seriesMatrix: Type.Optional(Type.Array(Type.Array(Type.Number()))),
  weights: Type.Optional(Type.Array(Type.Number())),
  targetRiskBudgets: Type.Optional(Type.Array(Type.Number())),
  covarianceMatrix: Type.Optional(Type.Array(Type.Array(Type.Number()))),
  seriesMode: Type.Optional(Type.String()),
  returnMode: Type.Optional(Type.String()),
  window: Type.Optional(Type.Number()),
  riskFreeRatePerPeriod: Type.Optional(Type.Number()),
  periodsPerYear: Type.Optional(Type.Number()),
  confidenceLevel: Type.Optional(Type.Number()),
  spot: Type.Optional(Type.Number()),
  strike: Type.Optional(Type.Number()),
  timeToExpiryYears: Type.Optional(Type.Number()),
  riskFreeRate: Type.Optional(Type.Number()),
  volatility: Type.Optional(Type.Number()),
  optionType: Type.Optional(Type.String()),
  couponRate: Type.Optional(Type.Number()),
  yieldRate: Type.Optional(Type.Number()),
  maturityYears: Type.Optional(Type.Number()),
  paymentsPerYear: Type.Optional(Type.Number()),
  faceValue: Type.Optional(Type.Number()),
  yieldShockBp: Type.Optional(Type.Number()),
});

type QuantAction =
  | "beta"
  | "correlation"
  | "returns_from_levels"
  | "covariance_matrix"
  | "correlation_matrix"
  | "linear_regression"
  | "rolling_beta"
  | "rolling_correlation"
  | "sharpe"
  | "sortino"
  | "tracking_error"
  | "information_ratio"
  | "max_drawdown"
  | "portfolio_return"
  | "portfolio_volatility"
  | "portfolio_risk_contribution"
  | "rolling_volatility"
  | "rolling_max_drawdown"
  | "drawdown_duration"
  | "cagr"
  | "calmar_ratio"
  | "z_score"
  | "historical_var"
  | "expected_shortfall"
  | "risk_budget_deviation"
  | "black_scholes"
  | "bond_duration";

function readNumberArray(params: Record<string, unknown>, key: string, label = key): number[] {
  const raw = params[key];
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ToolInputError(`${label} required`);
  }
  const values = raw.filter((value) => typeof value === "number" && Number.isFinite(value));
  if (values.length !== raw.length) {
    throw new ToolInputError(`${label} must contain only finite numbers`);
  }
  return values;
}

function readNumberMatrix(params: Record<string, unknown>, key: string, label = key): number[][] {
  const raw = params[key];
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ToolInputError(`${label} required`);
  }
  const matrix = raw.map((row) => {
    if (!Array.isArray(row) || row.length === 0) {
      throw new ToolInputError(`${label} must contain non-empty numeric rows`);
    }
    const values = row.filter((value) => typeof value === "number" && Number.isFinite(value));
    if (values.length !== row.length) {
      throw new ToolInputError(`${label} rows must contain only finite numbers`);
    }
    return values;
  });
  const width = matrix[0].length;
  if (!matrix.every((row) => row.length === width)) {
    throw new ToolInputError(`${label} rows must have the same length`);
  }
  return matrix;
}

function assertSameLength(series: number[], benchmark: number[]) {
  if (series.length !== benchmark.length || series.length < 2) {
    throw new ToolInputError(
      "series and benchmark must have the same length and at least 2 points",
    );
  }
}

function assertWeightsAndSeries(weights: number[], series: number[]) {
  if (weights.length !== series.length || weights.length === 0) {
    throw new ToolInputError("weights and series must have the same non-zero length");
  }
}

function assertPositive(value: number, label: string) {
  if (value <= 0) {
    throw new ToolInputError(`${label} must be positive`);
  }
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function normalPdf(value: number): number {
  return Math.exp(-0.5 * value ** 2) / Math.sqrt(2 * Math.PI);
}

function normalCdf(value: number): number {
  // Abramowitz and Stegun 7.1.26 approximation. Accuracy is enough for tool-level
  // deterministic finance checks without pulling in a heavy statistics dependency.
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const erf = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * erf);
}

function percentile(sortedAscending: number[], percentileRank: number): number {
  if (sortedAscending.length === 0) {
    throw new ToolInputError("series required");
  }
  const clamped = Math.max(0, Math.min(1, percentileRank));
  const index = (sortedAscending.length - 1) * clamped;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) {
    return sortedAscending[lower];
  }
  const weight = index - lower;
  return sortedAscending[lower] * (1 - weight) + sortedAscending[upper] * weight;
}

function sampleVariance(values: number[]): number {
  if (values.length < 2) {
    throw new ToolInputError("at least 2 values required");
  }
  const avg = mean(values);
  return values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1);
}

function sampleStdDev(values: number[]): number {
  return Math.sqrt(sampleVariance(values));
}

function covariance(a: number[], b: number[]): number {
  assertSameLength(a, b);
  const meanA = mean(a);
  const meanB = mean(b);
  let total = 0;
  for (let i = 0; i < a.length; i += 1) {
    total += (a[i] - meanA) * (b[i] - meanB);
  }
  return total / (a.length - 1);
}

function transposeMatrix(matrix: number[][]): number[][] {
  const width = matrix[0]?.length ?? 0;
  return Array.from({ length: width }, (_unused, columnIndex) =>
    matrix.map((row) => row[columnIndex]),
  );
}

export function calculateBeta(series: number[], benchmark: number[]) {
  const benchmarkVariance = sampleVariance(benchmark);
  if (benchmarkVariance === 0) {
    throw new ToolInputError("benchmark variance must be non-zero");
  }
  return {
    action: "beta",
    observations: series.length,
    beta: covariance(series, benchmark) / benchmarkVariance,
  };
}

export function calculateCorrelation(series: number[], benchmark: number[]) {
  const stdSeries = sampleStdDev(series);
  const stdBenchmark = sampleStdDev(benchmark);
  if (stdSeries === 0 || stdBenchmark === 0) {
    throw new ToolInputError("series and benchmark standard deviation must be non-zero");
  }
  return {
    action: "correlation",
    observations: series.length,
    correlation: covariance(series, benchmark) / (stdSeries * stdBenchmark),
  };
}

export function calculateReturnsFromLevels(levels: number[], returnMode?: string) {
  if (levels.length < 2) {
    throw new ToolInputError("series must contain at least 2 levels");
  }
  for (const level of levels) {
    assertPositive(level, "level");
  }
  const mode = returnMode === "log" ? "log" : "simple";
  const returns = [];
  for (let index = 1; index < levels.length; index += 1) {
    const ratio = levels[index] / levels[index - 1];
    returns.push(mode === "log" ? Math.log(ratio) : ratio - 1);
  }
  return {
    action: "returns_from_levels",
    returnMode: mode,
    observations: levels.length,
    returns,
  };
}

export function calculateCovarianceMatrix(seriesMatrix: number[][]) {
  const series = transposeMatrix(seriesMatrix);
  if (series.length < 2) {
    throw new ToolInputError("seriesMatrix must contain at least 2 assets");
  }
  const width = series[0].length;
  if (width < 2 || !series.every((row) => row.length === width)) {
    throw new ToolInputError("seriesMatrix assets must have the same length and at least 2 points");
  }
  return {
    action: "covariance_matrix",
    assets: series.length,
    observations: width,
    covarianceMatrix: series.map((left) => series.map((right) => covariance(left, right))),
  };
}

export function calculateCorrelationMatrix(seriesMatrix: number[][]) {
  const covarianceResult = calculateCovarianceMatrix(seriesMatrix);
  const matrix = covarianceResult.covarianceMatrix;
  const diagonalStdDev = matrix.map((row, index) => Math.sqrt(row[index]));
  if (diagonalStdDev.some((value) => value === 0)) {
    throw new ToolInputError("all series standard deviations must be non-zero");
  }
  return {
    action: "correlation_matrix",
    assets: covarianceResult.assets,
    observations: covarianceResult.observations,
    correlationMatrix: matrix.map((row, rowIndex) =>
      row.map(
        (value, columnIndex) => value / (diagonalStdDev[rowIndex] * diagonalStdDev[columnIndex]),
      ),
    ),
  };
}

export function calculateLinearRegression(series: number[], benchmark: number[]) {
  assertSameLength(series, benchmark);
  const betaResult = calculateBeta(series, benchmark);
  const alphaPerPeriod = mean(series) - betaResult.beta * mean(benchmark);
  const residuals = series.map(
    (value, index) => value - (alphaPerPeriod + betaResult.beta * benchmark[index]),
  );
  const residualStdDev = sampleStdDev(residuals);
  return {
    action: "linear_regression",
    observations: series.length,
    alphaPerPeriod,
    beta: betaResult.beta,
    residualStdDev,
    rSquared: calculateCorrelation(series, benchmark).correlation ** 2,
  };
}

export function calculateRollingBeta(params: {
  series: number[];
  benchmark: number[];
  window?: number;
}) {
  assertSameLength(params.series, params.benchmark);
  const window = clampWindow(params.window, params.series.length);
  const values = [];
  for (let end = window; end <= params.series.length; end += 1) {
    values.push({
      endIndex: end - 1,
      beta: calculateBeta(
        params.series.slice(end - window, end),
        params.benchmark.slice(end - window, end),
      ).beta,
    });
  }
  return {
    action: "rolling_beta",
    observations: params.series.length,
    window,
    values,
  };
}

export function calculateRollingCorrelation(params: {
  series: number[];
  benchmark: number[];
  window?: number;
}) {
  assertSameLength(params.series, params.benchmark);
  const window = clampWindow(params.window, params.series.length);
  const values = [];
  for (let end = window; end <= params.series.length; end += 1) {
    values.push({
      endIndex: end - 1,
      correlation: calculateCorrelation(
        params.series.slice(end - window, end),
        params.benchmark.slice(end - window, end),
      ).correlation,
    });
  }
  return {
    action: "rolling_correlation",
    observations: params.series.length,
    window,
    values,
  };
}

export function calculateSharpe(params: {
  series: number[];
  riskFreeRatePerPeriod?: number;
  periodsPerYear?: number;
}) {
  if (params.series.length < 2) {
    throw new ToolInputError("series must contain at least 2 returns");
  }
  const riskFreeRatePerPeriod = params.riskFreeRatePerPeriod ?? 0;
  const periodsPerYear = params.periodsPerYear ?? 252;
  const excess = params.series.map((value) => value - riskFreeRatePerPeriod);
  const volatility = sampleStdDev(excess);
  if (volatility === 0) {
    throw new ToolInputError("series volatility must be non-zero");
  }
  return {
    action: "sharpe",
    observations: params.series.length,
    riskFreeRatePerPeriod,
    periodsPerYear,
    sharpe: (mean(excess) / volatility) * Math.sqrt(periodsPerYear),
  };
}

export function calculateSortino(params: {
  series: number[];
  riskFreeRatePerPeriod?: number;
  periodsPerYear?: number;
}) {
  if (params.series.length < 2) {
    throw new ToolInputError("series must contain at least 2 returns");
  }
  const riskFreeRatePerPeriod = params.riskFreeRatePerPeriod ?? 0;
  const periodsPerYear = params.periodsPerYear ?? 252;
  const excess = params.series.map((value) => value - riskFreeRatePerPeriod);
  const downside = excess.map((value) => (value < 0 ? value : 0));
  const downsideVariance =
    downside.reduce((sum, value) => sum + value ** 2, 0) / Math.max(1, downside.length - 1);
  const downsideDeviation = Math.sqrt(downsideVariance);
  if (downsideDeviation === 0) {
    throw new ToolInputError("downside deviation must be non-zero");
  }
  return {
    action: "sortino",
    observations: params.series.length,
    riskFreeRatePerPeriod,
    periodsPerYear,
    sortino: (mean(excess) / downsideDeviation) * Math.sqrt(periodsPerYear),
  };
}

export function calculateTrackingError(params: {
  series: number[];
  benchmark: number[];
  periodsPerYear?: number;
}) {
  assertSameLength(params.series, params.benchmark);
  const activeReturns = params.series.map((value, index) => value - params.benchmark[index]);
  const trackingErrorPerPeriod = sampleStdDev(activeReturns);
  const periodsPerYear = params.periodsPerYear ?? 252;
  return {
    action: "tracking_error",
    observations: params.series.length,
    periodsPerYear,
    trackingErrorPerPeriod,
    annualizedTrackingError: trackingErrorPerPeriod * Math.sqrt(periodsPerYear),
  };
}

export function calculateInformationRatio(params: {
  series: number[];
  benchmark: number[];
  periodsPerYear?: number;
}) {
  const trackingError = calculateTrackingError(params);
  if (trackingError.trackingErrorPerPeriod === 0) {
    throw new ToolInputError("tracking error must be non-zero");
  }
  const activeReturns = params.series.map((value, index) => value - params.benchmark[index]);
  const activeReturnPerPeriod = mean(activeReturns);
  return {
    action: "information_ratio",
    observations: params.series.length,
    periodsPerYear: trackingError.periodsPerYear,
    activeReturnPerPeriod,
    annualizedActiveReturn: activeReturnPerPeriod * trackingError.periodsPerYear,
    trackingErrorPerPeriod: trackingError.trackingErrorPerPeriod,
    annualizedTrackingError: trackingError.annualizedTrackingError,
    informationRatio:
      (activeReturnPerPeriod / trackingError.trackingErrorPerPeriod) *
      Math.sqrt(trackingError.periodsPerYear),
  };
}

function toEquityCurve(series: number[], seriesMode?: string): number[] {
  if (seriesMode === "levels") {
    return series;
  }
  const curve = [1];
  for (const value of series) {
    curve.push(curve[curve.length - 1] * (1 + value));
  }
  return curve;
}

export function calculateMaxDrawdown(series: number[], seriesMode?: string) {
  if (series.length === 0) {
    throw new ToolInputError("series required");
  }
  const curve = toEquityCurve(series, seriesMode);
  let peak = curve[0];
  let maxDrawdown = 0;
  for (const point of curve) {
    if (point > peak) {
      peak = point;
    }
    const drawdown = peak === 0 ? 0 : (point - peak) / peak;
    if (drawdown < maxDrawdown) {
      maxDrawdown = drawdown;
    }
  }
  return {
    action: "max_drawdown",
    inputMode: seriesMode === "levels" ? "levels" : "returns",
    observations: series.length,
    maxDrawdown,
  };
}

export function calculateDrawdownDuration(series: number[], seriesMode?: string) {
  if (series.length === 0) {
    throw new ToolInputError("series required");
  }
  const curve = toEquityCurve(series, seriesMode);
  let peak = curve[0];
  let currentDuration = 0;
  let maxDuration = 0;
  let currentStartIndex: number | null = null;
  let maxStartIndex: number | null = null;
  let maxEndIndex: number | null = null;

  for (let index = 0; index < curve.length; index += 1) {
    const point = curve[index];
    if (point >= peak) {
      peak = point;
      currentDuration = 0;
      currentStartIndex = null;
      continue;
    }

    if (currentDuration === 0) {
      currentStartIndex = index - 1;
    }
    currentDuration += 1;
    if (currentDuration > maxDuration) {
      maxDuration = currentDuration;
      maxStartIndex = currentStartIndex;
      maxEndIndex = index;
    }
  }

  return {
    action: "drawdown_duration",
    inputMode: seriesMode === "levels" ? "levels" : "returns",
    observations: series.length,
    maxDuration,
    maxStartIndex,
    maxEndIndex,
  };
}

export function calculatePortfolioReturn(params: { weights: number[]; returns: number[] }) {
  assertWeightsAndSeries(params.weights, params.returns);
  return {
    action: "portfolio_return",
    assets: params.weights.length,
    portfolioReturn: params.weights.reduce(
      (sum, weight, index) => sum + weight * params.returns[index],
      0,
    ),
  };
}

export function calculatePortfolioVolatility(params: {
  weights: number[];
  covarianceMatrix: number[][];
  periodsPerYear?: number;
}) {
  const { weights, covarianceMatrix } = params;
  if (
    covarianceMatrix.length !== weights.length ||
    covarianceMatrix.some((row) => row.length !== weights.length)
  ) {
    throw new ToolInputError("covarianceMatrix must be square and match weights length");
  }
  let variance = 0;
  for (let i = 0; i < weights.length; i += 1) {
    for (let j = 0; j < weights.length; j += 1) {
      variance += weights[i] * weights[j] * covarianceMatrix[i][j];
    }
  }
  if (variance < 0) {
    throw new ToolInputError("portfolio variance must be non-negative");
  }
  const volatility = Math.sqrt(variance);
  const periodsPerYear = params.periodsPerYear;
  return {
    action: "portfolio_volatility",
    assets: weights.length,
    variance,
    volatility,
    periodsPerYear: periodsPerYear ?? null,
    annualizedVolatility: periodsPerYear ? volatility * Math.sqrt(periodsPerYear) : null,
  };
}

export function calculatePortfolioRiskContribution(params: {
  weights: number[];
  covarianceMatrix: number[][];
  periodsPerYear?: number;
}) {
  const volatilityResult = calculatePortfolioVolatility(params);
  const { weights, covarianceMatrix } = params;
  if (volatilityResult.volatility === 0) {
    throw new ToolInputError("portfolio volatility must be non-zero");
  }
  const marginalRiskContribution = weights.map(
    (_weight, index) =>
      covarianceMatrix[index].reduce((sum, covarianceValue, columnIndex) => {
        return sum + covarianceValue * weights[columnIndex];
      }, 0) / volatilityResult.volatility,
  );
  const componentRiskContribution = marginalRiskContribution.map(
    (value, index) => value * weights[index],
  );
  return {
    action: "portfolio_risk_contribution",
    assets: weights.length,
    portfolioVolatility: volatilityResult.volatility,
    annualizedPortfolioVolatility: volatilityResult.annualizedVolatility,
    marginalRiskContribution,
    componentRiskContribution,
    percentRiskContribution: componentRiskContribution.map(
      (value) => value / volatilityResult.volatility,
    ),
  };
}

function clampWindow(value: number | undefined, seriesLength: number): number {
  const window = value ?? seriesLength;
  if (!Number.isFinite(window) || window < 2) {
    throw new ToolInputError("window must be at least 2");
  }
  const integerWindow = Math.trunc(window);
  if (integerWindow > seriesLength) {
    throw new ToolInputError("window must not exceed series length");
  }
  return integerWindow;
}

export function calculateRollingVolatility(params: {
  series: number[];
  window?: number;
  periodsPerYear?: number;
}) {
  const window = clampWindow(params.window, params.series.length);
  const periodsPerYear = params.periodsPerYear ?? 252;
  const values = [];
  for (let end = window; end <= params.series.length; end += 1) {
    const windowSeries = params.series.slice(end - window, end);
    const volatility = sampleStdDev(windowSeries);
    values.push({
      endIndex: end - 1,
      volatility,
      annualizedVolatility: volatility * Math.sqrt(periodsPerYear),
    });
  }
  return {
    action: "rolling_volatility",
    observations: params.series.length,
    window,
    periodsPerYear,
    values,
  };
}

export function calculateRollingMaxDrawdown(params: {
  series: number[];
  window?: number;
  seriesMode?: string;
}) {
  const window = clampWindow(params.window, params.series.length);
  const values = [];
  for (let end = window; end <= params.series.length; end += 1) {
    const windowSeries = params.series.slice(end - window, end);
    values.push({
      endIndex: end - 1,
      maxDrawdown: calculateMaxDrawdown(windowSeries, params.seriesMode).maxDrawdown,
    });
  }
  return {
    action: "rolling_max_drawdown",
    inputMode: params.seriesMode === "levels" ? "levels" : "returns",
    observations: params.series.length,
    window,
    values,
  };
}

export function calculateCagr(series: number[], seriesMode?: string, periodsPerYear?: number) {
  const curve = toEquityCurve(series, seriesMode);
  if (curve.length < 2) {
    throw new ToolInputError("series must contain at least 2 points");
  }
  const start = curve[0];
  const end = curve[curve.length - 1];
  assertPositive(start, "starting value");
  assertPositive(end, "ending value");
  const years =
    seriesMode === "levels"
      ? (curve.length - 1) / (periodsPerYear ?? 1)
      : series.length / (periodsPerYear ?? 252);
  assertPositive(years, "years");
  return {
    action: "cagr",
    inputMode: seriesMode === "levels" ? "levels" : "returns",
    observations: series.length,
    periodsPerYear: periodsPerYear ?? (seriesMode === "levels" ? 1 : 252),
    cagr: (end / start) ** (1 / years) - 1,
  };
}

export function calculateCalmarRatio(
  series: number[],
  seriesMode?: string,
  periodsPerYear?: number,
) {
  const cagr = calculateCagr(series, seriesMode, periodsPerYear);
  const maxDrawdown = calculateMaxDrawdown(series, seriesMode).maxDrawdown;
  if (maxDrawdown === 0) {
    throw new ToolInputError("max drawdown must be non-zero");
  }
  return {
    action: "calmar_ratio",
    inputMode: cagr.inputMode,
    observations: cagr.observations,
    periodsPerYear: cagr.periodsPerYear,
    cagr: cagr.cagr,
    maxDrawdown,
    calmarRatio: cagr.cagr / Math.abs(maxDrawdown),
  };
}

export function calculateZScore(series: number[]) {
  if (series.length < 2) {
    throw new ToolInputError("series must contain at least 2 values");
  }
  const average = mean(series);
  const stdDev = sampleStdDev(series);
  if (stdDev === 0) {
    throw new ToolInputError("series standard deviation must be non-zero");
  }
  const latest = series[series.length - 1];
  return {
    action: "z_score",
    observations: series.length,
    mean: average,
    standardDeviation: stdDev,
    latest,
    zScore: (latest - average) / stdDev,
  };
}

export function calculateHistoricalVar(params: { series: number[]; confidenceLevel?: number }) {
  if (params.series.length < 2) {
    throw new ToolInputError("series must contain at least 2 returns");
  }
  const confidenceLevel = params.confidenceLevel ?? 0.95;
  if (confidenceLevel <= 0 || confidenceLevel >= 1) {
    throw new ToolInputError("confidenceLevel must be between 0 and 1");
  }
  const sorted = [...params.series].toSorted((a, b) => a - b);
  const lossQuantileReturn = percentile(sorted, 1 - confidenceLevel);
  return {
    action: "historical_var",
    observations: params.series.length,
    confidenceLevel,
    lossQuantileReturn,
    valueAtRisk: Math.max(0, -lossQuantileReturn),
  };
}

export function calculateExpectedShortfall(params: { series: number[]; confidenceLevel?: number }) {
  const varResult = calculateHistoricalVar(params);
  const tail = params.series.filter((value) => value <= varResult.lossQuantileReturn);
  if (tail.length === 0) {
    throw new ToolInputError("no tail observations found");
  }
  const tailMeanReturn = mean(tail);
  return {
    action: "expected_shortfall",
    observations: params.series.length,
    tailObservations: tail.length,
    confidenceLevel: varResult.confidenceLevel,
    tailMeanReturn,
    expectedShortfall: Math.max(0, -tailMeanReturn),
    historicalVar: varResult.valueAtRisk,
  };
}

export function calculateRiskBudgetDeviation(params: {
  weights: number[];
  covarianceMatrix: number[][];
  targetRiskBudgets: number[];
  periodsPerYear?: number;
}) {
  if (params.targetRiskBudgets.length !== params.weights.length) {
    throw new ToolInputError("targetRiskBudgets must match weights length");
  }
  const targetTotal = params.targetRiskBudgets.reduce((sum, value) => sum + value, 0);
  if (targetTotal <= 0) {
    throw new ToolInputError("targetRiskBudgets total must be positive");
  }
  const normalizedTargetRiskBudgets = params.targetRiskBudgets.map((value) => value / targetTotal);
  const contribution = calculatePortfolioRiskContribution(params);
  const deviations = contribution.percentRiskContribution.map(
    (actual, index) => actual - normalizedTargetRiskBudgets[index],
  );
  return {
    action: "risk_budget_deviation",
    assets: params.weights.length,
    portfolioVolatility: contribution.portfolioVolatility,
    percentRiskContribution: contribution.percentRiskContribution,
    targetRiskBudgets: normalizedTargetRiskBudgets,
    deviations,
    maxAbsoluteDeviation: Math.max(...deviations.map((value) => Math.abs(value))),
  };
}

export function calculateBlackScholes(params: {
  spot: number;
  strike: number;
  timeToExpiryYears: number;
  riskFreeRate: number;
  volatility: number;
  optionType?: string;
}) {
  assertPositive(params.spot, "spot");
  assertPositive(params.strike, "strike");
  assertPositive(params.timeToExpiryYears, "timeToExpiryYears");
  assertPositive(params.volatility, "volatility");
  const optionType = params.optionType === "put" ? "put" : "call";
  const sqrtT = Math.sqrt(params.timeToExpiryYears);
  const d1 =
    (Math.log(params.spot / params.strike) +
      (params.riskFreeRate + 0.5 * params.volatility ** 2) * params.timeToExpiryYears) /
    (params.volatility * sqrtT);
  const d2 = d1 - params.volatility * sqrtT;
  const discountedStrike =
    params.strike * Math.exp(-params.riskFreeRate * params.timeToExpiryYears);
  const callPrice = params.spot * normalCdf(d1) - discountedStrike * normalCdf(d2);
  const putPrice = discountedStrike * normalCdf(-d2) - params.spot * normalCdf(-d1);
  const pdfD1 = normalPdf(d1);
  const gamma = pdfD1 / (params.spot * params.volatility * sqrtT);
  const vega = (params.spot * pdfD1 * sqrtT) / 100;
  const callTheta =
    ((-params.spot * pdfD1 * params.volatility) / (2 * sqrtT) -
      params.riskFreeRate * discountedStrike * normalCdf(d2)) /
    365;
  const putTheta =
    ((-params.spot * pdfD1 * params.volatility) / (2 * sqrtT) +
      params.riskFreeRate * discountedStrike * normalCdf(-d2)) /
    365;
  const callRho = (params.timeToExpiryYears * discountedStrike * normalCdf(d2)) / 100;
  const putRho = (-params.timeToExpiryYears * discountedStrike * normalCdf(-d2)) / 100;
  return {
    action: "black_scholes",
    optionType,
    price: optionType === "put" ? putPrice : callPrice,
    callPrice,
    putPrice,
    d1,
    d2,
    delta: optionType === "put" ? normalCdf(d1) - 1 : normalCdf(d1),
    gamma,
    vega,
    theta: optionType === "put" ? putTheta : callTheta,
    rho: optionType === "put" ? putRho : callRho,
    greeksScale: "vega and rho are per 1 percentage point change; theta is per calendar day.",
    boundary:
      "Plain-vanilla European option formula only; no American exercise, dividends, stochastic volatility, or execution advice.",
  };
}

export function calculateBondDuration(params: {
  couponRate: number;
  yieldRate: number;
  maturityYears: number;
  paymentsPerYear?: number;
  faceValue?: number;
  yieldShockBp?: number;
}) {
  const paymentsPerYear = params.paymentsPerYear ?? 2;
  const faceValue = params.faceValue ?? 100;
  if (paymentsPerYear <= 0 || params.maturityYears <= 0) {
    throw new ToolInputError("paymentsPerYear and maturityYears must be positive");
  }
  const periods = Math.round(params.maturityYears * paymentsPerYear);
  const couponPayment = (params.couponRate * faceValue) / paymentsPerYear;
  const yieldPerPeriod = params.yieldRate / paymentsPerYear;

  let price = 0;
  let weightedTime = 0;
  let weightedConvexity = 0;
  for (let period = 1; period <= periods; period += 1) {
    const cashflow = period === periods ? couponPayment + faceValue : couponPayment;
    const discount = (1 + yieldPerPeriod) ** period;
    const pv = cashflow / discount;
    price += pv;
    weightedTime += (period / paymentsPerYear) * pv;
    weightedConvexity += period * (period + 1) * pv;
  }
  const macaulayDuration = weightedTime / price;
  const modifiedDuration = macaulayDuration / (1 + yieldPerPeriod);
  const convexity = weightedConvexity / (price * paymentsPerYear ** 2 * (1 + yieldPerPeriod) ** 2);
  const yieldShockBp = params.yieldShockBp ?? 1;
  const dv01 = price * modifiedDuration * (yieldShockBp / 10_000);
  return {
    action: "bond_duration",
    price,
    macaulayDuration,
    modifiedDuration,
    convexity,
    dv01,
    yieldShockBp,
    couponRate: params.couponRate,
    yieldRate: params.yieldRate,
    maturityYears: params.maturityYears,
    paymentsPerYear,
    faceValue,
  };
}

export function createQuantMathTool(): AnyAgentTool {
  return {
    label: "Quant Math",
    name: "quant_math",
    description:
      "Compute bounded quantitative metrics such as returns, covariance/correlation matrix, regression alpha/beta, rolling beta/correlation, Sharpe, Sortino, tracking error, information ratio, max drawdown/duration, portfolio return/volatility/risk contribution, risk-budget deviation, CAGR/Calmar, z-score, historical VaR/expected shortfall, Black-Scholes European option price/Greeks, and plain-vanilla bond duration/DV01 from explicit inputs. Use this instead of guessing portfolio math in prose.",
    parameters: QuantMathSchema,
    execute: async (_toolCallId, params) => {
      const action = readStringParam(params, "action", { required: true }) as QuantAction;

      switch (action) {
        case "beta":
          return jsonResult(
            calculateBeta(readNumberArray(params, "series"), readNumberArray(params, "benchmark")),
          );
        case "correlation":
          return jsonResult(
            calculateCorrelation(
              readNumberArray(params, "series"),
              readNumberArray(params, "benchmark"),
            ),
          );
        case "returns_from_levels":
          return jsonResult(
            calculateReturnsFromLevels(
              readNumberArray(params, "series", "series levels"),
              readStringParam(params, "returnMode"),
            ),
          );
        case "covariance_matrix":
          return jsonResult(calculateCovarianceMatrix(readNumberMatrix(params, "seriesMatrix")));
        case "correlation_matrix":
          return jsonResult(calculateCorrelationMatrix(readNumberMatrix(params, "seriesMatrix")));
        case "linear_regression":
          return jsonResult(
            calculateLinearRegression(
              readNumberArray(params, "series"),
              readNumberArray(params, "benchmark"),
            ),
          );
        case "rolling_beta":
          return jsonResult(
            calculateRollingBeta({
              series: readNumberArray(params, "series"),
              benchmark: readNumberArray(params, "benchmark"),
              window: readNumberParam(params, "window", { integer: true }),
            }),
          );
        case "rolling_correlation":
          return jsonResult(
            calculateRollingCorrelation({
              series: readNumberArray(params, "series"),
              benchmark: readNumberArray(params, "benchmark"),
              window: readNumberParam(params, "window", { integer: true }),
            }),
          );
        case "sharpe":
          return jsonResult(
            calculateSharpe({
              series: readNumberArray(params, "series"),
              riskFreeRatePerPeriod: readNumberParam(params, "riskFreeRatePerPeriod"),
              periodsPerYear: readNumberParam(params, "periodsPerYear"),
            }),
          );
        case "sortino":
          return jsonResult(
            calculateSortino({
              series: readNumberArray(params, "series"),
              riskFreeRatePerPeriod: readNumberParam(params, "riskFreeRatePerPeriod"),
              periodsPerYear: readNumberParam(params, "periodsPerYear"),
            }),
          );
        case "tracking_error":
          return jsonResult(
            calculateTrackingError({
              series: readNumberArray(params, "series"),
              benchmark: readNumberArray(params, "benchmark"),
              periodsPerYear: readNumberParam(params, "periodsPerYear"),
            }),
          );
        case "information_ratio":
          return jsonResult(
            calculateInformationRatio({
              series: readNumberArray(params, "series"),
              benchmark: readNumberArray(params, "benchmark"),
              periodsPerYear: readNumberParam(params, "periodsPerYear"),
            }),
          );
        case "max_drawdown":
          return jsonResult(
            calculateMaxDrawdown(
              readNumberArray(params, "series"),
              readStringParam(params, "seriesMode"),
            ),
          );
        case "portfolio_return":
          return jsonResult(
            calculatePortfolioReturn({
              weights: readNumberArray(params, "weights"),
              returns: readNumberArray(params, "series", "series returns"),
            }),
          );
        case "portfolio_volatility":
          return jsonResult(
            calculatePortfolioVolatility({
              weights: readNumberArray(params, "weights"),
              covarianceMatrix: readNumberMatrix(params, "covarianceMatrix"),
              periodsPerYear: readNumberParam(params, "periodsPerYear"),
            }),
          );
        case "portfolio_risk_contribution":
          return jsonResult(
            calculatePortfolioRiskContribution({
              weights: readNumberArray(params, "weights"),
              covarianceMatrix: readNumberMatrix(params, "covarianceMatrix"),
              periodsPerYear: readNumberParam(params, "periodsPerYear"),
            }),
          );
        case "rolling_volatility":
          return jsonResult(
            calculateRollingVolatility({
              series: readNumberArray(params, "series"),
              window: readNumberParam(params, "window", { integer: true }),
              periodsPerYear: readNumberParam(params, "periodsPerYear"),
            }),
          );
        case "rolling_max_drawdown":
          return jsonResult(
            calculateRollingMaxDrawdown({
              series: readNumberArray(params, "series"),
              window: readNumberParam(params, "window", { integer: true }),
              seriesMode: readStringParam(params, "seriesMode"),
            }),
          );
        case "drawdown_duration":
          return jsonResult(
            calculateDrawdownDuration(
              readNumberArray(params, "series"),
              readStringParam(params, "seriesMode"),
            ),
          );
        case "cagr":
          return jsonResult(
            calculateCagr(
              readNumberArray(params, "series"),
              readStringParam(params, "seriesMode"),
              readNumberParam(params, "periodsPerYear"),
            ),
          );
        case "calmar_ratio":
          return jsonResult(
            calculateCalmarRatio(
              readNumberArray(params, "series"),
              readStringParam(params, "seriesMode"),
              readNumberParam(params, "periodsPerYear"),
            ),
          );
        case "z_score":
          return jsonResult(calculateZScore(readNumberArray(params, "series")));
        case "historical_var":
          return jsonResult(
            calculateHistoricalVar({
              series: readNumberArray(params, "series"),
              confidenceLevel: readNumberParam(params, "confidenceLevel"),
            }),
          );
        case "expected_shortfall":
          return jsonResult(
            calculateExpectedShortfall({
              series: readNumberArray(params, "series"),
              confidenceLevel: readNumberParam(params, "confidenceLevel"),
            }),
          );
        case "risk_budget_deviation":
          return jsonResult(
            calculateRiskBudgetDeviation({
              weights: readNumberArray(params, "weights"),
              covarianceMatrix: readNumberMatrix(params, "covarianceMatrix"),
              targetRiskBudgets: readNumberArray(params, "targetRiskBudgets"),
              periodsPerYear: readNumberParam(params, "periodsPerYear"),
            }),
          );
        case "black_scholes":
          return jsonResult(
            calculateBlackScholes({
              spot: readNumberParam(params, "spot", { required: true })!,
              strike: readNumberParam(params, "strike", { required: true })!,
              timeToExpiryYears: readNumberParam(params, "timeToExpiryYears", {
                required: true,
              })!,
              riskFreeRate: readNumberParam(params, "riskFreeRate", { required: true })!,
              volatility: readNumberParam(params, "volatility", { required: true })!,
              optionType: readStringParam(params, "optionType"),
            }),
          );
        case "bond_duration":
          return jsonResult(
            calculateBondDuration({
              couponRate: readNumberParam(params, "couponRate", { required: true })!,
              yieldRate: readNumberParam(params, "yieldRate", { required: true })!,
              maturityYears: readNumberParam(params, "maturityYears", { required: true })!,
              paymentsPerYear: readNumberParam(params, "paymentsPerYear"),
              faceValue: readNumberParam(params, "faceValue"),
              yieldShockBp: readNumberParam(params, "yieldShockBp"),
            }),
          );
        default:
          throw new ToolInputError(
            "action must be one of beta, correlation, returns_from_levels, covariance_matrix, correlation_matrix, linear_regression, rolling_beta, rolling_correlation, sharpe, sortino, tracking_error, information_ratio, max_drawdown, portfolio_return, portfolio_volatility, portfolio_risk_contribution, rolling_volatility, rolling_max_drawdown, drawdown_duration, cagr, calmar_ratio, z_score, historical_var, expected_shortfall, risk_budget_deviation, black_scholes, bond_duration",
          );
      }
    },
  };
}
