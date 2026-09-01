import { describe, expect, it } from "vitest";
import { buildOwnerControlMap } from "../scripts/operator/lcx-owner-control-map.ts";

describe("LCX owner control map", () => {
  it("shows what the owner can see, what Codex can safely act on, and what stays blocked", () => {
    const map = buildOwnerControlMap({
      checkedAt: "2026-05-28T22:20:00.000Z",
      governance: {
        summary: {
          activeTrainingOrEval: true,
          actionableClusters: ["dirty_worktree_cluster", "context_recovery_cluster"],
          blockedClusters: [
            "adapter_promotion_truth_cluster",
            "module_learning_absorption_cluster",
          ],
          externalChannelBindingStatus: "deferred_active_training_or_eval",
          providerCouncilAccelerationStatus: "ready_plan",
          providerCouncilAccelerationAction: "dry_run_plan_only",
        },
        triggerPolicy: {
          selfRepairHandsOwnerWritePolicy: {
            whenAutoWrite: [
              { id: "candidate_eval_dirty_cases" },
              { id: "module_learning_incomplete_evidence" },
              { id: "skillopt_static_or_parse_gap" },
            ],
            dedupeKey: "signalKey",
            writeOncePerSignalKey: true,
          },
        },
        owners: {
          trainingPlan: {
            selectedCleanAdapter: "/tmp/adapters/clean-r2",
            latestCandidateEval: {
              promotionReady: false,
              parseRecoveredCaseIds: ["case_a", "case_b"],
              failedCaseIds: [],
              parseErrorCaseIds: [],
            },
            externalChannelBinding: {
              missingProof: ["fresh_real_external_inbound_and_outbound_seen"],
            },
          },
          monotonicDataLedger: {
            acceptedSkillOptPackets: 3,
            moduleLearningEvalAbsorbed: 0,
          },
          selfRepairHands: {
            status: "write_completed",
          },
          providerCouncilAcceleration: {
            hardBlocks: ["active_eval_or_mlx", "dirty_git_worktree"],
          },
          universeIndex: {
            dirtyFiles: 40,
            unmatchedChangedFiles: 11,
          },
        },
        liveTouched: false,
        providerConfigTouched: false,
        protectedMemoryTouched: false,
      },
      localFailureTrace: {
        canBecomeTrainingMaterial: true,
        processSummary: {
          activeHeavy: true,
          counts: { guard: 1, eval: 1, mlx: 1, teacher: 0, quota: 0 },
        },
      },
      paths: {
        latestMarkdownPath: "/tmp/state/lcx-owner-control-map-latest.md",
        latestJsonPath: "/tmp/state/lcx-owner-control-map-latest.json",
        sourcePaths: ["/tmp/state/lcx-governance-autopilot-latest.json"],
      },
    });

    expect(map).toEqual(
      expect.objectContaining({
        ok: true,
        kind: "lcx-owner-control-map",
        boundary: "local_owner_control_map_only",
        liveTouched: false,
        providerConfigTouched: false,
        protectedMemoryTouched: false,
      }),
    );
    expect(map.summary.unmanagedCount).toBeGreaterThan(0);
    expect(map.items.map((item) => item.id)).toEqual(
      expect.arrayContaining([
        "active_eval_and_mlx",
        "dirty_and_unmatched_worktree",
        "external_message_channel_real_user_proof",
        "skillopt_not_model_weight",
        "self_repair_memory_and_training_candidate_hands",
        "module_learning_not_absorbed",
        "provider_council_blocked",
        "protected_authority_boundaries",
      ]),
    );
    expect(map.markdown).toContain("# LCX 老板管控图");
    expect(map.markdown).toContain("老板现在管不到什么");
    expect(map.markdown).toContain("## 透明监督表");
    expect(map.markdown).toContain("谁负责看");
    expect(map.markdown).toContain("现在看什么");
    expect(map.markdown).toContain("允许继续的条件");
    expect(map.markdown).toContain("必须停手的情况");
    expect(map.markdown).toContain("是否需要你授权");
    expect(map.markdown).toContain("每次总控跑完自动刷新");
    expect(map.markdown).toContain("什么时候自动写");
    expect(map.markdown).toContain("补丁候选手");
    expect(map.markdown).toContain("训练/评测/补丁路径");
    expect(map.markdown).toContain("git index/commit");
    expect(map.markdown).toContain("总控决定什么时候自动加 --write");
    expect(map.markdown).toContain("同一个 signalKey 已写过就不重复写");
    expect(map.markdown).toContain("候选小考出现失败");
    expect(map.markdown).toContain("资料学习证据链不完整");
    expect(map.markdown).toContain("小规则候选没过静态门或格式门");
    expect(map.markdown).toContain("Codex 可以帮你管什么");
    expect(map.markdown).toContain("现在先别碰什么");
    expect(map.markdown).toContain("永远不能自动放权什么");
    expect(map.markdown).toContain("受保护记忆、供应商配置、外部通道发送、交易执行");
    expect(map.items[0]).toEqual(
      expect.objectContaining({
        supervisor: expect.any(String),
        evidenceNow: expect.any(String),
        proceedWhen: expect.any(String),
        stopWhen: expect.any(String),
        ownerAuthorization: expect.any(String),
      }),
    );
    expect(map.markdown).not.toContain("parseRecovered");
    expect(map.markdown).not.toContain("structuralOwnerFailures");
  });
});
