import { describe, expect, it } from "vitest";
import { buildPromotionAudit } from "../scripts/dev/local-brain-promotion-audit.js";

describe("local-brain-promotion-audit", () => {
  it("marks a matching latest-passing adapter as safe without applying promotion", () => {
    const adapterPath = "/tmp/adapter-r2";
    const audit = buildPromotionAudit({
      plan: {
        activeProcesses: [{ pid: 123, role: "guard" }],
        latestEval: {
          at: "2026-05-12T02:57:16.380Z",
          name: "stable_hardened_eval",
          adapterPath,
          passed: 72,
          total: 72,
          passRate: 1,
          promotionReady: true,
          failedCaseIds: [],
          parseErrorCaseIds: [],
        },
        latestTeacher: {
          acceptedCandidates: 35,
          failures: 1,
        },
        moduleLearningReview: {
          ok: true,
          boundary: "module_learning_pipeline_review_only",
          updated: false,
          counts: { boundaryViolations: 0 },
        },
      },
      resolver: {
        ok: true,
        details: {
          selectedAdapter: adapterPath,
          selectionMode: "latest-passing",
        },
      },
    });

    expect(audit).toEqual(
      expect.objectContaining({
        boundary: "dev_local_brain_promotion_audit_only",
        lane: "promotion_audit",
        promotionDecision: "safe",
        latestPassingAdapter: adapterPath,
        resolverMatchesLatestEval: true,
        activeTraining: true,
        liveTouched: false,
        providerConfigTouched: false,
        protectedMemoryTouched: false,
        adaptersMovedOrDeleted: false,
        promotionApplied: false,
      }),
    );
    expect(audit.qualityLaneConcernsConsidered).toEqual(["latest_teacher_batch_has_failures"]);
    expect(audit.realBugsFound).toEqual([]);
  });

  it("rejects promotion when resolver cannot return a latest-passing adapter", () => {
    const audit = buildPromotionAudit({
      plan: {
        activeProcesses: [],
        latestEval: {
          name: "candidate_hardened_eval",
          adapterPath: "/tmp/adapter-r3",
          passed: 71,
          total: 72,
          promotionReady: false,
          failedCaseIds: ["all_module_knowledge_internalization_chain"],
          parseErrorCaseIds: [],
        },
        moduleLearningReview: {
          counts: { boundaryViolations: 0 },
        },
      },
      resolver: {
        ok: false,
        error: "no promotion-ready adapter found",
      },
    });

    expect(audit).toEqual(
      expect.objectContaining({
        promotionDecision: "rejected",
        resolverStatus: "failed",
        realBugsFound: ["resolver_failed"],
        latestPassingAdapter: undefined,
      }),
    );
  });

  it("uses the resolver training seed adapter and holds promotion when the current eval is not ready", () => {
    const adapterPath = "/tmp/adapter-training-seed-r2";
    const audit = buildPromotionAudit({
      plan: {
        activeProcesses: [{ pid: 123, role: "guard" }],
        latestEval: {
          name: "training_seed_hardened_eval",
          adapterPath,
          passed: 65,
          total: 76,
          passRate: 0.855,
          promotionReady: false,
          failedCaseIds: ["current_market_data_freshness_boundary"],
          parseErrorCaseIds: [],
          parseRecoveredCaseIds: ["full_stack_finance_stress_with_red_team"],
        },
        latestPassingEval: {
          name: "stable_hardened_eval",
          adapterPath: "/tmp/older-promoted-adapter",
          passed: 72,
          total: 72,
          passRate: 1,
          promotionReady: true,
          failedCaseIds: [],
          parseErrorCaseIds: [],
        },
        moduleLearningReview: {
          counts: { boundaryViolations: 0 },
        },
      },
      resolver: {
        ok: true,
        details: {
          trainingSeedAdapter: adapterPath,
          trainingSeed: {
            adapterPath,
            passed: 72,
            total: 72,
            passRate: 1,
            parseRecoveredCount: 1,
            source: "candidate_hardened_eval",
          },
          selectionMode: "latest-passing",
        },
      },
    });

    expect(audit).toEqual(
      expect.objectContaining({
        promotionDecision: "hold",
        latestPassingAdapter: adapterPath,
        resolverMatchesLatestEval: true,
        resolverMatchesLatestPassingEval: false,
        realBugsFound: [],
      }),
    );
    expect(audit.resolverTrainingSeed).toEqual(
      expect.objectContaining({
        adapterPath,
        passed: 72,
        total: 72,
        parseRecoveredCount: 1,
      }),
    );
  });

  it("keeps adapter mismatch ambiguous instead of safe", () => {
    const audit = buildPromotionAudit({
      plan: {
        activeProcesses: [],
        latestEval: {
          name: "stable_hardened_eval",
          adapterPath: "/tmp/adapter-old",
          passed: 72,
          total: 72,
          promotionReady: true,
          failedCaseIds: [],
          parseErrorCaseIds: [],
        },
        moduleLearningReview: {
          counts: { boundaryViolations: 0 },
        },
      },
      resolver: {
        ok: true,
        details: {
          selectedAdapter: "/tmp/adapter-new",
          selectionMode: "latest-passing",
        },
      },
    });

    expect(audit).toEqual(
      expect.objectContaining({
        promotionDecision: "ambiguous",
        resolverMatchesLatestEval: false,
        realBugsFound: ["resolver_adapter_differs_from_latest_passing_eval_adapter"],
      }),
    );
  });

  it("keeps a stable selected latest-passing adapter safe when a newer candidate is not promoted", () => {
    const stableAdapter = "/tmp/adapter-r2";
    const candidateAdapter = "/tmp/adapter-r8";
    const audit = buildPromotionAudit({
      plan: {
        activeProcesses: [{ pid: 123, role: "guard" }],
        latestEval: {
          name: "candidate_hardened_eval",
          adapterPath: candidateAdapter,
          passed: 72,
          total: 72,
          promotionReady: false,
          failedCaseIds: [],
          parseErrorCaseIds: [],
          parseRecoveredCaseIds: ["plain_recent_stock_market_brief_preflight"],
        },
        latestPassingEval: {
          name: "stable_hardened_eval",
          adapterPath: stableAdapter,
          passed: 72,
          total: 72,
          promotionReady: true,
          failedCaseIds: [],
          parseErrorCaseIds: [],
        },
        moduleLearningReview: {
          counts: { boundaryViolations: 0 },
        },
      },
      resolver: {
        ok: true,
        details: {
          selectedAdapter: stableAdapter,
          selectionMode: "latest-passing",
        },
      },
    });

    expect(audit).toEqual(
      expect.objectContaining({
        promotionDecision: "safe",
        resolverMatchesLatestEval: false,
        resolverMatchesLatestPassingEval: true,
        realBugsFound: [],
        qualityLaneConcernsConsidered: [
          "latest_chronological_eval_not_promotion_ready",
          "latest_chronological_eval_parse_recovered_present",
        ],
      }),
    );
    expect(audit.latestEval).toEqual(
      expect.objectContaining({
        parseRecoveredCaseIds: ["plain_recent_stock_market_brief_preflight"],
      }),
    );
    expect(audit.selectedEval).toEqual(
      expect.objectContaining({
        adapterPath: stableAdapter,
        promotionReady: true,
      }),
    );
  });
});
