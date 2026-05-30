import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { buildCommercialAcceptanceHarness } from "../scripts/dev/lcx-commercial-acceptance-harness.js";
import { parseJsonObjectFromOutput } from "../scripts/dev/smoke-json-output.js";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");
const EXEC_MAX_BUFFER = 24 * 1024 * 1024;

function owner(ownerName: string, payload: Record<string, unknown>) {
  return {
    ok: true,
    owner: ownerName,
    command: `${ownerName} --json`,
    payload,
  };
}

function baseInputs() {
  return {
    commercialAnswerPipeline: owner("lcx-commercial-answer-pipeline", {
      ok: true,
      summary: { passed: 5, failed: 0, total: 5 },
      contractFilters: ["candidate_answer_not_final_authority"],
      actionableFailures: [],
    }),
    problemRadar: owner("lcx-problem-cluster-radar", {
      ok: true,
      summary: {
        clusters: 0,
        actionableClusters: 0,
        repairableClusters: 0,
        blockedClusters: 0,
        watchClusters: 0,
      },
      actionableClusters: [],
      repairableClusters: [],
      blockedClusters: [],
      nextActions: [],
    }),
    flowGraph: owner("lcx-flow-graph", {
      ok: true,
      summary: { scenarios: 16, failed: 0 },
      actionableFailures: [],
    }),
    mindModel: owner("lcx-mind-model", {
      ok: true,
      summary: { failed: 0 },
      actionableFailures: [],
    }),
    liveStatus: owner("lcx-promote-live", {
      operatorStatus: {
        liveRuntimeUpdated: true,
        liveUserSeen: true,
      },
      externalChannelStatus: {
        externalChannelBound: true,
        userVisibleObserved: true,
      },
      visibleProof: {
        status: "post_migration_reply_seen",
        freshInboundCount: 1,
        freshOutboundResultCount: 1,
        acceptanceMatched: false,
      },
      devLiveDrift: {
        liveMatchesCurrentDev: true,
      },
    }),
    trainingPlan: owner("local-brain-training-plan", {
      activeProcesses: [],
      overlappingHeavyEval: false,
      decisions: [],
    }),
    systemDoctor: owner("lcx-system-doctor", {
      ok: true,
      checks: [
        {
          name: "model-council-provider-evidence",
          ok: true,
          summary: { roleFailures: {} },
        },
      ],
    }),
  };
}

async function runJsonScript(script: string) {
  try {
    return await execFileAsync(process.execPath, ["--import", "tsx", script, "--json"], {
      cwd: repoRoot,
      env: process.env,
      maxBuffer: EXEC_MAX_BUFFER,
      timeout: 180_000,
    });
  } catch (error) {
    const details = error as { stdout?: string; stderr?: string; message?: string };
    if (details.stdout) {
      parseJsonObjectFromOutput(details.stdout);
      return { stdout: details.stdout, stderr: details.stderr ?? "" };
    }
    throw new Error(
      [details.message ?? String(error), `stderr=${details.stderr ?? ""}`].join("\n"),
      {
        cause: error,
      },
    );
  }
}

describe("lcx-commercial-acceptance-harness", () => {
  it("passes when commercial, architecture, radar, live, training, and provider gates are clean", () => {
    const result = buildCommercialAcceptanceHarness(baseInputs());

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        readyForCommercialRelease: true,
        boundary: "dev_commercial_acceptance_harness_only",
        liveTouched: false,
        providerConfigTouched: false,
        protectedMemoryTouched: false,
      }),
    );
    expect(result.summary).toEqual(
      expect.objectContaining({ failed: 0, blocked: 0, watch: 0, total: 6 }),
    );
    expect(result.canaryPlan.map((entry) => entry.id)).toEqual([
      "fixed_acceptance_phrase",
      "natural_learning_prompt",
      "finance_research_prompt",
    ]);
    expect(result.gates.map((gate) => gate.id)).toContain("user_visible_observed");
    expect(result.canaryPlan).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "fixed_acceptance_phrase",
          requiredFor: "external_channel_bound",
        }),
        expect.objectContaining({
          id: "natural_learning_prompt",
          requiredFor: "user_visible_observed",
        }),
      ]),
    );
  });

  it("blocks release when live runtime is updated but no post-migration Lark canary is visible", () => {
    const inputs = baseInputs();
    inputs.liveStatus = owner("lcx-promote-live", {
      operatorStatus: {
        liveRuntimeUpdated: true,
        liveUserSeen: false,
      },
      externalChannelStatus: {
        externalChannelBound: true,
        userVisibleObserved: false,
      },
      visibleProof: {
        status: "waiting_for_real_lark",
        freshInboundCount: 0,
        freshOutboundResultCount: 0,
        acceptanceMatched: false,
      },
    });

    const result = buildCommercialAcceptanceHarness(inputs);

    expect(result.ok).toBe(false);
    expect(result.blockedGates).toContain("post_migration_lark_canary_missing");
    expect(result.gates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "post_migration_lark_canary_missing",
          status: "blocked",
          severity: "P2",
        }),
      ]),
    );
  });

  it("blocks release when the Lark external channel is not bound", () => {
    const inputs = baseInputs();
    inputs.liveStatus = owner("lcx-promote-live", {
      operatorStatus: {
        liveRuntimeUpdated: false,
        liveUserSeen: false,
      },
      externalChannelStatus: {
        externalChannelBound: false,
        userVisibleObserved: false,
      },
      visibleProof: {
        status: "waiting_for_real_lark",
        freshInboundCount: 0,
        freshOutboundResultCount: 0,
        acceptanceMatched: false,
      },
      devLiveDrift: {
        liveMatchesCurrentDev: false,
      },
    });

    const result = buildCommercialAcceptanceHarness(inputs);

    expect(result.ok).toBe(false);
    expect(result.blockedGates).toContain("external_channel_not_bound");
    expect(result.gates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "external_channel_not_bound",
          status: "blocked",
          severity: "P1",
        }),
      ]),
    );
  });

  it("reports provider council degradation without claiming all model APIs are stable", () => {
    const inputs = baseInputs();
    inputs.systemDoctor = owner("lcx-system-doctor", {
      ok: false,
      checks: [
        {
          name: "model-council-provider-evidence",
          ok: false,
          error: "latest learning council degraded: failedRoles=deepseek",
          summary: { roleFailures: { deepseek: 2 } },
        },
      ],
    });

    const result = buildCommercialAcceptanceHarness(inputs);

    expect(result.blockedGates).toContain("provider_council_degraded");
    expect(result.gates.find((gate) => gate.id === "provider_council_degraded")).toEqual(
      expect.objectContaining({
        status: "blocked",
        severity: "P2",
      }),
    );
  });

  it("treats active Qwen guard as watch-only and never as permission to start overlap", () => {
    const inputs = baseInputs();
    inputs.trainingPlan = owner("local-brain-training-plan", {
      activeProcesses: [{ pid: 123, role: "guard", elapsed: "01:00" }],
      overlappingHeavyEval: false,
      decisions: [{ id: "training_already_active" }],
    });

    const result = buildCommercialAcceptanceHarness(inputs);

    expect(result.ok).toBe(true);
    expect(result.watchGates).toContain("training_active_watch_only");
    expect(
      result.gates.find((gate) => gate.id === "training_active_watch_only")?.nextAction,
    ).toContain("Do not start overlapping training");
  });

  it("does not inflate radar P3 owner-blocked clusters into commercial P2 blockers", () => {
    const inputs = baseInputs();
    inputs.problemRadar = owner("lcx-problem-cluster-radar", {
      ok: true,
      summary: {
        clusters: 1,
        actionableClusters: 0,
        repairableClusters: 0,
        blockedClusters: 1,
        watchClusters: 1,
        highestSeverity: "P3",
      },
      blockedClusters: ["adapter_promotion_truth_cluster"],
      blockedActions: [
        "adapter_promotion_truth_cluster: blocked_by=active_local_brain_guard_or_eval",
      ],
    });

    const result = buildCommercialAcceptanceHarness(inputs);

    expect(result.ok).toBe(true);
    expect(result.blockedGates).not.toContain("radar_blocked_problem_clusters");
    expect(result.watchGates).toContain("radar_blocked_problem_clusters");
    expect(result.gates.find((gate) => gate.id === "radar_blocked_problem_clusters")).toEqual(
      expect.objectContaining({
        status: "watch",
        severity: "P3",
      }),
    );
  });

  it("runs against the current repo without sending Lark messages or touching live sender", async () => {
    const { stdout } = await runJsonScript("scripts/dev/lcx-commercial-acceptance-harness.ts");
    const payload = JSON.parse(stdout) as {
      boundary: string;
      liveTouched: boolean;
      providerConfigTouched: boolean;
      protectedMemoryTouched: boolean;
      ownerCommands: string[];
    };

    expect(payload.boundary).toBe("dev_commercial_acceptance_harness_only");
    expect(payload.liveTouched).toBe(false);
    expect(payload.providerConfigTouched).toBe(false);
    expect(payload.protectedMemoryTouched).toBe(false);
    expect(payload.ownerCommands).toEqual(
      expect.arrayContaining([
        "node --import tsx scripts/dev/lcx-commercial-answer-pipeline.ts --json",
        "node --import tsx scripts/dev/lcx-problem-cluster-radar.ts --json",
      ]),
    );
  }, 240_000);
});
