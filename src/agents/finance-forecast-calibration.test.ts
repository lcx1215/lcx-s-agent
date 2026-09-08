import { describe, expect, it } from "vitest";
import { calibrateFinanceForecasts } from "./finance-forecast-calibration.js";
const input = {
  forecasts: [
    {
      id: "up",
      field: "close",
      unit: "USD",
      source: "exchange",
      checkpointMonths: 3 as const,
      threshold: 100,
      probabilityAbove: 0.8,
    },
  ],
  checkpointMonths: 3,
  dueAt: "2026-06-01T00:00:00Z",
  frozenAt: "2026-03-01T00:00:00Z",
  observedAt: "2026-06-02T00:00:00Z",
  evidence: [
    {
      id: "e",
      field: "close",
      unit: "USD",
      source: "exchange",
      sourceTimestamp: "2026-06-01T00:00:00Z",
      value: 110,
    },
  ],
};
describe("forecast calibration", () => {
  it("computes a reproducible proper score from the frozen probability", () => {
    expect(calibrateFinanceForecasts(input)[0]).toMatchObject({
      status: "scored",
      outcome: 1,
      brierScore: expect.closeTo(0.04),
      baselineBrierScore: 0.25,
    });
  });
  it("does not score hindsight forecasts or interim observations", () => {
    expect(calibrateFinanceForecasts({ ...input, frozenAt: input.dueAt })[0].status).toBe(
      "unscored",
    );
    expect(calibrateFinanceForecasts({ ...input, observedAt: input.frozenAt })[0].status).toBe(
      "unscored",
    );
  });
  it("requires exactly the declared source, unit and checkpoint", () => {
    for (const change of [
      { source: "other" },
      { unit: "EUR" },
      { sourceTimestamp: input.observedAt },
    ]) {
      expect(
        calibrateFinanceForecasts({ ...input, evidence: [{ ...input.evidence[0], ...change }] })[0]
          .status,
      ).toBe("unscored");
    }
    expect(
      calibrateFinanceForecasts({ ...input, evidence: [...input.evidence, ...input.evidence] })[0]
        .status,
    ).toBe("unscored");
  });
});
