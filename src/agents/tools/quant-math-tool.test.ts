import { describe, expect, it } from "vitest";
import {
  calculateBeta,
  calculateBondDuration,
  calculateCorrelation,
  calculateMaxDrawdown,
  calculateSharpe,
  calculateSortino,
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

  it("calculates max drawdown from returns and levels", () => {
    const fromReturns = calculateMaxDrawdown([0.1, -0.2, 0.05, -0.1]);
    const fromLevels = calculateMaxDrawdown([100, 110, 88, 92, 83], "levels");

    expect(fromReturns.maxDrawdown).toBeCloseTo(-0.244, 2);
    expect(fromLevels.maxDrawdown).toBeCloseTo(-0.245, 2);
  });

  it("calculates plain-vanilla bond duration", () => {
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
  });
});

describe("createQuantMathTool", () => {
  it("executes bond_duration through the tool wrapper", async () => {
    const tool = createQuantMathTool();
    const result = await tool.execute("call-1", {
      action: "bond_duration",
      couponRate: 0.04,
      yieldRate: 0.05,
      maturityYears: 10,
      paymentsPerYear: 2,
    });

    expect(result.details).toMatchObject({
      action: "bond_duration",
    });
  });
});
