import { describe, expect, it } from "vitest";
import { buildLiveLarkBrainBindingDecision } from "../scripts/dev/lcx-live-lark-brain-binding.js";

describe("lcx-live-lark-brain-binding", () => {
  const readyTrainingPlan = {
    boundary: "dev_local_brain_training_plan_only",
    activeProcesses: [],
    liveLarkBrainBinding: {
      boundary: "dev_live_lark_brain_binding_plan_only",
      status: "ready_for_live_runtime_binding",
      action: "bind_live_runtime_to_selected_clean_adapter_and_collect_lark_visible_proof",
      selectedCleanAdapter: "/tmp/adapter-clean-r4",
      missingProof: [
        "live_sidecar_source_drift_zero_after_selected_adapter",
        "live_gateway_and_feishu_proxy_restarted_after_selected_adapter",
        "live_lark_loop_diagnose_ok_after_restart",
        "fresh_real_lark_inbound_and_outbound_seen",
      ],
    },
  };

  it("defers live binding while eval or MLX is active", () => {
    const decision = buildLiveLarkBrainBindingDecision({
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

  it("exposes an apply-ready state without touching live runtime", () => {
    const decision = buildLiveLarkBrainBindingDecision({
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

  it("keeps live-user-seen separate after a successful runtime probe", () => {
    const decision = buildLiveLarkBrainBindingDecision({
      apply: true,
      liveTouched: true,
      larkLoopDiagnoseOk: true,
      trainingPlan: readyTrainingPlan,
    });

    expect(decision).toMatchObject({
      status: "applied_runtime_probe_ok",
      action: "keep_waiting_for_real_lark_user_seen_proof",
      selectedCleanAdapter: "/tmp/adapter-clean-r4",
      liveTouched: true,
      liveUserSeen: false,
    });
    expect(decision.missingProof).not.toContain("live_lark_loop_diagnose_ok_after_restart");
    expect(decision.missingProof).toContain("fresh_real_lark_inbound_and_outbound_seen");
  });
});
