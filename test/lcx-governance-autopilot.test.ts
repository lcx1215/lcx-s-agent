import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import vm from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import {
  boundaryFromFlags,
  buildLcxRunReceipt,
  createLcxRunId,
  createLcxRunSnapshot,
  type LcxRunReceipt,
} from "../src/shared/lcx-run-receipt.js";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");
const EXEC_MAX_BUFFER = 64 * 1024 * 1024;
const lcxUserHome = process.env.LCX_USER_HOME ?? "/Users/liuchengxu";
const lcxWorkspace = path.join(lcxUserHome, ".openclaw", "workspace");
const localOperatorPath = path.join(lcxUserHome, ".openclaw", "bin", "lcx-local-operator-loop.sh");

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
    multiAgentPatternShadowLatestPath: string;
    multiAgentPatternShadow: { status: string; reason: string };
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
      multiAgentPatternShadowStatus?: string;
      multiAgentPatternShadowTrialDecision?: string;
      externalChannelBound?: boolean;
      userVisibleObserved?: boolean;
      evolutionCooldownActive?: boolean;
      latestEvolutionCooldown?: unknown;
      latestGuardEvent?: unknown;
      universeIndexGovernanceScope?: string;
      universeIndexGovernanceStatus?: string;
      universeIndexGovernanceTotalComponents?: number;
      universeIndexGovernanceGovernedComponents?: number;
      universeIndexGovernanceInventoryOnlyComponents?: number;
      universeIndexGovernanceReviewRequiredComponents?: number;
      universeIndexGovernanceCoverageRate?: number;
      universeIndexGovernanceUnknownComponents?: string[];
      universeIndexGovernanceMissingRouteOwners?: string[];
      universeIndexGovernanceInventoryAreaCount?: number;
      universeIndexGovernanceInventoryAreaComponentCount?: number;
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
      centralAgentContextBudget?: {
        budgetBytes?: number;
        injectedBytes?: number;
        overBudget?: boolean;
        droppedSections?: Array<{ section?: string; droppedKeys?: Array<{ key?: string }> }>;
      };
      centralAgentEvidenceComplete?: boolean;
      centralAgentEvidenceWriteFailures?: unknown[];
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
      liveExternalBrainBinding?: { status?: string };
      problemRadar?: { actionableClusters?: string[] };
      changeImpact?: { affectedLanes?: string[] };
      universeIndex?: {
        trackedFiles?: number;
        dirtyFiles?: number;
        unmatchedChangedFiles?: number;
        governanceScope?: string;
        governanceStatus?: string;
        governanceTotalComponents?: number;
        governanceGovernedComponents?: number;
        governanceInventoryOnlyComponents?: number;
        governanceReviewRequiredComponents?: number;
        governanceCoverageRate?: number;
        governanceUnknownComponents?: string[];
        governanceMissingRouteOwners?: string[];
        governanceInventoryAreaCount?: number;
        governanceInventoryAreaComponentCount?: number;
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

describe("offline same-cycle central handoff", () => {
  type FixtureRun = {
    id: string;
    parsed: boolean;
    ok: boolean;
    command: string;
    exitCode: number;
    compact: Record<string, unknown>;
    payload: Record<string, unknown>;
    runReceipt: LcxRunReceipt;
    error?: string;
  };
  const snapshot = createLcxRunSnapshot({
    observedAt: "2026-10-07T03:00:00Z",
    sourceCommit: "offline-source",
    sourceBranch: "test",
    authorityOwner: "lcx-governance-autopilot",
  });
  function owner(id: string, compact: Record<string, unknown> = {}): FixtureRun {
    return {
      id,
      parsed: true,
      ok: true,
      command: `fixture:${id}`,
      exitCode: 0,
      compact,
      payload: { ok: true, fullDetail: "not sent to the decision child" },
      runReceipt: buildLcxRunReceipt({
        runId: `offline-${id}`,
        parentRunId: "offline-parent",
        owner: id,
        phase: "observe",
        status: "passed",
        checkedAt: snapshot.observedAt,
        snapshot,
        boundary: boundaryFromFlags({ scope: "offline" }),
        evidence: [],
        nextAction: "none",
      }),
    };
  }
  async function fixture(
    options: {
      beforeDirect?: () => Promise<void>;
      beforeAcceptance?: () => Promise<void>;
      failWrite?: boolean;
      centralFails?: boolean;
    } = {},
  ) {
    // Evaluate actual scheduling statements with isolated owners, never import/run the CLI.
    const source = await fs.readFile(
      path.join(repoRoot, "scripts/operator/lcx-governance-autopilot.ts"),
      "utf8",
    );
    const ast = ts.createSourceFile("autopilot.ts", source, ts.ScriptTarget.ESNext, true);
    const declarationName = (statement: ts.Statement): string | undefined =>
      ts.isVariableStatement(statement)
        ? statement.declarationList.declarations[0]?.name.getText(ast)
        : undefined;
    const first = ast.statements.findIndex(
      (statement) => declarationName(statement) === "directOwnerCommands",
    );
    const last = ast.statements.findIndex(
      (statement) => declarationName(statement) === "ownerById",
    );
    expect(first).toBeGreaterThanOrEqual(0);
    expect(last).toBeGreaterThan(first);
    const helpers = new Set([
      "runCentralOwnerAfterSnapshots",
      "buildOwnerRunReceipt",
      "ownerRunStatus",
      "ownerBoundary",
      "ownerEvidence",
      "ownerNextAction",
      "ownerMap",
      "toProblemRadarOwnerSnapshot",
      "toCommercialAcceptanceOwnerSnapshot",
    ]);
    const functions = ast.statements
      .filter(
        (statement) =>
          ts.isFunctionDeclaration(statement) && helpers.has(statement.name?.text ?? ""),
      )
      .map((statement) => statement.getText(ast))
      .join("\n");
    const commands = ast.statements.find(
      (statement) => declarationName(statement) === "OWNER_COMMANDS",
    );
    if (!commands) {
      throw new Error("original owner commands missing");
    }
    const sequence = ast.statements
      .slice(first, last + 1)
      .map((statement) => statement.getText(ast))
      .join("\n");
    const body = `const {fs,os,path,runOwner,ownerRunFromPayload,captureOwnerRun,collectProblemRadarExclusiveSnapshots,collectCommercialAcceptanceExclusiveSnapshots,buildProblemClusterRadarFromSnapshots,buildCommercialAcceptanceHarness,combineCommercialAcceptanceSnapshots,buildLcxRunReceipt,createLcxRunId,boundaryFromFlags,governanceSnapshot,governanceRunId}=deps;
      ${functions}
      ${commands.getText(ast)}
      const problemRadarCommand=OWNER_COMMANDS.find(command=>command.id==='problemRadar');
      const commercialAcceptanceCommand=OWNER_COMMANDS.find(command=>command.id==='commercialAcceptance');
      const centralAgentCommand=OWNER_COMMANDS.find(command=>command.id==='centralAgent');
      const ownerFanoutStartedAt=performance.now();
      return { run: async()=>{${sequence}; return [...ownerById.values()];},
        handoff:(completed)=>runCentralOwnerAfterSnapshots(centralAgentCommand,completed,{parentRunId:governanceRunId,snapshot:governanceSnapshot}) };`;
    const compiled = ts.transpileModule(body, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const events: string[] = [];
    const inputPaths: string[] = [];
    const temporaryDirectories: string[] = [];
    const inputs: Record<string, unknown>[] = [];
    const runOwner = vi.fn(async (command: { id: string; args?: string[] }) => {
      events.push(`start:${command.id}`);
      if (command.id === "centralAgent") {
        const index = command.args?.indexOf("--governance-input") ?? -1;
        expect(index).toBeGreaterThanOrEqual(0);
        const inputPath = command.args?.[index + 1];
        if (!inputPath) {
          throw new Error("missing original handoff path");
        }
        inputPaths.push(inputPath);
        expect((await fs.stat(inputPath)).mode & 0o777).toBe(0o600);
        inputs.push(JSON.parse(await fs.readFile(inputPath, "utf8")));
      } else {
        await options.beforeDirect?.();
      }
      events.push(`done:${command.id}`);
      const result = owner(command.id, {
        artifactEvidence: { status: "registered", id: `artifact-${command.id}` },
        sourceObservedAt: snapshot.observedAt,
      });
      if (command.id === "centralAgent" && options.centralFails) {
        result.ok = false;
        result.runReceipt = { ...result.runReceipt, status: "blocked" };
      }
      return result;
    });
    const evaluate = vm.runInThisContext(`(function(deps){${compiled}})`) as (
      dependencies: Record<string, unknown>,
    ) => {
      run: () => Promise<FixtureRun[]>;
      handoff: (owners: FixtureRun[]) => Promise<FixtureRun>;
    };
    const harness = evaluate({
      fs: {
        ...fs,
        mkdtemp: async (prefix: string) => {
          const directory = await fs.mkdtemp(prefix);
          temporaryDirectories.push(directory);
          return directory;
        },
        writeFile: options.failWrite
          ? async () => {
              throw new Error("isolated write denied");
            }
          : fs.writeFile,
      },
      os,
      path,
      runOwner,
      buildLcxRunReceipt,
      createLcxRunId,
      boundaryFromFlags,
      governanceSnapshot: snapshot,
      governanceRunId: "offline-parent",
      ownerRunFromPayload: (command: { id: string }) => owner(command.id),
      captureOwnerRun: async (run: FixtureRun) => {
        events.push(`captured:${run.id}`);
        return run;
      },
      collectProblemRadarExclusiveSnapshots: async () => ({}),
      collectCommercialAcceptanceExclusiveSnapshots: async () => {
        await options.beforeAcceptance?.();
        return {};
      },
      buildProblemClusterRadarFromSnapshots: async () => ({}),
      combineCommercialAcceptanceSnapshots: () => ({}),
      buildCommercialAcceptanceHarness: () => ({ summary: { failed: 0 } }),
    });
    return { ...harness, events, inputPaths, temporaryDirectories, inputs, runOwner };
  }

  it("waits for settled owners and both aggregations, then calls central exactly once", async () => {
    let releaseDirect!: () => void;
    let releaseAcceptance!: () => void;
    const direct = new Promise<void>((resolve) => {
      releaseDirect = resolve;
    });
    const acceptance = new Promise<void>((resolve) => {
      releaseAcceptance = resolve;
    });
    const harness = await fixture({
      beforeDirect: () => direct,
      beforeAcceptance: () => acceptance,
    });
    const pending = harness.run();
    await Promise.resolve();
    expect(harness.events.some((event) => event === "start:centralAgent")).toBe(false);
    releaseDirect();
    await Promise.resolve();
    expect(harness.events.some((event) => event === "start:centralAgent")).toBe(false);
    releaseAcceptance();
    const runs = await pending;
    const centralIndex = harness.events.indexOf("start:centralAgent");
    expect(centralIndex).toBeGreaterThan(harness.events.indexOf("captured:problemRadar"));
    expect(centralIndex).toBeGreaterThan(harness.events.indexOf("captured:commercialAcceptance"));
    expect(runs.map((run) => run.id)).toHaveLength(19);
    expect(new Set(harness.runOwner.mock.calls.map(([command]) => command.id)).size).toBe(17);
    expect(harness.runOwner).toHaveBeenCalledTimes(17);
    const input = harness.inputs[0];
    expect(input).toMatchObject({
      schemaVersion: "lcx_central_governance_input_v1",
      boundary: "same_cycle_completed_owners_only",
      phase: "before_central_decision",
      parentRunId: "offline-parent",
      snapshot,
    });
    const byOwner = input.byOwner as Record<string, Record<string, unknown>>;
    expect(Object.keys(byOwner)).toHaveLength(18);
    expect(byOwner.centralAgent).toBeUndefined();
    expect(Object.keys(byOwner.trainingPlan).toSorted()).toEqual([
      "compact",
      "id",
      "ok",
      "runReceipt",
    ]);
    expect(byOwner.trainingPlan.compact).toMatchObject({ sourceObservedAt: snapshot.observedAt });
    expect(byOwner.trainingPlan.runReceipt).toMatchObject({ checkedAt: snapshot.observedAt });
    expect(input.checkedAt).not.toBe(snapshot.observedAt);
    await expect(fs.access(harness.inputPaths[0])).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("excludes a supplied central result while preserving original artifact refs", async () => {
    const harness = await fixture();
    const completed = owner("trainingPlan", {
      sourceObservedAt: snapshot.observedAt,
      artifactEvidence: { status: "registered", id: "artifact-original", sha256: "original-hash" },
    });
    await harness.handoff([completed, owner("centralAgent")]);
    const input = harness.inputs[0];
    expect(input.byOwner).toEqual({
      trainingPlan: {
        id: completed.id,
        ok: completed.ok,
        compact: completed.compact,
        runReceipt: completed.runReceipt,
      },
    });
    await expect(fs.access(harness.inputPaths[0])).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports handoff write failure and oversized input without falling back to a central call", async () => {
    for (const failWrite of [true, false]) {
      const harness = await fixture({ failWrite });
      const result = await harness.handoff([
        owner("trainingPlan", { detail: failWrite ? "small" : "字".repeat(180000) }),
      ]);
      expect(result).toMatchObject({
        parsed: false,
        ok: false,
        exitCode: 1,
        runReceipt: { status: "failed" },
      });
      expect(result.error).toContain("central_governance_input_unavailable");
      expect(result.error).toContain(failWrite ? "isolated write denied" : "512 KiB");
      expect(harness.runOwner).not.toHaveBeenCalled();
      for (const directory of harness.temporaryDirectories) {
        await expect(fs.access(directory)).rejects.toMatchObject({ code: "ENOENT" });
      }
    }
  });

  it("preserves a central business failure while removing its handoff", async () => {
    const harness = await fixture({ centralFails: true });
    const result = await harness.handoff([owner("trainingPlan")]);
    expect(result).toMatchObject({
      parsed: true,
      ok: false,
      runReceipt: { status: "blocked" },
      compact: { artifactEvidence: { id: "artifact-centralAgent" } },
    });
    expect(harness.runOwner).toHaveBeenCalledTimes(1);
    await expect(fs.access(harness.temporaryDirectories[0])).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

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
    expect(payload.multiAgentPatternShadowLatestPath).toContain(
      "lcx-multi-agent-pattern-shadow-latest.json",
    );
    expect(["fresh", "stale", "missing", "blocked"]).toContain(
      payload.multiAgentPatternShadow.status,
    );
    expect(payload.summary.multiAgentPatternShadowStatus).toBe(
      payload.multiAgentPatternShadow.status,
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
        coverageStatus: "complete",
        bound: expect.any(Number),
        missingReaderContract: 0,
        readerContractReadyForAllAdapters: true,
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
        acceptedSkillOptPackets: expect.any(Number),
        materialChangeSignalCount: expect.any(Number),
        proofBoundaries: expect.objectContaining({
          dataIncreaseIsNotCapabilityIncrease: true,
          modelWeightAbsorptionRequiresPromotionProof: true,
        }),
      }),
    );
    expect(payload.owners.universeIndex?.trackedFiles).toEqual(expect.any(Number));
    expect(payload.owners.universeIndex?.dirtyFiles).toEqual(expect.any(Number));
    expect(payload.owners.universeIndex?.unmatchedChangedFiles).toEqual(expect.any(Number));
    expect(payload.owners.universeIndex?.governanceScope).toBe("repo_tracked_and_visible_files");
    expect(payload.owners.universeIndex?.governanceStatus).toBe("complete");
    expect(payload.owners.universeIndex?.governanceTotalComponents).toEqual(expect.any(Number));
    expect(payload.owners.universeIndex?.governanceGovernedComponents).toEqual(expect.any(Number));
    expect(payload.owners.universeIndex?.governanceInventoryOnlyComponents).toEqual(
      expect.any(Number),
    );
    expect(payload.owners.universeIndex?.governanceReviewRequiredComponents).toBe(0);
    expect(payload.owners.universeIndex?.governanceCoverageRate).toBe(1);
    expect(payload.owners.universeIndex?.governanceUnknownComponents).toEqual([]);
    expect(payload.owners.universeIndex?.governanceMissingRouteOwners).toEqual([]);
    expect(payload.summary.universeIndexGovernanceStatus).toBe(
      payload.owners.universeIndex?.governanceStatus,
    );
    expect(payload.summary.universeIndexGovernanceTotalComponents).toBe(
      payload.owners.universeIndex?.governanceTotalComponents,
    );
    expect(payload.owners.externalAgentUpgrade?.blacktechMechanismCount).toBe(8);
    expect(payload.owners.externalAgentUpgrade?.blacktechRuntimeAuthorityGrantedCount).toBe(0);
    expect(payload.owners.externalAgentUpgrade?.blacktechAutopilotRoutedCount).toBe(8);
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
    // The central agent's byte budget and evidence-write health have to survive the
    // governance projection, otherwise a bounded injection and a lost receipt would
    // only ever exist inside the owner's own stdout.
    expect(payload.summary.centralAgentContextBudget).toEqual(
      expect.objectContaining({
        budgetBytes: expect.any(Number),
        injectedBytes: expect.any(Number),
        overBudget: expect.any(Boolean),
      }),
    );
    expect(payload.summary.centralAgentContextBudget?.injectedBytes).toBeLessThanOrEqual(
      payload.summary.centralAgentContextBudget?.budgetBytes ?? 0,
    );
    expect(payload.summary.centralAgentEvidenceComplete).toEqual(expect.any(Boolean));
    expect(Array.isArray(payload.summary.centralAgentEvidenceWriteFailures)).toBe(true);
    expect(payload.latestStatePath).toBe(
      path.join(lcxWorkspace, "state", "lcx-governance-autopilot-latest.json"),
    );
    expect(payload.universeIndexLatestPath).toBe(
      path.join(lcxWorkspace, "state", "lcx-universe-index-latest.json"),
    );
    expect(payload.evolutionPromotionDigestPath).toBe(
      path.join(lcxWorkspace, "state", "lcx-evolution-promotion-digest-latest.json"),
    );
    expect(payload.monotonicDataLedgerLatestPath).toBe(
      path.join(lcxWorkspace, "state", "lcx-monotonic-data-ledger-latest.json"),
    );
    expect(payload.monotonicDataLedgerJsonlPath).toBe(
      path.join(lcxWorkspace, "logs", "lcx-monotonic-data-ledger.jsonl"),
    );
    expect(payload.localFailureTraceLatestPath).toBe(
      path.join(lcxWorkspace, "state", "lcx-local-failure-trace-latest.json"),
    );
    expect(payload.localFailureTraceJsonlPath).toBe(
      path.join(lcxWorkspace, "logs", "lcx-local-failure-trace.jsonl"),
    );
    expect(payload.ownerBriefLatestJsonPath).toBe(
      path.join(lcxWorkspace, "state", "lcx-owner-brief-latest.json"),
    );
    expect(payload.ownerBriefLatestMarkdownPath).toBe(
      path.join(lcxWorkspace, "state", "lcx-owner-brief-latest.md"),
    );
    expect(payload.ownerControlMapLatestJsonPath).toBe(
      path.join(lcxWorkspace, "state", "lcx-owner-control-map-latest.json"),
    );
    expect(payload.ownerControlMapLatestMarkdownPath).toBe(
      path.join(lcxWorkspace, "state", "lcx-owner-control-map-latest.md"),
    );
    expect(payload.handoffLatestPath).toBe(
      path.join(lcxWorkspace, "state", "lcx-context-recovery-handoff-latest.md"),
    );

    const latest = JSON.parse(await fs.readFile(payload.latestStatePath, "utf8")) as {
      boundary: string;
      autoTriggeredOwnerCommands: string[];
    };
    expect(latest.boundary).toBe("local_governance_autopilot_only");
    expect(latest.autoTriggeredOwnerCommands).toEqual(payload.autoTriggeredOwnerCommands);

    const digestPath = path.join(
      lcxWorkspace,
      "state",
      "lcx-evolution-promotion-digest-latest.json",
    );
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
    expect(digest.material?.externalUpgradeBlacktechMechanismCount).toBe(8);
    expect(digest.material?.externalUpgradeBlacktechRuntimeAuthorityGrantedCount).toBe(0);
    expect(digest.material?.externalUpgradeBlacktechAutopilotRoutedCount).toBe(8);
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
    expect(handoff).toContain("governanceStatus: complete");
    expect(handoff).toContain("governanceReviewRequiredComponents: 0");
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
    expect(ownerBrief).toContain("全量部件治理");
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
      fs.readFile(localOperatorPath, "utf8").catch(() => ""),
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
    if (localOperator) {
      expect(localOperator).toContain("governance_file");
      expect(localOperator).toContain("governanceAutopilot");
      expect(localOperator).toContain("NODE_GOVERNANCE_FILE");
    }
    expect(runbook).toContain("Governance Autopilot");
    expect(runbook).toContain("lcx-governance-autopilot-latest.json");
    expect(runbook).toContain("lcx-local-failure-trace-latest.json");
    expect(runbook).toContain("lcx-owner-brief-latest.md");
    expect(runbook).toContain("lcx-owner-control-map-latest.md");
  });

  it("uses a platform-compatible active process snapshot", async () => {
    const source = await fs.readFile(
      path.join(repoRoot, "scripts/operator/lcx-governance-autopilot.ts"),
      "utf8",
    );

    expect(source).toContain('"powershell.exe"');
    expect(source).toContain("Get-CimInstance Win32_Process");
    expect(source).toContain('execFileAsync("ps", ["-axo", "pid,etime,command"]');
  });

  it("still publishes its receipt when a derived evidence write fails", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-autopilot-evidence-"));
    try {
      const stateDir = path.join(home, ".openclaw", "workspace", "state");
      await fs.mkdir(stateDir, { recursive: true });
      // A directory cannot be opened for writing, so this forces exactly one
      // derived artifact write to fail without touching the real workspace.
      await fs.mkdir(path.join(stateDir, "lcx-context-recovery-handoff-latest.md"));

      const { stdout } = await execFileAsync(
        process.execPath,
        ["--import", "tsx", "scripts/operator/lcx-governance-autopilot.ts", "--json"],
        { cwd: repoRoot, env: { ...process.env, LCX_USER_HOME: home }, maxBuffer: EXEC_MAX_BUFFER },
      );
      const receipt = JSON.parse(stdout) as {
        evidenceComplete: boolean;
        evidenceWriteFailures: Array<{ artifact: string; error: string }>;
      };

      expect(receipt.evidenceComplete).toBe(false);
      const handoffFailure = receipt.evidenceWriteFailures.find(
        (failure) => failure.artifact === "contextRecoveryHandoff",
      );
      expect(handoffFailure?.error).toContain("EISDIR");

      // Every artifact written after the failing one must still be produced, and
      // the receipt must still reach the caller instead of exiting on the throw.
      for (const artifact of [
        "lcx-local-failure-trace-latest.json",
        "lcx-owner-control-map-latest.json",
        "lcx-owner-brief-latest.json",
        "lcx-governance-autopilot-latest.json",
      ]) {
        await expect(fs.stat(path.join(stateDir, artifact))).resolves.toBeTruthy();
      }
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  }, 120_000);
});
