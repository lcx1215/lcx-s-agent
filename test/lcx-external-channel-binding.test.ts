import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildExternalChannelBindingDecision,
  applyExternalChannelLocalVerification,
  readExternalChannelLocalVerification,
  buildExternalChannelBindingSummary,
  parseExternalChannelBindingArgs,
  runExternalChannelBinding,
} from "../scripts/operator/lcx-external-channel-binding.js";
import { resolveExternalChannelTruth } from "../scripts/operator/lcx-external-channel-status.js";

describe("lcx-external-channel-binding", () => {
  it("keeps platform compatibility separate from runtime activation and model promotion", async () => {
    expect(() => parseExternalChannelBindingArgs(["--compatibility-only", "--apply"])).toThrow(
      "cannot apply",
    );
    expect(parseExternalChannelBindingArgs(["--compatibility-only"]).snapshotPath).toContain(
      "compatibility-latest",
    );
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-channel-compat-"));
    try {
      const result = await runExternalChannelBinding(
        parseExternalChannelBindingArgs([
          "--compatibility-only",
          "--snapshot-path",
          path.join(root, "receipt.json"),
        ]),
      );
      expect(result).toMatchObject({
        boundary: "local_external_channel_compatibility_only",
        externalChannelApplied: false,
        userVisibleObserved: false,
        compatibility: {
          researchTool: "finance_research_run",
          localAdapterPromotionRequired: false,
        },
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  const readyTrainingPlan = {
    boundary: "local_brain_training_plan_only",
    activeProcesses: [],
    externalChannelBinding: {
      boundary: "local_external_channel_binding_plan_only",
      status: "ready_for_apply",
      action:
        "route_external_transport_to_selected_clean_answer_path_and_collect_user_visible_proof",
      selectedCleanAdapter: "/tmp/adapter-clean-r4",
      missingProof: [
        "external_channel_source_drift_zero_after_selected_adapter",
        "external_message_channel_gateway_restarted_after_selected_adapter",
        "external_message_channel_status_ok_after_restart",
        "fresh_real_external_inbound_and_outbound_user_visible_observed",
      ],
    },
    liveExternalBrainBinding: {
      boundary: "local_live_external_brain_binding_plan_only",
      status: "ready_for_live_runtime_binding",
      action:
        "route_external_transport_to_selected_clean_answer_path_and_collect_user_visible_proof",
      selectedCleanAdapter: "/tmp/adapter-clean-r4",
      missingProof: [
        "live_sidecar_source_drift_zero_after_selected_adapter",
        "live_gateway_and_external_proxy_restarted_after_selected_adapter",
        "live_external_channel_status_ok_after_restart",
        "fresh_real_external_inbound_and_outbound_seen",
      ],
    },
  };

  it("keeps missing optional local verification compatible but blocks an explicit bad host pin before apply", async () => {
    const legacy = await readExternalChannelLocalVerification({});
    expect(legacy).toMatchObject({ status: "not_observed", executionAuthority: false });
    expect(
      await readExternalChannelLocalVerification({
        localVerificationTestResultSha256: "a".repeat(64),
      }),
    ).toMatchObject({ status: "blocked", gaps: ["local_verification_receipt_unavailable"] });
    const ready = buildExternalChannelBindingDecision({
      trainingPlan: readyTrainingPlan,
      apply: false,
      liveTouched: false,
    });
    expect(applyExternalChannelLocalVerification(ready, legacy)).toBe(ready);
    const parsed = parseExternalChannelBindingArgs([
      "--local-verification-receipt",
      "/tmp/unread-local-verification",
      "--local-verification-test-result-sha256",
      "not-a-pin",
    ]);
    const invalid = await readExternalChannelLocalVerification(parsed);
    expect(invalid).toMatchObject({
      status: "blocked",
      gaps: ["local_verification_independent_test_pin_unavailable"],
    });
    expect(applyExternalChannelLocalVerification(ready, invalid)).toMatchObject({
      status: "deferred_training_plan_not_ready",
      missingProof: expect.arrayContaining(["local_verification_independent_test_pin_unavailable"]),
      liveTouched: false,
    });
  });

  it("defers external-channel binding while eval or MLX is active", () => {
    const decision = buildExternalChannelBindingDecision({
      apply: true,
      liveTouched: false,
      trainingPlan: {
        ...readyTrainingPlan,
        activeProcesses: [
          { pid: 101, role: "local_brain_eval", elapsed: "01:00" },
          { pid: 102, role: "mlx", elapsed: "00:20" },
        ],
      },
    });

    expect(decision).toMatchObject({
      status: "deferred_active_training_or_eval",
      action: "wait_for_current_eval_then_bind_live_to_selected_clean_adapter",
      selectedCleanAdapter: "/tmp/adapter-clean-r4",
      heavyActive: true,
      liveTouched: false,
      liveUserSeen: false,
      providerConfigTouched: false,
      protectedMemoryTouched: false,
    });
  });

  it("exposes an apply-ready state without touching the channel runtime", () => {
    const decision = buildExternalChannelBindingDecision({
      apply: false,
      liveTouched: false,
      trainingPlan: readyTrainingPlan,
    });

    expect(decision).toMatchObject({
      status: "ready_for_apply",
      action: "run_apply_when_operator_allows_live_runtime_restart",
      selectedCleanAdapter: "/tmp/adapter-clean-r4",
      heavyActive: false,
      liveTouched: false,
      liveUserSeen: false,
    });
  });

  it("keeps user-visible proof separate after a successful runtime probe", () => {
    const decision = buildExternalChannelBindingDecision({
      apply: true,
      liveTouched: true,
      externalChannelStatusOk: true,
      trainingPlan: readyTrainingPlan,
    });

    expect(decision).toMatchObject({
      status: "applied_runtime_probe_ok",
      action: "keep_waiting_for_real_external_user_seen_proof",
      selectedCleanAdapter: "/tmp/adapter-clean-r4",
      liveTouched: true,
      liveUserSeen: false,
    });
    expect(decision.missingProof).not.toContain("live_external_channel_status_ok_after_restart");
    expect(decision.missingProof).not.toContain(
      "external_channel_source_drift_zero_after_selected_adapter",
    );
    expect(decision.missingProof).not.toContain(
      "external_message_channel_gateway_restarted_after_selected_adapter",
    );
    expect(decision.missingProof).not.toContain("external_message_channel_status_ok_after_restart");
    expect(decision.missingProof).not.toContain(
      "live_sidecar_source_drift_zero_after_selected_adapter",
    );
    expect(decision.missingProof).not.toContain(
      "live_gateway_and_external_proxy_restarted_after_selected_adapter",
    );
    expect(decision.missingProof).toContain(
      "fresh_real_external_inbound_and_outbound_user_visible_observed",
    );
  });

  it("falls back to the legacy live field while older owners migrate", () => {
    const legacyOnlyPlan = { ...readyTrainingPlan };
    delete (legacyOnlyPlan as Partial<typeof readyTrainingPlan>).externalChannelBinding;
    const decision = buildExternalChannelBindingDecision({
      apply: false,
      liveTouched: false,
      trainingPlan: legacyOnlyPlan,
    });

    expect(decision).toMatchObject({
      status: "ready_for_apply",
      selectedCleanAdapter: "/tmp/adapter-clean-r4",
      missingProof: expect.arrayContaining([
        "live_sidecar_source_drift_zero_after_selected_adapter",
      ]),
    });
  });
  it("does not adopt independent visible evidence for a failed current binding probe", async () => {
    const decision = buildExternalChannelBindingDecision({
      apply: true,
      liveTouched: false,
      externalChannelStatusOk: false,
      userVisibleObserved: true,
      trainingPlan: readyTrainingPlan,
    });
    expect(decision).toMatchObject({
      status: "applied_runtime_probe_failed",
      userVisibleObserved: false,
      liveUserSeen: false,
      visibleProofObservation: {
        reported: true,
        adoptedForCurrentBinding: false,
        reason: "current_binding_probe_failed",
      },
    });
    expect(decision.missingProof).toEqual(readyTrainingPlan.externalChannelBinding.missingProof);
    const summary = buildExternalChannelBindingSummary(decision);
    const consumed = resolveExternalChannelTruth({
      binding: summary,
      bindingOwnerAvailable: true,
      legacyExternalChannelStatus: { externalChannelBound: true, userVisibleObserved: true },
      visibleProof: { status: "user_visible_observed", acceptanceMatched: true },
    });
    expect(summary.visibleProofObservation?.reported).toBe(true);
    expect(consumed).toMatchObject({
      externalChannelBound: false,
      userVisibleObserved: false,
      bindingStatus: "channel_runtime_probe_failed",
      visibleProofObservation: { reported: true, adoptedForCurrentBinding: false },
    });
    const proofDir = process.env.LCX_WATERFLOW_PROOF_DIR;
    if (proofDir) {
      await fs.mkdir(proofDir, { recursive: true });
      await fs.writeFile(
        path.join(proofDir, "binding-failed-probe-visible-after.json"),
        JSON.stringify(
          {
            boundary: "offline_original_pure_owners_no_runtime_mutation",
            input: { externalChannelStatusOk: false, userVisibleObserved: true },
            producerDecision: decision,
            originalOwnerSummary: summary,
            consumerTruth: consumed,
            realExternalProofStillRequired: true,
          },
          null,
          2,
        ) + "\n",
      );
    }
  });
});
