import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");

async function runRadar() {
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--import", "tsx", "scripts/operator/lcx-external-agent-upgrade-radar.ts", "--json"],
    {
      cwd: repoRoot,
      env: process.env,
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  return JSON.parse(stdout) as {
    ok: boolean;
    boundary: string;
    summary: {
      failed: number;
      registeredCandidateCount: number;
      architectureIntegratedCount: number;
      runtimeAuthorityGrantedCount: number;
      blacktechMechanismCount: number;
      blacktechReadyLocalOnlyCount: number;
      blacktechPartialLocalOnlyCount: number;
      blacktechRuntimeAuthorityGrantedCount: number;
      blacktechAutopilotRoutedCount: number;
      perfectIntegrationClaim: boolean;
    };
    architectureFit: string;
    perfectIntegrationReason: string;
    checks: Array<{ id: string; ok: boolean }>;
    candidates: Array<{
      id: string;
      label: string;
      ownerEntrypoint: string;
      ownerUseTrigger: string;
      autocueTerms: string[];
      runtimeAuthority: string;
      blockedDirectAdoption: boolean;
      sourceUrls: string[];
      requiredReceipts: string[];
      requiredFilters: string[];
      riskBoundaries: string[];
    }>;
    blacktechMechanisms: Array<{
      id: string;
      priority: number;
      label: string;
      sourceCandidates: string[];
      ownerEntrypoint: string;
      automaticTrigger: string;
      ownerGate: string;
      autopilotSurface: string;
      currentStatus: string;
      nextSafeLocalProbe: string;
      nextAutomationAction: string;
      blockedUntilIdle?: string;
      requiredProofChain: string[];
      forbiddenAuthorities: string[];
      runtimeAuthority: string;
      liveReady: boolean;
      modelWeightAbsorbed: boolean;
    }>;
    nextBlacktechProbes: Array<{
      id: string;
      priority: number;
      ownerEntrypoint: string;
      automaticTrigger: string;
      ownerGate: string;
      autopilotSurface: string;
      nextSafeLocalProbe: string;
      nextAutomationAction: string;
      blockedUntilIdle?: string;
    }>;
    liveTouched: boolean;
    providerConfigTouched: boolean;
    protectedMemoryTouched: boolean;
  };
}

describe("lcx-external-agent-upgrade-radar", () => {
  it("maps all external projects and market-research sources into existing LCX owner lanes", async () => {
    const payload = await runRadar();

    expect(payload).toEqual(
      expect.objectContaining({
        ok: true,
        boundary: "local_external_agent_upgrade_radar_only",
        architectureFit: "fully_integrated_into_existing_lcx_owner_stack",
        liveTouched: false,
        providerConfigTouched: false,
        protectedMemoryTouched: false,
      }),
    );
    expect(payload.summary).toEqual(
      expect.objectContaining({
        failed: 0,
        registeredCandidateCount: 13,
        architectureIntegratedCount: 13,
        runtimeAuthorityGrantedCount: 0,
        blacktechMechanismCount: 7,
        blacktechReadyLocalOnlyCount: 2,
        blacktechPartialLocalOnlyCount: 5,
        blacktechRuntimeAuthorityGrantedCount: 0,
        blacktechAutopilotRoutedCount: 7,
        perfectIntegrationClaim: false,
      }),
    );
    expect(payload.perfectIntegrationReason).toContain("external-channel migration");
    expect(payload.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "expected_external_candidates_registered", ok: true }),
        expect.objectContaining({ id: "all_candidates_map_to_existing_owners", ok: true }),
        expect.objectContaining({ id: "automatic_use_triggers_present", ok: true }),
        expect.objectContaining({ id: "direct_runtime_adoption_blocked", ok: true }),
        expect.objectContaining({ id: "expected_blacktech_mechanisms_registered", ok: true }),
        expect.objectContaining({ id: "blacktech_sources_map_to_candidates", ok: true }),
        expect.objectContaining({ id: "blacktech_runtime_authority_blocked", ok: true }),
        expect.objectContaining({ id: "blacktech_autopilot_contract_complete", ok: true }),
      ]),
    );
    expect(payload.candidates.map((candidate) => candidate.id)).toEqual([
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
    ]);
    expect(payload.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "AutoSkill / Skills-Coach",
          ownerEntrypoint: "scripts/operator/lcx-skillopt-lite.ts",
        }),
        expect.objectContaining({
          label: "Agent Lightning",
          ownerEntrypoint: "scripts/operator/lcx-problem-cluster-radar.ts",
        }),
        expect.objectContaining({
          label: "LongMemEval-V2 / AgentRunbook",
          ownerEntrypoint: "scripts/operator/lcx-context-recovery-exam.ts",
        }),
        expect.objectContaining({
          label: "MemX / ground-truth-preserving memory",
          ownerEntrypoint: "scripts/operator/lcx-learning-sedimentation-audit.ts",
        }),
        expect.objectContaining({
          label: "LightMem / LycheeMemory",
          ownerEntrypoint: "scripts/operator/lcx-learning-sedimentation-audit.ts",
        }),
        expect.objectContaining({
          label: "OpenTelemetry GenAI / AgentSight",
          ownerEntrypoint: "scripts/operator/lcx-governance-autopilot.ts",
        }),
        expect.objectContaining({
          label: "OWASP Agentic Top 10 / SMCP",
          ownerEntrypoint: "/Users/liuchengxu/.codex/skills/security-threat-model/SKILL.md",
        }),
        expect.objectContaining({
          label: "ClawBench / WildClawBench",
          ownerEntrypoint: "scripts/operator/lcx-commercial-acceptance-harness.ts",
        }),
        expect.objectContaining({
          label: "Agent S / HKUDS CLI-Anything",
          ownerEntrypoint: "/Users/liuchengxu/.codex/skills/cli-anything-harvester/SKILL.md",
        }),
        expect.objectContaining({
          label: "GitHub CLI / GitHub Agentic Workflows",
          ownerEntrypoint: "/Users/liuchengxu/.codex/skills/cli-anything-harvester/SKILL.md",
        }),
        expect.objectContaining({
          label: "LangGraph / OpenAI Agents / CrewAI / Microsoft Agent Framework",
          ownerEntrypoint: "scripts/operator/lcx-flow-graph.ts",
        }),
        expect.objectContaining({
          label: "Polymarket research intake tools",
          ownerEntrypoint: "src/agents/finance-data-gateway.ts",
        }),
        expect.objectContaining({
          label: "PolyBench / PolySwarm prediction-market strategy audit",
          ownerEntrypoint: "scripts/operator/lcx-commercial-acceptance-harness.ts",
        }),
      ]),
    );
  });

  it("keeps external projects as untrusted distillation sources, not runtime authority", async () => {
    const payload = await runRadar();

    for (const candidate of payload.candidates) {
      expect(candidate.sourceUrls.length, candidate.id).toBeGreaterThan(0);
      expect(candidate.requiredReceipts.length, candidate.id).toBeGreaterThan(0);
      expect(candidate.requiredFilters.length, candidate.id).toBeGreaterThan(0);
      expect(candidate.ownerUseTrigger.length, candidate.id).toBeGreaterThan(20);
      expect(candidate.autocueTerms.length, candidate.id).toBeGreaterThan(0);
      expect(candidate.runtimeAuthority, candidate.id).toBe("not_granted");
      expect(candidate.blockedDirectAdoption, candidate.id).toBe(true);
      expect(candidate.riskBoundaries, candidate.id).toEqual(
        expect.arrayContaining(["no_provider_config_change"]),
      );
    }
  });

  it("registers the seven prioritized blacktech mechanisms without live or model-weight authority", async () => {
    const payload = await runRadar();

    expect(payload.blacktechMechanisms.map((mechanism) => mechanism.id)).toEqual([
      "skillopt_v2_lifecycle",
      "real_runtime_battery",
      "unified_trajectory_schema",
      "local_first_memory_provenance",
      "agent_trace_observability",
      "secure_tool_skill_permission_layer",
      "github_cli_agentic_control_plane",
    ]);
    expect(payload.nextBlacktechProbes.map((probe) => probe.priority)).toEqual([
      1, 2, 3, 4, 5, 6, 7,
    ]);
    expect(payload.blacktechMechanisms).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "skillopt_v2_lifecycle",
          ownerEntrypoint: "scripts/operator/lcx-skillopt-lite.ts",
          automaticTrigger: expect.stringContaining("SkillOpt"),
          ownerGate: expect.stringContaining("eval/MLX"),
          autopilotSurface: expect.stringContaining("lcx-governance-autopilot"),
          nextAutomationAction: expect.stringContaining("nextIdleCommand"),
          blockedUntilIdle: expect.stringContaining("eval/MLX"),
          requiredProofChain: expect.arrayContaining([
            "targeted_eval_clean",
            "train_slice_contains_skillopt_evidence",
            "fresh_real_lark_inbound_and_outbound_seen",
          ]),
        }),
        expect.objectContaining({
          id: "real_runtime_battery",
          ownerEntrypoint: "scripts/operator/lcx-commercial-acceptance-harness.ts",
          automaticTrigger: expect.stringContaining("commercial acceptance"),
          autopilotSurface: expect.stringContaining("commercialAcceptance"),
          requiredProofChain: expect.arrayContaining(["side_effect_audit"]),
        }),
        expect.objectContaining({
          id: "unified_trajectory_schema",
          ownerEntrypoint: "scripts/operator/lcx-governance-autopilot.ts",
          ownerGate: expect.stringContaining("offline evidence"),
          nextAutomationAction: expect.stringContaining("trace_schema"),
          forbiddenAuthorities: expect.arrayContaining(["runtime_rl_server"]),
        }),
        expect.objectContaining({
          id: "local_first_memory_provenance",
          requiredProofChain: expect.arrayContaining(["conflict_or_staleness_decision"]),
        }),
        expect.objectContaining({
          id: "agent_trace_observability",
          ownerGate: expect.stringContaining("redacted local trace"),
          forbiddenAuthorities: expect.arrayContaining([
            "ebpf_or_tls_interception_without_explicit_approval",
          ]),
        }),
        expect.objectContaining({
          id: "secure_tool_skill_permission_layer",
          automaticTrigger: expect.stringContaining("MCP server"),
          requiredProofChain: expect.arrayContaining(["tool_allowlist_entry"]),
        }),
        expect.objectContaining({
          id: "github_cli_agentic_control_plane",
          automaticTrigger: expect.stringContaining("GitHub CLI"),
          ownerGate: expect.stringContaining("read-only gh inventory"),
          requiredProofChain: expect.arrayContaining([
            "gh_version_detected",
            "owner_approval_for_remote_write",
          ]),
          forbiddenAuthorities: expect.arrayContaining([
            "gh_issue_or_pr_write_without_owner_command",
            "copilot_agent_assignment_without_owner_command",
          ]),
        }),
      ]),
    );
    for (const mechanism of payload.blacktechMechanisms) {
      expect(mechanism.runtimeAuthority, mechanism.id).toBe("not_granted");
      expect(mechanism.liveReady, mechanism.id).toBe(false);
      expect(mechanism.modelWeightAbsorbed, mechanism.id).toBe(false);
      expect(mechanism.automaticTrigger.length, mechanism.id).toBeGreaterThan(20);
      expect(mechanism.ownerGate.length, mechanism.id).toBeGreaterThan(20);
      expect(mechanism.autopilotSurface.length, mechanism.id).toBeGreaterThan(10);
      expect(mechanism.nextAutomationAction.length, mechanism.id).toBeGreaterThan(20);
      expect(mechanism.sourceCandidates.length, mechanism.id).toBeGreaterThan(0);
      expect(mechanism.requiredProofChain.length, mechanism.id).toBeGreaterThan(0);
      expect(mechanism.forbiddenAuthorities, mechanism.id).toEqual(
        expect.arrayContaining(["provider_config_change"]),
      );
    }
  });

  it("routes GitHub CLI and agentic workflow tools through read-only inventory before remote writes", async () => {
    const payload = await runRadar();
    const githubCli = payload.candidates.find(
      (candidate) => candidate.id === "github_cli_agentic_workflow_control",
    );

    expect(githubCli).toEqual(
      expect.objectContaining({
        runtimeAuthority: "not_granted",
        blockedDirectAdoption: true,
        ownerUseTrigger: expect.stringContaining("remote write"),
      }),
    );
    expect(githubCli?.autocueTerms).toEqual(
      expect.arrayContaining(["GitHub CLI", "GitHub MCP", "Copilot CLI"]),
    );
    expect(githubCli?.requiredFilters).toEqual(
      expect.arrayContaining([
        "read_only_discovery_first",
        "remote_write_requires_owner_approval",
        "credential_scope_required",
        "human_review_before_agent_delegation",
      ]),
    );
    expect(githubCli?.riskBoundaries).toEqual(
      expect.arrayContaining([
        "no_gh_remote_write_by_default",
        "no_issue_or_pr_mutation_without_owner_command",
        "no_copilot_agent_assignment_without_owner_command",
        "no_mcp_server_install_without_security_receipt",
      ]),
    );
  });

  it("blocks prediction-market research from becoming wallet, order, or trade-execution authority", async () => {
    const payload = await runRadar();
    const predictionMarketCandidates = payload.candidates.filter((candidate) =>
      candidate.id.startsWith("prediction_market_"),
    );

    expect(predictionMarketCandidates.map((candidate) => candidate.id)).toEqual([
      "prediction_market_research_intake",
      "prediction_market_strategy_audit",
    ]);
    for (const candidate of predictionMarketCandidates) {
      expect(candidate.requiredReceipts).toEqual(
        expect.arrayContaining(["source_registry", "data_provenance_quality", "review_panel"]),
      );
      expect(candidate.requiredFilters).toEqual(
        expect.arrayContaining([
          "research_only_boundary",
          "no_trade_advice",
          "no_wallet_or_order_execution",
          "market_microstructure_warning_required",
          "thin_liquidity_downrank_required",
          "ambiguous_resolution_blocks_conclusion",
        ]),
      );
      expect(candidate.riskBoundaries).toEqual(
        expect.arrayContaining([
          "no_wallet_connection",
          "no_order_placement",
          "no_copy_trading",
          "no_latency_arbitrage",
          "no_external_channel_sender_change",
          "no_provider_config_change",
        ]),
      );
    }
  });

  it("requires paper-only prediction-market strategies to fail without fees, slippage, and sample-out proof", async () => {
    const payload = await runRadar();
    const strategyAudit = payload.candidates.find(
      (candidate) => candidate.id === "prediction_market_strategy_audit",
    );

    expect(strategyAudit).toEqual(
      expect.objectContaining({
        firstLocalProbe: expect.stringContaining("failure log"),
      }),
    );
    expect(strategyAudit?.requiredFilters).toEqual(
      expect.arrayContaining([
        "paper_only_backtest_required",
        "fees_slippage_and_sample_out_required",
        "thin_liquidity_downrank_required",
      ]),
    );
  });
});
