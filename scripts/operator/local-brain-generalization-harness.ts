#!/usr/bin/env node
// Runnable generalization harness for the local-brain router.
//
// Purpose: give you the ONE number the current fixed-213-bank eval cannot —
// held-out generalization. It emits an infinite, non-repeating training stream
// (so memorization is impossible) and a disjoint held-out set (feature
// combinations never seen in training) to quantify "did it learn the rule, or
// memorize the bank?".
//
// Usage:
//   node --import tsx scripts/operator/local-brain-generalization-harness.ts --emit-train 2000 > train.jsonl
//   node --import tsx scripts/operator/local-brain-generalization-harness.ts --emit-holdout 300 > holdout.jsonl
//   node --import tsx scripts/operator/local-brain-generalization-harness.ts --self-check
//
// Training-stream (MLX-LM dataset) modes emit {prompt, completion, meta} rows
// byte-compatible with datasets/thought-flow-v1/train.jsonl:
//   node --import tsx scripts/operator/local-brain-generalization-harness.ts --emit-train-dataset 20000 > gen-train.jsonl
//   node --import tsx scripts/operator/local-brain-generalization-harness.ts --emit-holdout-dataset 500 > gen-valid.jsonl
// Add --with-prerequisites to interleave each hard case's simpler prerequisite.
//
// Each --emit-*/target JSONL row is {id, userAsk, featureSignature, provenance,
// target:{requiredModules,...}}. The provenance is required by the neutral
// evaluator so a hand-written row cannot masquerade as a generated holdout.
// Feed userAsk to Qwen, parse its JSON plan, then score with scorePlan().

import {
  GENERALIZATION_CASE_SCHEMA_VERSION,
  GENERALIZATION_GENERATOR_ID,
  GENERALIZATION_GENERATOR_VERSION,
  generateCases,
  generateCasesWithPrerequisites,
  oraclePlan,
  scorePlan,
  toDatasetRow,
  type GeneralizationCaseProvenance,
  type GeneratedCase,
} from "./local-brain-generalization-generator.js";

type Options = {
  emitTrain?: number;
  emitHoldout?: number;
  emitTrainDataset?: number;
  emitHoldoutDataset?: number;
  selfCheck: boolean;
  seed: number;
  holdoutFraction: number;
  withPrerequisites: boolean;
};

function parseArgs(argv: string[]): Options {
  const options: Options = {
    selfCheck: false,
    seed: 1,
    holdoutFraction: 0.2,
    withPrerequisites: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--emit-train") {
      options.emitTrain = Number(argv[(i += 1)]);
    } else if (arg === "--emit-holdout") {
      options.emitHoldout = Number(argv[(i += 1)]);
    } else if (arg === "--emit-train-dataset") {
      options.emitTrainDataset = Number(argv[(i += 1)]);
    } else if (arg === "--emit-holdout-dataset") {
      options.emitHoldoutDataset = Number(argv[(i += 1)]);
    } else if (arg === "--with-prerequisites") {
      options.withPrerequisites = true;
    } else if (arg === "--self-check") {
      options.selfCheck = true;
    } else if (arg === "--seed") {
      options.seed = Number(argv[(i += 1)]);
    } else if (arg === "--holdout-fraction") {
      options.holdoutFraction = Number(argv[(i += 1)]);
    }
  }
  return options;
}

function emit(cases: GeneratedCase[], provenance: GeneralizationCaseProvenance): void {
  for (const c of cases) {
    process.stdout.write(
      `${JSON.stringify({
        id: c.id,
        userAsk: c.userAsk,
        featureSignature: c.featureSignature,
        provenance,
        target: {
          requiredModules: c.requiredModules,
          forbiddenModules: c.forbiddenModules,
          minModuleMatches: c.minModuleMatches,
          requiredMissingData: c.requiredMissingData,
          requiredRiskBoundaries: c.requiredRiskBoundaries,
        },
      })}\n`,
    );
  }
}

// Emit MLX-LM training rows. Each generated completion is validated against its
// own case with scorePlan() before it is written, so a self-inconsistent label
// can never leak into the training set (fail closed instead).
function emitDataset(cases: GeneratedCase[]): void {
  for (const c of cases) {
    const row = toDatasetRow(c);
    const plan = JSON.parse(row.completion) as Parameters<typeof scorePlan>[0];
    const verdict = scorePlan(plan, c);
    if (!verdict.ok) {
      throw new Error(
        `generated completion fails its own scorer for ${c.id}: ${verdict.reasons.join(";")}`,
      );
    }
    process.stdout.write(`${JSON.stringify(row)}\n`);
  }
}

// Self-check: prove the harness is internally sound before trusting its numbers.
// The oracle (rule-follower) must near-perfectly pass held-out; a lookup table
// trained on the train split must collapse on held-out. If these invariants
// ever break, the harness itself is miscalibrated.
function selfCheck(options: Options): number {
  const train = generateCases(800, {
    seed: options.seed,
    split: "train",
    holdoutFraction: options.holdoutFraction,
  });
  const holdout = generateCases(300, {
    seed: options.seed,
    split: "holdout",
    holdoutFraction: options.holdoutFraction,
  });

  const oracleHoldout =
    holdout.filter((c) => scorePlan(oraclePlan(c), c).ok).length / holdout.length;

  const table = new Map(train.map((c) => [c.userAsk, oraclePlan(c)]));
  const degenerate = {
    task_family: "unknown",
    primary_modules: [],
    supporting_modules: [],
    required_tools: [],
    missing_data: [],
    risk_boundaries: ["research_only"],
    next_step: "guess",
    rejected_context: ["old_external_conversation_history"],
  };
  const memHoldout =
    holdout.filter((c) => scorePlan(table.get(c.userAsk) ?? degenerate, c).ok).length /
    holdout.length;
  const memTrain =
    train.filter((c) => scorePlan(table.get(c.userAsk) ?? degenerate, c).ok).length / train.length;

  const trainSigs = new Set(train.map((c) => c.featureSignature));
  const leak = holdout.filter((c) => trainSigs.has(c.featureSignature)).length;

  process.stdout.write(
    [
      "local-brain generalization harness self-check",
      `  train cases:            ${train.length}`,
      `  holdout cases:          ${holdout.length}`,
      `  signature leak (0 ok):  ${leak}`,
      `  oracle pass @holdout:   ${(oracleHoldout * 100).toFixed(1)}%  (rule generalizes)`,
      `  memorizer pass @train:  ${(memTrain * 100).toFixed(1)}%  (fits training)`,
      `  memorizer pass @holdout:${(memHoldout * 100).toFixed(1)}%  (memorization does NOT transfer)`,
      "",
      "Interpretation: a model whose holdout score tracks the oracle learned the",
      "rule; a model whose holdout score tracks the memorizer just fit the bank.",
    ].join("\n"),
  );
  process.stdout.write("\n");

  const sound = oracleHoldout > 0.98 && memHoldout < 0.25 && leak === 0;
  return sound ? 0 : 1;
}

function main(): number {
  const options = parseArgs(process.argv.slice(2));
  if (options.emitTrain) {
    emit(
      generateCases(options.emitTrain, {
        seed: options.seed,
        split: "train",
        holdoutFraction: options.holdoutFraction,
      }),
      {
        schemaVersion: GENERALIZATION_CASE_SCHEMA_VERSION,
        generator: GENERALIZATION_GENERATOR_ID,
        generatorVersion: GENERALIZATION_GENERATOR_VERSION,
        split: "train",
        seed: options.seed,
        holdoutFraction: options.holdoutFraction,
      },
    );
    return 0;
  }
  if (options.emitHoldout) {
    emit(
      generateCases(options.emitHoldout, {
        seed: options.seed,
        split: "holdout",
        holdoutFraction: options.holdoutFraction,
      }),
      {
        schemaVersion: GENERALIZATION_CASE_SCHEMA_VERSION,
        generator: GENERALIZATION_GENERATOR_ID,
        generatorVersion: GENERALIZATION_GENERATOR_VERSION,
        split: "holdout",
        seed: options.seed,
        holdoutFraction: options.holdoutFraction,
      },
    );
    return 0;
  }
  // With --with-prerequisites, each hard case is followed by its simpler
  // prerequisite so the training/eval set can prove both pass.
  const gen = options.withPrerequisites ? generateCasesWithPrerequisites : generateCases;
  if (options.emitTrainDataset) {
    emitDataset(
      gen(options.emitTrainDataset, {
        seed: options.seed,
        split: "train",
        holdoutFraction: options.holdoutFraction,
      }),
    );
    return 0;
  }
  if (options.emitHoldoutDataset) {
    emitDataset(
      gen(options.emitHoldoutDataset, {
        seed: options.seed,
        split: "holdout",
        holdoutFraction: options.holdoutFraction,
      }),
    );
    return 0;
  }
  return selfCheck(options);
}

process.exitCode = main();
