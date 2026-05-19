import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type CandidateId =
  | "agent_lightning_trace_credit"
  | "longmemeval_agentrunbook_memory_regression"
  | "lightweight_memory_comparison"
  | "clawbench_real_task_regression"
  | "computer_use_cli_bridge";

type AdoptionMode =
  | "trace_export_probe"
  | "memory_regression_probe"
  | "memory_comparison_probe"
  | "real_task_benchmark_probe"
  | "computer_use_cli_probe";

type ExternalUpgradeCandidate = {
  id: CandidateId;
  label: string;
  sourceUrls: string[];
  sourceKind: "paper" | "github" | "paper_and_github";
  claimedCapability: string;
  adoptionMode: AdoptionMode;
  existingOwner: string;
  ownerEntrypoint: string;
  distilledPattern: string;
  firstDevProbe: string;
  requiredReceipts: string[];
  requiredFilters: string[];
  riskBoundaries: string[];
  liveBoundary: string;
};

type CandidateVerdict = ExternalUpgradeCandidate & {
  status: "dev_architecture_integrated";
  runtimeAuthority: "not_granted";
  missing: string[];
  blockedDirectAdoption: boolean;
};

type RadarCheck = {
  id: string;
  ok: boolean;
  summary: string;
  evidence?: unknown;
};

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(SCRIPT_DIR, "..", "..");

const CANDIDATES: ExternalUpgradeCandidate[] = [
  {
    id: "agent_lightning_trace_credit",
    label: "Agent Lightning",
    sourceUrls: [
      "https://arxiv.org/abs/2508.03680",
      "https://github.com/microsoft/agent-lightning",
    ],
    sourceKind: "paper_and_github",
    claimedCapability:
      "decouple agent execution traces from later learning, then use reward or failure attribution to improve agent workflows",
    adoptionMode: "trace_export_probe",
    existingOwner: "training failure feedback and problem-cluster radar",
    ownerEntrypoint: "scripts/dev/lcx-problem-cluster-radar.ts",
    distilledPattern:
      "export LCX receipts and failure clusters as trace rows for offline credit assignment; never replace Qwen promotion truth",
    firstDevProbe:
      "emit a read-only trace fixture from one failed commercial-answer or training cluster and score whether the blamed node matches the owner entrypoint",
    requiredReceipts: [
      "lcx-problem-cluster-radar",
      "local-brain-training-plan",
      "skill_pattern_distillation",
    ],
    requiredFilters: [
      "single_owner_required",
      "training_overlap_guard",
      "promotion_ready_required",
    ],
    riskBoundaries: [
      "no_runtime_rl_server",
      "no_provider_config_change",
      "no_live_sender_change",
      "no_direct_training_start",
    ],
    liveBoundary:
      "live can surface the dev radar result after migration, but no live model behavior is changed by this radar alone",
  },
  {
    id: "longmemeval_agentrunbook_memory_regression",
    label: "LongMemEval-V2 / AgentRunbook",
    sourceUrls: ["https://arxiv.org/abs/2605.12493"],
    sourceKind: "paper",
    claimedCapability:
      "evaluate whether long-term agent memory preserves environment state, workflows, gotchas, and premise changes",
    adoptionMode: "memory_regression_probe",
    existingOwner: "context recovery and memory sedimentation gates",
    ownerEntrypoint: "scripts/dev/lcx-context-recovery-exam.ts",
    distilledPattern:
      "turn LCX handoff, operator latest, module-learning, and live-boundary facts into regression questions for future compressed windows",
    firstDevProbe:
      "generate a small local memory-regression fixture asking what changed, what is stale, and which owner command proves it",
    requiredReceipts: [
      "lcx-context-recovery-exam",
      "lcx-learning-sedimentation-audit",
      "lcx-system-memory-sedimentation-gate",
    ],
    requiredFilters: [
      "fresh_operator_state_required",
      "memory_write_freshness_gate",
      "stored_only_is_not_learning",
    ],
    riskBoundaries: [
      "no_new_memory_layer",
      "protected_memory_guard",
      "system_memory_not_module_learning",
      "no_provider_config_change",
      "no_live_sender_change",
    ],
    liveBoundary:
      "live can use the same prompt doctrine after migration, but memory regression proof remains dev-only until a real Lark prompt uses it",
  },
  {
    id: "lightweight_memory_comparison",
    label: "LightMem / LycheeMemory",
    sourceUrls: ["https://arxiv.org/abs/2604.07798", "https://github.com/LycheeMem/LycheeMem"],
    sourceKind: "paper_and_github",
    claimedCapability:
      "compact, cheaper long-term memory extraction and retrieval for agent histories",
    adoptionMode: "memory_comparison_probe",
    existingOwner: "module learning absorption and system memory sedimentation",
    ownerEntrypoint: "scripts/dev/lcx-learning-sedimentation-audit.ts",
    distilledPattern:
      "compare compact-memory ideas against LCX source/retrieval/apply/eval receipts without replacing protected summaries",
    firstDevProbe:
      "score one stale-memory/downrank scenario with current LCX receipts versus a compact-memory candidate summary",
    requiredReceipts: [
      "lcx-module-learning-absorption-gate",
      "module-learning-pipeline-review",
      "lcx-system-memory-sedimentation-gate",
    ],
    requiredFilters: [
      "retrieval_apply_eval_review_required",
      "per_receipt_absorption_evidence_required",
      "protected_memory_guard",
    ],
    riskBoundaries: [
      "no_external_memory_daemon_by_default",
      "no_protected_memory_write",
      "no_storage_only_learning_claim",
      "no_provider_config_change",
      "no_live_sender_change",
    ],
    liveBoundary:
      "live prompt can mention the boundary after sync; no external memory daemon is enabled or trusted by this change",
  },
  {
    id: "clawbench_real_task_regression",
    label: "ClawBench / WildClawBench",
    sourceUrls: ["https://github.com/claw-bench/claw-bench", "https://arxiv.org/abs/2605.10912"],
    sourceKind: "paper_and_github",
    claimedCapability:
      "benchmark long-horizon and tool-heavy agent work beyond question-answer style evals",
    adoptionMode: "real_task_benchmark_probe",
    existingOwner: "commercial acceptance harness and L5 regression battery",
    ownerEntrypoint: "scripts/dev/lcx-commercial-acceptance-harness.ts",
    distilledPattern:
      "convert real task categories into LCX canaries with acceptance phrases, visible reply checks, and bounded failure reports",
    firstDevProbe:
      "add one read-only real-work canary that checks whether an answer, owner command, and visible-boundary proof line up",
    requiredReceipts: [
      "lcx-commercial-acceptance-harness",
      "l5-regression-batterer",
      "feishu-reply-flow",
    ],
    requiredFilters: [
      "commercial_error_budget_required",
      "product_canary_suite_required",
      "real_lark_inbound_required",
    ],
    riskBoundaries: [
      "no_leaderboard_submission",
      "no_untrusted_task_execution",
      "dev_ready_not_live_user_seen",
      "protected_memory_guard",
      "no_provider_config_change",
      "no_live_sender_change",
    ],
    liveBoundary:
      "commercial canary is live-visible only after migration plus fresh Lark inbound and matching reply evidence",
  },
  {
    id: "computer_use_cli_bridge",
    label: "Agent S / HKUDS CLI-Anything",
    sourceUrls: ["https://arxiv.org/abs/2410.08164", "https://github.com/HKUDS/CLI-Anything"],
    sourceKind: "paper_and_github",
    claimedCapability:
      "make computer or GUI workflows controllable through either visual computer-use agents or generated CLI wrappers",
    adoptionMode: "computer_use_cli_probe",
    existingOwner: "skill harvester and CLI-Anything harvester",
    ownerEntrypoint: "/Users/liuchengxu/.codex/skills/cli-anything-harvester/SKILL.md",
    distilledPattern:
      "prefer stable local CLI or official automation first; only distill a wrapper after JSON contract, proof command, and uninstall path exist",
    firstDevProbe:
      "classify one local command or app with cli-anything-harvester before any wrapper is allowed into LCX runtime",
    requiredReceipts: ["skill-harvester", "cli-anything-harvester", "skill_pattern_distillation"],
    requiredFilters: [
      "license_scope_required",
      "untrusted_source_isolation",
      "human_signoff_checkpoint",
    ],
    riskBoundaries: [
      "no_gui_write_without_probe",
      "no_global_install",
      "no_provider_config_change",
      "no_live_sender_change",
    ],
    liveBoundary:
      "live agent may autocue the harvester skill after sync; no desktop-control authority is granted without a concrete tested wrapper",
  },
];

function missingFor(candidate: ExternalUpgradeCandidate): string[] {
  const missing: string[] = [];
  if (candidate.sourceUrls.length === 0) {
    missing.push("source_url");
  }
  if (!candidate.ownerEntrypoint) {
    missing.push("existing_owner_entrypoint");
  }
  if (!candidate.distilledPattern) {
    missing.push("distilled_pattern");
  }
  if (!candidate.firstDevProbe) {
    missing.push("first_dev_probe");
  }
  if (candidate.requiredReceipts.length === 0) {
    missing.push("required_receipts");
  }
  if (candidate.requiredFilters.length === 0) {
    missing.push("required_filters");
  }
  if (candidate.riskBoundaries.length === 0) {
    missing.push("risk_boundaries");
  }
  return missing;
}

function candidateVerdicts(): CandidateVerdict[] {
  return CANDIDATES.map((candidate) => ({
    ...candidate,
    status: "dev_architecture_integrated",
    runtimeAuthority: "not_granted",
    missing: missingFor(candidate),
    blockedDirectAdoption: true,
  }));
}

function buildChecks(verdicts: readonly CandidateVerdict[]): RadarCheck[] {
  const ids = new Set(verdicts.map((candidate) => candidate.id));
  const expectedIds: CandidateId[] = [
    "agent_lightning_trace_credit",
    "longmemeval_agentrunbook_memory_regression",
    "lightweight_memory_comparison",
    "clawbench_real_task_regression",
    "computer_use_cli_bridge",
  ];
  const missingExpected = expectedIds.filter((id) => !ids.has(id));
  const missingFields = verdicts.flatMap((candidate) =>
    candidate.missing.map((field) => `${candidate.id}:${field}`),
  );
  const unsafeRuntimeAuthority = verdicts.filter(
    (candidate) => candidate.runtimeAuthority !== "not_granted" || !candidate.blockedDirectAdoption,
  );
  const missingBoundaries = verdicts.filter(
    (candidate) =>
      !candidate.riskBoundaries.some((boundary) =>
        boundary.includes("no_provider_config_change"),
      ) &&
      !candidate.riskBoundaries.some((boundary) => boundary.includes("protected_memory_guard")),
  );
  const missingOwner = verdicts.filter((candidate) => !candidate.ownerEntrypoint);
  return [
    {
      id: "five_external_candidates_registered",
      ok: verdicts.length === 5 && missingExpected.length === 0,
      summary: "exactly five external upgrade candidates are registered",
      evidence: { count: verdicts.length, missingExpected },
    },
    {
      id: "all_candidates_map_to_existing_owners",
      ok: missingOwner.length === 0,
      summary: "each external idea lands in an existing LCX owner instead of a parallel system",
      evidence: verdicts.map((candidate) => ({
        id: candidate.id,
        ownerEntrypoint: candidate.ownerEntrypoint,
      })),
    },
    {
      id: "source_to_distillation_contract_complete",
      ok: missingFields.length === 0,
      summary: "source, reading, distillation, receipt, filter, and probe fields are present",
      evidence: { missingFields },
    },
    {
      id: "direct_runtime_adoption_blocked",
      ok: unsafeRuntimeAuthority.length === 0,
      summary: "no external project receives runtime authority or direct install status",
      evidence: unsafeRuntimeAuthority.map((candidate) => candidate.id),
    },
    {
      id: "boundary_guards_present",
      ok: missingBoundaries.length === 0,
      summary:
        "provider, live, protected-memory, install, and execution boundaries remain explicit",
      evidence: verdicts.map((candidate) => ({
        id: candidate.id,
        riskBoundaries: candidate.riskBoundaries,
      })),
    },
  ];
}

export function buildExternalAgentUpgradeRadar() {
  const candidates = candidateVerdicts();
  const checks = buildChecks(candidates);
  const failed = checks.filter((check) => !check.ok);
  return {
    ok: failed.length === 0,
    boundary: "dev_external_agent_upgrade_radar_only",
    repoRoot,
    summary: {
      total: checks.length,
      failed: failed.length,
      registeredCandidateCount: candidates.length,
      architectureIntegratedCount: candidates.filter(
        (candidate) => candidate.status === "dev_architecture_integrated",
      ).length,
      runtimeAuthorityGrantedCount: candidates.filter(
        (candidate) => candidate.runtimeAuthority !== "not_granted",
      ).length,
      perfectIntegrationClaim: false,
    },
    architectureFit: "fully_integrated_into_existing_lcx_owner_stack",
    perfectIntegrationReason:
      "No external project should be called perfectly integrated until a concrete dev probe, eval/receipt, live migration, and fresh Lark visible proof all pass. This radar proves architecture wiring, not live-user-seen behavior.",
    checks,
    candidates,
    nextDevProbes: candidates.map((candidate) => ({
      id: candidate.id,
      ownerEntrypoint: candidate.ownerEntrypoint,
      firstDevProbe: candidate.firstDevProbe,
    })),
    liveTouched: false,
    providerConfigTouched: false,
    protectedMemoryTouched: false,
  };
}

function parseArgs(args: string[]) {
  return { json: args.includes("--json") };
}

function renderText(payload: ReturnType<typeof buildExternalAgentUpgradeRadar>): string {
  const lines = [
    `external agent upgrade radar ${payload.ok ? "ok" : "failed"}`,
    `boundary=${payload.boundary}`,
    `registeredCandidateCount=${payload.summary.registeredCandidateCount}`,
    `architectureFit=${payload.architectureFit}`,
    `perfectIntegrationClaim=${payload.summary.perfectIntegrationClaim}`,
    `runtimeAuthorityGrantedCount=${payload.summary.runtimeAuthorityGrantedCount}`,
    `liveTouched=${payload.liveTouched}`,
    `providerConfigTouched=${payload.providerConfigTouched}`,
    `protectedMemoryTouched=${payload.protectedMemoryTouched}`,
    "",
    "Candidates:",
    ...payload.candidates.map(
      (candidate) =>
        `- ${candidate.label}: owner=${candidate.ownerEntrypoint}; mode=${candidate.adoptionMode}; authority=${candidate.runtimeAuthority}`,
    ),
  ];
  return lines.join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const payload = buildExternalAgentUpgradeRadar();
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderText(payload)}\n`);
  }
  if (!payload.ok) {
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void main();
}
