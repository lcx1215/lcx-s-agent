import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");

async function runRadar() {
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--import", "tsx", "scripts/dev/lcx-external-agent-upgrade-radar.ts", "--json"],
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
        boundary: "dev_external_agent_upgrade_radar_only",
        architectureFit: "fully_integrated_into_existing_lcx_owner_stack",
        liveTouched: false,
        providerConfigTouched: false,
        protectedMemoryTouched: false,
      }),
    );
    expect(payload.summary).toEqual(
      expect.objectContaining({
        failed: 0,
        registeredCandidateCount: 8,
        architectureIntegratedCount: 8,
        runtimeAuthorityGrantedCount: 0,
        perfectIntegrationClaim: false,
      }),
    );
    expect(payload.perfectIntegrationReason).toContain("live migration");
    expect(payload.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "expected_external_candidates_registered", ok: true }),
        expect.objectContaining({ id: "all_candidates_map_to_existing_owners", ok: true }),
        expect.objectContaining({ id: "automatic_use_triggers_present", ok: true }),
        expect.objectContaining({ id: "direct_runtime_adoption_blocked", ok: true }),
      ]),
    );
    expect(payload.candidates.map((candidate) => candidate.id)).toEqual([
      "agent_lightning_trace_credit",
      "longmemeval_agentrunbook_memory_regression",
      "lightweight_memory_comparison",
      "clawbench_real_task_regression",
      "computer_use_cli_bridge",
      "multi_agent_framework_orchestration_guardrails",
      "prediction_market_research_intake",
      "prediction_market_strategy_audit",
    ]);
    expect(payload.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "Agent Lightning",
          ownerEntrypoint: "scripts/dev/lcx-problem-cluster-radar.ts",
        }),
        expect.objectContaining({
          label: "LongMemEval-V2 / AgentRunbook",
          ownerEntrypoint: "scripts/dev/lcx-context-recovery-exam.ts",
        }),
        expect.objectContaining({
          label: "LightMem / LycheeMemory",
          ownerEntrypoint: "scripts/dev/lcx-learning-sedimentation-audit.ts",
        }),
        expect.objectContaining({
          label: "ClawBench / WildClawBench",
          ownerEntrypoint: "scripts/dev/lcx-commercial-acceptance-harness.ts",
        }),
        expect.objectContaining({
          label: "Agent S / HKUDS CLI-Anything",
          ownerEntrypoint: "/Users/liuchengxu/.codex/skills/cli-anything-harvester/SKILL.md",
        }),
        expect.objectContaining({
          label: "LangGraph / OpenAI Agents / CrewAI / Microsoft Agent Framework",
          ownerEntrypoint: "scripts/dev/lcx-flow-graph.ts",
        }),
        expect.objectContaining({
          label: "Polymarket research intake tools",
          ownerEntrypoint: "src/agents/finance-data-gateway.ts",
        }),
        expect.objectContaining({
          label: "PolyBench / PolySwarm prediction-market strategy audit",
          ownerEntrypoint: "scripts/dev/lcx-commercial-acceptance-harness.ts",
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
        expect.arrayContaining(["no_provider_config_change", "no_live_sender_change"]),
      );
    }
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
        ]),
      );
      expect(candidate.riskBoundaries).toEqual(
        expect.arrayContaining([
          "no_wallet_connection",
          "no_order_placement",
          "no_copy_trading",
          "no_latency_arbitrage",
          "no_live_sender_change",
          "no_provider_config_change",
        ]),
      );
    }
  });
});
