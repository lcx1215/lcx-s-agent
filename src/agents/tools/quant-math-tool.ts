import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "./common.js";
import { ToolInputError, jsonResult, readNumberParam, readStringParam } from "./common.js";

const QuantMathSchema = Type.Object({
  action: Type.String(),
  series: Type.Optional(Type.Array(Type.Number())),
  benchmark: Type.Optional(Type.Array(Type.Number())),
  seriesMode: Type.Optional(Type.String()),
  riskFreeRatePerPeriod: Type.Optional(Type.Number()),
  periodsPerYear: Type.Optional(Type.Number()),
  couponRate: Type.Optional(Type.Number()),
  yieldRate: Type.Optional(Type.Number()),
  maturityYears: Type.Optional(Type.Number()),
  paymentsPerYear: Type.Optional(Type.Number()),
  faceValue: Type.Optional(Type.Number()),
});

type QuantAction = "beta" | "correlation" | "sharpe" | "sortino" | "max_drawdown" | "bond_duration";

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

function assertSameLength(series: number[], benchmark: number[]) {
  if (series.length !== benchmark.length || series.length < 2) {
    throw new ToolInputError(
      "series and benchmark must have the same length and at least 2 points",
    );
  }
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
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

export function calculateBondDuration(params: {
  couponRate: number;
  yieldRate: number;
  maturityYears: number;
  paymentsPerYear?: number;
  faceValue?: number;
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
  for (let period = 1; period <= periods; period += 1) {
    const cashflow = period === periods ? couponPayment + faceValue : couponPayment;
    const discount = (1 + yieldPerPeriod) ** period;
    const pv = cashflow / discount;
    price += pv;
    weightedTime += (period / paymentsPerYear) * pv;
  }
  const macaulayDuration = weightedTime / price;
  const modifiedDuration = macaulayDuration / (1 + yieldPerPeriod);
  return {
    action: "bond_duration",
    price,
    macaulayDuration,
    modifiedDuration,
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
      "Compute bounded quantitative metrics such as beta, correlation, Sharpe, Sortino, max drawdown, and plain-vanilla bond duration from explicit inputs. Use this instead of guessing portfolio math in prose.",
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
        case "max_drawdown":
          return jsonResult(
            calculateMaxDrawdown(
              readNumberArray(params, "series"),
              readStringParam(params, "seriesMode"),
            ),
          );
        case "bond_duration":
          return jsonResult(
            calculateBondDuration({
              couponRate: readNumberParam(params, "couponRate", { required: true })!,
              yieldRate: readNumberParam(params, "yieldRate", { required: true })!,
              maturityYears: readNumberParam(params, "maturityYears", { required: true })!,
              paymentsPerYear: readNumberParam(params, "paymentsPerYear"),
              faceValue: readNumberParam(params, "faceValue"),
            }),
          );
        default:
          throw new ToolInputError(
            "action must be one of beta, correlation, sharpe, sortino, max_drawdown, bond_duration",
          );
      }
    },
  };
}
