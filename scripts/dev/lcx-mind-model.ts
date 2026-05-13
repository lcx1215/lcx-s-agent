import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type MindModelSurfaceGroup = "head" | "workflow" | "proof" | "boundary";

type MindModelLane = {
  id: string;
  masterLane: string;
  objective: string;
  headTerms: string[];
  workflowTerms: string[];
  proofTerms: string[];
  boundaryTerms: string[];
  nextAction: string;
};

type LaneVerdict = {
  id: string;
  masterLane: string;
  ok: boolean;
  severity: "info" | "P2";
  objective: string;
  missing: Array<{ surface: MindModelSurfaceGroup; term: string }>;
  evidence: string[];
  nextAction: string;
};

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(SCRIPT_DIR, "..", "..");

const HEAD_SURFACES = [
  "AGENTS.md",
  "README.md",
  "ops/local-brain/README.md",
  "src/agents/system-prompt.ts",
] as const;

const WORKFLOW_SURFACES = [
  "scripts/dev/lcx-change-impact-plan.ts",
  "scripts/dev/lcx-head-tail-consistency.ts",
  "scripts/dev/lcx-system-doctor.ts",
  "scripts/dev/lcx-agent-exam.ts",
  "scripts/dev/local-brain-training-plan.ts",
  "scripts/dev/local-brain-distill-eval.ts",
  "scripts/dev/minimax-brain-training-guard.ts",
  "scripts/dev/minimax-brain-teacher-batch.ts",
  "scripts/dev/minimax-quota-brain-saturator.ts",
  "scripts/dev/local-brain-promotion-audit.ts",
  "scripts/dev/module-learning-pipeline-plan.ts",
  "scripts/dev/module-learning-pipeline-review.ts",
  "scripts/dev/lcx-local-operator-loop.sh",
  "scripts/dev/codex-archive-lcx-automation-threads.sh",
  "scripts/dev/lcx-promote-live.ts",
  "src/agents/tools/module-learning-pipeline-plan-tool.ts",
  "src/agents/tools/module-learning-pipeline-review-tool.ts",
  "src/commands/capabilities/lark-loop-diagnose.ts",
] as const;

const PROOF_SURFACES = [
  ...WORKFLOW_SURFACES,
  "test/lcx-head-tail-consistency.test.ts",
  "test/lcx-mind-model.test.ts",
  "test/lcx-agent-exam.test.ts",
  "test/local-brain-training-plan.test.ts",
  "test/local-brain-distill-eval.test.ts",
  "test/local-brain-contracts.test.ts",
  "test/minimax-brain-training-guard.test.ts",
  "test/minimax-brain-teacher-batch.test.ts",
  "test/local-brain-promotion-audit.test.ts",
  "test/lcx-promote-live-status.test.ts",
  "src/agents/tools/module-learning-pipeline-plan-tool.test.ts",
  "src/agents/tools/module-learning-pipeline-review-tool.test.ts",
] as const;

const BOUNDARY_SURFACES = [
  "AGENTS.md",
  "README.md",
  "ops/local-brain/README.md",
  "src/agents/system-prompt.ts",
  "scripts/dev/lcx-promote-live.ts",
  "scripts/dev/lcx-system-doctor.ts",
  "scripts/dev/local-brain-training-plan.ts",
  "scripts/dev/minimax-brain-teacher-batch.ts",
  "scripts/dev/lcx-automation-repair-lock.ts",
  "src/agents/tools/module-learning-pipeline-review-tool.ts",
] as const;

const MIND_MODEL_LANES: MindModelLane[] = [
  {
    id: "context_recovery",
    masterLane: "global_doctrine_and_runbook",
    objective: "Recover the whole agent state from durable evidence when chat context is missing.",
    headTerms: [
      "Context-Limited Continuity Doctrine",
      "fixed evidence",
      "lcx-local-operator-latest.json",
    ],
    workflowTerms: ["lcx-system-doctor", "local-brain-training-plan", "lcx-agent-exam"],
    proofTerms: ["observability-entrypoints", "doctrine-consistency", "head-tail-consistency"],
    boundaryTerms: ["dev_observability_only", "live-visible-fixed"],
    nextAction:
      "Start from AGENTS, runbook, doctor, training-plan, and local operator state before coding.",
  },
  {
    id: "change_impact_micro_to_macro",
    masterLane: "global_doctrine_and_runbook",
    objective: "Force every small engineering edit to declare its master lane and proof path.",
    headTerms: ["lcx-change-impact-plan", "master lane", "head-tail consistency"],
    workflowTerms: ["PATH_RULES", "recommendedFastCommands", "headTailRequired"],
    proofTerms: ["plans required verification", "recommendedFastCommands"],
    boundaryTerms: ["liveTouched", "providerConfigTouched", "protectedMemoryTouched"],
    nextAction:
      "Run lcx-change-impact-plan for changed files and use its focused checks before broad scans.",
  },
  {
    id: "local_brain_training",
    masterLane: "qwen_training",
    objective:
      "Keep Qwen training, MiniMax teacher, eval, and adapter promotion observable as one loop.",
    headTerms: ["Qwen training", "MiniMax teacher", "adapter promotion"],
    workflowTerms: [
      "minimax-brain-training-guard",
      "minimax-quota-brain-saturator",
      "local-brain-training-plan",
    ],
    proofTerms: ["latestQuotaStatus", "overlappingHeavyEval", "trainingSeedAdapter"],
    boundaryTerms: ["noLanguageRoutingPromotion", "providerConfigTouched", "liveTouched"],
    nextAction:
      "Use training-plan and doctor before starting or judging training; never start overlap.",
  },
  {
    id: "module_learning_memory",
    masterLane: "memory_sedimentation",
    objective:
      "Prevent stored sources or summaries from being mistaken for learned module capability.",
    headTerms: ["All-Module Internalization Chain", "source storage is not learning"],
    workflowTerms: ["module_learning_pipeline_plan", "module_learning_pipeline_review"],
    proofTerms: ["weakModuleLearning", "evalAbsorbed", "applicationReady"],
    boundaryTerms: ["languageCorpusUntouched", "protectedMemoryUntouched", "noExecutionAuthority"],
    nextAction:
      "Use module-learning plan/review before claiming a module learned anything from a source.",
  },
  {
    id: "lark_feishu_live_boundary",
    masterLane: "dev_live_boundary",
    objective: "Keep dev correctness, live runtime sync, and real Lark/Feishu user proof separate.",
    headTerms: ["dev-ready", "live-runtime-updated", "live-user-seen"],
    workflowTerms: ["lcx-promote-live", "lark-loop-diagnose", "channels status"],
    proofTerms: ["acceptancePhrase", "liveUserSeen", "freshInboundCount"],
    boundaryTerms: ["live-visible-fixed", "providerConfigTouched", "liveTouched"],
    nextAction:
      "Do not claim live-visible-fixed until migration, probe, and real inbound/reply evidence exist.",
  },
  {
    id: "finance_research_capability",
    masterLane: "finance_research_capability",
    objective:
      "Keep advanced trader thinking tied to fundamentals, timing, risk, evidence, and review.",
    headTerms: ["fundamentals for filtering", "technicals for timing", "hard risk gates"],
    workflowTerms: ["company_fundamentals_value", "portfolio_risk_gates", "review_panel"],
    proofTerms: ["local-brain-contracts", "financial_modeling_valuation_qc"],
    boundaryTerms: ["research-only", "no_trade_advice", "no_execution_authority"],
    nextAction:
      "Route finance improvements through source, capability, retrieval/apply, eval, and review.",
  },
  {
    id: "local_automation_single_digest",
    masterLane: "local_automation",
    objective:
      "Keep local background automation useful without spawning noisy Codex threads or duplicate loops.",
    headTerms: [
      "LCX Agent Operator Digest",
      "local automation",
      "one visible high-level automation",
    ],
    workflowTerms: ["lcx-local-operator-loop", "codex-archive", "automation_or_operator_loop"],
    proofTerms: ["local_automation", "automation_or_operator_loop"],
    boundaryTerms: ["dev_automation_coordination_only", "liveTouched"],
    nextAction: "Read local operator receipts first; keep Codex visible automation as one digest.",
  },
  {
    id: "protected_boundary",
    masterLane: "dev_live_boundary",
    objective:
      "Stop repairs from silently mutating protected memory, provider config, or live sender paths.",
    headTerms: ["protected memory", "provider config", "live sender"],
    workflowTerms: ["protectedMemoryTouched", "providerConfigTouched", "liveTouched"],
    proofTerms: ["notTouched", "separationContract", "protectedMemoryUntouched"],
    boundaryTerms: ["memory/current-research-line.md", "memory/unified-risk-view.md"],
    nextAction:
      "Treat boundary flags as hard evidence; never upgrade a dev receipt into live or memory truth.",
  },
  {
    id: "mind_model_self_supervision",
    masterLane: "global_doctrine_and_runbook",
    objective:
      "Make the agent's own macro architecture visible enough for future Codex or Claude sessions.",
    headTerms: ["LCX Agent Mind Model", "god-view", "workflow closure"],
    workflowTerms: ["lcx-mind-model", "mind-model-consistency", "MIND_MODEL_LANES"],
    proofTerms: ["lcx-mind-model", "mind-model-consistency"],
    boundaryTerms: ["dev_mind_model_only", "liveTouched", "providerConfigTouched"],
    nextAction:
      "Run lcx-mind-model when a future edit risks forgetting adjacent workflows or proof surfaces.",
  },
];

function usage(): never {
  throw new Error(
    [
      "Usage: node --import tsx scripts/dev/lcx-mind-model.ts [--json]",
      "",
      "Read-only LCX Agent god-view architecture check. It verifies that macro doctrine,",
      "workflow entrypoints, proof surfaces, and boundary flags still cover the main loops.",
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

async function readText(filePath: string): Promise<string> {
  return fs.readFile(filePath, "utf8").catch(() => "");
}

async function joinedSurfaceText(files: readonly string[]): Promise<string> {
  const chunks = await Promise.all(
    files.map(async (file) => `${file}\n${await readText(path.join(repoRoot, file))}`),
  );
  return chunks.join("\n").replace(/\s+/gu, " ").toLowerCase();
}

function termPresent(text: string, term: string): boolean {
  return text.includes(term.toLowerCase());
}

function missingTerms(params: {
  text: string;
  terms: readonly string[];
  surface: MindModelSurfaceGroup;
}): Array<{ surface: MindModelSurfaceGroup; term: string }> {
  return params.terms
    .filter((term) => !termPresent(params.text, term))
    .map((term) => ({ surface: params.surface, term }));
}

function evidenceFor(lane: MindModelLane): string[] {
  return [
    `head=${lane.headTerms.join(" + ")}`,
    `workflow=${lane.workflowTerms.join(" + ")}`,
    `proof=${lane.proofTerms.join(" + ")}`,
    `boundary=${lane.boundaryTerms.join(" + ")}`,
  ];
}

function laneVerdict(params: {
  lane: MindModelLane;
  headText: string;
  workflowText: string;
  proofText: string;
  boundaryText: string;
}): LaneVerdict {
  const missing = [
    ...missingTerms({ text: params.headText, terms: params.lane.headTerms, surface: "head" }),
    ...missingTerms({
      text: params.workflowText,
      terms: params.lane.workflowTerms,
      surface: "workflow",
    }),
    ...missingTerms({ text: params.proofText, terms: params.lane.proofTerms, surface: "proof" }),
    ...missingTerms({
      text: params.boundaryText,
      terms: params.lane.boundaryTerms,
      surface: "boundary",
    }),
  ];
  return {
    id: params.lane.id,
    masterLane: params.lane.masterLane,
    ok: missing.length === 0,
    severity: missing.length === 0 ? "info" : "P2",
    objective: params.lane.objective,
    missing,
    evidence: evidenceFor(params.lane),
    nextAction: params.lane.nextAction,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const [headText, workflowText, proofText, boundaryText] = await Promise.all([
    joinedSurfaceText(HEAD_SURFACES),
    joinedSurfaceText(WORKFLOW_SURFACES),
    joinedSurfaceText(PROOF_SURFACES),
    joinedSurfaceText(BOUNDARY_SURFACES),
  ]);
  const lanes = MIND_MODEL_LANES.map((lane) =>
    laneVerdict({ lane, headText, workflowText, proofText, boundaryText }),
  );
  const failed = lanes.filter((lane) => !lane.ok);
  const result = {
    ok: failed.length === 0,
    boundary: "dev_mind_model_only",
    checkedAt: new Date().toISOString(),
    summary: {
      passed: lanes.length - failed.length,
      failed: failed.length,
      total: lanes.length,
      masterLanes: [...new Set(lanes.map((lane) => lane.masterLane))].toSorted(),
    },
    lanes,
    actionableFailures: failed.map(
      (lane) =>
        `${lane.id}: missing ${lane.missing.map((entry) => `${entry.surface}:${entry.term}`).join(", ")}`,
    ),
    surfaceFiles: {
      head: [...HEAD_SURFACES],
      workflow: [...WORKFLOW_SURFACES],
      proof: [...PROOF_SURFACES],
      boundary: [...BOUNDARY_SURFACES],
    },
    liveTouched: false,
    providerConfigTouched: false,
    protectedMemoryTouched: false,
  };

  process.stdout.write(
    options.json
      ? `${JSON.stringify(result, null, 2)}\n`
      : [
          `lcx mind model ${result.ok ? "ok" : "failed"}`,
          `passed=${result.summary.passed} failed=${result.summary.failed} total=${result.summary.total}`,
          ...failed.map((lane) => `- ${lane.id}: ${lane.nextAction}`),
        ].join("\n") + "\n",
  );
  process.exitCode = result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
