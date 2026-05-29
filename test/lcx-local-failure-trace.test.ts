import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildLocalFailureTraceReceipt,
  summarizeTraceForHandoff,
} from "../scripts/dev/lcx-local-failure-trace.ts";

describe("LCX local failure trace", () => {
  it("builds one compact failure card from existing owner evidence", () => {
    const checkedAt = "2026-05-28T21:30:00.000Z";
    const receipt = buildLocalFailureTraceReceipt({
      checkedAt,
      workspaceDir: "/tmp/lcx-workspace",
      repo: {
        cwd: "/repo",
        statusShortBranch: "## codex/example",
        dirtyCount: 2,
      },
      activePidSummary: {
        guard: ["111 guard"],
        eval: ["222 local-brain-distill-eval"],
        mlx: ["333 mlx_lm generate"],
        teacher: [],
        quota: ["444 quota"],
      },
      source: "governance_autopilot",
      sourceArtifacts: [
        "/tmp/lcx-workspace/state/lcx-governance-autopilot-latest.json",
        "/tmp/lcx-workspace/state/lcx-evolution-promotion-digest-latest.json",
      ],
      writtenArtifacts: [
        "/tmp/lcx-workspace/state/lcx-governance-autopilot-latest.json",
        "/tmp/lcx-workspace/state/lcx-context-recovery-handoff-latest.md",
      ],
      ownerCommands: [
        {
          id: "trainingPlan",
          command: "node --import tsx scripts/dev/local-brain-training-plan.ts --json",
          parsed: true,
          ok: true,
          exitCode: 0,
        },
        {
          id: "providerCouncilAcceleration",
          command: "node --import tsx scripts/dev/lcx-provider-council-acceleration.ts --json",
          parsed: true,
          ok: false,
          exitCode: 0,
        },
      ],
      summary: {
        activeTrainingOrEval: true,
        structuralOwnerFailures: ["providerCouncilAcceleration"],
        blockedClusters: ["provider_council_stale"],
        blockedGates: ["active_eval_or_mlx"],
        failedGates: [],
        fastestSafeNextAction: "wait_for_eval_idle",
      },
      boundaryFlags: {
        liveTouched: false,
        providerConfigTouched: false,
        protectedMemoryTouched: false,
      },
    });

    expect(receipt).toEqual(
      expect.objectContaining({
        ok: true,
        kind: "lcx-local-failure-trace",
        boundary: "dev_local_failure_trace_index_only",
        checkedAt,
        source: "governance_autopilot",
        result: "blocked",
        firstFailedGate: "active_eval_or_mlx",
        canBecomeTrainingMaterial: true,
        trainingMaterialReason: "blocked_or_failed_owner_output_can_seed_targeted_eval_or_sop",
        nextSafeAction: "wait_for_eval_idle",
        liveTouched: false,
        providerConfigTouched: false,
        protectedMemoryTouched: false,
      }),
    );
    expect(receipt.runId).toMatch(/^2026-05-28T21-30-00-000Z-governance_autopilot-/u);
    expect(receipt.processSummary.activeHeavy).toBe(true);
    expect(receipt.processSummary.counts).toEqual(
      expect.objectContaining({ guard: 1, eval: 1, mlx: 1, quota: 1 }),
    );
    expect(receipt.ownerResults).toEqual([
      {
        id: "trainingPlan",
        parsed: true,
        ok: true,
        exitCode: 0,
        command: "node --import tsx scripts/dev/local-brain-training-plan.ts --json",
      },
      {
        id: "providerCouncilAcceleration",
        parsed: true,
        ok: false,
        exitCode: 0,
        command: "node --import tsx scripts/dev/lcx-provider-council-acceleration.ts --json",
      },
    ]);
    expect(receipt.artifacts.written).toContain(
      "/tmp/lcx-workspace/state/lcx-context-recovery-handoff-latest.md",
    );
    expect(receipt.indexOnly).toBe(true);
  });

  it("summarizes the trace in plain Chinese for the handoff", () => {
    const receipt = buildLocalFailureTraceReceipt({
      checkedAt: "2026-05-28T21:30:00.000Z",
      workspaceDir: "/tmp/lcx-workspace",
      repo: {
        cwd: "/repo",
        statusShortBranch: "## codex/example",
        dirtyCount: 0,
      },
      activePidSummary: { guard: [], eval: [], mlx: [], teacher: [], quota: [] },
      source: "unit_test",
      sourceArtifacts: [],
      writtenArtifacts: [path.join("/tmp/lcx-workspace", "state", "latest.json")],
      ownerCommands: [{ id: "ownerA", command: "node owner-a", parsed: true, exitCode: 0 }],
      summary: {
        activeTrainingOrEval: false,
        structuralOwnerFailures: [],
        blockedClusters: [],
        blockedGates: [],
        failedGates: [],
      },
      boundaryFlags: {
        liveTouched: false,
        providerConfigTouched: false,
        protectedMemoryTouched: false,
      },
    });

    expect(summarizeTraceForHandoff(receipt)).toContain("结果: passed");
    expect(summarizeTraceForHandoff(receipt)).toContain("第一处卡点: none");
    expect(summarizeTraceForHandoff(receipt)).toContain("能否变训练材料: false");
    expect(summarizeTraceForHandoff(receipt)).toContain(
      "边界: 只做索引，不碰线上、不碰配置、不碰受保护记忆、不启动训练",
    );
  });
});
