/**
 * White-box tests for the pipeline's figure-grounding step.
 *
 * The suite next door drives the script as a subprocess; these tests call `buildPipelineResult`
 * directly so the `derived` path can be exercised with a known set of calculations. The point is
 * not that a good answer passes, it is that a number the model claims it computed is checked
 * against calculations that actually ran — and that "no ledger" is reported, not passed silently.
 */

import { describe, expect, it } from "vitest";
import { buildPipelineResult } from "../scripts/operator/lcx-commercial-answer-pipeline.js";
import {
  getSharedCalculationLedger,
  type CalculationRecord,
} from "../src/agents/finance-calculation-ledger.js";

function answerWithFigures(figures: unknown): string {
  return `The portfolio volatility is materially lower.\n\n\`\`\`figures\n${JSON.stringify(figures)}\n\`\`\`\n`;
}

function calculation(output: Record<string, unknown>): CalculationRecord {
  return {
    id: "calc-test",
    action: "portfolio_vol",
    inputs: { weights: [0.5, 0.5] },
    output,
    at: "2026-09-20T00:00:00.000Z",
  };
}

describe("pipeline derived-figure grounding", () => {
  it("rejects a derived figure that no supplied calculation produced", () => {
    const result = buildPipelineResult(
      "what is portfolio vol?",
      answerWithFigures([{ kind: "derived", name: "portfolio_vol", value: 0.9999 }]),
      { calculations: [calculation({ portfolioVol: 0.1855 })] },
    );
    expect(result.answerGrounding.ungroundedFigures).toBe(1);
    expect(result.answerGrounding.reasons.join(" ")).toMatch(
      /does not match any recorded calculation/u,
    );
  });

  it("accepts a derived figure a supplied calculation did produce", () => {
    const result = buildPipelineResult(
      "what is portfolio vol?",
      answerWithFigures([{ kind: "derived", name: "portfolio_vol", value: 0.1855 }]),
      { calculations: [calculation({ portfolioVol: 0.1855 })] },
    );
    expect(result.answerGrounding.ungroundedFigures).toBe(0);
  });

  it("falls back to the process-wide ledger when the caller supplies none", () => {
    // Without this fallback the check is dead in the real run: the operator script never had a
    // ledger to pass, so a figure computed earlier in the same process would go unchecked.
    // Asserted on a figure the ledger does NOT contain, on purpose: a matching figure would also
    // pass when the check never runs, so it could not tell a working fallback from no fallback.
    getSharedCalculationLedger().record({
      action: "portfolio_vol",
      inputs: { weights: [0.5, 0.5] },
      output: { portfolioVol: 0.2718 },
    });
    const result = buildPipelineResult(
      "what is portfolio vol?",
      answerWithFigures([{ kind: "derived", name: "portfolio_vol", value: 0.9999 }]),
    );
    expect(result.answerGrounding.ungroundedFigures).toBe(1);
    expect(result.answerGrounding.reasons.join(" ")).toMatch(
      /does not match any recorded calculation/u,
    );
  });

  it("reports a derived figure as unverified rather than failing it when nothing was computed", () => {
    const result = buildPipelineResult(
      "what is portfolio vol?",
      answerWithFigures([{ kind: "derived", name: "portfolio_vol", value: 0.9999 }]),
      { calculations: [] },
    );
    expect(result.answerGrounding.ungroundedFigures).toBe(0);
    expect(result.answerGrounding.reasons.join(" ")).toMatch(/recorded, not verified/u);
  });
});
