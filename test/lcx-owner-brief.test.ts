import { describe, expect, it } from "vitest";
import { buildOwnerBrief } from "../scripts/dev/lcx-owner-brief.ts";

describe("LCX owner brief", () => {
  it("turns machine receipts into a short plain-Chinese owner summary", () => {
    const brief = buildOwnerBrief({
      checkedAt: "2026-05-28T22:00:00.000Z",
      governance: {
        ok: true,
        summary: {
          activeTrainingOrEval: true,
          structuralOwnerFailures: ["commercialAcceptance", "contextRecovery"],
          blockedClusters: ["training_eval_runtime_cluster"],
          actionableClusters: ["dirty_worktree_cluster"],
          externalChannelBindingStatus: "deferred_active_training_or_eval",
          fastestSafeNextAction: "wait_for_current_training_eval_then_run_idle_queue",
        },
        owners: {
          trainingPlan: {
            selectedCleanAdapter: "/tmp/adapters/clean-r2",
            latestCandidateEval: {
              promotionReady: false,
              failedCaseIds: [],
              parseErrorCaseIds: [],
              parseRecoveredCaseIds: ["case_a", "case_b"],
            },
          },
          monotonicDataLedger: {
            datasetExamples: 6800,
            trainSliceWritten: 2928,
            acceptedSkillOptPackets: 3,
          },
        },
        liveTouched: false,
        providerConfigTouched: false,
        protectedMemoryTouched: false,
      },
      localFailureTrace: {
        result: "failed",
        firstFailedGate: "owner_exit_failed:commercialAcceptance",
        canBecomeTrainingMaterial: true,
        nextSafeAction: "wait_for_current_training_eval_then_run_idle_queue",
        processSummary: {
          activeHeavy: true,
          counts: { guard: 1, eval: 1, mlx: 1, teacher: 1, quota: 1 },
        },
      },
      paths: {
        latestMarkdownPath: "/tmp/state/lcx-owner-brief-latest.md",
        latestJsonPath: "/tmp/state/lcx-owner-brief-latest.json",
        ownerControlMapMarkdownPath: "/tmp/state/lcx-owner-control-map-latest.md",
        sourcePaths: ["/tmp/state/lcx-governance-autopilot-latest.json"],
      },
    });

    expect(brief).toEqual(
      expect.objectContaining({
        ok: true,
        kind: "lcx-owner-brief",
        boundary: "local_owner_brief_readable_summary_only",
        checkedAt: "2026-05-28T22:00:00.000Z",
        title: "LCX 老板总览",
        liveTouched: false,
        providerConfigTouched: false,
        protectedMemoryTouched: false,
      }),
    );
    expect(brief.markdown).toContain("# LCX 老板总览");
    expect(brief.markdown).toContain("一句话：机器还在跑评测，先不加新的重活。");
    expect(brief.markdown).toContain("今天进展");
    expect(brief.markdown).toContain("卡在哪里");
    expect(brief.markdown).toContain("下一步");
    expect(brief.markdown).toContain("风险边界");
    expect(brief.markdown).toContain("管控图");
    expect(brief.markdown).toContain("/tmp/state/lcx-owner-control-map-latest.md");
    expect(brief.markdown).toContain("已经有 3 条小规则候选");
    expect(brief.markdown).toContain("候选模型还有 2 个格式不干净的案例");
    expect(brief.markdown).toContain("商品级验收还没过");
    expect(brief.markdown).not.toContain("structuralOwnerFailures");
    expect(brief.markdown).not.toContain("parseRecovered");
  });
});
