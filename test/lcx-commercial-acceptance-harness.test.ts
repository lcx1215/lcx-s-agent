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
      summary: { passed: 34, failed: 0, total: 34 },
      contractFilters: [
        "real_lark_short_canary_suite_required",
        "short_intent_family_fuzzer_required",
        "unknown_short_intent_clean_failure_required",
        "provider_council_evidence_required",
        "provider_outputs_not_faked",
        "async_task_receipt_required_for_deferred_work",
        "stored_only_is_not_learning",
        "retrieval_apply_eval_review_required",
        "finance_data_gateway_snapshot_required_for_numbers",
        "finance_data_conflicts_route_to_provenance_review",
        "positive_visible_answer_acceptance_required",
        "direct_answer_not_overconservative_required",
        "visible_answer_quality_fuzzer_required",
      ],
      actionableFailures: [],
    }),
    shortIntentFuzzer: owner("lcx-lark-short-intent-fuzzer", {
      ok: true,
      boundary: "dev_lark_short_intent_fuzzer_only",
      macroContract: {
        notWhitelist: true,
        unknownShortIntentBehavior:
          "A terse ask that cannot be safely classified must fail cleanly with missing evidence or next-step reason.",
      },
      summary: {
        families: 10,
        generated: 70,
        passed: 70,
        failed: 0,
        failedFamilies: [],
      },
      failedCases: [],
      generatedEvalSeeds: [
        {
          caseId: "short_finance_action_intent_01",
          familyId: "short_finance_action_intent",
          ask: "能买吗",
        },
      ],
    }),
    visibleAnswerQualityFuzzer: owner("lcx-visible-answer-quality-fuzzer", {
      ok: true,
      boundary: "dev_visible_answer_quality_fuzzer_only",
      macroContract: {
        positiveAcceptanceNotOnlyRejection: true,
        conciseDirectAnswerRequired: true,
        noVagueConservativeFallback: true,
      },
      summary: {
        families: 8,
        positive: 8,
        negative: 14,
        total: 22,
        passed: 22,
        failed: 0,
        positiveFailures: 0,
        negativeFailures: 0,
      },
      failedCases: [],
      perFamily: [
        {
          id: "status_with_checked_evidence",
          productContract:
            "status asks answer current state, blocker, and next step from owner evidence",
          positive: 1,
          negative: 2,
          passed: 3,
          failed: 0,
        },
      ],
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
    externalChannelStatus: owner("lcx-external-channel-status", {
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
    externalChannelBindingStatus: owner("lcx-external-channel-binding", {
      externalChannelBinding: {
        status: "channel_runtime_probe_ok_user_visible_pending",
        userVisibleObserved: true,
        missingProof: [],
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
    providerCouncilAcceleration: owner("lcx-provider-council-acceleration", {
      ok: true,
      status: "provider_council_acceleration_receipt_written",
      action: "provider_council_run_completed",
      freshCompleteCouncil: false,
      dailyUse: {
        completeCouncilInWindow: true,
        missingSuccessfulRoles: [],
        dueNow: false,
      },
      latestCouncil: {
        path: "bank/knowledge/learning-councils/2026-05-31.json",
        successfulRoles: ["kimi", "minimax", "deepseek"],
      },
      outputsFeed: [
        "skillopt_candidate_edit",
        "eval_case",
        "teacher_curriculum",
        "rejected_edit_buffer",
        "discard",
      ],
    }),
    moduleLearningAbsorptionGate: owner("lcx-module-learning-absorption-gate", {
      ok: true,
      absorptionReady: true,
      gateDecision: "ready_for_eval_absorbed_review",
      absorptionDecision: "keep",
      blockers: [],
      counts: {
        weakReceiptCount: 0,
        boundaryViolations: 0,
        missingAbsorptionEvidenceReceipts: 0,
        evalAbsorbed: 6,
        terminalNonAbsorbedRows: 2,
      },
      terminalNonAbsorbedRows: [
        {
          targetModule: "portfolio_risk_gates",
          status: "stored_only",
          keepDownrankDiscardDecision: "discard",
        },
      ],
    }),
    financeDataGatewaySmoke: owner("finance-data-gateway-smoke-clean", {
      ok: true,
      qualityStatus: "ready",
      providerRolesPresent: [
        "primary_market_data",
        "cross_check_market_data",
        "official_or_issuer_reference",
      ],
      requiredNextSteps: [],
      conflicts: [],
    }),
    financeDataGatewayConflictSmoke: owner("finance-data-gateway-smoke-conflict", {
      ok: true,
      qualityStatus: "needs_review",
      providerRolesPresent: [
        "primary_market_data",
        "cross_check_market_data",
        "official_or_issuer_reference",
      ],
      requiredNextSteps: ["run_data_provenance_quality_review"],
      conflicts: [{ fieldName: "last_price" }],
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
      expect.objectContaining({ failed: 0, blocked: 0, watch: 0, total: 11 }),
    );
    expect(result.canaryPlan.map((entry) => entry.id)).toEqual([
      "natural_plain_probe",
      "optional_fixed_receipt_anchor",
      "finance_research_prompt",
      "real_short_lark_canary_suite",
      "short_intent_family_fuzzer",
      "visible_answer_quality_fuzzer",
      "three_provider_council_receipt",
      "learning_sedimentation_closed_loop",
      "finance_gateway_async_receipt_experience",
    ]);
    expect(result.gates.map((gate) => gate.id)).toContain("user_visible_observed");
    expect(result.canaryPlan).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "natural_plain_probe",
          requiredFor: "user_visible_observed",
        }),
        expect.objectContaining({
          id: "optional_fixed_receipt_anchor",
          requiredFor: "optional_receipt_anchor",
        }),
        expect.objectContaining({
          id: "three_provider_council_receipt",
          requiredFor: "provider_council_evidence",
        }),
        expect.objectContaining({
          id: "short_intent_family_fuzzer",
          requiredFor: "unknown_short_intent_clean_failure",
        }),
        expect.objectContaining({
          id: "visible_answer_quality_fuzzer",
          requiredFor: "direct_answer_quality",
        }),
        expect.objectContaining({
          id: "learning_sedimentation_closed_loop",
          requiredFor: "learning_absorption_truth",
        }),
        expect.objectContaining({
          id: "finance_gateway_async_receipt_experience",
          requiredFor: "numeric_answer_and_async_reply_quality",
        }),
      ]),
    );
    expect(result.gates.map((gate) => gate.id)).toEqual(
      expect.arrayContaining([
        "provider_council_three_role_evidence_present",
        "short_intent_family_fuzzer_clean",
        "visible_answer_quality_fuzzer_clean",
        "module_learning_closed_loop_clean",
        "finance_data_gateway_contract_clean",
      ]),
    );
  });

  it("blocks release when live runtime is updated but no post-migration Lark canary is visible", () => {
    const inputs = baseInputs();
    inputs.externalChannelStatus = owner("lcx-external-channel-status", {
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
    inputs.externalChannelBindingStatus = owner("lcx-external-channel-binding", {
      externalChannelBinding: {
        status: "channel_runtime_probe_ok_user_visible_pending",
        userVisibleObserved: false,
        missingProof: ["fresh_real_lark_inbound_and_outbound_user_visible_observed"],
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

  it("uses the external-channel binding owner before the legacy promote-live commit gate", () => {
    const inputs = baseInputs();
    inputs.externalChannelStatus = owner("lcx-external-channel-status", {
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
    inputs.externalChannelBindingStatus = owner("lcx-external-channel-binding", {
      externalChannelBinding: {
        status: "channel_runtime_probe_ok_user_visible_pending",
        userVisibleObserved: false,
        missingProof: ["fresh_real_lark_inbound_and_outbound_user_visible_observed"],
      },
    });

    const result = buildCommercialAcceptanceHarness(inputs);

    expect(result.ok).toBe(false);
    expect(result.blockedGates).not.toContain("external_channel_not_bound");
    expect(result.blockedGates).toContain("post_migration_lark_canary_missing");
  });

  it("falls back to the canonical binding owner when external-channel status is unavailable", () => {
    const inputs = baseInputs();
    inputs.externalChannelStatus = {
      ok: false,
      owner: "lcx-external-channel-status",
      command: "node --import tsx scripts/dev/lcx-external-channel-status.ts --json",
      error: "legacy status probe unavailable",
    };
    inputs.externalChannelBindingStatus = owner("lcx-external-channel-binding", {
      externalChannelBinding: {
        status: "channel_runtime_probe_ok_user_visible_observed",
        userVisibleObserved: true,
        missingProof: [],
      },
    });

    const result = buildCommercialAcceptanceHarness(inputs);

    expect(result.failedGates).not.toContain("lcx-external-channel-status_owner_unavailable");
    expect(result.blockedGates).not.toContain("external_channel_not_bound");
    expect(result.gates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "user_visible_observed",
          status: "passed",
        }),
      ]),
    );
  });

  it("blocks release when the Lark external channel is not bound", () => {
    const inputs = baseInputs();
    inputs.externalChannelStatus = owner("lcx-external-channel-status", {
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
    inputs.externalChannelBindingStatus = owner("lcx-external-channel-binding", {
      externalChannelBinding: {
        status: "ready_for_channel_bind_apply",
        userVisibleObserved: false,
        missingProof: ["lark_external_channel_gateway_restarted_after_selected_adapter"],
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

  it("blocks release when the short-intent family fuzzer regresses beyond fixed canaries", () => {
    const inputs = baseInputs();
    inputs.shortIntentFuzzer = owner("lcx-lark-short-intent-fuzzer", {
      ok: true,
      summary: {
        families: 10,
        generated: 70,
        passed: 69,
        failed: 1,
      },
      macroContract: { notWhitelist: true },
      failedCases: [{ caseId: "short_generic_intro_wrong_route_99" }],
    });

    const result = buildCommercialAcceptanceHarness(inputs);

    expect(result.ok).toBe(false);
    expect(result.failedGates).toContain("short_intent_family_fuzzer_regression");
    expect(result.gates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "short_intent_family_fuzzer_regression",
          status: "failed",
          severity: "P1",
        }),
      ]),
    );
  });

  it("blocks release when good visible answers are no longer adopted", () => {
    const inputs = baseInputs();
    inputs.visibleAnswerQualityFuzzer = owner("lcx-visible-answer-quality-fuzzer", {
      ok: true,
      summary: {
        families: 8,
        positive: 8,
        negative: 14,
        total: 22,
        passed: 21,
        failed: 1,
        positiveFailures: 1,
        negativeFailures: 0,
      },
      macroContract: {
        positiveAcceptanceNotOnlyRejection: true,
        conciseDirectAnswerRequired: true,
      },
      failedCases: [{ caseId: "market_data_boundary_still_useful_positive" }],
    });

    const result = buildCommercialAcceptanceHarness(inputs);

    expect(result.ok).toBe(false);
    expect(result.failedGates).toContain("visible_answer_quality_fuzzer_regression");
    expect(result.gates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "visible_answer_quality_fuzzer_regression",
          status: "failed",
          severity: "P1",
        }),
      ]),
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

  it("runs against the current repo without sending Lark messages or touching external channel sender", async () => {
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
        "node --import tsx scripts/dev/lcx-lark-short-intent-fuzzer.ts --json",
        "node --import tsx scripts/dev/lcx-visible-answer-quality-fuzzer.ts --json",
        "node --import tsx scripts/dev/lcx-problem-cluster-radar.ts --json",
      ]),
    );
  }, 240_000);
});
