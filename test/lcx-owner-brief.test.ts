import { describe, expect, it } from "vitest";
import { buildOwnerBrief } from "../scripts/operator/lcx-owner-brief.ts";

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
          universeIndex: {
            governanceStatus: "complete",
            governanceTotalComponents: 8080,
            governanceGovernedComponents: 7966,
            governanceInventoryOnlyComponents: 114,
            governanceReviewRequiredComponents: 0,
            governanceCoverageRate: 1,
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
    expect(brief.markdown).toContain("全量部件治理：complete");
    expect(brief.markdown).toContain("共 8080 个");
    expect(brief.markdown).toContain("候选模型还有 2 个格式不干净的案例");
    expect(brief.markdown).toContain("商品级验收还没过");
    expect(brief.markdown).not.toContain("structuralOwnerFailures");
    expect(brief.markdown).not.toContain("parseRecovered");
    expect(brief.markdown).not.toContain("具体原因");
  });

  it("quotes each failing owner's reason instead of leaving the blocker unexplained", () => {
    const brief = buildOwnerBrief({
      checkedAt: "2026-05-28T22:00:00.000Z",
      governance: {
        ok: false,
        summary: {
          structuralOwnerFailures: ["contextRecovery"],
          actionableClusters: ["context_recovery_cluster"],
        },
        owners: {
          trainingPlan: {
            actionableFailures: ["candidate eval is not promotion ready"],
          },
          contextRecovery: {
            actionableFailures: [
              "runtime_lcx_operator_skills_available_and_autocued: local runtime skill snapshot is missing required LCX operator skills [managedRoot=/tmp/managed/skills exists=true skillDirs=59 merged=7]",
            ],
          },
        },
        liveTouched: false,
        providerConfigTouched: false,
        protectedMemoryTouched: false,
      },
      localFailureTrace: {
        result: "failed",
        firstFailedGate: "owner_exit_failed:contextRecovery",
        canBecomeTrainingMaterial: false,
      },
      paths: {
        latestMarkdownPath: "/tmp/state/lcx-owner-brief-latest.md",
        latestJsonPath: "/tmp/state/lcx-owner-brief-latest.json",
        sourcePaths: [],
      },
    });

    expect(brief.markdown).toContain("## 具体原因（回执原文，未改写）");
    expect(brief.markdown).toContain("managedRoot=/tmp/managed/skills");
    // The owner the autopilot already names as a structural failure is quoted first, so the
    // reason lines line up with the blockers above them instead of reading alphabetically.
    expect(brief.markdown.indexOf("contextRecovery：")).toBeLessThan(
      brief.markdown.indexOf("trainingPlan："),
    );
  });

  it("caps the quoted reasons and says how many it left out", () => {
    const owners = Object.fromEntries(
      Array.from({ length: 6 }, (_, index) => [
        `owner${index}`,
        { actionableFailures: [`reason ${index}`] },
      ]),
    );
    const brief = buildOwnerBrief({
      checkedAt: "2026-05-28T22:00:00.000Z",
      governance: {
        ok: false,
        summary: {},
        owners,
        liveTouched: false,
        providerConfigTouched: false,
        protectedMemoryTouched: false,
      },
      localFailureTrace: { result: "failed" },
      paths: {
        latestMarkdownPath: "/tmp/state/lcx-owner-brief-latest.md",
        latestJsonPath: "/tmp/state/lcx-owner-brief-latest.json",
        sourcePaths: [],
      },
    });

    expect(brief.markdown).toContain("owner0：reason 0");
    expect(brief.markdown).toContain("owner3：reason 3");
    expect(brief.markdown).not.toContain("owner4：reason 4");
    expect(brief.markdown).toContain("还有 2 个 owner 有待处理问题，见管控图。");
  });
});
