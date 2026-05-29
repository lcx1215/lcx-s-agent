import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");
const EXEC_MAX_BUFFER = 20 * 1024 * 1024;
const localRuntimeEnv = {
  ...process.env,
  HOME: "/Users/liuchengxu",
  OPENCLAW_CONFIG_PATH: "/Users/liuchengxu/.openclaw/openclaw.json",
  OPENCLAW_STATE_DIR: "/Users/liuchengxu/.openclaw",
};

async function runJsonScript(script: string) {
  try {
    return await execFileAsync(process.execPath, ["--import", "tsx", script, "--json"], {
      cwd: repoRoot,
      env: localRuntimeEnv,
      maxBuffer: EXEC_MAX_BUFFER,
    });
  } catch (error) {
    const details = error as { stdout?: string; stderr?: string; message?: string };
    throw new Error(
      [
        details.message ?? String(error),
        `stdout=${details.stdout ?? ""}`,
        `stderr=${details.stderr ?? ""}`,
      ].join("\n"),
      { cause: error },
    );
  }
}

async function runJsonScriptWithArgs(script: string, args: string[]) {
  try {
    return await execFileAsync(process.execPath, ["--import", "tsx", script, ...args], {
      cwd: repoRoot,
      env: localRuntimeEnv,
      maxBuffer: EXEC_MAX_BUFFER,
    });
  } catch (error) {
    const details = error as { stdout?: string; stderr?: string; message?: string };
    throw new Error(
      [
        details.message ?? String(error),
        `stdout=${details.stdout ?? ""}`,
        `stderr=${details.stderr ?? ""}`,
      ].join("\n"),
      { cause: error },
    );
  }
}

describe("LCX compressed context recovery exam", () => {
  it("proves a new coding window can recover from durable evidence", async () => {
    const { stdout } = await runJsonScript("scripts/dev/lcx-context-recovery-exam.ts");
    const payload = JSON.parse(stdout) as {
      ok: boolean;
      boundary: string;
      compressedContextRecovered: boolean;
      summary: { failed: number; total: number };
      requiredRecoveryCommands: string[];
      actionableWarnings: string[];
      warnings: Array<{ id: string; summary: string }>;
      liveTouched: boolean;
      providerConfigTouched: boolean;
      protectedMemoryTouched: boolean;
    };

    expect(payload).toEqual(
      expect.objectContaining({
        ok: true,
        boundary: "dev_context_recovery_exam_only",
        compressedContextRecovered: true,
        liveTouched: false,
        providerConfigTouched: false,
        protectedMemoryTouched: false,
      }),
    );
    expect(payload.summary.failed).toBe(0);
    expect(payload.summary.total).toBeGreaterThanOrEqual(7);
    expect(payload.requiredRecoveryCommands).toEqual(
      expect.arrayContaining([
        "node --import tsx scripts/dev/lcx-mind-model.ts --json",
        "node --import tsx scripts/dev/lcx-flow-graph.ts --json",
        "node --import tsx scripts/dev/lcx-universe-index.ts --json",
        "node --import tsx scripts/dev/lcx-governance-autopilot.ts --json",
        "node --import tsx scripts/dev/lcx-self-repair-hands.ts --json",
        "node --import tsx scripts/dev/lcx-system-doctor.ts --json",
        "node --import tsx scripts/dev/local-brain-training-plan.ts --json",
        "node --import tsx scripts/dev/lcx-live-lark-brain-binding.ts --json",
        "node --import tsx scripts/dev/lcx-problem-cluster-radar.ts --json",
        "node --import tsx scripts/dev/lcx-external-agent-upgrade-radar.ts --json",
      ]),
    );
    expect(Array.isArray(payload.actionableWarnings)).toBe(true);
    expect(Array.isArray(payload.warnings)).toBe(true);
  }, 240_000);

  it("can emit a compact new-window handoff from the existing recovery owner", async () => {
    const { stdout } = await runJsonScriptWithArgs("scripts/dev/lcx-context-recovery-exam.ts", [
      "--handoff",
      "--json",
    ]);
    const payload = JSON.parse(stdout) as {
      ok: boolean;
      handoffForNewWindow: {
        boundary: string;
        owner: string;
        purpose: string;
        changeImpact: {
          changedFiles: string[];
          affectedLanes: string[];
          unmatchedFiles: string[];
          deferredCommands: string[];
          safetyNotes: string[];
        };
        liveStatus: {
          liveRuntimeUpdated?: boolean;
          liveUserSeen?: boolean;
          liveMatchesCurrentDev?: boolean;
        };
        trainingPlan: {
          decisionIds: string[];
          evolutionAcceleration?: {
            fastestSafeNextAction?: string;
            stepIds: string[];
          };
        };
        moduleAbsorption: { blockers: string[] };
        learningSedimentation: {
          assessment: string;
          moduleLearningPipeline: {
            evalAbsorbed: number;
            weakModuleLearning: number;
            exactMissingProofReceipts: number;
            proofGapSummary: Record<string, number>;
            nextProofQueue: unknown[];
            boundaryViolations: number;
            latestReview?: {
              path: string;
              evalAbsorbed: number;
              weakModuleLearning: number;
              exactMissingProofReceipts?: number;
            };
          };
          gaps: string[];
        };
        selfRepairHands: {
          boundary: string;
          status: string;
          absorptionStatus: string;
          latestJsonPath: string;
          jsonlPath: string;
        };
        text: string;
      };
    };

    expect(payload.ok).toBe(true);
    expect(payload.handoffForNewWindow).toEqual(
      expect.objectContaining({
        boundary: "dev_context_recovery_handoff_only",
        owner: "lcx-context-recovery-exam",
      }),
    );
    expect(payload.handoffForNewWindow.purpose).toContain("parallel memory lane");
    expect(Array.isArray(payload.handoffForNewWindow.changeImpact.changedFiles)).toBe(true);
    expect(Array.isArray(payload.handoffForNewWindow.changeImpact.affectedLanes)).toBe(true);
    expect(Array.isArray(payload.handoffForNewWindow.changeImpact.unmatchedFiles)).toBe(true);
    expect(Array.isArray(payload.handoffForNewWindow.changeImpact.deferredCommands)).toBe(true);
    expect(Array.isArray(payload.handoffForNewWindow.changeImpact.safetyNotes)).toBe(true);
    expect(payload.handoffForNewWindow.liveStatus).toEqual(
      expect.objectContaining({
        liveRuntimeUpdated: expect.any(Boolean),
        liveUserSeen: expect.any(Boolean),
      }),
    );
    expect(Array.isArray(payload.handoffForNewWindow.trainingPlan.decisionIds)).toBe(true);
    expect(Array.isArray(payload.handoffForNewWindow.moduleAbsorption.blockers)).toBe(true);
    expect(Array.isArray(payload.handoffForNewWindow.learningSedimentation.gaps)).toBe(true);
    expect(payload.handoffForNewWindow.learningSedimentation.assessment).toEqual(
      expect.any(String),
    );
    expect(payload.handoffForNewWindow.learningSedimentation.moduleLearningPipeline).toEqual(
      expect.objectContaining({
        evalAbsorbed: expect.any(Number),
        weakModuleLearning: expect.any(Number),
        exactMissingProofReceipts: expect.any(Number),
        proofGapSummary: expect.any(Object),
        nextProofQueue: expect.any(Array),
        boundaryViolations: expect.any(Number),
      }),
    );
    expect(payload.handoffForNewWindow.selfRepairHands).toEqual(
      expect.objectContaining({
        boundary: "dev_self_repair_hands_only",
        absorptionStatus: "candidate_only_not_in_train_slice",
      }),
    );
    expect(payload.handoffForNewWindow.text).toContain("# LCX New-Window Handoff");
    expect(payload.handoffForNewWindow.text).toContain("do not start overlapping");
    expect(payload.handoffForNewWindow.text).toContain("context handoff is dev/local evidence");
    expect(payload.handoffForNewWindow.text).not.toContain("not live-runtime-updated");
    expect(payload.handoffForNewWindow.text).toContain("Live Boundary Truth");
    expect(payload.handoffForNewWindow.text).toContain("volatileOwner=lcx-promote-live");
    expect(payload.handoffForNewWindow.text).toContain("liveRuntimeUpdated=");
    expect(payload.handoffForNewWindow.text).toContain("liveUserSeen=");
    expect(payload.handoffForNewWindow.text).toContain("liveLarkBrainBinding=");
    expect(payload.handoffForNewWindow.text).toContain("liveLarkBrainBindingMissingProof=");
    expect(payload.handoffForNewWindow.text).toContain("deferredCommands=");
    expect(payload.handoffForNewWindow.text).toContain("safetyNotes=");
    expect(payload.handoffForNewWindow.text).toContain("moduleGateCounts=");
    expect(payload.handoffForNewWindow.text).toContain("moduleExactMissingProofReceipts=");
    expect(payload.handoffForNewWindow.text).toContain("moduleProofGapSummary=");
    expect(payload.handoffForNewWindow.text).toContain("moduleNextProofOwners=");
    expect(payload.handoffForNewWindow.text).toContain("evolutionAcceleration=");
    expect(payload.handoffForNewWindow.text).toContain("evolutionAccelerationSteps=");
    expect(
      Array.isArray(payload.handoffForNewWindow.trainingPlan.evolutionAcceleration?.stepIds),
    ).toBe(true);
    expect(payload.handoffForNewWindow.text).toContain("sedimentationAssessment=");
    expect(payload.handoffForNewWindow.text).toContain("sedimentationModulePipeline=");
    expect(payload.handoffForNewWindow.text).toContain("historicalEvalAbsorbed=");
    expect(payload.handoffForNewWindow.text).toContain("sedimentationLatestReview=");
    expect(payload.handoffForNewWindow.text).toContain("sedimentationGaps=");
    expect(payload.handoffForNewWindow.text).toContain("informationalWarnings=");
    expect(payload.handoffForNewWindow.text).toContain("Self-Repair Hands");
    expect(payload.handoffForNewWindow.text).toContain("owner=lcx-self-repair-hands");
    expect(payload.handoffForNewWindow.text).toContain(
      "absorptionStatus=candidate_only_not_in_train_slice",
    );
  }, 240_000);

  it("keeps the recovery exam visible in durable doctrine and local automation", async () => {
    const [agents, runbook, doctorSource, recoverySource, localOperator] = await Promise.all([
      fs.readFile(path.join(repoRoot, "AGENTS.md"), "utf8"),
      fs.readFile(path.join(repoRoot, "ops/local-brain/README.md"), "utf8"),
      fs.readFile(path.join(repoRoot, "scripts/dev/lcx-system-doctor.ts"), "utf8"),
      fs.readFile(path.join(repoRoot, "scripts/dev/lcx-context-recovery-exam.ts"), "utf8"),
      fs.readFile("/Users/liuchengxu/.openclaw/bin/lcx-local-operator-loop.sh", "utf8"),
    ]);

    expect(agents).toContain("lcx-context-recovery-exam");
    expect(runbook).toContain("compressed-window proof");
    expect(doctorSource).toContain("context-recovery-exam");
    expect(doctorSource).toContain("flow-graph-exam");
    expect(doctorSource).toContain("lcx-governance-autopilot");
    expect(doctorSource).toContain("liveLarkBrainBinding");
    expect(recoverySource).toContain("local_operator_latest_is_fresh");
    expect(recoverySource).toContain("local_operator_latest_matches_current_workflow_surface");
    expect(recoverySource).toContain("fresh_training_plan_decision_visible_after_recovery");
    expect(recoverySource).toContain("runtime_lcx_operator_skills_available_and_autocued");
    expect(recoverySource).toContain("external_agent_upgrade_radar_recovered_and_autocued");
    expect(recoverySource).toContain("self_repair_hands_recovered_and_supervised");
    expect(recoverySource).toContain("lcx-self-repair-hands");
    expect(recoverySource).toContain("lcx-external-agent-upgrade-radar");
    expect(recoverySource).toContain("github_cli_agentic_workflow_control");
    expect(recoverySource).toContain("github_cli_agentic_control_plane");
    expect(recoverySource).toContain("externalAgentCandidateIds");
    expect(recoverySource).toContain("externalAgentBlacktechIds");
    expect(recoverySource).toContain("operatorDecisionIdsMatchCurrent");
    expect(recoverySource).toContain("operator_training_plan_snapshot_differs_from_current");
    expect(recoverySource).toContain("operator_training_state_snapshot_differs_from_current");
    expect(recoverySource).toContain("actionableWarnings");
    expect(recoverySource).toContain("informationalWarnings");
    expect(recoverySource).toContain("volatileTruthOwner");
    expect(recoverySource).toContain("compressed_digest_not_realtime_training_authority");
    expect(recoverySource).toContain("MAX_OPERATOR_STATE_AGE_MS");
    expect(recoverySource).toContain("flow_graph_recovers_task_waterflows");
    expect(recoverySource).toContain("universe_index_recovers_total_inventory");
    expect(recoverySource).toContain("lcx-universe-index");
    expect(recoverySource).toContain("lcx-problem-cluster-radar");
    expect(recoverySource).toContain("currentLiveStatusSnapshot");
    expect(recoverySource).toContain("Live Boundary Truth");
    expect(recoverySource).toContain("volatileOwner=lcx-promote-live");
    expect(localOperator).toContain("NODE_CONTEXT_RECOVERY_FILE");
    expect(localOperator).toContain("NODE_FLOW_FILE");
    expect(localOperator).toContain("NODE_GOVERNANCE_FILE");
    expect(localOperator).toContain("governanceAutopilot");
    expect(localOperator).toContain("volatileOwner");
    expect(localOperator).toContain("learningSedimentationBridge");
    expect(localOperator).toContain("compressedContextRecovered");
  });
});
