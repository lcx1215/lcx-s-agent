import { describe, expect, it } from "vitest";
import { buildMonotonicDataLedgerSnapshot } from "../scripts/dev/lcx-monotonic-data-ledger.js";

describe("LCX monotonic data ledger", () => {
  it("records dataset, train-slice, SkillOpt, rejected/downranked, and promotion truth", () => {
    const previousEntry = {
      entryKey: "previous",
      dataset: { counts: { examples: 100, train: 90 } },
      trainSlice: { counts: { trainWritten: 40 } },
      dispositions: {
        acceptedSkillOptPackets: 1,
        blockedAdapterCandidates: 2,
      },
    };

    const payload = buildMonotonicDataLedgerSnapshot({
      checkedAt: "2026-05-28T03:30:00.000Z",
      workspaceDir: "/tmp/workspace",
      previousEntry,
      write: true,
      trainingPlan: {
        selectedCleanAdapter: "/tmp/adapter-clean-r2",
        onDiskLocalBrainDataset: {
          path: "/tmp/dataset/manifest.json",
          exists: true,
          counts: { sourceFiles: 8, examples: 120, train: 110, valid: 5, test: 5 },
          sourceKinds: {
            curated_seed: 12,
            module_learning_plan_receipt: 4,
            module_learning_review_receipt: 2,
          },
        },
        onDiskTrainSlice: {
          path: "/tmp/train-slice/manifest.json",
          exists: true,
          counts: {
            sourceTrain: 110,
            curatedSeen: 12,
            nonReviewSeen: 20,
            reviewSeen: 78,
            trainWritten: 64,
            validCopied: 5,
            testCopied: 5,
          },
        },
        moduleLearningReview: {
          counts: {
            weakModuleLearning: 1,
            invalidReceipts: 2,
            storedOnly: 3,
            applicationReady: 4,
            evalAbsorbed: 0,
          },
        },
        qwenCapabilityConsolidation: {
          cleanCandidateAdapterCount: 3,
          blockedCandidateAdapterCount: 4,
          monotonicIntelligenceGuard: {
            runtimeInvariant:
              "never_replace_clean_champion_with_dirty_or_parse_recovered_challenger",
            noRegressionGate: true,
            currentRuntimeStatus: "clean_champion_serving",
            latestChallengerStatus: "blocked_and_harvested",
          },
        },
        latestStableEval: {
          at: "2026-05-28T03:00:00.000Z",
          name: "stable_hardened_eval",
          adapterPath: "/tmp/adapter-clean-r2",
          passed: 213,
          total: 213,
          promotionReady: true,
          failedCaseIds: [],
          parseErrorCaseIds: [],
          parseRecoveredCaseIds: [],
        },
        latestPassingEval: {
          at: "2026-05-28T03:00:00.000Z",
          name: "stable_hardened_eval",
          adapterPath: "/tmp/adapter-clean-r2",
          passed: 213,
          total: 213,
          promotionReady: true,
          failedCaseIds: [],
          parseErrorCaseIds: [],
          parseRecoveredCaseIds: [],
        },
        latestCandidateEval: {
          at: "2026-05-28T03:10:00.000Z",
          name: "candidate_hardened_eval",
          adapterPath: "/tmp/adapter-r4",
          passed: 213,
          total: 213,
          promotionReady: false,
          failedCaseIds: [],
          parseErrorCaseIds: [],
          parseRecoveredCaseIds: ["case_a", "case_b"],
        },
      },
      skillOptLite: {
        status: "candidate_edit_static_accepted_pending_eval",
        skillFamilyCount: 2,
        staticGateOk: true,
        matchedSkillIds: ["finance_data_provenance_preflight"],
        skillPackets: [
          {
            skillId: "finance_data_provenance_preflight",
            accepted: true,
            status: "candidate_edit_static_accepted_pending_eval",
            candidatePath: "memory/skillopt-lite/finance/candidate.md",
          },
          {
            skillId: "single_stock_curve_technical_timing_preflight",
            accepted: true,
            status: "candidate_edit_static_accepted_pending_eval",
            candidatePath: "memory/skillopt-lite/timing/candidate.md",
          },
        ],
        proofChain: {
          modelWeightAbsorption: {
            status: "not_absorbed_until_training_and_promotion_truth",
          },
        },
      },
    });

    expect(payload).toMatchObject({
      ok: true,
      boundary: "local_monotonic_data_ledger_only",
      appendDecision: "append_latest_entry",
      guaranteeLevel: "data_accounting_not_model_capability_guarantee",
      dataset: {
        counts: { examples: 120, train: 110 },
        sourceKindCount: 3,
        sourceKindTotal: 18,
      },
      trainSlice: {
        counts: { sourceTrain: 110, trainWritten: 64 },
      },
      dispositions: {
        acceptedSkillOptPackets: 2,
        pendingSkillOptEvalPackets: 2,
        rejectedOrBlockedCurrentCandidateCases: 2,
        blockedAdapterCandidates: 4,
        downrankedOrWeakModuleLearningCount: 3,
        moduleLearningEvalAbsorbed: 0,
      },
      promotion: {
        selectedCleanAdapter: "/tmp/adapter-clean-r2",
        latestCandidateEval: {
          adapterPath: "/tmp/adapter-r4",
          promotionReady: false,
          parseRecoveredCaseIds: ["case_a", "case_b"],
        },
        currentRuntimeStatus: "clean_champion_serving",
        latestChallengerStatus: "blocked_and_harvested",
      },
      deltaFromPrevious: {
        datasetExamples: "increased",
        datasetTrain: "increased",
        trainSliceWritten: "increased",
        acceptedSkillOptPackets: "increased",
        blockedAdapterCandidates: "increased",
      },
      proofBoundaries: {
        dataIncreaseIsNotCapabilityIncrease: true,
        runtimeMonotonicNotEveryTrainingRound: true,
        modelWeightAbsorptionRequiresPromotionProof: true,
        externalChannelRequiresSeparateUserVisibleProof: true,
        liveLarkRequiresSeparateLiveProof: true,
      },
      liveTouched: false,
      providerConfigTouched: false,
      protectedMemoryTouched: false,
    });
    expect(payload.entryKey).toContain("memory/skillopt-lite/finance/candidate.md");
    expect(payload.entryKey).toContain("memory/skillopt-lite/timing/candidate.md");
  });

  it("does not collapse different SkillOpt candidate edits under the same ledger key", () => {
    const baseTrainingPlan = {
      onDiskLocalBrainDataset: {
        counts: { sourceFiles: 1, examples: 10, train: 8, valid: 1, test: 1 },
        sourceKinds: { curated_seed: 10 },
      },
      onDiskTrainSlice: {
        counts: { sourceTrain: 8, trainWritten: 4 },
      },
      qwenCapabilityConsolidation: {
        cleanCandidateAdapterCount: 1,
        blockedCandidateAdapterCount: 0,
      },
      latestEval: { at: "2026-05-28T00:00:00.000Z" },
      latestCandidateEval: { at: "2026-05-28T00:01:00.000Z" },
    };
    const first = buildMonotonicDataLedgerSnapshot({
      checkedAt: "2026-05-28T01:00:00.000Z",
      workspaceDir: "/tmp/workspace",
      write: true,
      trainingPlan: baseTrainingPlan,
      skillOptLite: {
        skillPackets: [
          {
            skillId: "finance_data_provenance_preflight",
            accepted: true,
            candidatePath: "memory/skillopt-lite/finance/candidates/a.md",
          },
        ],
      },
    });
    const second = buildMonotonicDataLedgerSnapshot({
      checkedAt: "2026-05-28T01:05:00.000Z",
      workspaceDir: "/tmp/workspace",
      previousEntry: first,
      write: true,
      trainingPlan: baseTrainingPlan,
      skillOptLite: {
        skillPackets: [
          {
            skillId: "finance_data_provenance_preflight",
            accepted: true,
            candidatePath: "memory/skillopt-lite/finance/candidates/b.md",
          },
        ],
      },
    });

    expect(first.entryKey).not.toBe(second.entryKey);
    expect(second.appendDecision).toBe("append_latest_entry");
  });
});
