import { describe, expect, it } from "vitest";
import {
  brierScore,
  calibrationAdjustedFloor,
  overconfidenceGap,
  parseResearchConclusion,
} from "./finance-conclusion-intake.js";

const valid = {
  conclusionId: "c1",
  instrument: "aapl",
  direction: "buy",
  conviction: 0.8,
  thesis: "earnings revisions are turning",
  assetClass: "us_equity",
  evidence: [{ sourceId: "sec-10q" }, { sourceId: "fmp-estimates" }],
};

describe("parseResearchConclusion", () => {
  it("accepts a complete conclusion and normalises the instrument", () => {
    const result = parseResearchConclusion(valid);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.conclusion.instrument).toBe("AAPL");
    }
  });

  it("refuses a single source, because one document must not decide a trade", () => {
    const result = parseResearchConclusion({
      ...valid,
      evidence: [{ sourceId: "sec-10q" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusals.join()).toMatch(/single source|1 distinct/);
    }
  });

  it("counts distinct sources, so repeating one does not buy a pass", () => {
    const result = parseResearchConclusion({
      ...valid,
      evidence: [{ sourceId: "sec-10q" }, { sourceId: "sec-10q" }, { sourceId: "sec-10q" }],
    });
    expect(result.ok).toBe(false);
  });

  it("refuses a hold or avoid, which are not orders", () => {
    for (const direction of ["hold", "avoid"] as const) {
      const result = parseResearchConclusion({ ...valid, direction });
      expect(result.ok).toBe(false);
    }
  });

  it("refuses a conviction outside 0..1 rather than clamping it", () => {
    for (const conviction of [1.5, -0.2]) {
      const result = parseResearchConclusion({ ...valid, conviction });
      expect(result.ok).toBe(false);
    }
  });

  it("refuses a missing thesis", () => {
    const result = parseResearchConclusion({ ...valid, thesis: "   " });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusals.join()).toMatch(/thesis/);
    }
  });

  it("refuses a non-object rather than throwing", () => {
    expect(parseResearchConclusion("not json").ok).toBe(false);
    expect(parseResearchConclusion(null).ok).toBe(false);
  });
});

describe("calibration", () => {
  it("scores a perfect forecaster at zero", () => {
    expect(brierScore([{ claimedProbability: 1, outcome: 1 }])).toBe(0);
  });

  it("scores always-wrong at one", () => {
    expect(brierScore([{ claimedProbability: 1, outcome: 0 }])).toBe(1);
  });

  it("reports null instead of a perfect score when there is no history", () => {
    // Claiming 0 with no records would say "perfectly calibrated", which is a
    // lie that would let an unproven model trade at full size.
    expect(brierScore([])).toBeNull();
  });

  it("measures overconfidence as claimed minus realized", () => {
    const records = [
      { claimedProbability: 0.8, outcome: 0 },
      { claimedProbability: 0.8, outcome: 1 },
    ] as const;
    // Claims 0.8, delivers 0.5.
    expect(overconfidenceGap(records)).toBeCloseTo(0.3, 10);
  });

  it("raises the floor for an overconfident model", () => {
    const records = [
      { claimedProbability: 0.9, outcome: 0 },
      { claimedProbability: 0.9, outcome: 0 },
    ] as const;
    const adjusted = calibrationAdjustedFloor(0.6, records);
    expect(adjusted).toBeGreaterThan(0.6);
    expect(adjusted).toBeLessThanOrEqual(0.95);
  });

  it("leaves the floor alone for a calibrated or humble model", () => {
    const calibrated = [
      { claimedProbability: 0.5, outcome: 1 },
      { claimedProbability: 0.5, outcome: 0 },
    ] as const;
    expect(calibrationAdjustedFloor(0.6, calibrated)).toBe(0.6);
    expect(calibrationAdjustedFloor(0.6, [])).toBe(0.6);
  });
});
