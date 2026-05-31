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

type MindModelInvariant = {
  id: string;
  category: "workflow" | "content" | "boundary" | "automation" | "testing";
  objective: string;
  termsBySurface: Partial<Record<MindModelSurfaceGroup, string[]>>;
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

type InvariantVerdict = {
  id: string;
  category: MindModelInvariant["category"];
  ok: boolean;
  severity: "info" | "P2";
  objective: string;
  missing: Array<{ surface: MindModelSurfaceGroup; term: string }>;
  nextAction: string;
};

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(SCRIPT_DIR, "..", "..");
const LCX_USER_HOME = process.env.LCX_USER_HOME ?? "/Users/liuchengxu";
const LOCAL_OPERATOR_LOOP = path.join(
  LCX_USER_HOME,
  ".openclaw",
  "bin",
  "lcx-local-operator-loop.sh",
);
const LOCAL_CODEX_ARCHIVE = path.join(
  LCX_USER_HOME,
  ".openclaw",
  "bin",
  "codex-archive-lcx-automation-threads.sh",
);

const HEAD_SURFACES = [
  "AGENTS.md",
  "README.md",
  "ops/local-brain/README.md",
  "src/agents/system-prompt.ts",
] as const;

const WORKFLOW_SURFACES = [
  "scripts/dev/lcx-mind-model.ts",
  "scripts/dev/lcx-flow-graph.ts",
  "scripts/dev/lcx-governance-autopilot.ts",
  "scripts/dev/lcx-change-impact-plan.ts",
  "scripts/dev/lcx-universe-index.ts",
  "scripts/dev/lcx-skillopt-lite.ts",
  "scripts/dev/lcx-local-paths.ts",
  "scripts/dev/lcx-context-recovery-exam.ts",
  "scripts/dev/lcx-head-tail-consistency.ts",
  "scripts/dev/lcx-problem-cluster-radar.ts",
  "scripts/dev/lcx-commercial-acceptance-harness.ts",
  "scripts/dev/lcx-commercial-answer-pipeline.ts",
  "scripts/dev/lcx-self-repair-hands.ts",
  "scripts/dev/lcx-external-agent-upgrade-radar.ts",
  "scripts/dev/lcx-learning-sedimentation-bridge.ts",
  "scripts/dev/lcx-learning-sedimentation-audit.ts",
  "scripts/dev/lcx-learning-sedimentation-map.ts",
  "scripts/dev/lcx-module-learning-absorption-gate.ts",
  "scripts/dev/lcx-system-memory-sedimentation-gate.ts",
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
  LOCAL_OPERATOR_LOOP,
  LOCAL_CODEX_ARCHIVE,
  "scripts/dev/lcx-promote-live.ts",
  "extensions/feishu/src/lark-language-handoff-receipts.ts",
  "src/auto-reply/reply/get-reply-run.ts",
  "src/auto-reply/reply/skillopt-autocue.ts",
  "src/agents/tools/module-learning-pipeline-plan-tool.ts",
  "src/agents/tools/module-learning-pipeline-review-tool.ts",
  "src/commands/capabilities/lark-loop-diagnose.ts",
] as const;

const PROOF_SURFACES = [
  ...WORKFLOW_SURFACES,
  "test/lcx-context-recovery-exam.test.ts",
  "test/lcx-flow-graph.test.ts",
  "test/lcx-governance-autopilot.test.ts",
  "test/lcx-universe-index.test.ts",
  "test/lcx-skillopt-lite.test.ts",
  "src/auto-reply/reply/skillopt-autocue.test.ts",
  "test/lcx-head-tail-consistency.test.ts",
  "test/lcx-mind-model.test.ts",
  "test/lcx-problem-cluster-radar.test.ts",
  "test/lcx-commercial-acceptance-harness.test.ts",
  "test/lcx-commercial-answer-pipeline.test.ts",
  "test/lcx-self-repair-hands.test.ts",
  "extensions/feishu/src/lark-language-handoff-receipts.test.ts",
  "test/lcx-external-agent-upgrade-radar.test.ts",
  "test/lcx-agent-exam.test.ts",
  "test/local-brain-training-plan.test.ts",
  "test/local-brain-distill-eval.test.ts",
  "test/local-brain-contracts.test.ts",
  "test/minimax-brain-training-guard.test.ts",
  "test/minimax-brain-teacher-batch.test.ts",
  "test/local-brain-promotion-audit.test.ts",
  "test/lcx-learning-sedimentation-bridge.test.ts",
  "test/lcx-learning-sedimentation-audit.test.ts",
  "test/lcx-learning-sedimentation-map.test.ts",
  "test/lcx-module-learning-absorption-gate.test.ts",
  "test/lcx-system-memory-sedimentation-gate.test.ts",
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
  "scripts/dev/lcx-external-agent-upgrade-radar.ts",
  "scripts/dev/lcx-flow-graph.ts",
  "scripts/dev/lcx-governance-autopilot.ts",
  "scripts/dev/lcx-universe-index.ts",
  "scripts/dev/lcx-skillopt-lite.ts",
  "scripts/dev/lcx-commercial-acceptance-harness.ts",
  "scripts/dev/lcx-commercial-answer-pipeline.ts",
  "scripts/dev/lcx-self-repair-hands.ts",
  "scripts/dev/lcx-system-doctor.ts",
  "scripts/dev/lcx-context-recovery-exam.ts",
  "scripts/dev/local-brain-training-plan.ts",
  "src/auto-reply/reply/skillopt-autocue.ts",
  "scripts/dev/minimax-brain-teacher-batch.ts",
  "scripts/dev/lcx-automation-repair-lock.ts",
  "extensions/feishu/src/lark-language-handoff-receipts.ts",
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
    workflowTerms: [
      "lcx-system-doctor",
      "local-brain-training-plan",
      "lcx-agent-exam",
      "lcx-context-recovery-exam",
      "lcx-problem-cluster-radar",
    ],
    proofTerms: [
      "observability-entrypoints",
      "doctrine-consistency",
      "head-tail-consistency",
      "compressedContextRecovered",
      "local_operator_latest_is_fresh",
      "maxOperatorStateAgeMs",
      "problemClusters",
    ],
    boundaryTerms: ["dev_observability_only", "user-visible-observed"],
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
    workflowTerms: [
      "module_learning_pipeline_plan",
      "module_learning_pipeline_review",
      "lcx-learning-sedimentation-bridge",
      "lcx-learning-sedimentation-audit",
      "lcx-learning-sedimentation-map",
      "lcx-module-learning-absorption-gate",
      "lcx-system-memory-sedimentation-gate",
    ],
    proofTerms: [
      "weakModuleLearning",
      "evalAbsorbed",
      "applicationReady",
      "sufficientForCurrentUse",
      "riskyConflations",
      "absorptionReady",
      "recallReady",
    ],
    boundaryTerms: ["languageCorpusUntouched", "protectedMemoryUntouched", "noExecutionAuthority"],
    nextAction:
      "Use module-learning plan/review before claiming a module learned anything from a source.",
  },
  {
    id: "self_repair_hands",
    masterLane: "memory_sedimentation",
    objective:
      "Let the agent write bounded memory correction/downrank notes and training/eval candidate packets while keeping them supervised, candidate-only, and outside protected/live/provider/training authority.",
    headTerms: [
      "Self-repair hands",
      "memory correction/downrank notes",
      "training/eval candidate packets",
    ],
    workflowTerms: [
      "lcx-self-repair-hands",
      "selfRepairHands",
      "lcx-self-repair-hands-latest",
      "lcx-owner-control-map-latest",
    ],
    proofTerms: [
      "test/lcx-self-repair-hands.test.ts",
      "candidate_only_not_in_train_slice",
      "canWriteWithoutCodex",
      "self_repair_hands_waterflow",
    ],
    boundaryTerms: [
      "dev_self_repair_hands_only",
      "protectedMemoryTouched",
      "providerConfigTouched",
      "liveTouched",
      "training_candidate_not_absorbed",
    ],
    nextAction:
      "Review self-repair packets through governance/autopilot and owner-control before any owner-approved eval or train-slice absorption.",
  },
  {
    id: "lark_feishu_live_boundary",
    masterLane: "external_channel_boundary",
    objective:
      "Treat Lark/Feishu as owner-agent communication transport, not a second live brain; keep dev correctness, connector routing, and user-visible proof separate.",
    headTerms: [
      "dev-ready",
      "external-channel-bound",
      "user-visible-observed",
      "legacy-live-runtime-updated",
      "legacy-live-user-seen",
    ],
    workflowTerms: ["lcx-promote-live", "lark-loop-diagnose", "channels status"],
    proofTerms: ["naturalProbeMessage", "userVisibleObserved", "freshInboundCount"],
    boundaryTerms: [
      "user-visible-observed",
      "legacy-live-visible-fixed",
      "providerConfigTouched",
      "liveTouched",
    ],
    nextAction:
      "Do not claim user-visible-observed until channel binding, probe, and real inbound/reply evidence exist; live terms are legacy compatibility labels.",
  },
  {
    id: "commercial_acceptance_harness",
    masterLane: "global_doctrine_and_runbook",
    objective:
      "Grade commercial readiness through one product-level exam that consumes existing owners instead of manual red-dot hunting.",
    headTerms: ["Commercial Acceptance Harness", "product-grade exam", "readyForCommercialRelease"],
    workflowTerms: [
      "lcx-commercial-acceptance-harness",
      "lcx-commercial-answer-pipeline",
      "lcx-problem-cluster-radar",
      "lcx-promote-live",
    ],
    proofTerms: [
      "commercial_acceptance_harness",
      "canaryPlan",
      "blockedGates",
      "provider_council_degraded",
      "post_migration_lark_canary_missing",
    ],
    boundaryTerms: [
      "dev_commercial_acceptance_harness_only",
      "liveTouched",
      "providerConfigTouched",
      "protectedMemoryTouched",
    ],
    nextAction:
      "Run the commercial acceptance harness for product readiness; fix owner gates, not isolated symptoms.",
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
    workflowTerms: [
      "lcx-local-operator-loop",
      "lcx-governance-autopilot",
      "codex-archive",
      "automation_or_operator_loop",
      "lcx-context-recovery-exam",
      "mind_file",
      "governanceAutopilot",
    ],
    proofTerms: [
      "local_automation",
      "automation_or_operator_loop",
      "mindModel",
      "contextRecovery",
      "autoTriggeredOwnerCommands",
    ],
    boundaryTerms: [
      "dev_automation_coordination_only",
      "dev_context_recovery_exam_only",
      "liveTouched",
    ],
    nextAction: "Read local operator receipts first; keep Codex visible automation as one digest.",
  },
  {
    id: "governance_autopilot_auto_update",
    masterLane: "local_automation",
    objective:
      "Automatically trigger and refresh the read-only governance stack so waterflow, mind model, radar, impact plan, training truth, and live-binding truth stay current without manual reminders.",
    headTerms: ["Governance Stack Autopilot", "local operator", "automatically"],
    workflowTerms: [
      "lcx-governance-autopilot",
      "lcx-governance-autopilot-latest",
      "lcx-local-failure-trace-latest",
      "lcx-owner-brief-latest",
      "lcx-owner-control-map-latest",
      "governanceAutopilot",
      "autoTriggeredOwnerCommands",
    ],
    proofTerms: [
      "dev_governance_autopilot_only",
      "dev_local_failure_trace_index_only",
      "dev_owner_brief_readable_summary_only",
      "dev_owner_control_map_only",
      "test/lcx-governance-autopilot.test.ts",
      "latestStatePath",
    ],
    boundaryTerms: ["readOnly", "noOverlappingTrainingStarted", "liveTouched"],
    nextAction:
      "Let the local operator refresh governanceAutopilot; use its owner list before adding another parallel diagnostic.",
  },
  {
    id: "universe_index_total_coverage",
    masterLane: "global_doctrine_and_runbook",
    objective:
      "Give future agents one inventory owner for all repo files, code surfaces, runtime artifacts, live sidecar files, owner coverage, and cleanup candidates.",
    headTerms: [
      "LCX Agent Universe Index Doctrine",
      "all files, all code, all artifacts",
      "lcx-universe-index",
    ],
    workflowTerms: [
      "lcx-universe-index",
      "dev_universe_index_only",
      "garbageCandidates",
      "ownerCoverage",
    ],
    proofTerms: [
      "test/lcx-universe-index.test.ts",
      "universe_index_recovers_total_inventory",
      "dev_universe_index_only",
    ],
    boundaryTerms: [
      "inventory and cleanup candidates only",
      "no delete/migration/live authority",
      "liveTouched",
    ],
    nextAction:
      "Run lcx-universe-index before broad cleanup or full-system review; route any candidate to its owner instead of deleting or migrating directly.",
  },
  {
    id: "protected_boundary",
    masterLane: "dev_live_boundary",
    objective:
      "Stop repairs from silently mutating protected memory, provider config, or external-channel sender paths.",
    headTerms: ["protected memory", "provider config", "external-channel sender"],
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
  {
    id: "flow_graph_waterflow_supervision",
    masterLane: "global_doctrine_and_runbook",
    objective:
      "Make task waterflows explicit so future small workflow edits cannot skip filters, receipts, or bounded feedback gates.",
    headTerms: ["LCX Agent Flow Graph", "waterflow", "filter valve"],
    workflowTerms: ["lcx-flow-graph", "FLOW_SCENARIOS", "requiredFilters"],
    proofTerms: ["flow_graph_exam", "missingRequiredFilters", "test/lcx-flow-graph.test.ts"],
    boundaryTerms: ["dev_flow_graph_only", "liveTouched", "providerConfigTouched"],
    nextAction:
      "Run lcx-flow-graph when a task family could wrong-flow, skip a filter, or recirculate without a guard.",
  },
  {
    id: "skillopt_runtime_self_use",
    masterLane: "lark_feishu_visible_reply",
    objective:
      "Let eval-derived SkillOpt SOPs guide the Lark/local reply planner immediately while keeping model-weight absorption and user-visible proof separate.",
    headTerms: ["SkillOpt-lite", "runtime hook", "not Qwen weight absorption"],
    workflowTerms: ["lcx-skillopt-lite", "skillopt-autocue", "get-reply-run", "best_skill.md"],
    proofTerms: [
      "test/lcx-skillopt-lite.test.ts",
      "skillopt-autocue.test.ts",
      "ready_via_preflight_context_injection",
    ],
    boundaryTerms: [
      "dev_skillopt_preflight_only",
      "not model-weight absorption",
      "not user-visible-observed proof",
    ],
    nextAction:
      "Keep SkillOpt as deterministic preflight context until targeted eval, training/promotion truth, external-channel binding, and real Lark user-visible proof pass.",
  },
  {
    id: "world_class_agent_architecture",
    masterLane: "global_doctrine_and_runbook",
    objective:
      "Keep world-class agent architecture as an operational standard instead of a slogan.",
    headTerms: [
      "World-Class Agent Architecture Doctrine",
      "world-class agent architecture",
      "operator-grade engineering quality",
    ],
    workflowTerms: [
      "single factual owner",
      "local-brain-training-plan",
      "lcx-flow-graph",
      "lcx-context-recovery-exam",
    ],
    proofTerms: [
      "world_class_agent_architecture_is_operational_not_slogan",
      "flow_graph_exam",
      "mind-model-consistency",
      "actionableFailures",
    ],
    boundaryTerms: [
      "no fake user-visible-observed",
      "protectedMemoryTouched",
      "providerConfigTouched",
      "liveTouched",
    ],
    nextAction:
      "Judge future architecture work by factual owners, recovery, eval proof, bounded feedback, and boundary honesty.",
  },
  {
    id: "external_agent_upgrade_distillation",
    masterLane: "agent_workflow_memory",
    objective:
      "Fold useful GitHub, arXiv, memory, benchmark, and computer-use projects into existing LCX owners without granting runtime authority.",
    headTerms: [
      "external agent upgrade radar",
      "AutoSkill",
      "Skills-Coach",
      "Agent Lightning",
      "LongMemEval-V2",
      "MemX",
      "OpenTelemetry GenAI",
      "AgentSight",
      "OWASP Agentic",
      "SMCP",
      "ClawBench",
      "CLI-Anything",
      "multi-agent orchestration",
      "Polymarket",
      "prediction market",
      "blacktech mechanism",
    ],
    workflowTerms: [
      "lcx-external-agent-upgrade-radar",
      "SkillOpt v2 lifecycle",
      "unified trajectory schema",
      "secure tool/skill permission",
      "automatic trigger",
      "owner gate",
      "autopilot surface",
      "next automation action",
      "github_project_capability_intake",
      "skill-harvester",
      "cli-anything-harvester",
      "prediction_market_research_only_waterflow",
      "finance_data_gateway",
    ],
    proofTerms: [
      "registeredCandidateCount",
      "blacktechMechanismCount",
      "blacktechRuntimeAuthorityGrantedCount",
      "blacktechAutopilotRoutedCount",
      "perfectIntegrationClaim",
      "runtimeAuthorityGrantedCount",
      "test/lcx-external-agent-upgrade-radar.test.ts",
      "test/lcx-flow-graph.test.ts",
    ],
    boundaryTerms: [
      "dev_external_agent_upgrade_radar_only",
      "no direct install",
      "no wallet connection",
      "no order placement",
      "providerConfigTouched",
      "protectedMemoryTouched",
      "liveTouched",
    ],
    nextAction:
      "Run lcx-external-agent-upgrade-radar before absorbing external agent projects; distill only into existing owner lanes.",
  },
];

const MIND_MODEL_INVARIANTS: MindModelInvariant[] = [
  {
    id: "surface_file_existence_is_hard_failure",
    category: "workflow",
    objective:
      "Referenced workflow, proof, and local operator files must exist, not only be named.",
    termsBySurface: {
      workflow: ["missingSurfaceFiles", "resolveSurfaceFile"],
      proof: ["missingSurfaceFiles", "surface_missing"],
    },
    nextAction:
      "Keep missingSurfaceFiles as a hard mind-model failure when adding any surface file.",
  },
  {
    id: "compressed_recovery_requires_fresh_operator_state",
    category: "automation",
    objective:
      "A readable old local operator receipt must not be accepted as current machine truth.",
    termsBySurface: {
      head: ["operator latest state must be fresh", "stale"],
      workflow: [
        "local_operator_latest_is_fresh",
        "MAX_OPERATOR_STATE_AGE_MS",
        "operatorStateAgeMs",
      ],
      proof: ["local_operator_latest_is_fresh", "MAX_OPERATOR_STATE_AGE_MS"],
    },
    nextAction:
      "Fail compressed recovery when lcx-local-operator-latest.json is stale or missing checkedAt.",
  },
  {
    id: "test_home_drift_cannot_hide_real_operator_state",
    category: "testing",
    objective:
      "Temporary test HOME values must not make the mind model look at the wrong operator state.",
    termsBySurface: {
      workflow: ["LCX_USER_HOME", "/Users/liuchengxu", "LOCAL_OPERATOR_LATEST"],
      proof: ["LCX_USER_HOME", "openclaw-test-home", "missingSurfaceFiles"],
    },
    nextAction:
      "Use LCX_USER_HOME for user-specific operator state and test the temporary-HOME case.",
  },
  {
    id: "heavy_eval_overlap_remains_visible",
    category: "workflow",
    objective: "Doctor and training plan must prevent accidental overlapping MLX/eval work.",
    termsBySurface: {
      head: ["do not start overlapping training", "overlapping local-brain training"],
      workflow: [
        "overlappingHeavyEval",
        "training_already_active",
        "do_not_start_overlapping_guard",
      ],
      proof: ["overlappingHeavyEval", "training_already_active"],
    },
    nextAction:
      "Never run heavy eval and doctor in ways that hide overlap; keep overlap as a hard visible failure.",
  },
  {
    id: "dev_live_status_words_stay_separate",
    category: "boundary",
    objective:
      "Dev proof, Lark external-channel binding, and real user-visible proof must stay separate while legacy live terms fade out.",
    termsBySurface: {
      head: [
        "dev-ready",
        "external-channel-bound",
        "user-visible-observed",
        "legacy-live-runtime-updated",
        "legacy-live-user-seen",
      ],
      workflow: ["liveRuntimeUpdated", "liveUserSeen", "liveNeedsPromotion"],
      proof: [
        "naturalProbeMessage",
        "freshInboundCount",
        "liveVisibleStatus",
        "acceptanceMatched",
        "post_migration_reply_seen",
      ],
    },
    nextAction:
      "Do not claim user-visible-observed unless Lark channel proof has fresh inbound plus a successful visible reply; legacy live-user-seen is only a compatibility alias.",
  },
  {
    id: "visible_reply_hides_internal_runtime_details",
    category: "content",
    objective:
      "Lark-visible answers must translate backend and eval machinery into user language unless the user asks for protocol proof.",
    termsBySurface: {
      head: ["visible reply", "no internal labels", "用户入口简单"],
      workflow: [
        "no_internal_runtime_details_visible",
        "Internal-detail rule",
        "visible_text_no_internal_runtime_details",
      ],
      proof: [
        "visible_learning_reply_blocks_internal_runtime_details",
        "internal_runtime_details_in_visible_answer",
      ],
      boundary: ["providerConfigTouched", "liveTouched", "protectedMemoryTouched"],
    },
    nextAction:
      "If a real Lark reply exposes module ids, receipt paths, message ids, timeout milliseconds, or protocol labels, repair the shared visible-answer gate before adding features.",
  },
  {
    id: "content_claims_need_source_or_unverified_flag",
    category: "content",
    objective:
      "Finance and macro content claims must require source evidence or be marked unverified.",
    termsBySurface: {
      head: ["speculative market claims", "re-verification"],
      workflow: [
        "unverified_macro_claim_source_audit",
        "source_url_or_local_source_path",
        "no_unverified_current_market_data",
      ],
      proof: [
        "unverified_macro_claim_source_audit",
        "source_url_or_local_source_path",
        "no_unverified_current_market_data",
      ],
      boundary: ["no_trade_advice", "no_unverified_current_market_data"],
    },
    nextAction:
      "Add or reuse an invariant whenever a new content claim family could be stated without evidence.",
  },
  {
    id: "module_learning_cannot_be_stored_only",
    category: "content",
    objective:
      "A stored source, summary, or dataset row must not be treated as learned module capability.",
    termsBySurface: {
      head: [
        "A stored source, summary, or dataset row is not enough",
        "All-Module Internalization Chain",
      ],
      workflow: [
        "storedOnly",
        "retrievalReady",
        "applicationReady",
        "evalAbsorbed",
        "lcx-learning-sedimentation-bridge",
        "lcx-learning-sedimentation-audit",
        "lcx-learning-sedimentation-map",
        "lcx-module-learning-absorption-gate",
        "lcx-system-memory-sedimentation-gate",
      ],
      proof: [
        "weakModuleLearning",
        "boundaryViolations",
        "evalAbsorbed",
        "sufficientForCurrentUse",
        "riskyConflations",
        "absorptionReady",
        "recallReady",
      ],
    },
    nextAction:
      "Require source registry, retrieval/apply receipt, eval/training evidence, and review status.",
  },
  {
    id: "skillopt_preflight_is_not_absorption_or_live_proof",
    category: "boundary",
    objective:
      "SkillOpt runtime preflight can improve the next answer immediately, but must not be upgraded into model-weight absorption, adapter promotion, or user-visible-observed proof.",
    termsBySurface: {
      head: ["SkillOpt-lite", "not Qwen weight absorption", "user-visible-observed proof"],
      workflow: [
        "dev_skillopt_preflight_only",
        "resolveSkillOptAutoCue",
        "applySkillOptAutoCueToBody",
        "lcx-skillopt-lite",
      ],
      proof: [
        "ready_via_preflight_context_injection",
        "skillopt-autocue.test.ts",
        "test/lcx-skillopt-lite.test.ts",
      ],
      boundary: [
        "dev_skillopt_preflight_only",
        "not model-weight absorption",
        "not user-visible-observed proof",
      ],
    },
    nextAction:
      "Use SkillOpt preflight for immediate planning only; require targeted eval, clean promotion truth, live sync, and real Lark evidence before stronger claims.",
  },
  {
    id: "universe_index_is_inventory_not_delete_authority",
    category: "boundary",
    objective:
      "The universe index may find every file, artifact, sidecar, and cleanup candidate, but it must not delete, migrate live runtime, or change authority by itself.",
    termsBySurface: {
      head: [
        "LCX Agent Universe Index Doctrine",
        "all files, all code, all artifacts",
        "not deletion authority",
      ],
      workflow: [
        "dev_universe_index_only",
        "garbageCandidates",
        "no delete/migration/live authority",
      ],
      proof: ["test/lcx-universe-index.test.ts", "universe_index_recovers_total_inventory"],
      boundary: [
        "inventory and cleanup candidates only",
        "liveTouched",
        "providerConfigTouched",
        "protectedMemoryTouched",
      ],
    },
    nextAction:
      "Treat universe-index output as a map; cleanup or migration still needs the matching owner gate and explicit proof.",
  },
  {
    id: "mind_model_changes_have_targeted_tests",
    category: "testing",
    objective: "Every mind-model or recovery change must be backed by targeted tests.",
    termsBySurface: {
      workflow: ["test/lcx-mind-model.test.ts", "test/lcx-context-recovery-exam.test.ts"],
      proof: ["passes current macro workflow closure surfaces", "compressed context recovery exam"],
    },
    nextAction:
      "Add a regression test when adding any invariant, lane, recovery check, or boundary rule.",
  },
  {
    id: "task_waterflows_have_filters_and_receipts",
    category: "workflow",
    objective:
      "Complex task waterflows must name their required filters, receipts, and bounded feedback gates.",
    termsBySurface: {
      head: ["LCX Agent Flow Graph", "wrong-flow", "bounded feedback"],
      workflow: ["requiredFilters", "feedbackEdges", "ILLEGAL_EDGES"],
      proof: ["flow_graph_exam", "flow_graph_illegal_shortcuts_absent"],
      boundary: ["dev_flow_graph_only", "protectedMemoryTouched"],
    },
    nextAction:
      "Add or update a flow-graph scenario whenever a new task family can skip filters or recirculate.",
  },
  {
    id: "external_agent_projects_cannot_be_parallel_systems",
    category: "workflow",
    objective:
      "External papers, GitHub projects, skills, benchmarks, and computer-use frameworks must distill into existing LCX owners instead of becoming parallel architectures.",
    termsBySurface: {
      head: ["external agent upgrade radar", "not direct runtime authority", "skill-harvester"],
      workflow: [
        "lcx-external-agent-upgrade-radar",
        "external_upgrade_radar",
        "github_project_capability_intake",
        "cli-anything-harvester",
        "prediction_market_research_only_waterflow",
      ],
      proof: [
        "registeredCandidateCount",
        "runtimeAuthorityGrantedCount",
        "perfectIntegrationClaim",
        "no_wallet_or_order_execution",
      ],
      boundary: [
        "dev_external_agent_upgrade_radar_only",
        "no direct install",
        "no wallet connection",
        "no order placement",
        "no provider config",
        "no external-channel sender",
      ],
    },
    nextAction:
      "Block direct installs or new agent frameworks until the upgrade radar maps them to source, license, distillation, receipt, eval, and owner gates.",
  },
  {
    id: "world_class_agent_architecture_is_operational_not_slogan",
    category: "workflow",
    objective:
      "World-class agent architecture must be proven through product surfaces, factual owners, recovery, eval proof, and boundaries.",
    termsBySurface: {
      head: [
        "World-Class Agent Architecture Doctrine",
        "operator-grade engineering quality",
        "measured capability and operational cleanliness",
      ],
      workflow: [
        "world_class_agent_architecture",
        "single factual owner",
        "MIND_MODEL_LANES",
        "CONSOLIDATION_CLUSTERS",
      ],
      proof: [
        "world_class_agent_architecture",
        "world_class_agent_architecture_is_operational_not_slogan",
        "test/lcx-mind-model.test.ts",
      ],
      boundary: [
        "no fake user-visible-observed",
        "protectedMemoryTouched",
        "providerConfigTouched",
        "liveTouched",
      ],
    },
    nextAction:
      "Reject architecture changes that add slogans, duplicate truth owners, or unverified live/provider/protected-memory claims.",
  },
  {
    id: "problem_cluster_radar_consumes_owner_outputs",
    category: "workflow",
    objective:
      "God-view checks must aggregate current owner red lights into problem clusters instead of requiring Codex to manually rediscover them.",
    termsBySurface: {
      head: ["problem cluster radar", "owner outputs", "problemClusters"],
      workflow: ["lcx-problem-cluster-radar", "sourceOwners", "ownerEntrypoint"],
      proof: ["test/lcx-problem-cluster-radar.test.ts", "actionableClusters"],
      boundary: ["dev_problem_cluster_radar_only", "liveTouched", "providerConfigTouched"],
    },
    nextAction:
      "Use lcx-problem-cluster-radar when owner commands are green structurally but current runtime or learning facts still expose P2/P3 clusters.",
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

function resolveSurfaceFile(file: string): string {
  return path.isAbsolute(file) ? file : path.join(repoRoot, file);
}

async function joinedSurfaceText(files: readonly string[]): Promise<string> {
  const chunks = await Promise.all(
    files.map(async (file) => `${file}\n${await readText(resolveSurfaceFile(file))}`),
  );
  return chunks.join("\n").replace(/\s+/gu, " ").toLowerCase();
}

async function missingSurfaceFiles(files: readonly string[]): Promise<string[]> {
  const statuses = await Promise.all(
    files.map(async (file) => {
      try {
        await fs.access(resolveSurfaceFile(file));
        return undefined;
      } catch {
        return file;
      }
    }),
  );
  return statuses.filter((file): file is string => typeof file === "string");
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

function invariantVerdict(params: {
  invariant: MindModelInvariant;
  surfaceText: Record<MindModelSurfaceGroup, string>;
}): InvariantVerdict {
  const missing = Object.entries(params.invariant.termsBySurface).flatMap(([surface, terms]) =>
    missingTerms({
      text: params.surfaceText[surface as MindModelSurfaceGroup],
      terms: terms ?? [],
      surface: surface as MindModelSurfaceGroup,
    }),
  );
  return {
    id: params.invariant.id,
    category: params.invariant.category,
    ok: missing.length === 0,
    severity: missing.length === 0 ? "info" : "P2",
    objective: params.invariant.objective,
    missing,
    nextAction: params.invariant.nextAction,
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
  const missingFiles = await missingSurfaceFiles([
    ...HEAD_SURFACES,
    ...WORKFLOW_SURFACES,
    ...PROOF_SURFACES,
    ...BOUNDARY_SURFACES,
  ]);
  const lanes = MIND_MODEL_LANES.map((lane) =>
    laneVerdict({ lane, headText, workflowText, proofText, boundaryText }),
  );
  const surfaceText = {
    head: headText,
    workflow: workflowText,
    proof: proofText,
    boundary: boundaryText,
  };
  const invariants = MIND_MODEL_INVARIANTS.map((invariant) =>
    invariantVerdict({ invariant, surfaceText }),
  );
  const failed = lanes.filter((lane) => !lane.ok);
  const failedInvariants = invariants.filter((invariant) => !invariant.ok);
  const result = {
    ok: failed.length === 0 && failedInvariants.length === 0 && missingFiles.length === 0,
    boundary: "dev_mind_model_only",
    checkedAt: new Date().toISOString(),
    summary: {
      passed: lanes.length - failed.length + invariants.length - failedInvariants.length,
      failed: failed.length + failedInvariants.length,
      total: lanes.length + invariants.length,
      laneTotal: lanes.length,
      invariantTotal: invariants.length,
      masterLanes: [...new Set(lanes.map((lane) => lane.masterLane))].toSorted(),
      invariantCategories: [
        ...new Set(invariants.map((invariant) => invariant.category)),
      ].toSorted(),
    },
    lanes,
    invariants,
    missingSurfaceFiles: missingFiles,
    actionableFailures: [
      ...missingFiles.map((file) => `surface_missing: ${file}`),
      ...failed.map(
        (lane) =>
          `${lane.id}: missing ${lane.missing.map((entry) => `${entry.surface}:${entry.term}`).join(", ")}`,
      ),
      ...failedInvariants.map(
        (invariant) =>
          `${invariant.id}: missing ${invariant.missing.map((entry) => `${entry.surface}:${entry.term}`).join(", ")}`,
      ),
    ],
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
          `passed=${result.summary.passed} failed=${result.summary.failed} total=${result.summary.total} invariants=${result.summary.invariantTotal}`,
          ...failed.map((lane) => `- ${lane.id}: ${lane.nextAction}`),
          ...failedInvariants.map((invariant) => `- ${invariant.id}: ${invariant.nextAction}`),
        ].join("\n") + "\n",
  );
  process.exitCode = result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
