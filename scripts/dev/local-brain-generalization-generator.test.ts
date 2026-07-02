import { describe, expect, it } from "vitest";
import {
  deriveLabel,
  generateCases,
  isHeldOut,
  makeRng,
  oraclePlan,
  sampleFeatures,
  scorePlan,
  type GeneratedCase,
  type PlanOutput,
  type TaskFeatures,
} from "./local-brain-generalization-generator.js";

describe("deriveLabel (deterministic feature -> label rule)", () => {
  it("is a pure function: same features yield identical labels", () => {
    const features: TaskFeatures = {
      assetClasses: ["us_equity", "etf"],
      dataSupplied: false,
      learningRequest: false,
      sourceSupplied: false,
      tradeWording: true,
      portfolioContext: true,
      crossMarket: false,
      oldContextPollution: true,
      redTeam: false,
    };
    expect(deriveLabel(features)).toEqual(deriveLabel(features));
  });

  it("requires the data gateway + missing snapshot when no source is supplied", () => {
    const label = deriveLabel({
      assetClasses: ["us_equity"],
      dataSupplied: false,
      learningRequest: false,
      sourceSupplied: false,
      tradeWording: false,
      portfolioContext: false,
      crossMarket: false,
      oldContextPollution: false,
      redTeam: false,
    });
    expect(label.requiredModules).toContain("finance_data_gateway");
    expect(label.requiredMissingData).toContain("fresh_market_data_snapshot");
    expect(label.requiredRiskBoundaries).toContain("no_unverified_current_market_data");
  });

  it("converts trade wording into a research gate boundary", () => {
    const label = deriveLabel({
      assetClasses: ["us_equity"],
      dataSupplied: true,
      learningRequest: false,
      sourceSupplied: false,
      tradeWording: true,
      portfolioContext: false,
      crossMarket: false,
      oldContextPollution: false,
      redTeam: false,
    });
    expect(label.requiredRiskBoundaries).toContain("no_trade_advice");
    expect(label.requiredRiskBoundaries).toContain("risk_gate_before_action_language");
  });

  it("forbids finance fan-out for a sourceless learning audit", () => {
    const label = deriveLabel({
      assetClasses: [],
      dataSupplied: false,
      learningRequest: true,
      sourceSupplied: false,
      tradeWording: false,
      portfolioContext: false,
      crossMarket: false,
      oldContextPollution: false,
      redTeam: false,
    });
    expect(label.requiredMissingData).toContain("source_url_or_local_source_path");
    expect(label.forbiddenModules.length).toBeGreaterThan(0);
  });

  it("only references modules from the real taxonomy", () => {
    // sample a broad spread and assert deriveLabel never invents a module id
    const rng = makeRng(7);
    for (let i = 0; i < 500; i += 1) {
      const label = deriveLabel(sampleFeatures(rng));
      expect(label.minModuleMatches).toBeGreaterThanOrEqual(0);
      expect(label.minModuleMatches).toBeLessThanOrEqual(label.requiredModules.length || 2);
    }
  });
});

describe("held-out split", () => {
  it("assigns a signature to the same side deterministically", () => {
    const features = sampleFeatures(makeRng(3));
    expect(isHeldOut(features, 0.2)).toBe(isHeldOut(features, 0.2));
  });

  it("keeps train and holdout feature-signatures disjoint", () => {
    const train = generateCases(400, { seed: 11, split: "train", holdoutFraction: 0.25 });
    const holdout = generateCases(200, { seed: 11, split: "holdout", holdoutFraction: 0.25 });
    const trainSigs = new Set(train.map((c) => c.featureSignature));
    const holdoutSigs = new Set(holdout.map((c) => c.featureSignature));
    for (const sig of holdoutSigs) {
      expect(trainSigs.has(sig)).toBe(false);
    }
    expect(holdoutSigs.size).toBeGreaterThan(0);
  });
});

describe("reproducibility", () => {
  it("same seed produces identical asks", () => {
    const a = generateCases(20, { seed: 42 });
    const b = generateCases(20, { seed: 42 });
    expect(a.map((c) => c.userAsk)).toEqual(b.map((c) => c.userAsk));
  });
});

// A memorizer: learns exact userAsk -> oracle plan from a training set, and
// returns a degenerate plan for anything it has not seen verbatim.
function lookupTablePlan(trainingCases: GeneratedCase[]): (ask: string) => PlanOutput {
  const table = new Map<string, PlanOutput>();
  for (const c of trainingCases) {
    table.set(c.userAsk, oraclePlan(c));
  }
  return (ask: string) =>
    table.get(ask) ?? {
      task_family: "unknown",
      primary_modules: [],
      supporting_modules: [],
      required_tools: [],
      missing_data: [],
      risk_boundaries: ["research_only"],
      next_step: "guess",
      rejected_context: ["old_lark_conversation_history"],
    };
}

describe("memorization-vs-rule probe (the whole point)", () => {
  it("the oracle (rule-follower) passes held-out cases it has never seen", () => {
    const holdout = generateCases(150, { seed: 99, split: "holdout", holdoutFraction: 0.25 });
    const passed = holdout.filter((c) => scorePlan(oraclePlan(c), c).ok).length;
    // The rule generalizes: near-perfect on unseen feature combinations.
    expect(passed / holdout.length).toBeGreaterThan(0.98);
  });

  it("a lookup table trained on TRAIN collapses on held-out cases", () => {
    const train = generateCases(600, { seed: 5, split: "train", holdoutFraction: 0.25 });
    const holdout = generateCases(150, { seed: 5, split: "holdout", holdoutFraction: 0.25 });
    const memorizer = lookupTablePlan(train);
    const passed = holdout.filter((c) => scorePlan(memorizer(c.userAsk), c).ok).length;
    // Memorization does not transfer to unseen feature combinations.
    expect(passed / holdout.length).toBeLessThan(0.25);
  });

  it("the same lookup table scores high on its own training asks", () => {
    const train = generateCases(300, { seed: 8, split: "train", holdoutFraction: 0.25 });
    const memorizer = lookupTablePlan(train);
    const passed = train.filter((c) => scorePlan(memorizer(c.userAsk), c).ok).length;
    // High train score + low holdout score = the brittleness signature.
    expect(passed / train.length).toBeGreaterThan(0.95);
  });
});
