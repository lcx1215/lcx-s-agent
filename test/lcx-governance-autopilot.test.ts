import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");
const EXEC_MAX_BUFFER = 64 * 1024 * 1024;

async function runAutopilot() {
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--import", "tsx", "scripts/operator/lcx-governance-autopilot.ts", "--json"],
    {
      cwd: repoRoot,
      env: process.env,
      maxBuffer: EXEC_MAX_BUFFER,
    },
  );
  return JSON.parse(stdout) as {
    ok: boolean;
    boundary: string;
    latestStatePath: string;
    universeIndexLatestPath: string;
    evolutionPromotionDigestPath: string;
    monotonicDataLedgerLatestPath: string;
    monotonicDataLedgerJsonlPath: string;
    localFailureTraceLatestPath: string;
    localFailureTraceJsonlPath: string;
    ownerBriefLatestJsonPath: string;
    ownerBriefLatestMarkdownPath: string;
    ownerControlMapLatestJsonPath: string;
    ownerControlMapLatestMarkdownPath: string;
    handoffLatestPath: string;
    globalEvidenceProjectionReader: {
      contractVersion: string;
      adapterId: string;
      readStatus: string;
      blocked: boolean;
    };
    autoTriggeredOwnerCommands: string[];
    ownerCommands: Array<{ id: string; parsed: boolean; command: string }>;
    triggerPolicy: {
      readOnly: boolean;
      repoReadOnly: boolean;
      workspaceStateWrites: string[];
      autoUpdateLatestState: boolean;
      evolutionPromotionDigestUpdated: boolean;
      contextRecoveryHandoffUpdated: boolean;
      monotonicDataLedgerWriteEnabled: boolean;
      localFailureTraceWriteEnabled: boolean;
      ownerBriefWriteEnabled: boolean;
      ownerControlMapWriteEnabled: boolean;
      selfRepairHandsAutoWriteEnabled: boolean;
      selfRepairHandsWriteRequiresOwnerSignalOrExplicitWriteFlag: boolean;
      selfRepairHandsOwnerWritePolicy: {
        whenAutoWrite: Array<{ id: string; sourceOwner: string; signalKeyPrefix: string }>;
        dedupeKey: string;
        writeOncePerSignalKey: boolean;
        allowedWriteRoots: string[];
        deniedAuthorities: string[];
        afterWriteGate: string;
      };
      selfRepairHandsAutoWriteTriggered: boolean;
      noOverlappingTrainingStarted: boolean;
      noRepoMutationRequired: boolean;
    };
    summary: {
      parsedOwners: number;
      ownerCount: number;
      activeTrainingOrEval: boolean;
      externalChannelBindingStatus?: string;
      externalChannelStatusModel?: string;
      externalChannelBound?: boolean;
      userVisibleObserved?: boolean;
      evolutionCooldownActive?: boolean;
      latestEvolutionCooldown?: unknown;
      latestGuardEvent?: unknown;
      affectedLanes: string[];
      projectionReaderCoverageStatus?: string;
      projectionReaderContractReadyForAllAdapters?: boolean;
      projectionReaderMissingCount?: number;
      selfRepairHandsAutoWriteTriggered?: boolean;
      selfRepairHandsAutoSignal?: unknown;
      selfRepairHandsOwnerWritePolicy?: {
        whenAutoWrite?: Array<{ id?: string }>;
        deniedAuthorities?: string[];
      };
      selfRepairHandsLatestWrittenStatus?: string;
      selfRepairHandsLatestWrittenSignalKey?: string;
    };
    owners: {
      mindModel?: { summary?: unknown };
      projectionReaderAudit?: {
        coverageStatus?: string;
        bound?: number;
        missingReaderContract?: number;
        readerContractReadyForAllAdapters?: boolean;
        nextAction?: string;
      };
      flowGraph?: { summary?: unknown };
      headTail?: { summary?: unknown };
      contextRecovery?: { compressedContextRecovered?: boolean };
      trainingPlan?: {
        decisionIds?: string[];
        evolutionCooldownActive?: boolean;
        latestEvolutionCooldown?: unknown;
        latestGuardEvent?: unknown;
        activeGuardEvolutionCooldown?: unknown;
      };
      skillOptLite?: { status?: string; nextIdleAction?: string; staticGateOk?: boolean };
      selfRepairHands?: {
        status?: string;
        signalKey?: string;
        nextSafeAction?: string;
        writtenArtifacts?: string[];
        latestWrittenReceipt?: { signalKey?: string; status?: string };
        trainingCaseBuilder?: { absorptionStatus?: string };
        patchCandidateBuilder?: { absorptionStatus?: string; action?: string };
      };
      monotonicDataLedger?: {
        appendDecision?: string;
        guaranteeLevel?: string;
        datasetExamples?: number;
        trainSliceWritten?: number;
        acceptedSkillOptPackets?: number;
      };
      providerCouncilAcceleration?: { status?: string; action?: string };
      externalChannelStatus?: {
        statusModel?: string;
        externalChannelBound?: boolean;
        userVisibleObserved?: boolean;
      };
      liveLarkBrainBinding?: { status?: string };
      problemRadar?: { actionableClusters?: string[] };
      changeImpact?: { affectedLanes?: string[] };
      universeIndex?: {
        trackedFiles?: number;
        dirtyFiles?: number;
        unmatchedChangedFiles?: number;
      };
      externalAgentUpgrade?: {
        blacktechMechanismCount?: number;
        blacktechRuntimeAuthorityGrantedCount?: number;
        blacktechAutopilotRoutedCount?: number;
        perfectIntegrationClaim?: boolean;
      };
      commercialAcceptance?: { readyForCommercialRelease?: boolean };
    };
    liveTouched: boolean;
    providerConfigTouched: boolean;
    protectedMemoryTouched: boolean;
  };
}

describe("LCX governance autopilot", () => {
  it("runs and persists the read-only governance owner stack", async () => {
    const payload = await runAutopilot();

    expect(payload).toEqual(
      expect.objectContaining({
        ok: true,
        boundary: "local_governance_autopilot_only",
        liveTouched: false,
        providerConfigTouched: false,
        protectedMemoryTouched: false,
      }),
    );
    expect(payload.triggerPolicy).toEqual(
      expect.objectContaining({
        readOnly: false,
        repoReadOnly: true,
        workspaceStateWrites: expect.arrayContaining([
          "monotonic_data_ledger_latest",
          "monotonic_data_ledger_jsonl",
          "local_failure_trace_latest",
          "local_failure_trace_jsonl",
          "owner_brief_latest_json",
          "owner_brief_latest_markdown",
          "owner_control_map_latest_json",
          "owner_control_map_latest_markdown",
        ]),
        autoUpdateLatestState: true,
        evolutionPromotionDigestUpdated: true,
        contextRecoveryHandoffUpdated: true,
        monotonicDataLedgerWriteEnabled: true,
        localFailureTraceWriteEnabled: true,
        ownerBriefWriteEnabled: true,
        ownerControlMapWriteEnabled: true,
        selfRepairHandsAutoWriteEnabled: true,
        selfRepairHandsWriteRequiresOwnerSignalOrExplicitWriteFlag: true,
        selfRepairHandsOwnerWritePolicy: expect.objectContaining({
          dedupeKey: "signalKey",
          writeOncePerSignalKey: true,
          allowedWriteRoots: expect.arrayContaining([
            "workspace/memory/self-repair",
            "workspace/state/lcx-self-repair-hands-*",
            "workspace/logs/lcx-self-repair-hands.jsonl",
          ]),
          deniedAuthorities: expect.arrayContaining([
            "repo_source",
            "external_channel_sender",
            "provider_config",
            "protected_memory",
            "formal_language_corpus",
            "training_processes",
            "train_slice_direct_write",
            "model_weight_absorption_claim",
          ]),
          afterWriteGate:
            "owner_review_then_owner_approved_eval_or_train_slice_only_after_training_plan_idle_safe",
        }),
        selfRepairHandsAutoWriteTriggered: expect.any(Boolean),
        noOverlappingTrainingStarted: true,
        noRepoMutationRequired: true,
      }),
    );
    expect(payload.triggerPolicy.selfRepairHandsOwnerWritePolicy.whenAutoWrite).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "candidate_eval_dirty_cases", sourceOwner: "trainingPlan" }),
        expect.objectContaining({
          id: "module_learning_incomplete_evidence",
          sourceOwner: "trainingPlan",
        }),
        expect.objectContaining({
          id: "skillopt_static_or_parse_gap",
          sourceOwner: "skillOptLite",
        }),
      ]),
    );
    expect(payload.autoTriggeredOwnerCommands).toEqual(
      expect.arrayContaining([
        "problemRadar",
        "commercialAcceptance",
        "changeImpact",
        "projectionReaderAudit",
        "universeIndex",
        "externalAgentUpgrade",
        "liveFadeoutAudit",
        "externalChannelStatus",
        "trainingPlan",
        "skillOptLite",
        "selfRepairHands",
        "monotonicDataLedger",
        "providerCouncilAcceleration",
        "externalChannelBinding",
        "mindModel",
        "flowGraph",
        "headTail",
        "contextRecovery",
      ]),
    );
    expect(payload.summary.parsedOwners).toBe(payload.summary.ownerCount);
    expect(payload.ownerCommands.every((owner) => owner.parsed)).toBe(true);
    expect(payload.owners.mindModel?.summary).toBeTruthy();
    expect(payload.owners.projectionReaderAudit).toEqual(
      expect.objectContaining({
        coverageStatus: "partial",
        bound: 3,
        missingReaderContract: 3,
        readerContractReadyForAllAdapters: false,
        nextAction: expect.stringContaining("neutral answer boundary"),
      }),
    );
    expect(payload.globalEvidenceProjectionReader).toEqual({
      contractVersion: "global_evidence_projection_reader_v1",
      adapterId: "governance-autopilot",
      readStatus: expect.any(String),
      blocked: expect.any(Boolean),
    });
    expect(payload.owners.flowGraph?.summary).toBeTruthy();
    expect(payload.owners.headTail?.summary).toBeTruthy();
    expect(Array.isArray(payload.owners.trainingPlan?.decisionIds)).toBe(true);
    expect(typeof payload.owners.trainingPlan?.evolutionCooldownActive).toBe("boolean");
    expect(payload.owners.trainingPlan?.activeGuardEvolutionCooldown).toBeTruthy();
    expect(payload.owners.skillOptLite?.status).toEqual(expect.any(String));
    expect(payload.owners.selfRepairHands).toEqual(
      expect.objectContaining({
        status: expect.stringMatching(/^(dry_run_ready|write_completed)$/),
        nextSafeAction: expect.any(String),
      }),
    );
    expect(payload.owners.selfRepairHands?.trainingCaseBuilder?.absorptionStatus).toBe(
      "candidate_only_not_in_train_slice",
    );
    expect(payload.owners.selfRepairHands?.patchCandidateBuilder?.absorptionStatus).toBe(
      "candidate_only_not_applied_to_repo",
    );
    expect(payload.owners.monotonicDataLedger).toEqual(
      expect.objectContaining({
        appendDecision: expect.stringMatching(
          /^(append_latest_entry|duplicate_latest_entry_not_appended)$/,
        ),
        guaranteeLevel: "data_accounting_not_model_capability_guarantee",
        datasetExamples: expect.any(Number),
        trainSliceWritten: expect.any(Number),
        acceptedSkillOptPackets: expect.any(Number),
      }),
    );
    expect(payload.owners.universeIndex?.trackedFiles).toEqual(expect.any(Number));
    expect(payload.owners.universeIndex?.dirtyFiles).toEqual(expect.any(Number));
    expect(payload.owners.universeIndex?.unmatchedChangedFiles).toEqual(expect.any(Number));
    expect(payload.owners.externalAgentUpgrade?.blacktechMechanismCount).toBe(7);
    expect(payload.owners.externalAgentUpgrade?.blacktechRuntimeAuthorityGrantedCount).toBe(0);
    expect(payload.owners.externalAgentUpgrade?.blacktechAutopilotRoutedCount).toBe(7);
    expect(payload.owners.externalAgentUpgrade?.perfectIntegrationClaim).toBe(false);
    expect(payload.owners.skillOptLite?.nextIdleAction).toEqual(expect.any(String));
    expect(payload.owners.providerCouncilAcceleration?.status).toEqual(expect.any(String));
    expect(payload.owners.providerCouncilAcceleration?.action).toEqual(expect.any(String));
    expect(payload.owners.externalChannelStatus).toEqual(
      expect.objectContaining({
        statusModel: "core-ready -> external-channel-bound -> user-visible-observed",
        externalChannelBound: expect.any(Boolean),
        userVisibleObserved: expect.any(Boolean),
      }),
    );
    expect(payload.summary.externalChannelStatusModel).toBe(
      payload.owners.externalChannelStatus?.statusModel,
    );
    expect(payload.owners.contextRecovery?.compressedContextRecovered).toEqual(expect.any(Boolean));
    expect(payload.latestStatePath).toBe(
      "/Users/liuchengxu/.openclaw/workspace/state/lcx-governance-autopilot-latest.json",
    );
    expect(payload.universeIndexLatestPath).toBe(
      "/Users/liuchengxu/.openclaw/workspace/state/lcx-universe-index-latest.json",
    );
    expect(payload.evolutionPromotionDigestPath).toBe(
      "/Users/liuchengxu/.openclaw/workspace/state/lcx-evolution-promotion-digest-latest.json",
    );
    expect(payload.monotonicDataLedgerLatestPath).toBe(
      "/Users/liuchengxu/.openclaw/workspace/state/lcx-monotonic-data-ledger-latest.json",
    );
    expect(payload.monotonicDataLedgerJsonlPath).toBe(
      "/Users/liuchengxu/.openclaw/workspace/logs/lcx-monotonic-data-ledger.jsonl",
    );
    expect(payload.localFailureTraceLatestPath).toBe(
      "/Users/liuchengxu/.openclaw/workspace/state/lcx-local-failure-trace-latest.json",
    );
    expect(payload.localFailureTraceJsonlPath).toBe(
      "/Users/liuchengxu/.openclaw/workspace/logs/lcx-local-failure-trace.jsonl",
    );
    expect(payload.ownerBriefLatestJsonPath).toBe(
      "/Users/liuchengxu/.openclaw/workspace/state/lcx-owner-brief-latest.json",
    );
    expect(payload.ownerBriefLatestMarkdownPath).toBe(
      "/Users/liuchengxu/.openclaw/workspace/state/lcx-owner-brief-latest.md",
    );
    expect(payload.ownerControlMapLatestJsonPath).toBe(
      "/Users/liuchengxu/.openclaw/workspace/state/lcx-owner-control-map-latest.json",
    );
    expect(payload.ownerControlMapLatestMarkdownPath).toBe(
      "/Users/liuchengxu/.openclaw/workspace/state/lcx-owner-control-map-latest.md",
    );
    expect(payload.handoffLatestPath).toBe(
      "/Users/liuchengxu/.openclaw/workspace/state/lcx-context-recovery-handoff-latest.md",
    );

    const latest = JSON.parse(await fs.readFile(payload.latestStatePath, "utf8")) as {
      boundary: string;
      autoTriggeredOwnerCommands: string[];
    };
    expect(latest.boundary).toBe("local_governance_autopilot_only");
    expect(latest.autoTriggeredOwnerCommands).toEqual(payload.autoTriggeredOwnerCommands);

    const digestPath =
      "/Users/liuchengxu/.openclaw/workspace/state/lcx-evolution-promotion-digest-latest.json";
    const digest = JSON.parse(await fs.readFile(digestPath, "utf8")) as {
      boundary: string;
      autopilot?: { ok?: boolean; summary?: { activeTrainingOrEval?: boolean } };
      activePidSummary?: { guard?: string[]; eval?: string[]; mlx?: string[] };
      material?: {
        activePidCounts?: Record<string, number>;
        externalChannelBindingStatus?: string;
        externalChannelStatusModel?: string;
        externalChannelBound?: boolean;
        userVisibleObserved?: boolean;
        evolutionCooldownActive?: boolean;
        latestEvolutionCooldown?: unknown;
        latestGuardEvent?: unknown;
        projectionReaderCoverageStatus?: string;
        projectionReaderContractReadyForAllAdapters?: boolean;
        projectionReaderMissingCount?: number;
        skillOptLiteStatus?: string;
        selfRepairHandsAutoWriteTriggered?: boolean;
        selfRepairHandsOwnerWritePolicy?: {
          whenAutoWrite?: Array<{ id?: string }>;
          deniedAuthorities?: string[];
        };
        selfRepairHandsLatestWrittenStatus?: string;
        selfRepairHandsLatestWrittenSignalKey?: string;
        monotonicDataLedgerDatasetExamples?: number;
        monotonicDataLedgerTrainSliceWritten?: number;
        monotonicDataLedgerAcceptedSkillOptPackets?: number;
        providerCouncilAccelerationStatus?: string;
        externalUpgradeBlacktechMechanismCount?: number;
        externalUpgradeBlacktechRuntimeAuthorityGrantedCount?: number;
        externalUpgradeBlacktechAutopilotRoutedCount?: number;
      };
      liveTouched?: boolean;
      providerConfigTouched?: boolean;
      protectedMemoryTouched?: boolean;
    };
    expect(digest.boundary).toBe("local_evolution_promotion_digest_only");
    expect(digest.autopilot?.ok).toBe(payload.ok);
    expect(digest.autopilot?.summary?.activeTrainingOrEval).toBe(
      payload.summary.activeTrainingOrEval,
    );
    expect(Array.isArray(digest.activePidSummary?.guard)).toBe(true);
    expect(Array.isArray(digest.activePidSummary?.eval)).toBe(true);
    expect(Array.isArray(digest.activePidSummary?.mlx)).toBe(true);
    expect(digest.material?.activePidCounts).toEqual(
      expect.objectContaining({
        guard: expect.any(Number),
        eval: expect.any(Number),
        mlx: expect.any(Number),
      }),
    );
    expect(digest.material?.externalChannelBindingStatus).toBe(
      payload.summary.externalChannelBindingStatus,
    );
    expect(digest.material?.externalChannelStatusModel).toBe(
      payload.summary.externalChannelStatusModel,
    );
    expect(digest.material?.externalChannelBound).toBe(payload.summary.externalChannelBound);
    expect(digest.material?.userVisibleObserved).toBe(payload.summary.userVisibleObserved);
    expect(digest.material?.evolutionCooldownActive).toBe(payload.summary.evolutionCooldownActive);
    expect(digest.material?.latestEvolutionCooldown).toEqual(
      payload.summary.latestEvolutionCooldown,
    );
    expect(digest.material?.latestGuardEvent).toEqual(payload.summary.latestGuardEvent);
    expect(digest.material?.projectionReaderCoverageStatus).toBe(
      payload.summary.projectionReaderCoverageStatus,
    );
    expect(digest.material?.projectionReaderContractReadyForAllAdapters).toBe(
      payload.summary.projectionReaderContractReadyForAllAdapters,
    );
    expect(digest.material?.projectionReaderMissingCount).toBe(
      payload.summary.projectionReaderMissingCount,
    );
    expect(digest.material?.skillOptLiteStatus).toBe(payload.owners.skillOptLite?.status);
    expect(digest.material?.selfRepairHandsAutoWriteTriggered).toBe(
      payload.summary.selfRepairHandsAutoWriteTriggered,
    );
    expect(digest.material?.selfRepairHandsLatestWrittenStatus).toBe(
      payload.summary.selfRepairHandsLatestWrittenStatus,
    );
    expect(digest.material?.selfRepairHandsOwnerWritePolicy?.whenAutoWrite).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "candidate_eval_dirty_cases" }),
        expect.objectContaining({ id: "module_learning_incomplete_evidence" }),
        expect.objectContaining({ id: "skillopt_static_or_parse_gap" }),
      ]),
    );
    expect(digest.material?.selfRepairHandsOwnerWritePolicy?.deniedAuthorities).toEqual(
      expect.arrayContaining(["repo_source", "external_channel_sender", "provider_config"]),
    );
    expect(digest.material?.monotonicDataLedgerDatasetExamples).toBe(
      payload.owners.monotonicDataLedger?.datasetExamples,
    );
    expect(digest.material?.monotonicDataLedgerTrainSliceWritten).toBe(
      payload.owners.monotonicDataLedger?.trainSliceWritten,
    );
    expect(digest.material?.monotonicDataLedgerAcceptedSkillOptPackets).toBe(
      payload.owners.monotonicDataLedger?.acceptedSkillOptPackets,
    );
    expect(digest.material?.providerCouncilAccelerationStatus).toBe(
      payload.owners.providerCouncilAcceleration?.status,
    );
    expect(digest.material?.externalUpgradeBlacktechMechanismCount).toBe(7);
    expect(digest.material?.externalUpgradeBlacktechRuntimeAuthorityGrantedCount).toBe(0);
    expect(digest.material?.externalUpgradeBlacktechAutopilotRoutedCount).toBe(7);
    expect(digest.liveTouched).toBe(false);
    expect(digest.providerConfigTouched).toBe(false);
    expect(digest.protectedMemoryTouched).toBe(false);

    const handoff = await fs.readFile(payload.handoffLatestPath, "utf8");
    expect(handoff).toContain("# LCX Context Recovery Handoff");
    expect(handoff).toContain("boundary: local_context_recovery_handoff_only");
    expect(handoff).toContain("activeTrainingOrEval");
    expect(handoff).toContain("evolutionCooldownActive");
    expect(handoff).toContain("latestEvolutionCooldown");
    expect(handoff).toContain("selectedCleanAdapter");
    expect(handoff).toContain("latestCandidateAdapter");
    expect(handoff).toContain("## SkillOpt-lite");
    expect(handoff).toContain("## Monotonic Data Ledger");
    expect(handoff).toContain("## Self-Repair Hands");
    expect(handoff).toContain("autoWriteTriggered");
    expect(handoff).toContain("ownerPolicy.whenAutoWrite");
    expect(handoff).toContain("patchCandidateBuilder");
    expect(handoff).toContain("candidate_eval_dirty_cases");
    expect(handoff).toContain("module_learning_incomplete_evidence");
    expect(handoff).toContain("skillopt_static_or_parse_gap");
    expect(handoff).toContain("local_monotonic_data_ledger_only");
    expect(handoff).toContain("## Local Failure Trace");
    expect(handoff).toContain("local_failure_trace_index_only");
    expect(handoff).toContain("## Universe Index");
    expect(handoff).toContain("local_universe_index_only");
    expect(handoff).toContain("local_skillopt_lite_only");
    expect(handoff).toContain("## Blacktech Upgrade Radar");
    expect(handoff).toContain("## Projection Reader Audit");
    expect(handoff).toContain("readerContractReadyForAllAdapters");
    expect(handoff).toContain("local_external_agent_upgrade_radar_only");
    expect(handoff).toContain("## Provider Council Acceleration");
    expect(handoff).toContain("local_provider_council_acceleration_only");
    expect(handoff).toContain("## External Channel Status");
    expect(handoff).toContain("local_external_channel_status_only");
    expect(handoff).toContain("liveTouched: false");
    expect(handoff).toContain("providerConfigTouched: false");
    expect(handoff).toContain("protectedMemoryTouched: false");
    expect(handoff).toContain("use fresh local-brain-training-plan");

    const ownerBrief = await fs.readFile(payload.ownerBriefLatestMarkdownPath, "utf8");
    expect(ownerBrief).toContain("# LCX 老板总览");
    expect(ownerBrief).toContain("一句话：");
    expect(ownerBrief).toContain("今天进展");
    expect(ownerBrief).toContain("卡在哪里");
    expect(ownerBrief).toContain("下一步");
    expect(ownerBrief).toContain("风险边界");
    expect(ownerBrief).toContain("管控图");

    const ownerControlMap = await fs.readFile(payload.ownerControlMapLatestMarkdownPath, "utf8");
    expect(ownerControlMap).toContain("# LCX 老板管控图");
    expect(ownerControlMap).toContain("老板现在管不到什么");
    expect(ownerControlMap).toContain("Codex 可以帮你管什么");
  }, 240_000);

  it("is wired into recovery, flow graph, mind model, doctor entrypoint inventory, and local operator", async () => {
    const [recovery, flowGraph, mindModel, doctor, localOperator, runbook] = await Promise.all([
      fs.readFile(path.join(repoRoot, "scripts/operator/lcx-context-recovery-exam.ts"), "utf8"),
      fs.readFile(path.join(repoRoot, "scripts/operator/lcx-flow-graph.ts"), "utf8"),
      fs.readFile(path.join(repoRoot, "scripts/operator/lcx-mind-model.ts"), "utf8"),
      fs.readFile(path.join(repoRoot, "scripts/operator/lcx-system-doctor.ts"), "utf8"),
      fs.readFile("/Users/liuchengxu/.openclaw/bin/lcx-local-operator-loop.sh", "utf8"),
      fs.readFile(path.join(repoRoot, "ops/local-brain/README.md"), "utf8"),
    ]);

    expect(recovery).toContain("scripts/operator/lcx-governance-autopilot.ts --json");
    expect(recovery).toContain("scripts/operator/lcx-universe-index.ts --json");
    expect(recovery).toContain("scripts/operator/lcx-external-agent-upgrade-radar.ts --json");
    expect(recovery).toContain("scripts/operator/lcx-live-fadeout-audit.ts --json");
    expect(flowGraph).toContain("governance_autopilot");
    expect(flowGraph).toContain("universe_index");
    expect(flowGraph).toContain("lcx-governance-autopilot-latest");
    expect(mindModel).toContain("governance_autopilot_auto_update");
    expect(mindModel).toContain("universe_index_total_coverage");
    expect(mindModel).toContain("autoTriggeredOwnerCommands");
    expect(doctor).toContain("scripts/operator/lcx-governance-autopilot.ts");
    expect(doctor).toContain("scripts/operator/lcx-live-fadeout-audit.ts");
    expect(localOperator).toContain("governance_file");
    expect(localOperator).toContain("governanceAutopilot");
    expect(localOperator).toContain("NODE_GOVERNANCE_FILE");
    expect(runbook).toContain("Governance Autopilot");
    expect(runbook).toContain("lcx-governance-autopilot-latest.json");
    expect(runbook).toContain("lcx-local-failure-trace-latest.json");
    expect(runbook).toContain("lcx-owner-brief-latest.md");
    expect(runbook).toContain("lcx-owner-control-map-latest.md");
  });
});
