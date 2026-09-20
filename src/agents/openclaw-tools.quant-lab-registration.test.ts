import "./test-helpers/fast-core-tools.js";
import { describe, expect, it } from "vitest";
import {
  createCalculationLedger,
  getSharedCalculationLedger,
} from "./finance-calculation-ledger.js";
import { createOpenClawTools } from "./openclaw-tools.js";
import { createQuantLabTool } from "./tools/quant-lab-tool.js";

describe("createOpenClawTools quant_lab registration", () => {
  it("exposes the quant_lab tool so the model can reach the full toolkit", () => {
    const tools = createOpenClawTools();
    const tool = tools.find((candidate) => candidate.name === "quant_lab");
    expect(tool).toBeTruthy();
    expect(tool?.description).toContain("risk parity");
    expect(tool?.description).toContain("significance");
  });
});

describe("quant_lab dispatch", () => {
  const cov = [
    [0.04, 0.012],
    [0.012, 0.09],
  ];

  it("solves a risk-parity portfolio through the tool surface", async () => {
    const tool = createQuantLabTool();
    const result = (await tool.execute?.("call-1", {
      action: "risk_parity",
      cov,
    } as never)) as { details?: unknown };
    const payload = (result.details ?? result) as {
      weights: number[];
      riskContributions: number[];
    };
    expect(payload.weights).toHaveLength(2);
    expect(payload.riskContributions).toHaveLength(2);
  });

  it("rejects an unknown action instead of guessing one", async () => {
    const tool = createQuantLabTool();
    await expect(
      tool.execute?.("call-2", { action: "not_a_real_action" } as never),
    ).rejects.toThrow(/action must be one of/);
  });

  it("reports a correlation with its significance, not just a coefficient", async () => {
    const tool = createQuantLabTool();
    const result = (await tool.execute?.("call-3", {
      action: "correlation_test",
      series: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      benchmark: [2, 4, 6, 8, 10, 12, 14, 16, 18, 20],
    } as never)) as { details: { pearson: number; pValue: number } };
    expect(result.details.pearson).toBeCloseTo(1, 10);
    expect(result.details.pValue).toBeLessThan(0.001);
  });
});

describe("calculation ledger", () => {
  const cov = [
    [0.04, 0.012],
    [0.012, 0.09],
  ];

  it("records every call so a derived figure can be traced later", async () => {
    const ledger = createCalculationLedger();
    const tool = createQuantLabTool({ ledger });
    const result = (await tool.execute?.("call-1", {
      action: "min_variance",
      cov,
    } as never)) as { details: { calculationId?: string; ledgerSize?: number } };

    expect(result.details.calculationId).toMatch(/^calc-/);
    expect(ledger.list()).toHaveLength(1);
    expect(ledger.list()[0].action).toBe("min_variance");
    // The recorded inputs are what make the output reproducible.
    expect(ledger.list()[0].inputs).toMatchObject({ cov });
  });

  it("accumulates records across calls within one unit of work", async () => {
    const ledger = createCalculationLedger();
    const tool = createQuantLabTool({ ledger });
    await tool.execute?.("a", { action: "min_variance", cov } as never);
    await tool.execute?.("b", { action: "risk_parity", cov } as never);
    expect(ledger.list()).toHaveLength(2);
    expect(ledger.numericOutputs().length).toBeGreaterThan(0);
  });

  it("keeps an injected ledger separate from the shared one, so a scoped run does not pollute the process ledger", async () => {
    const sharedBefore = getSharedCalculationLedger().list().length;
    const scoped = createCalculationLedger();
    const tool = createQuantLabTool({ ledger: scoped });
    await tool.execute?.("call-1", {
      action: "min_variance",
      cov,
    } as never);
    expect(scoped.list()).toHaveLength(1);
    expect(getSharedCalculationLedger().list().length).toBe(sharedBefore);
  });
});

describe("quant_lab default wiring", () => {
  it("records to the shared ledger when no ledger is injected, so a default-assembled tool still leaves a trace", async () => {
    const tool = createOpenClawTools({}).find((entry) => entry.name === "quant_lab");
    expect(tool).toBeDefined();
    const before = getSharedCalculationLedger().list().length;
    const result = (await tool!.execute?.("call-default", {
      action: "correlation_test",
      series: [1, 2, 3, 4, 5, 6],
      benchmark: [2, 4.1, 5.9, 8.2, 9.8, 12.1],
    } as never)) as { details?: { calculationId?: string } };
    const details = (result.details ?? result) as { calculationId?: string };
    expect(details.calculationId).toMatch(/^calc-\d+$/u);
    expect(getSharedCalculationLedger().list().length).toBe(before + 1);
  });

  it("returns the same ledger instance across reads, so a pipeline can see what the tool recorded", () => {
    expect(getSharedCalculationLedger()).toBe(getSharedCalculationLedger());
  });
});

describe("quant_lab foundational actions", () => {
  const tool = () =>
    createOpenClawTools({}).find((entry) => entry.name === "quant_lab") as {
      execute?: (id: string, params: unknown) => Promise<unknown>;
    };

  async function call(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result = (await tool().execute?.("call-foundations", params as never)) as {
      details?: Record<string, unknown>;
    };
    return (result.details ?? result) as Record<string, unknown>;
  }

  it("computes a covariance matrix through the tool surface", async () => {
    const details = await call({
      action: "covariance_matrix",
      returnsMatrix: [
        [1, 2],
        [2, 4],
        [3, 7],
        [4, 9],
      ],
    });
    const covariance = details.covariance as number[][];
    expect(covariance).toHaveLength(2);
    expect(covariance[0][0]).toBeCloseTo(5 / 3, 10);
    expect(details.calculationId).toMatch(/^calc-\d+$/u);
  });

  it("runs an ADF test and does not call a random walk stationary", async () => {
    const walk: number[] = [];
    let level = 100;
    let state = 7;
    for (let i = 0; i < 260; i += 1) {
      state = (state * 1103515245 + 12345) % 2147483648;
      level += state / 2147483648 - 0.5;
      walk.push(level);
    }
    const details = await call({ action: "adf_test", series: walk });
    expect(details.verdict).toBe("unit_root");
  });

  it("removes a p-value that only looked significant because many were tested", async () => {
    const details = await call({
      action: "adjust_p_values",
      pValues: [0.03, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6],
    });
    expect(details.rawSignificant).toBe(1);
    expect(details.adjustedSignificant).toBe(0);
    expect((details.rejected as boolean[])[0]).toBe(false);
  });

  it("reports a rolling correlation with its stability, not just one number", async () => {
    const length = 40;
    const a = Array.from({ length }, (_unused, index) => index);
    const b = a.map((value, index) => (index < length / 2 ? value : -value));
    const details = await call({
      action: "rolling_correlation",
      series: a,
      benchmark: b,
      window: 10,
    });
    expect(details.min as number).toBeLessThan(-0.9);
    expect(details.max as number).toBeGreaterThan(0.9);
    expect(details.signFlips as number).toBeGreaterThan(0);
    expect(details.unstable).toBeNull();
  });

  it("rejects an unknown regression type instead of defaulting to one", async () => {
    await expect(
      call({ action: "adf_test", series: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], regression: "cubic" }),
    ).rejects.toThrow(/regression must be one of/u);
  });
});
