import { describe, expect, it } from "vitest";
import {
  calculateBeta,
  calculateBlackScholes,
  calculateBondDuration,
  calculateCagr,
  calculateCalmarRatio,
  calculateCorrelation,
  calculateCorrelationMatrix,
  calculateCovarianceMatrix,
  calculateDrawdownDuration,
  calculateExpectedShortfall,
  calculateHistoricalVar,
  calculateInformationRatio,
  calculateLinearRegression,
  calculateMaxDrawdown,
  calculatePortfolioReturn,
  calculatePortfolioRiskContribution,
  calculatePortfolioVolatility,
  calculateReturnsFromLevels,
  calculateRiskBudgetDeviation,
  calculateRollingBeta,
  calculateRollingCorrelation,
  calculateRollingMaxDrawdown,
  calculateRollingVolatility,
  calculateSharpe,
  calculateSortino,
  calculateTrackingError,
  calculateZScore,
  createQuantMathTool,
} from "./quant-math-tool.js";

describe("quant-math tool helpers", () => {
  it("calculates beta from explicit return series", () => {
    const result = calculateBeta([0.02, 0.01, -0.01, 0.03], [0.01, 0.005, -0.01, 0.02]);
    expect(result.beta).toBeCloseTo(1.36, 3);
  });

  it("calculates correlation from explicit return series", () => {
    const result = calculateCorrelation([0.02, 0.01, -0.01, 0.03], [0.01, 0.005, -0.01, 0.02]);
    expect(result.correlation).toBeCloseTo(0.9954, 3);
  });

  it("calculates sharpe and sortino with annualization", () => {
    const sharpe = calculateSharpe({
      series: [0.01, 0.015, -0.005, 0.02, 0.01],
      periodsPerYear: 252,
    });
    const sortino = calculateSortino({
      series: [0.01, 0.015, -0.005, 0.02, 0.01],
      periodsPerYear: 252,
    });

    expect(sharpe.sharpe).toBeGreaterThan(5);
    expect(sortino.sortino).toBeGreaterThan(sharpe.sharpe);
  });

  it("calculates returns from levels", () => {
    const simple = calculateReturnsFromLevels([100, 105, 102.9]);
    const log = calculateReturnsFromLevels([100, 105, 102.9], "log");

    expect(simple.returns[0]).toBeCloseTo(0.05, 8);
    expect(simple.returns[1]).toBeCloseTo(-0.02, 8);
    expect(log.returns[0]).toBeCloseTo(Math.log(1.05), 8);
    expect(log.returns[1]).toBeCloseTo(Math.log(0.98), 8);
  });

  it("calculates covariance and correlation matrices from aligned return rows", () => {
    const matrix = [
      [0.01, 0.02, -0.01],
      [0.02, 0.01, -0.02],
      [-0.01, 0.0, 0.01],
      [0.03, 0.025, -0.015],
    ];
    const covariance = calculateCovarianceMatrix(matrix);
    const correlation = calculateCorrelationMatrix(matrix);

    expect(covariance.covarianceMatrix[0][0]).toBeCloseTo(0.0002916667, 8);
    expect(covariance.covarianceMatrix[0][1]).toBeCloseTo(0.0001541667, 8);
    expect(correlation.correlationMatrix[0][0]).toBeCloseTo(1, 8);
    expect(correlation.correlationMatrix[0][1]).toBeCloseTo(0.8142, 3);
  });

  it("calculates regression alpha beta and active-risk metrics", () => {
    const series = [0.03, 0.01, -0.02, 0.04, 0.02];
    const benchmark = [0.02, 0.005, -0.015, 0.03, 0.01];
    const regression = calculateLinearRegression(series, benchmark);
    const trackingError = calculateTrackingError({ series, benchmark, periodsPerYear: 252 });
    const informationRatio = calculateInformationRatio({ series, benchmark, periodsPerYear: 252 });

    expect(regression.beta).toBeCloseTo(1.3478, 3);
    expect(regression.alphaPerPeriod).toBeCloseTo(0.0025, 3);
    expect(regression.rSquared).toBeGreaterThan(0.95);
    expect(trackingError.annualizedTrackingError).toBeGreaterThan(0.08);
    expect(informationRatio.informationRatio).toBeGreaterThan(1);
  });

  it("calculates rolling beta and rolling correlation", () => {
    const series = [0.03, 0.01, -0.02, 0.04, 0.02];
    const benchmark = [0.02, 0.005, -0.015, 0.03, 0.01];
    const beta = calculateRollingBeta({ series, benchmark, window: 3 });
    const correlation = calculateRollingCorrelation({ series, benchmark, window: 3 });

    expect(beta.values).toHaveLength(3);
    expect(beta.values[0].beta).toBeCloseTo(1.4324, 4);
    expect(correlation.values).toHaveLength(3);
    expect(correlation.values[1].correlation).toBeGreaterThan(0.98);
  });

  it("calculates max drawdown from returns and levels", () => {
    const fromReturns = calculateMaxDrawdown([0.1, -0.2, 0.05, -0.1]);
    const fromLevels = calculateMaxDrawdown([100, 110, 88, 92, 83], "levels");

    expect(fromReturns.maxDrawdown).toBeCloseTo(-0.244, 2);
    expect(fromLevels.maxDrawdown).toBeCloseTo(-0.245, 2);
  });

  it("calculates portfolio return and volatility from explicit weights", () => {
    const portfolioReturn = calculatePortfolioReturn({
      weights: [0.6, 0.4],
      returns: [0.1, 0.05],
    });
    const portfolioVolatility = calculatePortfolioVolatility({
      weights: [0.6, 0.4],
      covarianceMatrix: [
        [0.04, 0.006],
        [0.006, 0.0225],
      ],
      periodsPerYear: 1,
    });

    expect(portfolioReturn.portfolioReturn).toBeCloseTo(0.08, 6);
    expect(portfolioVolatility.variance).toBeCloseTo(0.02088, 6);
    expect(portfolioVolatility.volatility).toBeCloseTo(0.144499, 6);
  });

  it("calculates portfolio risk contribution from weights and covariance", () => {
    const result = calculatePortfolioRiskContribution({
      weights: [0.6, 0.4],
      covarianceMatrix: [
        [0.04, 0.006],
        [0.006, 0.0225],
      ],
      periodsPerYear: 1,
    });

    expect(result.portfolioVolatility).toBeCloseTo(0.144499, 6);
    expect(result.marginalRiskContribution[0]).toBeCloseTo(0.1827, 6);
    expect(result.marginalRiskContribution[1]).toBeCloseTo(0.087198, 6);
    expect(result.percentRiskContribution[0]).toBeCloseTo(0.758621, 6);
    expect(result.percentRiskContribution[1]).toBeCloseTo(0.241379, 6);
  });

  it("calculates rolling volatility and rolling max drawdown", () => {
    const returns = [0.02, -0.01, 0.03, -0.04, 0.01];
    const rollingVolatility = calculateRollingVolatility({
      series: returns,
      window: 3,
      periodsPerYear: 1,
    });
    const rollingDrawdown = calculateRollingMaxDrawdown({
      series: returns,
      window: 3,
    });

    expect(rollingVolatility.values).toHaveLength(3);
    expect(rollingVolatility.values[0].volatility).toBeCloseTo(0.020817, 6);
    expect(rollingDrawdown.values).toHaveLength(3);
    expect(rollingDrawdown.values[1].maxDrawdown).toBeCloseTo(-0.04, 6);
  });

  it("calculates drawdown duration, Calmar ratio, and latest z-score", () => {
    const duration = calculateDrawdownDuration([100, 110, 105, 106, 104, 112], "levels");
    const calmar = calculateCalmarRatio([100, 115, 105, 121], "levels");
    const zScore = calculateZScore([10, 11, 12, 13, 20]);

    expect(duration.maxDuration).toBe(3);
    expect(duration.maxStartIndex).toBe(1);
    expect(duration.maxEndIndex).toBe(4);
    expect(calmar.cagr).toBeCloseTo(0.0656, 3);
    expect(calmar.maxDrawdown).toBeCloseTo(-0.087, 3);
    expect(calmar.calmarRatio).toBeGreaterThan(0.7);
    expect(zScore.zScore).toBeGreaterThan(1.6);
  });

  it("calculates CAGR from explicit level series", () => {
    const result = calculateCagr([100, 121], "levels");

    expect(result.cagr).toBeCloseTo(0.21, 6);
  });

  it("calculates historical VaR and expected shortfall from returns", () => {
    const series = [-0.08, -0.05, -0.02, 0.01, 0.02, 0.03];
    const varResult = calculateHistoricalVar({ series, confidenceLevel: 0.95 });
    const shortfall = calculateExpectedShortfall({ series, confidenceLevel: 0.95 });

    expect(varResult.valueAtRisk).toBeCloseTo(0.0725, 4);
    expect(shortfall.expectedShortfall).toBeCloseTo(0.08, 6);
  });

  it("calculates risk budget deviation from target risk budgets", () => {
    const result = calculateRiskBudgetDeviation({
      weights: [0.6, 0.4],
      covarianceMatrix: [
        [0.04, 0.006],
        [0.006, 0.0225],
      ],
      targetRiskBudgets: [0.5, 0.5],
    });

    expect(result.percentRiskContribution[0]).toBeCloseTo(0.758621, 6);
    expect(result.targetRiskBudgets).toEqual([0.5, 0.5]);
    expect(result.deviations[0]).toBeCloseTo(0.258621, 6);
    expect(result.maxAbsoluteDeviation).toBeCloseTo(0.258621, 6);
  });

  it("calculates a plain-vanilla Black-Scholes European option price", () => {
    const result = calculateBlackScholes({
      spot: 100,
      strike: 100,
      timeToExpiryYears: 1,
      riskFreeRate: 0.05,
      volatility: 0.2,
      optionType: "call",
    });

    expect(result.callPrice).toBeCloseTo(10.45, 2);
    expect(result.putPrice).toBeCloseTo(5.57, 2);
    expect(result.delta).toBeCloseTo(0.6368, 3);
    expect(result.gamma).toBeCloseTo(0.0188, 3);
    expect(result.vega).toBeCloseTo(0.3752, 3);
    expect(result.rho).toBeCloseTo(0.5323, 3);
  });

  it("calculates plain-vanilla bond duration and convexity", () => {
    const result = calculateBondDuration({
      couponRate: 0.04,
      yieldRate: 0.05,
      maturityYears: 10,
      paymentsPerYear: 2,
    });

    expect(result.price).toBeGreaterThan(90);
    expect(result.price).toBeLessThan(100);
    expect(result.modifiedDuration).toBeGreaterThan(7);
    expect(result.modifiedDuration).toBeLessThan(9);
    expect(result.convexity).toBeGreaterThan(70);
    expect(result.dv01).toBeCloseTo(0.07425, 4);
  });
});

describe("createQuantMathTool", () => {
  it("executes financial math actions through the tool wrapper", async () => {
    const tool = createQuantMathTool();
    const bondResult = await tool.execute("call-1", {
      action: "bond_duration",
      couponRate: 0.04,
      yieldRate: 0.05,
      maturityYears: 10,
      paymentsPerYear: 2,
    });
    const optionResult = await tool.execute("call-2", {
      action: "black_scholes",
      spot: 100,
      strike: 100,
      timeToExpiryYears: 1,
      riskFreeRate: 0.05,
      volatility: 0.2,
    });
    const regressionResult = await tool.execute("call-3", {
      action: "linear_regression",
      series: [0.03, 0.01, -0.02, 0.04, 0.02],
      benchmark: [0.02, 0.005, -0.015, 0.03, 0.01],
    });
    const riskContributionResult = await tool.execute("call-4", {
      action: "portfolio_risk_contribution",
      weights: [0.6, 0.4],
      covarianceMatrix: [
        [0.04, 0.006],
        [0.006, 0.0225],
      ],
    });
    const riskBudgetResult = await tool.execute("call-5", {
      action: "risk_budget_deviation",
      weights: [0.6, 0.4],
      targetRiskBudgets: [0.5, 0.5],
      covarianceMatrix: [
        [0.04, 0.006],
        [0.006, 0.0225],
      ],
    });

    expect(bondResult.details).toMatchObject({
      action: "bond_duration",
    });
    expect(optionResult.details).toMatchObject({
      action: "black_scholes",
      optionType: "call",
    });
    expect(regressionResult.details).toMatchObject({
      action: "linear_regression",
    });
    expect(riskContributionResult.details).toMatchObject({
      action: "portfolio_risk_contribution",
    });
    expect(riskBudgetResult.details).toMatchObject({
      action: "risk_budget_deviation",
    });
  });
});
