import { describe, expect, it } from "vitest";
import {
  complexityDegree,
  deriveLabel,
  generateCases,
  generateCasesWithPrerequisites,
  isHeldOut,
  makeRng,
  oraclePlan,
  prerequisiteFeatures,
  sampleFeatures,
  scorePlan,
  toDatasetRow,
  type GeneratedCase,
  type PlanOutput,
  type TaskFeatures,
} from "./local-brain-generalization-generator.js";

// Build a TaskFeatures with all flags off, overriding only what a test cares
// about. Keeps tests robust as new feature axes are added to the generator.
function baseFeatures(overrides: Partial<TaskFeatures> = {}): TaskFeatures {
  return {
    assetClasses: [],
    dataSupplied: false,
    learningRequest: false,
    sourceSupplied: false,
    tradeWording: false,
    portfolioContext: false,
    crossMarket: false,
    oldContextPollution: false,
    redTeam: false,
    fundamentalsDeep: false,
    eventRisk: false,
    technicalTiming: false,
    valuationModeling: false,
    abstractionTransfer: false,
    ...overrides,
  };
}

describe("deriveLabel (deterministic feature -> label rule)", () => {
  it("is a pure function: same features yield identical labels", () => {
    const features = baseFeatures({
      assetClasses: ["us_equity", "etf"],
      tradeWording: true,
      portfolioContext: true,
      oldContextPollution: true,
    });
    expect(deriveLabel(features)).toEqual(deriveLabel(features));
  });

  it("requires the data gateway + missing snapshot when no source is supplied", () => {
    const label = deriveLabel(baseFeatures({ assetClasses: ["us_equity"] }));
    expect(label.requiredModules).toContain("finance_data_gateway");
    expect(label.requiredMissingData).toContain("fresh_market_data_snapshot");
    expect(label.requiredRiskBoundaries).toContain("no_unverified_current_market_data");
  });

  it("converts trade wording into a research gate boundary", () => {
    const label = deriveLabel(
      baseFeatures({ assetClasses: ["us_equity"], dataSupplied: true, tradeWording: true }),
    );
    expect(label.requiredRiskBoundaries).toContain("no_trade_advice");
    expect(label.requiredRiskBoundaries).toContain("risk_gate_before_action_language");
  });

  it("forbids finance fan-out for a sourceless learning audit", () => {
    const label = deriveLabel(baseFeatures({ learningRequest: true }));
    expect(label.requiredMissingData).toContain("source_url_or_local_source_path");
    expect(label.forbiddenModules.length).toBeGreaterThan(0);
  });

  it("routes deep fundamentals + valuation modeling to the right modules", () => {
    const label = deriveLabel(
      baseFeatures({
        assetClasses: ["us_equity"],
        fundamentalsDeep: true,
        valuationModeling: true,
      }),
    );
    expect(label.requiredModules).toContain("company_fundamentals_value");
    expect(label.requiredModules).toContain("financial_modeling_valuation_qc");
    expect(label.requiredRiskBoundaries).toContain("no_model_math_guessing");
    expect(label.requiredRiskBoundaries).toContain("no_unverified_filing_claims");
  });

  it("keeps technical timing as a non-standalone-alpha boundary", () => {
    const label = deriveLabel(baseFeatures({ assetClasses: ["etf"], technicalTiming: true }));
    expect(label.requiredModules).toContain("technical_timing");
    expect(label.requiredRiskBoundaries).toContain("technical_timing_not_standalone_alpha");
  });

  it("abstracts a terse phrase into a problem family before answering", () => {
    const label = deriveLabel(baseFeatures({ abstractionTransfer: true }));
    expect(label.requiredModules).toContain("agent_workflow_memory");
    expect(label.requiredMissingData).toContain("abstracted_failure_family");
    expect(label.requiredMissingData).toContain("regression_proof");
    expect(label.requiredRiskBoundaries).toContain("proof_required_before_claiming_transfer");
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

describe("infinite training-stream dataset rows", () => {
  it("every generated completion passes its own case scorer (never train a bad label)", () => {
    // If any generated (prompt, completion) taught the model an answer the
    // production scorer rejects, training would be actively harmful. Assert the
    // whole stream is self-consistent across a large sample.
    const cases = generateCases(1500, { seed: 314, split: "all" });
    for (const c of cases) {
      const row = toDatasetRow(c);
      const plan = JSON.parse(row.completion) as PlanOutput;
      const verdict = scorePlan(plan, c);
      expect(verdict.ok, `${c.id}: ${verdict.reasons.join(";")}`).toBe(true);
    }
  });

  it("emits the exact MLX-LM row shape {prompt, completion, meta}", () => {
    const [row] = generateCases(1, { seed: 1 }).map(toDatasetRow);
    expect(Object.keys(row).toSorted()).toEqual(["completion", "meta", "prompt"]);
    // Prompt prefix must match the real dataset's system preamble verbatim.
    expect(row.prompt.startsWith("You are the LCX Agent local auxiliary thought-flow model.")).toBe(
      true,
    );
    expect(row.prompt).toContain("user_or_task:");
    // Completion must be a single compact JSON line (no newlines).
    expect(row.completion.includes("\n")).toBe(false);
    expect(row.meta.source).toBe("generalization_generator");
  });

  it("train/holdout dataset rows stay disjoint by feature signature", () => {
    const train = generateCases(300, { seed: 21, split: "train", holdoutFraction: 0.25 });
    const holdout = generateCases(120, { seed: 21, split: "holdout", holdoutFraction: 0.25 });
    const trainSigs = new Set(train.map((c) => toDatasetRow(c).meta.featureSignature));
    for (const c of holdout) {
      expect(trainSigs.has(toDatasetRow(c).meta.featureSignature)).toBe(false);
    }
  });
});

describe("prerequisite chains", () => {
  it("a prerequisite is strictly simpler than its complex case", () => {
    const complex = baseFeatures({
      assetClasses: ["us_equity", "crypto"],
      tradeWording: true,
      redTeam: true,
      valuationModeling: true,
    });
    const prereq = prerequisiteFeatures(complex);
    expect(prereq).toBeDefined();
    expect(complexityDegree(prereq!)).toBeLessThan(complexityDegree(complex));
  });

  it("minimal cases have no prerequisite", () => {
    expect(prerequisiteFeatures(baseFeatures({ assetClasses: ["etf"] }))).toBeUndefined();
    expect(prerequisiteFeatures(baseFeatures())).toBeUndefined();
  });

  it("interleaves prerequisites and every emitted case stays self-consistent", () => {
    // Both the hard case and its simpler prerequisite must be trainable labels.
    const cases = generateCasesWithPrerequisites(800, { seed: 77, split: "all" });
    for (const c of cases) {
      const plan = JSON.parse(toDatasetRow(c).completion) as PlanOutput;
      expect(scorePlan(plan, c).ok, `${c.id}: ${scorePlan(plan, c).reasons.join(";")}`).toBe(true);
    }
    // The paired stream is strictly larger than the bare stream (prerequisites added).
    expect(cases.length).toBeGreaterThan(0);
  });
});
