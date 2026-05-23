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
    ["--import", "tsx", "scripts/dev/lcx-governance-autopilot.ts", "--json"],
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
    evolutionPromotionDigestPath: string;
    handoffLatestPath: string;
    autoTriggeredOwnerCommands: string[];
    ownerCommands: Array<{ id: string; parsed: boolean; command: string }>;
    triggerPolicy: {
      readOnly: boolean;
      autoUpdateLatestState: boolean;
      evolutionPromotionDigestUpdated: boolean;
      contextRecoveryHandoffUpdated: boolean;
      noOverlappingTrainingStarted: boolean;
      noRepoMutationRequired: boolean;
    };
    summary: {
      parsedOwners: number;
      ownerCount: number;
      activeTrainingOrEval: boolean;
      liveLarkBrainBindingStatus?: string;
      affectedLanes: string[];
    };
    owners: {
      mindModel?: { summary?: unknown };
      flowGraph?: { summary?: unknown };
      headTail?: { summary?: unknown };
      contextRecovery?: { compressedContextRecovered?: boolean };
      trainingPlan?: { decisionIds?: string[] };
      liveLarkBrainBinding?: { status?: string };
      problemRadar?: { actionableClusters?: string[] };
      changeImpact?: { affectedLanes?: string[] };
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
        boundary: "dev_governance_autopilot_only",
        liveTouched: false,
        providerConfigTouched: false,
        protectedMemoryTouched: false,
      }),
    );
    expect(payload.triggerPolicy).toEqual(
      expect.objectContaining({
        readOnly: true,
        autoUpdateLatestState: true,
        evolutionPromotionDigestUpdated: true,
        contextRecoveryHandoffUpdated: true,
        noOverlappingTrainingStarted: true,
        noRepoMutationRequired: true,
      }),
    );
    expect(payload.autoTriggeredOwnerCommands).toEqual(
      expect.arrayContaining([
        "problemRadar",
        "commercialAcceptance",
        "changeImpact",
        "trainingPlan",
        "liveLarkBrainBinding",
        "mindModel",
        "flowGraph",
        "headTail",
        "contextRecovery",
      ]),
    );
    expect(payload.summary.parsedOwners).toBe(payload.summary.ownerCount);
    expect(payload.ownerCommands.every((owner) => owner.parsed)).toBe(true);
    expect(payload.owners.mindModel?.summary).toBeTruthy();
    expect(payload.owners.flowGraph?.summary).toBeTruthy();
    expect(payload.owners.headTail?.summary).toBeTruthy();
    expect(Array.isArray(payload.owners.trainingPlan?.decisionIds)).toBe(true);
    expect(payload.owners.contextRecovery?.compressedContextRecovered).toEqual(expect.any(Boolean));
    expect(payload.latestStatePath).toBe(
      "/Users/liuchengxu/.openclaw/workspace/state/lcx-governance-autopilot-latest.json",
    );
    expect(payload.evolutionPromotionDigestPath).toBe(
      "/Users/liuchengxu/.openclaw/workspace/state/lcx-evolution-promotion-digest-latest.json",
    );
    expect(payload.handoffLatestPath).toBe(
      "/Users/liuchengxu/.openclaw/workspace/state/lcx-context-recovery-handoff-latest.md",
    );

    const latest = JSON.parse(await fs.readFile(payload.latestStatePath, "utf8")) as {
      boundary: string;
      autoTriggeredOwnerCommands: string[];
    };
    expect(latest.boundary).toBe("dev_governance_autopilot_only");
    expect(latest.autoTriggeredOwnerCommands).toEqual(payload.autoTriggeredOwnerCommands);

    const digestPath =
      "/Users/liuchengxu/.openclaw/workspace/state/lcx-evolution-promotion-digest-latest.json";
    const digest = JSON.parse(await fs.readFile(digestPath, "utf8")) as {
      boundary: string;
      autopilot?: { ok?: boolean; summary?: { activeTrainingOrEval?: boolean } };
      activePidSummary?: { guard?: string[]; eval?: string[]; mlx?: string[] };
      material?: { activePidCounts?: Record<string, number>; liveLarkBrainBindingStatus?: string };
      liveTouched?: boolean;
      providerConfigTouched?: boolean;
      protectedMemoryTouched?: boolean;
    };
    expect(digest.boundary).toBe("dev_evolution_promotion_digest_only");
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
    expect(digest.material?.liveLarkBrainBindingStatus).toBe(
      payload.summary.liveLarkBrainBindingStatus,
    );
    expect(digest.liveTouched).toBe(false);
    expect(digest.providerConfigTouched).toBe(false);
    expect(digest.protectedMemoryTouched).toBe(false);

    const handoff = await fs.readFile(payload.handoffLatestPath, "utf8");
    expect(handoff).toContain("# LCX Context Recovery Handoff");
    expect(handoff).toContain("boundary: dev_context_recovery_handoff_only");
    expect(handoff).toContain("activeTrainingOrEval");
    expect(handoff).toContain("selectedCleanAdapter");
    expect(handoff).toContain("latestCandidateAdapter");
    expect(handoff).toContain("liveTouched: false");
    expect(handoff).toContain("providerConfigTouched: false");
    expect(handoff).toContain("protectedMemoryTouched: false");
    expect(handoff).toContain("use fresh local-brain-training-plan");
  }, 240_000);

  it("is wired into recovery, flow graph, mind model, doctor entrypoint inventory, and local operator", async () => {
    const [recovery, flowGraph, mindModel, doctor, localOperator, runbook] = await Promise.all([
      fs.readFile(path.join(repoRoot, "scripts/dev/lcx-context-recovery-exam.ts"), "utf8"),
      fs.readFile(path.join(repoRoot, "scripts/dev/lcx-flow-graph.ts"), "utf8"),
      fs.readFile(path.join(repoRoot, "scripts/dev/lcx-mind-model.ts"), "utf8"),
      fs.readFile(path.join(repoRoot, "scripts/dev/lcx-system-doctor.ts"), "utf8"),
      fs.readFile("/Users/liuchengxu/.openclaw/bin/lcx-local-operator-loop.sh", "utf8"),
      fs.readFile(path.join(repoRoot, "ops/local-brain/README.md"), "utf8"),
    ]);

    expect(recovery).toContain("scripts/dev/lcx-governance-autopilot.ts --json");
    expect(flowGraph).toContain("governance_autopilot");
    expect(flowGraph).toContain("lcx-governance-autopilot-latest");
    expect(mindModel).toContain("governance_autopilot_auto_update");
    expect(mindModel).toContain("autoTriggeredOwnerCommands");
    expect(doctor).toContain("scripts/dev/lcx-governance-autopilot.ts");
    expect(localOperator).toContain("governance_file");
    expect(localOperator).toContain("governanceAutopilot");
    expect(localOperator).toContain("NODE_GOVERNANCE_FILE");
    expect(runbook).toContain("Governance Autopilot");
    expect(runbook).toContain("lcx-governance-autopilot-latest.json");
  });
});
