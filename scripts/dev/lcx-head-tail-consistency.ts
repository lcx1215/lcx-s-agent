import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MODULE_LEARNING_TARGETS } from "../../src/agents/tools/module-learning-pipeline-plan-tool.ts";
import { LOCAL_BRAIN_MODULE_TAXONOMY } from "./local-brain-taxonomy.ts";

type HeadTailCheck = {
  id: string;
  ok: boolean;
  summary: string;
  evidence?: string[];
};

type Surface = {
  label: string;
  text: string | null;
};

type CriticalModuleContract = {
  id: string;
  headTerms: string[];
  tailTerms: string[];
};

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(SCRIPT_DIR, "..", "..");

const HEAD_SURFACE_FILES = [
  "AGENTS.md",
  "README.md",
  "ops/local-brain/README.md",
  "src/agents/system-prompt.ts",
] as const;

const TAIL_SURFACE_FILES = [
  "scripts/dev/lcx-change-impact-plan.ts",
  "scripts/dev/local-brain-taxonomy.ts",
  "scripts/dev/local-brain-contracts.ts",
  "scripts/dev/local-brain-distill-eval.ts",
  "scripts/dev/minimax-brain-teacher-batch.ts",
  "scripts/dev/minimax-quota-brain-saturator.ts",
  "scripts/dev/local-brain-training-plan.ts",
  "scripts/dev/lcx-system-doctor.ts",
  "scripts/dev/lcx-agent-exam.ts",
  "scripts/dev/lcx-mind-model.ts",
  "scripts/dev/lcx-context-recovery-exam.ts",
  "src/agents/tools/module-learning-pipeline-plan-tool.ts",
  "src/agents/tools/module-learning-pipeline-review-tool.ts",
  "src/commands/capabilities/lark-loop-diagnose.ts",
] as const;

const MODULE_LEARNING_TARGET_EXEMPTIONS: Record<string, string> = {
  credit_liquidity:
    "macro/rates/credit liquidity is currently enforced through eval and teacher curricula before it becomes a standalone module-learning target",
  cross_asset_liquidity:
    "cross-asset liquidity is currently enforced through broad finance eval and teacher curricula",
  etf_regime: "ETF regime is currently enforced through eval and teacher curricula",
  us_equity_market_structure:
    "US equity market structure is currently enforced through broad finance eval and teacher curricula",
  china_a_share_policy_flow:
    "A-share policy flow is currently enforced through broad finance eval and teacher curricula",
  crypto_market_structure:
    "crypto market structure is currently enforced through broad finance eval and no-high-leverage boundaries",
  fx_dollar: "fx_dollar is normalized with fx_currency_liquidity in the planning contract",
  quant_math: "factor_research is the current module-learning target for quant/factor math intake",
  causal_map:
    "causal_map is an orchestration primitive checked through eval and review-panel contracts",
  finance_learning_memory:
    "finance_learning_memory is the retrieval/apply substrate checked through finance-learning receipts",
  source_registry:
    "source_registry is the source-intake substrate required by every module-learning target",
  eval_harness_design:
    "eval_harness_design is the regression substrate and is checked through eval/test surfaces",
  review_panel:
    "review_panel is the arbitration substrate checked through eval and doctor surfaces",
  control_room_summary:
    "control_room_summary is the visible-output substrate checked through prompt/eval surfaces",
} as const;

const MODULE_LEARNING_TARGETS_WITHOUT_TAXONOMY = new Set([
  "factor_research",
  "lark_feishu_workflow",
]);

const CRITICAL_MODULE_CONTRACTS: CriticalModuleContract[] = [
  {
    id: "financial_modeling_valuation_qc",
    headTerms: ["financial_modeling_valuation_qc", "valuation/modeling QC"],
    tailTerms: ["financial_modeling_valuation_qc", "financial_modeling_valuation_qc_chain"],
  },
  {
    id: "thesis_catalyst_lifecycle",
    headTerms: ["thesis_catalyst_lifecycle", "thesis/catalyst lifecycle"],
    tailTerms: ["thesis_catalyst_lifecycle", "thesis_catalyst_lifecycle_review"],
  },
  {
    id: "data_provenance_quality",
    headTerms: ["data_provenance_quality", "data provenance"],
    tailTerms: ["data_provenance_quality", "data_provenance_quality_gate"],
  },
  {
    id: "research_artifact_qc",
    headTerms: ["research_artifact_qc", "research artifact QC"],
    tailTerms: ["research_artifact_qc", "research_artifact_qc_gate"],
  },
  {
    id: "module_learning_pipeline",
    headTerms: ["module_learning_pipeline_plan", "module_learning_pipeline_review"],
    tailTerms: ["module_learning_pipeline_plan", "module_learning_pipeline_review_status"],
  },
  {
    id: "source_registry",
    headTerms: ["source registry", "source_registry"],
    tailTerms: ["source_registry", "sourceRegistryRecordPath"],
  },
  {
    id: "finance_learning_memory",
    headTerms: ["finance_learning_memory", "learned rules"],
    tailTerms: ["finance_learning_memory", "finance_learning_capability_apply"],
  },
  {
    id: "eval_review_output_tail",
    headTerms: ["eval", "review", "summary"],
    tailTerms: ["eval_harness_design", "review_panel", "control_room_summary"],
  },
];

const ENGINEERING_MICRO_CONTRACTS: CriticalModuleContract[] = [
  {
    id: "change_impact_planning",
    headTerms: ["lcx-change-impact-plan", "small repairs", "master lane"],
    tailTerms: ["PATH_RULES", "recommendedFastCommands"],
  },
  {
    id: "dev_live_boundary",
    headTerms: ["dev-fixed", "live-visible-fixed"],
    tailTerms: ["liveTouched", "providerConfigTouched"],
  },
  {
    id: "protected_memory_boundary",
    headTerms: ["protected memory", "memory/current-research-line.md"],
    tailTerms: ["protectedMemoryTouched", "protectedMemoryUntouched"],
  },
  {
    id: "local_automation_boundary",
    headTerms: ["local automation", "LCX Agent Operator Digest"],
    tailTerms: ["local_automation", "automation_or_operator_loop"],
  },
  {
    id: "lark_feishu_boundary",
    headTerms: ["Lark/Feishu", "live-visible-fixed"],
    tailTerms: ["lark_loop_diagnose", "liveTouched"],
  },
  {
    id: "memory_sedimentation_boundary",
    headTerms: ["memory sedimentation", "source storage is not learning"],
    tailTerms: ["memory_sedimentation", "module_learning_memory"],
  },
  {
    id: "mind_model_boundary",
    headTerms: ["LCX Agent Mind Model", "god-view", "workflow closure"],
    tailTerms: [
      "lcx-mind-model",
      "mind-model-consistency",
      "lcx-context-recovery-exam",
      "compressedContextRecovered",
      "MIND_MODEL_LANES",
    ],
  },
];

function usage(): never {
  throw new Error(
    [
      "Usage: node --import tsx scripts/dev/lcx-head-tail-consistency.ts [--json]",
      "",
      "Checks that macro doctrine, prompts, runbooks, local-brain modules, teacher",
      "curriculum, eval cases, and module-learning memory targets stay wired together.",
    ].join("\n"),
  );
}

function parseArgs(args: string[]) {
  const options = { json: false };
  for (const arg of args) {
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      usage();
    } else {
      usage();
    }
  }
  return options;
}

async function readOptionalText(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function readSurfaces(files: readonly string[]): Promise<Surface[]> {
  return Promise.all(
    files.map(async (file) => ({
      label: file,
      text: await readOptionalText(path.join(repoRoot, file)),
    })),
  );
}

function joinedText(surfaces: readonly Surface[]): string {
  return surfaces
    .map((surface) => surface.text ?? "")
    .join("\n")
    .toLowerCase();
}

function missingFilesCheck(surfaces: readonly Surface[], id: string, label: string): HeadTailCheck {
  const missing = surfaces
    .filter((surface) => surface.text === null)
    .map((surface) => `missing: ${surface.label}`);
  return {
    id,
    ok: missing.length === 0,
    summary: `${label} surfaces must be readable`,
    evidence: missing,
  };
}

function termsPresent(text: string, terms: readonly string[]): boolean {
  return terms.every((term) => text.includes(term.toLowerCase()));
}

function moduleCoverageCheck(): HeadTailCheck {
  const targets = new Set<string>(MODULE_LEARNING_TARGETS);
  const uncovered = LOCAL_BRAIN_MODULE_TAXONOMY.filter(
    (moduleId) => !targets.has(moduleId) && !MODULE_LEARNING_TARGET_EXEMPTIONS[moduleId],
  );
  const exemptionEvidence = LOCAL_BRAIN_MODULE_TAXONOMY.filter(
    (moduleId) => !targets.has(moduleId) && MODULE_LEARNING_TARGET_EXEMPTIONS[moduleId],
  ).map((moduleId) => `${moduleId}: ${MODULE_LEARNING_TARGET_EXEMPTIONS[moduleId]}`);
  return {
    id: "taxonomy_modules_have_learning_target_or_explicit_exemption",
    ok: uncovered.length === 0,
    summary:
      "every local-brain module must either have a module-learning target or a named explicit exemption",
    evidence: [
      ...uncovered.map((moduleId) => `missing learning target or exemption: ${moduleId}`),
      ...exemptionEvidence.map((entry) => `exemption: ${entry}`),
    ],
  };
}

function extraTargetsCheck(): HeadTailCheck {
  const modules = new Set<string>(LOCAL_BRAIN_MODULE_TAXONOMY);
  const unknownTargets = MODULE_LEARNING_TARGETS.filter(
    (target) => !modules.has(target) && !MODULE_LEARNING_TARGETS_WITHOUT_TAXONOMY.has(target),
  );
  return {
    id: "module_learning_targets_are_taxonomy_backed_or_named_external_targets",
    ok: unknownTargets.length === 0,
    summary:
      "module-learning targets should be backed by the local-brain taxonomy unless explicitly external",
    evidence: unknownTargets.map((target) => `unknown module-learning target: ${target}`),
  };
}

function runbookListsTargetsCheck(runbookText: string): HeadTailCheck {
  const missing = MODULE_LEARNING_TARGETS.filter((target) => !runbookText.includes(target));
  return {
    id: "runbook_lists_every_module_learning_target",
    ok: missing.length === 0,
    summary: "operator runbook must list every supported module_learning_pipeline_plan target",
    evidence: missing.map((target) => `missing in ops/local-brain/README.md: ${target}`),
  };
}

function criticalModuleCheck(headText: string, tailText: string): HeadTailCheck {
  const missing = CRITICAL_MODULE_CONTRACTS.flatMap((contract) => {
    const misses: string[] = [];
    if (!termsPresent(headText, contract.headTerms)) {
      misses.push(`head missing ${contract.id}: ${contract.headTerms.join(" + ")}`);
    }
    if (!termsPresent(tailText, contract.tailTerms)) {
      misses.push(`tail missing ${contract.id}: ${contract.tailTerms.join(" + ")}`);
    }
    return misses;
  });
  return {
    id: "critical_module_head_tail_terms_present",
    ok: missing.length === 0,
    summary: "critical modules must appear at both doctrine/prompt head and eval/teacher/tool tail",
    evidence: missing,
  };
}

function engineeringMicroContractCheck(headText: string, tailText: string): HeadTailCheck {
  const missing = ENGINEERING_MICRO_CONTRACTS.flatMap((contract) => {
    const misses: string[] = [];
    if (!termsPresent(headText, contract.headTerms)) {
      misses.push(`head missing ${contract.id}: ${contract.headTerms.join(" + ")}`);
    }
    if (!termsPresent(tailText, contract.tailTerms)) {
      misses.push(`tail missing ${contract.id}: ${contract.tailTerms.join(" + ")}`);
    }
    return misses;
  });
  return {
    id: "engineering_micro_contracts_head_tail_present",
    ok: missing.length === 0,
    summary:
      "non-module micro-change rules must also appear at both macro doctrine and executable tail",
    evidence: missing,
  };
}

function fullChainPhrasesCheck(headText: string, tailText: string): HeadTailCheck {
  const required = [
    "source registry",
    "actual reading scope",
    "retrieval receipt",
    "application validation",
    "eval or training absorption",
    "fresh adjacent",
    "keep/downrank/discard",
  ];
  const missing = required.flatMap((phrase) => {
    const misses: string[] = [];
    if (!headText.includes(phrase)) {
      misses.push(`head missing chain phrase: ${phrase}`);
    }
    if (!tailText.includes(phrase.replaceAll(" ", "_")) && !tailText.includes(phrase)) {
      misses.push(`tail missing chain phrase: ${phrase}`);
    }
    return misses;
  });
  return {
    id: "head_tail_full_learning_chain_terms_present",
    ok: missing.length === 0,
    summary:
      "the same source-to-learning chain must be visible in both macro doctrine and micro code",
    evidence: missing,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const [headSurfaces, tailSurfaces] = await Promise.all([
    readSurfaces(HEAD_SURFACE_FILES),
    readSurfaces(TAIL_SURFACE_FILES),
  ]);
  const headText = joinedText(headSurfaces);
  const tailText = joinedText(tailSurfaces);
  const runbookText =
    (await readOptionalText(path.join(repoRoot, "ops", "local-brain", "README.md"))) ?? "";

  const checks: HeadTailCheck[] = [
    missingFilesCheck(headSurfaces, "head_surfaces_readable", "head"),
    missingFilesCheck(tailSurfaces, "tail_surfaces_readable", "tail"),
    moduleCoverageCheck(),
    extraTargetsCheck(),
    runbookListsTargetsCheck(runbookText),
    criticalModuleCheck(headText, tailText),
    engineeringMicroContractCheck(headText, tailText),
    fullChainPhrasesCheck(headText, tailText),
  ];

  const failed = checks.filter((check) => !check.ok);
  const result = {
    ok: failed.length === 0,
    boundary: "dev_head_tail_consistency_only",
    checkedAt: new Date().toISOString(),
    summary: {
      passed: checks.length - failed.length,
      failed: failed.length,
      total: checks.length,
    },
    moduleCounts: {
      localBrainTaxonomy: LOCAL_BRAIN_MODULE_TAXONOMY.length,
      moduleLearningTargets: MODULE_LEARNING_TARGETS.length,
      explicitExemptions: Object.keys(MODULE_LEARNING_TARGET_EXEMPTIONS).length,
    },
    checks,
    actionableFailures: failed.map((check) => `${check.id}: ${check.summary}`),
    liveTouched: false,
    providerConfigTouched: false,
    protectedMemoryTouched: false,
  };

  process.stdout.write(
    options.json
      ? `${JSON.stringify(result, null, 2)}\n`
      : [
          `lcx head-tail consistency ${result.ok ? "ok" : "failed"}`,
          `passed=${result.summary.passed} failed=${result.summary.failed} total=${result.summary.total}`,
          ...failed.map((check) => `- ${check.id}: ${check.summary}`),
        ].join("\n") + "\n",
  );
  process.exitCode = result.ok ? 0 : 1;
}

await main();
