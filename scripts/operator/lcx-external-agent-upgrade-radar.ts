import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type CandidateId =
  | "skillopt_v2_autoskill_coach"
  | "agent_lightning_trace_credit"
  | "longmemeval_agentrunbook_memory_regression"
  | "local_first_memory_provenance"
  | "lightweight_memory_comparison"
  | "agent_trace_observability"
  | "secure_tool_skill_permission_layer"
  | "clawbench_real_task_regression"
  | "computer_use_cli_bridge"
  | "github_cli_agentic_workflow_control"
  | "multi_agent_framework_orchestration_guardrails"
  | "prediction_market_research_intake"
  | "prediction_market_strategy_audit";

type AdoptionMode =
  | "skill_lifecycle_probe"
  | "trace_export_probe"
  | "memory_regression_probe"
  | "memory_provenance_probe"
  | "memory_comparison_probe"
  | "agent_trace_probe"
  | "secure_tool_permission_probe"
  | "real_task_benchmark_probe"
  | "computer_use_cli_probe"
  | "github_cli_agentic_workflow_probe"
  | "multi_agent_orchestration_probe"
  | "prediction_market_research_probe"
  | "strategy_audit_probe";

type ExternalUpgradeCandidate = {
  id: CandidateId;
  label: string;
  sourceUrls: string[];
  sourceKind: "paper" | "github" | "paper_and_github" | "docs_product_and_paper";
  claimedCapability: string;
  adoptionMode: AdoptionMode;
  existingOwner: string;
  ownerEntrypoint: string;
  ownerUseTrigger: string;
  autocueTerms: string[];
  distilledPattern: string;
  firstLocalProbe: string;
  requiredReceipts: string[];
  requiredFilters: string[];
  riskBoundaries: string[];
  liveBoundary: string;
};

type SourceReceiptKey = "freshness" | "version" | "license_scope" | "actual_reading_scope";

type SourceEvidenceContract = {
  registration: "static";
  status: "static_registration_only";
  receipts: Record<
    SourceReceiptKey,
    {
      status: "missing" | "verified";
      receiptId: string;
    }
  >;
};

type CandidateVerdict = ExternalUpgradeCandidate & {
  status: "local_architecture_integrated";
  runtimeAuthority: "not_granted";
  missing: string[];
  blockedDirectAdoption: boolean;
  sourceEvidence: SourceEvidenceContract;
};

type BlacktechMechanismId =
  | "skillopt_v2_lifecycle"
  | "real_runtime_battery"
  | "unified_trajectory_schema"
  | "local_first_memory_provenance"
  | "agent_trace_observability"
  | "secure_tool_skill_permission_layer"
  | "github_cli_agentic_control_plane";

type BlacktechMechanism = {
  id: BlacktechMechanismId;
  priority: number;
  label: string;
  sourceCandidates: CandidateId[];
  ownerEntrypoint: string;
  automaticTrigger: string;
  ownerGate: string;
  autopilotSurface: string;
  doctrineTerms: string[];
  currentStatus: "owner_wired_local_only" | "partially_wired_local_only";
  nextSafeLocalProbe: string;
  nextAutomationAction: string;
  blockedUntilIdle?: string;
  requiredProofChain: string[];
  forbiddenAuthorities: string[];
  liveBoundary: string;
};

type BlacktechVerdict = BlacktechMechanism & {
  runtimeAuthority: "not_granted";
  liveReady: false;
  modelWeightAbsorbed: false;
  missing: string[];
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
    id: "skillopt_v2_autoskill_coach",
    label: "AutoSkill / Skills-Coach",
    sourceUrls: ["https://arxiv.org/abs/2603.01145", "https://huggingface.co/papers/2604.27488"],
    sourceKind: "paper",
    claimedCapability:
      "derive reusable skills from interaction traces, generate variants, optimize skills, compare execution, and evaluate traceably",
    adoptionMode: "skill_lifecycle_probe",
    existingOwner: "SkillOpt-lite, failure curriculum, and local-brain promotion truth",
    ownerEntrypoint: "scripts/operator/lcx-skillopt-lite.ts",
    ownerUseTrigger:
      "When a future task asks for SkillOpt v2, AutoSkill, Skills-Coach, self-evolving skills, or SOP expansion, route through lcx-skillopt-lite and keep preflight, eval, train-slice, promotion, and external-channel proof separate.",
    autocueTerms: [
      "SkillOpt v2",
      "AutoSkill",
      "Skills-Coach",
      "self-evolving skills",
      "SOP expansion",
    ],
    distilledPattern:
      "turn real mistakes into skill packets with variant tasks, static gates, targeted eval, regression eval, train-slice evidence, clean promotion truth, and live preflight cue",
    firstLocalProbe:
      "extend one existing SkillOpt packet with generated adjacent validation cases and compare original versus optimized SOP before any training claim",
    requiredReceipts: [
      "lcx-skillopt-lite",
      "local-brain-distill-eval",
      "local-brain-training-plan",
      "local-brain-promotion-audit",
      "skillopt-autocue",
    ],
    requiredFilters: [
      "targeted_eval_required",
      "regression_eval_required",
      "train_slice_evidence_required",
      "promotion_ready_required",
      "real_lark_proof_required",
    ],
    riskBoundaries: [
      "local_skillopt_lite_only",
      "skillopt_preflight_not_weight_absorption",
      "no_provider_config_change",
      "no_external_channel_sender_change",
      "protected_memory_guard",
      "no_direct_training_start",
    ],
    liveBoundary:
      "SkillOpt SOPs may cue the live/local reply planner only after source sync; model-weight absorption and user-visible-observed still require separate owner proof",
  },
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
    ownerEntrypoint: "scripts/operator/lcx-problem-cluster-radar.ts",
    ownerUseTrigger:
      "When a future task asks to learn from Agent Lightning, first run lcx-external-agent-upgrade-radar, then let problem-cluster radar own trace/credit-assignment probes.",
    autocueTerms: ["Agent Lightning", "trace credit", "credit assignment", "agent RL"],
    distilledPattern:
      "export LCX receipts and failure clusters as trace rows for offline credit assignment; never replace Qwen promotion truth",
    firstLocalProbe:
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
      "no_external_channel_sender_change",
      "no_direct_training_start",
    ],
    liveBoundary:
      "external channel can surface the dev radar result after migration, but no external-channel model behavior is changed by this radar alone",
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
    ownerEntrypoint: "scripts/operator/lcx-context-recovery-exam.ts",
    ownerUseTrigger:
      "When a future task asks for LongMemEval, AgentRunbook, stale snapshot, or long-memory regression, route through context recovery before changing memory.",
    autocueTerms: ["LongMemEval", "AgentRunbook", "long memory eval", "stale snapshot"],
    distilledPattern:
      "turn LCX handoff, operator latest, module-learning, and external-channel-boundary facts into regression questions for future compressed windows",
    firstLocalProbe:
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
      "no_external_channel_sender_change",
    ],
    liveBoundary:
      "external channel can use the same prompt doctrine after migration, but memory regression proof remains local-only until a real Lark prompt uses it",
  },
  {
    id: "local_first_memory_provenance",
    label: "MemX / ground-truth-preserving memory",
    sourceUrls: ["https://arxiv.org/abs/2603.16171", "https://arxiv.org/abs/2604.04853"],
    sourceKind: "paper",
    claimedCapability:
      "local-first, explainable, provenance-aware memory retrieval with conservative miss handling and conflict preservation",
    adoptionMode: "memory_provenance_probe",
    existingOwner: "source registry, memory sedimentation, and context recovery",
    ownerEntrypoint: "scripts/operator/lcx-learning-sedimentation-audit.ts",
    ownerUseTrigger:
      "When a future task asks for MemX, memory provenance, explainable retrieval, stale-rule downranking, or ground-truth-preserving memory, route through source registry and memory sedimentation owners before changing storage.",
    autocueTerms: [
      "MemX",
      "memory provenance",
      "explainable retrieval",
      "ground-truth memory",
      "stale rule downrank",
    ],
    distilledPattern:
      "attach source, timestamp, conflict state, applicability scope, and keep/downrank/discard decision to memory recall instead of trusting extracted summaries",
    firstLocalProbe:
      "take one stale finance rule and produce a provenance packet with source, scope, conflict, downrank decision, and adjacent eval requirement",
    requiredReceipts: [
      "source_registry",
      "lcx-learning-sedimentation-audit",
      "lcx-system-memory-sedimentation-gate",
      "lcx-context-recovery-exam",
    ],
    requiredFilters: [
      "source_timestamp_required",
      "conflict_preservation_required",
      "stale_memory_downrank_required",
      "stored_only_is_not_learning",
      "protected_memory_guard",
    ],
    riskBoundaries: [
      "no_new_memory_daemon_by_default",
      "no_protected_memory_write",
      "no_storage_only_learning_claim",
      "no_provider_config_change",
      "no_external_channel_sender_change",
    ],
    liveBoundary:
      "Live may use provenance wording only after sync; this radar does not mutate protected memory or claim learned memory",
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
    ownerEntrypoint: "scripts/operator/lcx-learning-sedimentation-audit.ts",
    ownerUseTrigger:
      "When a future task asks for LightMem, LycheeMemory, compact memory, or cheaper memory, audit current sedimentation before adding storage.",
    autocueTerms: ["LightMem", "LycheeMemory", "compact memory", "memory comparison"],
    distilledPattern:
      "compare compact-memory ideas against LCX source/retrieval/apply/eval receipts without replacing protected summaries",
    firstLocalProbe:
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
      "no_external_channel_sender_change",
    ],
    liveBoundary:
      "external-channel prompt can mention the boundary after sync; no external memory daemon is enabled or trusted by this change",
  },
  {
    id: "agent_trace_observability",
    label: "OpenTelemetry GenAI / AgentSight",
    sourceUrls: [
      "https://opentelemetry.io/docs/specs/semconv/gen-ai/",
      "https://arxiv.org/abs/2508.02736",
    ],
    sourceKind: "paper_and_github",
    claimedCapability:
      "connect agent decisions, model calls, tool calls, PIDs, file side effects, errors, and security-relevant behavior into traceable spans",
    adoptionMode: "agent_trace_probe",
    existingOwner: "governance autopilot, universe index, and problem-cluster radar",
    ownerEntrypoint: "scripts/operator/lcx-governance-autopilot.ts",
    ownerUseTrigger:
      "When a future task asks for OpenTelemetry, AgentSight, trace spans, side-effect attribution, or agent observability, add lightweight LCX trace receipts first and avoid eBPF or network interception by default.",
    autocueTerms: [
      "OpenTelemetry",
      "AgentSight",
      "agent trace",
      "side-effect attribution",
      "observability",
    ],
    distilledPattern:
      "normalize owner command, model call, tool call, process, file write, artifact, and boundary events into a local trace receipt for later failure attribution",
    firstLocalProbe:
      "emit one local owner-run trace row from governance autopilot linking owner id, command, exit code, parsed status, boundary, and artifact path",
    requiredReceipts: [
      "lcx-governance-autopilot",
      "lcx-universe-index",
      "lcx-problem-cluster-radar",
      "agent_trace_receipt",
    ],
    requiredFilters: [
      "local_trace_only",
      "no_tls_interception_by_default",
      "side_effect_boundary_required",
      "single_owner_required",
    ],
    riskBoundaries: [
      "no_ebpf_or_tls_interception_without_explicit_approval",
      "no_provider_config_change",
      "no_external_channel_sender_change",
      "protected_memory_guard",
    ],
    liveBoundary:
      "Live trace summaries require explicit migration and redaction; dev trace receipts alone are not user-visible proof",
  },
  {
    id: "secure_tool_skill_permission_layer",
    label: "OWASP Agentic Top 10 / SMCP",
    sourceUrls: [
      "https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/",
      "https://arxiv.org/abs/2602.01129",
    ],
    sourceKind: "paper_and_github",
    claimedCapability:
      "agent security controls for tool poisoning, prompt injection, privilege escalation, authentication, policy enforcement, and audit logging",
    adoptionMode: "secure_tool_permission_probe",
    existingOwner: "skill harvester, CLI-Anything harvester, and security threat model",
    ownerEntrypoint: "/Users/liuchengxu/.codex/skills/security-threat-model/SKILL.md",
    ownerUseTrigger:
      "When a future task asks to add tools, MCP servers, CLI wrappers, desktop control, external skills, or agent permissions, run security ownership/threat-model checks before granting authority.",
    autocueTerms: [
      "OWASP Agentic",
      "SMCP",
      "secure MCP",
      "tool poisoning",
      "agent permission",
      "prompt injection",
    ],
    distilledPattern:
      "treat every new tool or skill as untrusted until it has identity, allowlist, least privilege, audit log, uninstall path, and owner boundary",
    firstLocalProbe:
      "score one proposed CLI wrapper or MCP server against tool allowlist, write scope, credential scope, prompt-injection risk, audit log, and uninstall path",
    requiredReceipts: [
      "security-threat-model",
      "security-ownership-map",
      "skill-harvester",
      "cli-anything-harvester",
      "agent_permission_audit",
    ],
    requiredFilters: [
      "tool_allowlist_required",
      "least_privilege_required",
      "credential_scope_required",
      "audit_log_required",
      "uninstall_path_required",
    ],
    riskBoundaries: [
      "no_untrusted_tool_authority",
      "no_global_install",
      "no_provider_config_change",
      "no_external_channel_sender_change",
      "protected_memory_guard",
    ],
    liveBoundary:
      "Live can only use a new tool after security receipts, source sync, and explicit external-channel migration; this radar grants no authority",
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
    ownerEntrypoint: "scripts/operator/lcx-commercial-acceptance-harness.ts",
    ownerUseTrigger:
      "When a future task asks for ClawBench, WildClawBench, or real-task agent benchmarks, convert it into commercial canaries instead of leaderboard code.",
    autocueTerms: ["ClawBench", "WildClawBench", "real task benchmark", "agent benchmark"],
    distilledPattern:
      "convert real task categories into LCX canaries with natural owner prompts, internal route traces, optional acceptance anchors, visible reply checks, and bounded failure reports",
    firstLocalProbe:
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
      "local_ready_not_live_user_seen",
      "protected_memory_guard",
      "no_provider_config_change",
      "no_external_channel_sender_change",
    ],
    liveBoundary:
      "commercial canary is user-visible only after migration plus fresh Lark inbound and matching reply evidence",
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
    ownerUseTrigger:
      "When a future task asks for Agent S, CLI-Anything, CLI-Hub, or desktop software CLI wrappers, use cli-anything-harvester before any wrapper is trusted.",
    autocueTerms: ["Agent S", "CLI-Anything", "CLI-Hub", "desktop control"],
    distilledPattern:
      "prefer stable local CLI or official automation first; only distill a wrapper after JSON contract, proof command, and uninstall path exist",
    firstLocalProbe:
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
      "no_external_channel_sender_change",
    ],
    liveBoundary:
      "external-channel agent may autocue the harvester skill after sync; no desktop-control authority is granted without a concrete tested wrapper",
  },
  {
    id: "github_cli_agentic_workflow_control",
    label: "GitHub CLI / GitHub Agentic Workflows",
    sourceUrls: [
      "https://cli.github.com/manual/gh_extension",
      "https://github.github.io/gh-aw/reference/gh-aw-as-mcp-server/",
      "https://github.com/github/github-mcp-server",
      "https://github.com/features/copilot/cli",
    ],
    sourceKind: "docs_product_and_paper",
    claimedCapability:
      "turn GitHub issues, pull requests, MCP tools, Copilot CLI, and gh extensions into an agent-facing control plane",
    adoptionMode: "github_cli_agentic_workflow_probe",
    existingOwner:
      "GitHub CLI wrapper planning, CLI-Anything harvester, and secure tool permission layer",
    ownerEntrypoint: "/Users/liuchengxu/.codex/skills/cli-anything-harvester/SKILL.md",
    ownerUseTrigger:
      "When a future task asks where GitHub CLI lives, asks to use gh, Copilot CLI, gh-aw, GitHub MCP, gh extensions, PR agents, issue agents, or GitHub agent workflow automation, first classify the command as read-only discovery, local-only wrapper, remote write, or agent delegation before any execution.",
    autocueTerms: [
      "GitHub CLI",
      "gh cli",
      "gh extension",
      "gh-aw",
      "GitHub Agentic Workflows",
      "GitHub MCP",
      "Copilot CLI",
      "PR agent",
      "issue agent",
    ],
    distilledPattern:
      "use gh as a transparent operator console: read-only repo/issue/PR discovery first, then JSON wrapper contract, permission scope review, dry-run receipt, and explicit owner approval before remote writes or agent delegation",
    firstLocalProbe:
      "run a read-only gh capability inventory that reports gh version, auth scope status, installed extensions, repo identity, and which commands would be remote-write blocked",
    requiredReceipts: [
      "cli-anything-harvester",
      "security-threat-model",
      "github_cli_capability_inventory",
      "agent_permission_audit",
      "owner_control_map",
    ],
    requiredFilters: [
      "read_only_discovery_first",
      "remote_write_requires_owner_approval",
      "credential_scope_required",
      "repo_scope_required",
      "dry_run_receipt_required",
      "human_review_before_agent_delegation",
    ],
    riskBoundaries: [
      "no_gh_remote_write_by_default",
      "no_issue_or_pr_mutation_without_owner_command",
      "no_copilot_agent_assignment_without_owner_command",
      "no_mcp_server_install_without_security_receipt",
      "no_provider_config_change",
      "no_external_channel_sender_change",
      "protected_memory_guard",
    ],
    liveBoundary:
      "GitHub CLI may become an operator-side control panel after wrapper tests and permission receipts, but it never becomes live Lark, provider, protected-memory, or trading authority by default",
  },
  {
    id: "multi_agent_framework_orchestration_guardrails",
    label: "LangGraph / OpenAI Agents / CrewAI / Microsoft Agent Framework",
    sourceUrls: [
      "https://docs.langchain.com/oss/python/langchain/multi-agent",
      "https://openai.github.io/openai-agents-python/handoffs/",
      "https://docs.crewai.com/introduction",
      "https://learn.microsoft.com/agent-framework/overview/agent-framework-overview",
    ],
    sourceKind: "docs_product_and_paper",
    claimedCapability:
      "multi-agent routing, supervisor, handoff, and role-orchestration patterns for complex workflows",
    adoptionMode: "multi_agent_orchestration_probe",
    existingOwner: "flow graph, commercial answer pipeline, and problem-cluster radar",
    ownerEntrypoint: "scripts/operator/lcx-flow-graph.ts",
    ownerUseTrigger:
      "When a future task asks for LangGraph, OpenAI Agents handoffs, CrewAI crews, Microsoft Agent Framework, supervisor routing, or multi-agent orchestration, map the pattern through flow graph and existing owners before adding agents.",
    autocueTerms: [
      "LangGraph",
      "OpenAI Agents handoffs",
      "CrewAI",
      "Microsoft Agent Framework",
      "multi-agent",
      "supervisor routing",
    ],
    distilledPattern:
      "use specialist roles and handoffs only as workflow structure while keeping volatile truth in one owner per state family",
    firstLocalProbe:
      "classify one LCX workflow into supervisor, handoff, worker, owner-truth, and terminal-decision nodes without changing runtime",
    requiredReceipts: [
      "lcx-flow-graph",
      "lcx-commercial-answer-pipeline",
      "lcx-problem-cluster-radar",
      "skill_pattern_distillation",
    ],
    requiredFilters: [
      "single_owner_required",
      "terminal_decision_required",
      "bounded_answer_review",
      "no_provider_config_change",
      "no_external_channel_sender_change",
    ],
    riskBoundaries: [
      "no_parallel_agent_framework",
      "no_hidden_tool_authority",
      "no_provider_config_change",
      "no_external_channel_sender_change",
      "protected_memory_guard",
    ],
    liveBoundary:
      "external channel can benefit from clearer role routing only after local owner checks and migration; this radar grants no external-channel agent framework authority",
  },
  {
    id: "prediction_market_research_intake",
    label: "Polymarket research intake tools",
    sourceUrls: [
      "https://docs.polymarket.com/api-reference",
      "https://docs.polymarket.com/developers/CLOB/clients/%3Aslug%2A",
      "https://polyclaw.cloud/",
      "https://www.forezai.com/",
      "https://polymark.et/product/polyseer",
    ],
    sourceKind: "docs_product_and_paper",
    claimedCapability:
      "prediction-market topic, resolution criteria, close date, liquidity, orderbook, and evidence intake for research",
    adoptionMode: "prediction_market_research_probe",
    existingOwner: "finance data gateway, source registry, and data provenance review",
    ownerEntrypoint: "src/agents/finance-data-gateway.ts",
    ownerUseTrigger:
      "When a future task mentions Polymarket, PolyClaw, Polybot, Polyseer, prediction markets, CLOB, orderbooks, or market probabilities, route it through research-only finance data provenance before any conclusion.",
    autocueTerms: [
      "Polymarket",
      "PolyClaw",
      "Polybot",
      "Polyseer",
      "prediction market",
      "CLOB",
      "orderbook",
    ],
    distilledPattern:
      "treat prediction markets as weak but useful research sources requiring a real market metadata packet, resolution criteria, timestamp, liquidity, source evidence, ambiguous-resolution review, thin-liquidity downranking, and counterevidence",
    firstLocalProbe:
      "create a paper-only prediction-market research packet with market metadata, source timestamps, resolution ambiguity review, thin-liquidity downrank decision, liquidity caveats, and no execution authority",
    requiredReceipts: [
      "source_registry",
      "finance-data-gateway",
      "data_provenance_quality",
      "review_panel",
      "control_room_summary",
    ],
    requiredFilters: [
      "research_only_boundary",
      "no_trade_advice",
      "fresh_timestamp_required",
      "field_definition_required",
      "market_microstructure_warning_required",
      "thin_liquidity_downrank_required",
      "ambiguous_resolution_blocks_conclusion",
      "no_wallet_or_order_execution",
    ],
    riskBoundaries: [
      "research_only",
      "no_wallet_connection",
      "no_order_placement",
      "no_copy_trading",
      "no_latency_arbitrage",
      "market_probability_not_forecast",
      "no_provider_config_change",
      "no_external_channel_sender_change",
    ],
    liveBoundary:
      "external channel may summarize research packets after migration, but no wallet, order, private-key, or trading action is enabled",
  },
  {
    id: "prediction_market_strategy_audit",
    label: "PolyBench / PolySwarm prediction-market strategy audit",
    sourceUrls: ["https://arxiv.org/abs/2604.14199", "https://arxiv.org/abs/2604.03888"],
    sourceKind: "paper",
    claimedCapability:
      "prediction-market benchmark, multi-agent debate, strategy simulation, and calibration patterns",
    adoptionMode: "strategy_audit_probe",
    existingOwner: "commercial acceptance harness, eval harness design, and review panel",
    ownerEntrypoint: "scripts/operator/lcx-commercial-acceptance-harness.ts",
    ownerUseTrigger:
      "When a future task asks for Polymarket strategy, PolyBench, PolySwarm, prediction-market bots, or market-making ideas, keep it paper-only and route to strategy audit, overfit checks, and review.",
    autocueTerms: [
      "PolyBench",
      "PolySwarm",
      "Polymarket strategy",
      "prediction-market bot",
      "market-making",
      "paper trading",
    ],
    distilledPattern:
      "audit strategies with calibration, slippage, liquidity, resolution-risk, sample-out, and failure logs before treating any result as useful research",
    firstLocalProbe:
      "score one paper-only strategy artifact and write a failure log when fees, slippage, sample-out, thin-liquidity, or no-execution compliance is missing",
    requiredReceipts: [
      "source_registry",
      "data_provenance_quality",
      "strategy_experiment_audit",
      "eval_harness_design",
      "review_panel",
    ],
    requiredFilters: [
      "research_only_boundary",
      "no_trade_advice",
      "paper_only_backtest_required",
      "sample_out_validation_required",
      "market_microstructure_warning_required",
      "thin_liquidity_downrank_required",
      "ambiguous_resolution_blocks_conclusion",
      "fees_slippage_and_sample_out_required",
      "no_wallet_or_order_execution",
    ],
    riskBoundaries: [
      "research_only",
      "no_wallet_connection",
      "no_order_placement",
      "no_copy_trading",
      "no_latency_arbitrage",
      "market_probability_not_forecast",
      "no_provider_config_change",
      "no_external_channel_sender_change",
    ],
    liveBoundary:
      "strategy audit can only become a visible research summary after review; it must never execute, size, copy, or route orders",
  },
];

const BLACKTECH_MECHANISMS: BlacktechMechanism[] = [
  {
    id: "skillopt_v2_lifecycle",
    priority: 1,
    label: "SkillOpt v2 lifecycle",
    sourceCandidates: ["skillopt_v2_autoskill_coach"],
    ownerEntrypoint: "scripts/operator/lcx-skillopt-lite.ts",
    automaticTrigger:
      "When user feedback, failed cases, repeated wrong answers, or SkillOpt/AutoSkill/Skills-Coach wording appears, governance autopilot reads SkillOpt-lite before any eval or training action.",
    ownerGate:
      "active eval/MLX must be idle before targeted eval, train-slice rebuild, adapter promotion, or external-channel binding; preflight cue stays local-only while busy",
    autopilotSurface:
      "lcx-governance-autopilot owners.skillOptLite plus owners.externalAgentUpgrade.nextBlacktechProbes",
    doctrineTerms: [
      "real mistakes become skills",
      "variant tasks",
      "compare original versus optimized SOP",
      "targeted eval",
      "train-slice",
      "external-channel preflight cue",
    ],
    currentStatus: "partially_wired_local_only",
    nextSafeLocalProbe:
      "extend one accepted SkillOpt packet with generated adjacent validation cases, comparative execution, and a traceable eval receipt",
    nextAutomationAction:
      "autopilot should surface the exact SkillOpt nextIdleCommand, then run at most that one command only after active eval/MLX is idle and owner gates are clean",
    blockedUntilIdle:
      "targeted eval, train-slice, adapter promotion, and external-channel binding must wait until eval/MLX is idle",
    requiredProofChain: [
      "accepted_skillopt_candidate",
      "generated_variant_tasks",
      "original_vs_optimized_sop_comparison",
      "targeted_eval_clean",
      "regression_eval_clean",
      "train_slice_contains_skillopt_evidence",
      "new_adapter_hardened_eval_clean",
      "promotionReady_true_without_failed_or_parseRecovered",
      "live_preflight_cue_source_synced",
      "fresh_real_lark_inbound_and_outbound_seen",
    ],
    forbiddenAuthorities: [
      "model_weight_absorption_claim_without_training",
      "live_visible_fixed_claim_without_lark_proof",
      "provider_config_change",
      "protected_memory_write",
      "direct_trading_authority",
    ],
    liveBoundary:
      "Immediate SkillOpt preflight can improve planning, but learned capability and external-channel usage require separate promotion and live-proof owners.",
  },
  {
    id: "real_runtime_battery",
    priority: 2,
    label: "Native-runtime long-task battery",
    sourceCandidates: ["clawbench_real_task_regression"],
    ownerEntrypoint: "scripts/operator/lcx-commercial-acceptance-harness.ts",
    automaticTrigger:
      "When a task claims product-grade, user-visible, long-horizon, runtime, or commercial acceptance readiness, autopilot includes the commercial acceptance harness.",
    ownerGate:
      "canary tasks may inspect dev/runtime state, but cannot create user-visible-observed, install untrusted tasks, or mutate provider/external-channel/protected surfaces",
    autopilotSurface:
      "lcx-governance-autopilot owners.commercialAcceptance and context handoff commercial gates",
    doctrineTerms: [
      "real CLI/browser/runtime tasks",
      "environment-state grading",
      "long-horizon canaries",
      "visible reply proof",
    ],
    currentStatus: "owner_wired_local_only",
    nextSafeLocalProbe:
      "add one LCX real-runtime canary that grades owner command output, artifact state, visible boundary wording, and no forbidden side effects",
    nextAutomationAction:
      "autopilot should keep runtime canary gaps visible through commercial acceptance and problem radar until a bounded canary fixture and side-effect audit exist",
    requiredProofChain: [
      "task_fixture",
      "deterministic_state_check",
      "semantic_visible_answer_check",
      "side_effect_audit",
      "commercial_acceptance_gate",
      "context_recovery_handoff",
    ],
    forbiddenAuthorities: [
      "leaderboard_driven_runtime_install",
      "untrusted_task_execution",
      "live_user_seen_claim_from_local_canary",
      "provider_config_change",
      "protected_memory_write",
    ],
    liveBoundary:
      "Real-runtime canaries are local proof until a migrated external-channel path sees fresh real inbound and outbound evidence.",
  },
  {
    id: "unified_trajectory_schema",
    priority: 3,
    label: "Unified trajectory schema",
    sourceCandidates: ["agent_lightning_trace_credit", "agent_trace_observability"],
    ownerEntrypoint: "scripts/operator/lcx-governance-autopilot.ts",
    automaticTrigger:
      "Every governance autopilot run already has owner id, command, exit status, parsed compact output, digest material, and artifact paths; future trace export must reuse this surface.",
    ownerGate:
      "trajectory export is offline evidence only and must not start RL, SFT, eval, training, provider calls, or external channel sender changes",
    autopilotSurface:
      "lcx-governance-autopilot receipt, evolution promotion digest, and context recovery handoff",
    doctrineTerms: [
      "owner command trace",
      "credit assignment",
      "tool call and PID linkage",
      "training transition export",
    ],
    currentStatus: "partially_wired_local_only",
    nextSafeLocalProbe:
      "emit one local trajectory receipt that links owner id, command, exit, parsed boundary, changed artifact, and blamed failure cluster",
    nextAutomationAction:
      "autopilot should expose missing trace_schema and failure_cluster_link as local-only next probes instead of inventing a parallel telemetry daemon",
    requiredProofChain: [
      "owner_run_trace",
      "artifact_side_effect_scope",
      "failure_cluster_link",
      "credit_assignment_label",
      "rejected_or_trainable_transition_decision",
      "no_runtime_training_started",
    ],
    forbiddenAuthorities: [
      "runtime_rl_server",
      "direct_training_start",
      "provider_config_change",
      "external_channel_sender_change",
      "protected_memory_write",
    ],
    liveBoundary:
      "Trajectory export is offline dev evidence; external-channel behavior changes only after normal eval, promotion, and external-channel gates.",
  },
  {
    id: "local_first_memory_provenance",
    priority: 4,
    label: "Local-first memory provenance",
    sourceCandidates: [
      "local_first_memory_provenance",
      "longmemeval_agentrunbook_memory_regression",
      "lightweight_memory_comparison",
    ],
    ownerEntrypoint: "scripts/operator/lcx-learning-sedimentation-audit.ts",
    automaticTrigger:
      "When source registry, memory conflict, stale rule, retrieval, downrank, or MemX wording appears, route through sedimentation audit and module-learning review before durable claims.",
    ownerGate:
      "stored source, retrieved memory, or receipt is not model absorption; protected memory remains blocked unless the existing protected-memory owner explicitly permits it",
    autopilotSurface:
      "lcx-governance-autopilot owners.learningSedimentationAudit, moduleLearningAbsorptionGate, contextRecovery",
    doctrineTerms: [
      "source timestamp",
      "conflict preservation",
      "stale memory downrank",
      "keep/downrank/discard",
      "context recovery regression",
    ],
    currentStatus: "partially_wired_local_only",
    nextSafeLocalProbe:
      "produce a provenance packet for one stale finance-memory rule with source, scope, conflict, downrank decision, and adjacent eval case",
    nextAutomationAction:
      "autopilot should report missing source_registry_record, actual_reading_scope, retrieval/apply validation, and keep/downrank/discard proof before any absorption claim",
    requiredProofChain: [
      "source_registry_record",
      "actual_reading_scope",
      "retrieval_receipt",
      "apply_validation",
      "conflict_or_staleness_decision",
      "module_learning_pipeline_review",
      "eval_or_training_absorption_evidence",
    ],
    forbiddenAuthorities: [
      "new_memory_daemon_by_default",
      "protected_memory_write",
      "stored_only_learning_claim",
      "provider_config_change",
      "external_channel_sender_change",
    ],
    liveBoundary:
      "Live may read migrated provenance cues, but protected memory and model absorption stay behind existing proof gates.",
  },
  {
    id: "agent_trace_observability",
    priority: 5,
    label: "Agent trace and side-effect observability",
    sourceCandidates: ["agent_trace_observability"],
    ownerEntrypoint: "scripts/operator/lcx-governance-autopilot.ts",
    automaticTrigger:
      "When a workflow writes state, claims ownership, runs owner commands, or reports blocked/unblocked status, autopilot should preserve command, PID, artifact, and boundary evidence.",
    ownerGate:
      "only redacted local trace receipts are allowed by default; no eBPF, TLS interception, network export, provider config, protected memory, or external channel sender authority",
    autopilotSurface:
      "lcx-governance-autopilot material digest and future redacted local trace receipt",
    doctrineTerms: [
      "agent span",
      "tool span",
      "PID",
      "file side effect",
      "boundary",
      "failure attribution",
    ],
    currentStatus: "partially_wired_local_only",
    nextSafeLocalProbe:
      "write a redacted local trace receipt for one governance autopilot run without eBPF, TLS interception, or extra provider calls",
    nextAutomationAction:
      "autopilot should keep trace observability as a local receipt gap until redaction, artifact scope, and boundary flags pass",
    requiredProofChain: [
      "trace_schema",
      "owner_command_span",
      "artifact_write_span",
      "pid_snapshot",
      "boundary_flags",
      "redaction_check",
    ],
    forbiddenAuthorities: [
      "ebpf_or_tls_interception_without_explicit_approval",
      "network_trace_export_by_default",
      "provider_config_change",
      "protected_memory_write",
      "external_channel_sender_change",
    ],
    liveBoundary:
      "Dev traces may explain operator behavior; live trace summaries require explicit redaction and migration proof.",
  },
  {
    id: "secure_tool_skill_permission_layer",
    priority: 6,
    label: "Secure tool and skill permission layer",
    sourceCandidates: ["secure_tool_skill_permission_layer", "computer_use_cli_bridge"],
    ownerEntrypoint: "/Users/liuchengxu/.codex/skills/security-threat-model/SKILL.md",
    automaticTrigger:
      "When a task proposes a CLI wrapper, MCP server, external skill, browser/desktop bridge, credentialed tool, or install, route through skill-harvester plus security threat-model gates first.",
    ownerGate:
      "untrusted tools need allowlist, write-scope, credential-scope, prompt-injection, audit-log, and uninstall proof before any runtime or live authority",
    autopilotSurface:
      "external agent upgrade radar, skill-harvester boundary, and future security review receipt",
    doctrineTerms: [
      "tool allowlist",
      "least privilege",
      "credential scope",
      "audit log",
      "uninstall path",
      "prompt injection defense",
    ],
    currentStatus: "owner_wired_local_only",
    nextSafeLocalProbe:
      "score one proposed CLI wrapper, MCP server, or external skill through allowlist, write scope, credential scope, audit log, and uninstall path",
    nextAutomationAction:
      "autopilot should block direct adoption and surface the security review owner until the tool permission receipt exists",
    requiredProofChain: [
      "source_license_scope",
      "tool_allowlist_entry",
      "credential_scope_review",
      "write_scope_review",
      "prompt_injection_test",
      "audit_log_receipt",
      "uninstall_path",
    ],
    forbiddenAuthorities: [
      "untrusted_tool_authority",
      "global_install",
      "provider_config_change",
      "protected_memory_write",
      "external_channel_sender_change",
      "wallet_or_order_execution",
    ],
    liveBoundary:
      "No new tool or skill becomes live authority without security receipts, owner mapping, source sync, and explicit migration.",
  },
  {
    id: "github_cli_agentic_control_plane",
    priority: 7,
    label: "GitHub CLI agentic control plane",
    sourceCandidates: ["github_cli_agentic_workflow_control"],
    ownerEntrypoint: "/Users/liuchengxu/.codex/skills/cli-anything-harvester/SKILL.md",
    automaticTrigger:
      "When GitHub CLI, gh extension, GitHub MCP, gh-aw, Copilot CLI, issue agent, PR agent, or remote repo automation wording appears, external upgrade radar routes it to CLI-Anything plus security review before any write-capable command.",
    ownerGate:
      "read-only gh inventory is allowed; remote issue/PR writes, Copilot agent assignment, MCP server install, extension install, token scope expansion, and workflow dispatch require explicit owner command and receipt",
    autopilotSurface:
      "lcx-governance-autopilot owners.externalAgentUpgrade.nextBlacktechProbes plus future github_cli_capability_inventory receipt",
    doctrineTerms: [
      "gh as operator console",
      "read-only discovery first",
      "remote write owner approval",
      "credential scope",
      "extension install review",
      "agent delegation gate",
    ],
    currentStatus: "partially_wired_local_only",
    nextSafeLocalProbe:
      "add a read-only GitHub CLI capability inventory that reports gh version, auth scope status, installed extensions, current repo remote, and blocked remote-write commands",
    nextAutomationAction:
      "autopilot should surface GitHub CLI as an available but gated operator console, then refuse issue/PR mutation or Copilot delegation unless an owner command explicitly unlocks that lane",
    requiredProofChain: [
      "gh_version_detected",
      "auth_scope_inventory",
      "repo_scope_inventory",
      "installed_extension_inventory",
      "remote_write_blocklist",
      "dry_run_receipt",
      "owner_approval_for_remote_write",
    ],
    forbiddenAuthorities: [
      "gh_issue_or_pr_write_without_owner_command",
      "copilot_agent_assignment_without_owner_command",
      "mcp_server_install_without_security_receipt",
      "token_scope_expansion",
      "provider_config_change",
      "protected_memory_write",
      "external_channel_sender_change",
    ],
    liveBoundary:
      "GitHub CLI control-plane proof is dev/operator-only; it cannot prove user-visible-observed or grant remote repository write authority by itself.",
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
  if (!candidate.ownerUseTrigger) {
    missing.push("owner_use_trigger");
  }
  if (candidate.autocueTerms.length === 0) {
    missing.push("autocue_terms");
  }
  if (!candidate.distilledPattern) {
    missing.push("distilled_pattern");
  }
  if (!candidate.firstLocalProbe) {
    missing.push("first_local_probe");
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

function staticSourceEvidence(): SourceEvidenceContract {
  return {
    registration: "static",
    status: "static_registration_only",
    receipts: {
      freshness: { status: "missing", receiptId: "source_freshness_receipt" },
      version: { status: "missing", receiptId: "source_version_receipt" },
      license_scope: { status: "missing", receiptId: "source_license_scope_receipt" },
      actual_reading_scope: {
        status: "missing",
        receiptId: "actual_reading_scope_receipt",
      },
    },
  };
}

function candidateVerdicts(): CandidateVerdict[] {
  return CANDIDATES.map((candidate) => ({
    ...candidate,
    status: "local_architecture_integrated",
    runtimeAuthority: "not_granted",
    missing: missingFor(candidate),
    blockedDirectAdoption: true,
    sourceEvidence: staticSourceEvidence(),
  }));
}

function blacktechMissingFor(mechanism: BlacktechMechanism): string[] {
  const missing: string[] = [];
  if (mechanism.sourceCandidates.length === 0) {
    missing.push("source_candidates");
  }
  if (!mechanism.ownerEntrypoint) {
    missing.push("owner_entrypoint");
  }
  if (!mechanism.automaticTrigger) {
    missing.push("automatic_trigger");
  }
  if (!mechanism.ownerGate) {
    missing.push("owner_gate");
  }
  if (!mechanism.autopilotSurface) {
    missing.push("autopilot_surface");
  }
  if (mechanism.doctrineTerms.length === 0) {
    missing.push("doctrine_terms");
  }
  if (!mechanism.nextSafeLocalProbe) {
    missing.push("next_safe_local_probe");
  }
  if (!mechanism.nextAutomationAction) {
    missing.push("next_automation_action");
  }
  if (mechanism.requiredProofChain.length === 0) {
    missing.push("required_proof_chain");
  }
  if (mechanism.forbiddenAuthorities.length === 0) {
    missing.push("forbidden_authorities");
  }
  if (!mechanism.liveBoundary) {
    missing.push("live_boundary");
  }
  return missing;
}

function blacktechVerdicts(): BlacktechVerdict[] {
  return BLACKTECH_MECHANISMS.map((mechanism) => ({
    ...mechanism,
    runtimeAuthority: "not_granted",
    liveReady: false,
    modelWeightAbsorbed: false,
    missing: blacktechMissingFor(mechanism),
  }));
}

function buildChecks(verdicts: readonly CandidateVerdict[]): RadarCheck[] {
  const ids = new Set(verdicts.map((candidate) => candidate.id));
  const expectedIds: CandidateId[] = [
    "skillopt_v2_autoskill_coach",
    "agent_lightning_trace_credit",
    "longmemeval_agentrunbook_memory_regression",
    "local_first_memory_provenance",
    "lightweight_memory_comparison",
    "agent_trace_observability",
    "secure_tool_skill_permission_layer",
    "clawbench_real_task_regression",
    "computer_use_cli_bridge",
    "github_cli_agentic_workflow_control",
    "multi_agent_framework_orchestration_guardrails",
    "prediction_market_research_intake",
    "prediction_market_strategy_audit",
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
  const missingUseTriggers = verdicts.filter(
    (candidate) => !candidate.ownerUseTrigger || candidate.autocueTerms.length === 0,
  );
  const sourceEvidenceGaps = verdicts.flatMap((candidate) =>
    Object.entries(candidate.sourceEvidence.receipts)
      .filter(([, receipt]) => receipt.status !== "verified")
      .map(([kind, receipt]) => `${candidate.id}:${kind}:${receipt.receiptId}`),
  );
  const sourceEvidenceStateErrors = verdicts
    .filter(
      (candidate) =>
        candidate.sourceEvidence.registration !== "static" ||
        candidate.sourceEvidence.status !== "static_registration_only",
    )
    .map((candidate) => candidate.id);
  return [
    {
      id: "expected_external_candidates_registered",
      ok: verdicts.length === expectedIds.length && missingExpected.length === 0,
      summary: "all expected external upgrade candidates are registered",
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
      id: "automatic_use_triggers_present",
      ok: missingUseTriggers.length === 0,
      summary:
        "each external project has explicit autocue terms and an owner-use trigger for future agents",
      evidence: verdicts.map((candidate) => ({
        id: candidate.id,
        autocueTerms: candidate.autocueTerms,
        ownerUseTrigger: candidate.ownerUseTrigger,
      })),
    },
    {
      id: "source_registration_and_receipt_state_explicit",
      ok: sourceEvidenceStateErrors.length === 0,
      summary:
        "source URLs are static registrations; freshness, version, license scope, and actual reading scope remain separate receipt gates",
      evidence: {
        sourceEvidenceStateErrors,
        sourceReceiptKinds: ["freshness", "version", "license_scope", "actual_reading_scope"],
      },
    },
    {
      id: "source_receipts_not_claimed_verified",
      ok: sourceEvidenceGaps.length === verdicts.length * 4,
      summary:
        "the radar does not claim source freshness, version, license scope, or reading scope without receipts",
      evidence: {
        missingReceiptCount: sourceEvidenceGaps.length,
        expectedMissingReceiptCount: verdicts.length * 4,
        missingReceipts: sourceEvidenceGaps,
      },
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

function buildBlacktechChecks(
  mechanisms: readonly BlacktechVerdict[],
  candidateVerdicts: readonly CandidateVerdict[],
): RadarCheck[] {
  const mechanismIds = new Set(mechanisms.map((mechanism) => mechanism.id));
  const candidateIds = new Set(candidateVerdicts.map((candidate) => candidate.id));
  const expectedIds: BlacktechMechanismId[] = [
    "skillopt_v2_lifecycle",
    "real_runtime_battery",
    "unified_trajectory_schema",
    "local_first_memory_provenance",
    "agent_trace_observability",
    "secure_tool_skill_permission_layer",
    "github_cli_agentic_control_plane",
  ];
  const missingExpected = expectedIds.filter((id) => !mechanismIds.has(id));
  const missingFields = mechanisms.flatMap((mechanism) =>
    mechanism.missing.map((field) => `${mechanism.id}:${field}`),
  );
  const missingSourceCandidates = mechanisms.flatMap((mechanism) =>
    mechanism.sourceCandidates
      .filter((candidateId) => !candidateIds.has(candidateId))
      .map((candidateId) => `${mechanism.id}:${candidateId}`),
  );
  const unsafeAuthority = mechanisms.filter(
    (mechanism) =>
      mechanism.runtimeAuthority !== "not_granted" ||
      mechanism.liveReady ||
      mechanism.modelWeightAbsorbed,
  );
  const missingAutomationContract = mechanisms.filter(
    (mechanism) =>
      !mechanism.automaticTrigger ||
      !mechanism.ownerGate ||
      !mechanism.autopilotSurface ||
      !mechanism.nextAutomationAction,
  );
  return [
    {
      id: "expected_blacktech_mechanisms_registered",
      ok: mechanisms.length === expectedIds.length && missingExpected.length === 0,
      summary: "the prioritized blacktech mechanisms are registered",
      evidence: { count: mechanisms.length, missingExpected },
    },
    {
      id: "blacktech_sources_map_to_candidates",
      ok: missingSourceCandidates.length === 0,
      summary: "every blacktech mechanism maps back to registered source candidates",
      evidence: { missingSourceCandidates },
    },
    {
      id: "blacktech_owner_and_proof_contract_complete",
      ok: missingFields.length === 0,
      summary:
        "each blacktech mechanism has owner, doctrine, probe, proof, boundary, and forbidden authority fields",
      evidence: { missingFields },
    },
    {
      id: "blacktech_runtime_authority_blocked",
      ok: unsafeAuthority.length === 0,
      summary:
        "blacktech mechanisms are architecture intake only, not runtime/live/model-weight authority",
      evidence: unsafeAuthority.map((mechanism) => mechanism.id),
    },
    {
      id: "blacktech_autopilot_contract_complete",
      ok: missingAutomationContract.length === 0,
      summary:
        "each blacktech mechanism has automatic trigger, owner gate, autopilot surface, and next automation action",
      evidence: missingAutomationContract.map((mechanism) => mechanism.id),
    },
  ];
}

export function buildExternalAgentUpgradeRadar() {
  const candidates = candidateVerdicts();
  const blacktechMechanisms = blacktechVerdicts();
  const checks = [
    ...buildChecks(candidates),
    ...buildBlacktechChecks(blacktechMechanisms, candidates),
  ];
  const failed = checks.filter((check) => !check.ok);
  return {
    ok: failed.length === 0,
    boundary: "local_external_agent_upgrade_radar_only",
    repoRoot,
    summary: {
      total: checks.length,
      failed: failed.length,
      registeredCandidateCount: candidates.length,
      architectureIntegratedCount: candidates.filter(
        (candidate) => candidate.status === "local_architecture_integrated",
      ).length,
      sourceRegistrationOnlyCount: candidates.filter(
        (candidate) => candidate.sourceEvidence.status === "static_registration_only",
      ).length,
      sourceReceiptVerifiedCount: candidates.filter((candidate) =>
        Object.values(candidate.sourceEvidence.receipts).every(
          (receipt) => receipt.status === "verified",
        ),
      ).length,
      sourceReceiptMissingCount: candidates.reduce(
        (total, candidate) =>
          total +
          Object.values(candidate.sourceEvidence.receipts).filter(
            (receipt) => receipt.status !== "verified",
          ).length,
        0,
      ),
      sourceVerificationClaim: false,
      runtimeAuthorityGrantedCount: candidates.filter(
        (candidate) => candidate.runtimeAuthority !== "not_granted",
      ).length,
      blacktechMechanismCount: blacktechMechanisms.length,
      blacktechReadyLocalOnlyCount: blacktechMechanisms.filter(
        (mechanism) => mechanism.currentStatus === "owner_wired_local_only",
      ).length,
      blacktechPartialLocalOnlyCount: blacktechMechanisms.filter(
        (mechanism) => mechanism.currentStatus === "partially_wired_local_only",
      ).length,
      blacktechRuntimeAuthorityGrantedCount: blacktechMechanisms.filter(
        (mechanism) => mechanism.runtimeAuthority !== "not_granted",
      ).length,
      blacktechAutopilotRoutedCount: blacktechMechanisms.filter(
        (mechanism) =>
          mechanism.automaticTrigger &&
          mechanism.ownerGate &&
          mechanism.autopilotSurface &&
          mechanism.nextAutomationAction,
      ).length,
      perfectIntegrationClaim: false,
    },
    architectureFit: "fully_integrated_into_existing_lcx_owner_stack",
    perfectIntegrationReason:
      "No external project should be called perfectly integrated until a concrete dev probe, eval/receipt, external-channel migration, and fresh Lark visible proof all pass. This radar proves architecture wiring, not user-visible-observed behavior.",
    checks,
    candidates,
    blacktechMechanisms,
    nextLocalProbes: candidates.map((candidate) => ({
      id: candidate.id,
      ownerEntrypoint: candidate.ownerEntrypoint,
      firstLocalProbe: candidate.firstLocalProbe,
    })),
    nextBlacktechProbes: blacktechMechanisms
      .toSorted((a, b) => a.priority - b.priority)
      .map((mechanism) => ({
        id: mechanism.id,
        priority: mechanism.priority,
        ownerEntrypoint: mechanism.ownerEntrypoint,
        automaticTrigger: mechanism.automaticTrigger,
        ownerGate: mechanism.ownerGate,
        autopilotSurface: mechanism.autopilotSurface,
        nextSafeLocalProbe: mechanism.nextSafeLocalProbe,
        nextAutomationAction: mechanism.nextAutomationAction,
        blockedUntilIdle: mechanism.blockedUntilIdle,
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
    `blacktechMechanismCount=${payload.summary.blacktechMechanismCount}`,
    `architectureFit=${payload.architectureFit}`,
    `perfectIntegrationClaim=${payload.summary.perfectIntegrationClaim}`,
    `sourceRegistrationOnlyCount=${payload.summary.sourceRegistrationOnlyCount}`,
    `sourceReceiptVerifiedCount=${payload.summary.sourceReceiptVerifiedCount}`,
    `sourceReceiptMissingCount=${payload.summary.sourceReceiptMissingCount}`,
    `sourceVerificationClaim=${payload.summary.sourceVerificationClaim}`,
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
    "",
    "Blacktech mechanisms:",
    ...payload.blacktechMechanisms.map(
      (mechanism) =>
        `- ${mechanism.priority}. ${mechanism.label}: owner=${mechanism.ownerEntrypoint}; status=${mechanism.currentStatus}; authority=${mechanism.runtimeAuthority}`,
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
