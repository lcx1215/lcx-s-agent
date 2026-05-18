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
        "node --import tsx scripts/dev/lcx-system-doctor.ts --json",
        "node --import tsx scripts/dev/local-brain-training-plan.ts --json",
      ]),
    );
    expect(Array.isArray(payload.actionableWarnings)).toBe(true);
    expect(Array.isArray(payload.warnings)).toBe(true);
  });

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
        trainingPlan: { decisionIds: string[] };
        moduleAbsorption: { blockers: string[] };
        learningSedimentation: {
          assessment: string;
          moduleLearningPipeline: {
            evalAbsorbed: number;
            weakModuleLearning: number;
            boundaryViolations: number;
            latestReview?: {
              path: string;
              evalAbsorbed: number;
              weakModuleLearning: number;
            };
          };
          gaps: string[];
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
        boundaryViolations: expect.any(Number),
      }),
    );
    expect(payload.handoffForNewWindow.text).toContain("# LCX New-Window Handoff");
    expect(payload.handoffForNewWindow.text).toContain("do not start overlapping");
    expect(payload.handoffForNewWindow.text).toContain("dev/local handoff only");
    expect(payload.handoffForNewWindow.text).toContain("deferredCommands=");
    expect(payload.handoffForNewWindow.text).toContain("safetyNotes=");
    expect(payload.handoffForNewWindow.text).toContain("moduleGateCounts=");
    expect(payload.handoffForNewWindow.text).toContain("sedimentationAssessment=");
    expect(payload.handoffForNewWindow.text).toContain("sedimentationModulePipeline=");
    expect(payload.handoffForNewWindow.text).toContain("historicalEvalAbsorbed=");
    expect(payload.handoffForNewWindow.text).toContain("sedimentationLatestReview=");
    expect(payload.handoffForNewWindow.text).toContain("sedimentationGaps=");
    expect(payload.handoffForNewWindow.text).toContain("informationalWarnings=");
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
    expect(recoverySource).toContain("local_operator_latest_is_fresh");
    expect(recoverySource).toContain("local_operator_latest_matches_current_workflow_surface");
    expect(recoverySource).toContain("fresh_training_plan_decision_visible_after_recovery");
    expect(recoverySource).toContain("runtime_lcx_operator_skills_available_and_autocued");
    expect(recoverySource).toContain("operatorDecisionIdsMatchCurrent");
    expect(recoverySource).toContain("operator_training_plan_snapshot_differs_from_current");
    expect(recoverySource).toContain("operator_training_state_snapshot_differs_from_current");
    expect(recoverySource).toContain("actionableWarnings");
    expect(recoverySource).toContain("informationalWarnings");
    expect(recoverySource).toContain("volatileTruthOwner");
    expect(recoverySource).toContain("compressed_digest_not_realtime_training_authority");
    expect(recoverySource).toContain("MAX_OPERATOR_STATE_AGE_MS");
    expect(recoverySource).toContain("flow_graph_recovers_task_waterflows");
    expect(localOperator).toContain("NODE_CONTEXT_RECOVERY_FILE");
    expect(localOperator).toContain("NODE_FLOW_FILE");
    expect(localOperator).toContain("volatileOwner");
    expect(localOperator).toContain("learningSedimentationBridge");
    expect(localOperator).toContain("compressedContextRecovered");
  });
});
