import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildAgentExamReport } from "../scripts/operator/lcx-agent-exam.js";

const repoRoot = path.resolve(import.meta.dirname, "..");

const okCommand = (name: string, json: Record<string, unknown>) =>
  ({
    ok: true,
    name,
    durationMs: 1,
    json,
    stdoutTail: JSON.stringify(json),
  }) as const;

const cognitiveSources = {
  doctrine: "Capability must be monotonic; simple prerequisite eval",
  localBrainEval:
    "EVAL_CASE_PREREQUISITES expandEvalCasesWithPrerequisites autoIncludedPrerequisiteCaseIds registeredPrerequisiteRuleCount",
  localBrainEvalTests:
    "runs simple prerequisite cases before complex commodity evals; gates all-domain finance learning behind simple prerequisite evals; requires abstraction-transfer evals to include adjacent prerequisites",
  systemPrompt:
    "do not describe a run as learned/internalized when the status is not application_ready; retrievalFirstLearning.failedReason; weakLearningIntents.failedReason; usageReceiptPath",
  moduleLearningReviewTool:
    "weakModuleLearning exactMissingProof nextProofOwner proofGapSummary boundaryViolation languageCorpusUntouched protectedMemoryUntouched providerConfigTouched: false",
  externalSurfaces:
    "POST core-verified means local implementation or tests only; user-visible-observed means migrated, built, restarted, probed, and verified through the real external message path; started, running, completed, blocked, or unproven",
  localBrainRunbook:
    "core-verified; external-channel-bound; user-visible-observed; real-entry; fresh real External inbound plus visible reply; Do not call local training or synthetic replay `user-visible-observed`; A stored source, summary, or dataset row is not enough; stored_only; application_ready; eval_absorbed; Do not claim Qwen model-internal learning without retained artifacts and eval evidence; bounded feedback; answer audit; model answer is candidate; Qwen is challenger; terminal decision; Commercial-grade convergence does not mean deleting useful entrypoints; Converge duplicated authority instead; single factual owner",
  answerAuditSurfaces:
    "buildAnswerAuditPolicy local_commercial_answer_pipeline_only model_candidate_not_final_authority candidate_answer_not_final_authority challenger_only_not_final_authority answer_audit terminalDecision return_failed_reason local_memory_recall learning_sedimentation_review stored_only_is_not_learning retrieval_apply_eval_review_required",
  controlRoomSurfaces:
    "one main control room control_room_main_lane specialist detail only on demand",
};

describe("lcx-agent-exam", () => {
  it("keeps dev exam separate from live-visible proof by default", () => {
    const report = buildAgentExamReport({
      checkedAt: "2026-05-12T00:00:00.000Z",
      live: false,
      l5: false,
      doctor: okCommand("doctor", {
        ok: true,
        boundary: "local_observability_only",
        liveTouched: false,
        summary: { passed: 12, failed: 0, skipped: 5 },
      }),
      trainingPlan: okCommand("training-plan", {
        activeProcesses: [{ pid: 123, role: "guard" }],
        latestEval: { name: "stable_hardened_eval", passed: 72, total: 72 },
        latestDataset: { counts: { examples: 9000 } },
        latestTeacher: { failures: 0 },
        decisions: [{ id: "continue_medium_training" }],
      }),
      promotionAudit: okCommand("promotion-audit", {
        boundary: "local_brain_promotion_audit_only",
        promotionDecision: "safe",
        resolverMatchesLatestEval: true,
        realBugsFound: [],
        latestEval: {
          name: "stable_hardened_eval",
          passed: 72,
          total: 72,
          promotionReady: true,
        },
        selectedEval: {
          name: "stable_hardened_eval",
          passed: 72,
          total: 72,
          promotionReady: true,
        },
      }),
      moduleLearningReview: okCommand("module-review", {
        boundary: "module_learning_pipeline_review_only",
        updated: false,
        counts: {
          receiptFiles: 0,
          weakModuleLearning: 0,
          invalidReceipts: 0,
          boundaryViolations: 0,
        },
      }),
      cognitiveIntegritySources: cognitiveSources,
    });

    expect(report).toEqual(
      expect.objectContaining({
        ok: true,
        boundary: "local_exam_only",
        liveTouched: false,
        providerConfigTouched: false,
        protectedMemoryTouched: false,
        trainingStarted: false,
        heavyEvalStarted: false,
      }),
    );
    expect(report.lanes.find((lane) => lane.lane === "live_visible_boundary")).toEqual(
      expect.objectContaining({
        status: "pass",
        boundary: "core_verified_not_user_visible_observed",
      }),
    );
    expect(report.lanes.find((lane) => lane.lane === "external_visible_loop")).toEqual(
      expect.objectContaining({
        status: "not_run",
      }),
    );
    expect(report.lanes.find((lane) => lane.lane === "module_learning_internalization")).toEqual(
      expect.objectContaining({
        status: "warn",
        issue: expect.stringContaining("今天没有模块学习 review 输入收据"),
      }),
    );
    expect(report.lanes.find((lane) => lane.lane === "training_guard")).toEqual(
      expect.objectContaining({
        evidence: expect.arrayContaining(["datasetExamples=9000"]),
      }),
    );
    expect(report.lanes.find((lane) => lane.lane === "thinking_hierarchy_integrity")).toEqual(
      expect.objectContaining({ status: "pass" }),
    );
    expect(report.lanes.find((lane) => lane.lane === "work_status_boundary_integrity")).toEqual(
      expect.objectContaining({ status: "pass" }),
    );
    expect(report.lanes.find((lane) => lane.lane === "memory_sedimentation_integrity")).toEqual(
      expect.objectContaining({ status: "pass" }),
    );
    expect(report.lanes.find((lane) => lane.lane === "commercial_answer_audit_pipeline")).toEqual(
      expect.objectContaining({ status: "pass" }),
    );
    expect(report.lanes.find((lane) => lane.lane === "product_control_room")).toEqual(
      expect.objectContaining({ status: "pass" }),
    );
    expect(report.commercialBlueprint).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "live_closure", status: "needs_live" }),
        expect.objectContaining({ id: "module_learning_absorption", status: "needs_receipts" }),
        expect.objectContaining({ id: "commercial_answer_audit", status: "ready" }),
        expect.objectContaining({ id: "product_control_room", status: "ready" }),
        expect.objectContaining({ id: "commercial_acceptance_harness", status: "not_run" }),
      ]),
    );
  });

  it("does not ask to re-complete module learning when absorption inventory is ready", () => {
    const report = buildAgentExamReport({
      checkedAt: "2026-05-12T00:00:00.000Z",
      live: false,
      l5: false,
      doctor: okCommand("doctor", {
        ok: true,
        boundary: "local_observability_only",
        liveTouched: false,
        summary: { passed: 12, failed: 0, skipped: 5 },
      }),
      trainingPlan: okCommand("training-plan", {
        activeProcesses: [{ pid: 123, role: "guard" }],
        latestEval: { name: "stable_hardened_eval", passed: 72, total: 72 },
        latestDataset: { examples: 9000 },
        latestTeacher: { failures: 0 },
        decisions: [{ id: "continue_medium_training" }],
      }),
      promotionAudit: okCommand("promotion-audit", {
        boundary: "local_brain_promotion_audit_only",
        promotionDecision: "safe",
        resolverMatchesLatestEval: true,
        realBugsFound: [],
        latestEval: {
          name: "stable_hardened_eval",
          passed: 72,
          total: 72,
          promotionReady: true,
        },
        selectedEval: {
          name: "stable_hardened_eval",
          passed: 72,
          total: 72,
          promotionReady: true,
        },
      }),
      moduleLearningReview: okCommand("module-review", {
        boundary: "module_learning_pipeline_review_only",
        updated: false,
        counts: {
          receiptFiles: 8,
          weakModuleLearning: 0,
          applicationReady: 0,
          evalAbsorbed: 8,
          invalidReceipts: 0,
          boundaryViolations: 0,
        },
      }),
      learningSedimentationAudit: okCommand("learning-audit", {
        ok: true,
        boundary: "local_learning_sedimentation_audit_only",
        assessment: "usable_and_module_certifiable",
        chains: {
          moduleLearningPipeline: {
            planReceipts: 32,
            evalAbsorbed: 16,
            weakModuleLearning: 0,
            boundaryViolations: 0,
            latestReview: {
              path: "memory/module-learning-pipeline-reviews/2026-05-18.json",
              evalAbsorbed: 8,
              weakModuleLearning: 0,
              applicationReady: 0,
            },
          },
        },
      }),
      cognitiveIntegritySources: cognitiveSources,
    });

    const moduleBlueprint = report.commercialBlueprint.find(
      (item) => item.id === "module_learning_absorption",
    );
    expect(moduleBlueprint).toEqual(
      expect.objectContaining({
        status: "ready",
        evidence: expect.arrayContaining([
          "inventory.assessment=usable_and_module_certifiable",
          "inventory.planReceipts=32",
          "inventory.historicalEvalAbsorbed=16",
          "inventory.latestReview.evalAbsorbed=8",
          "todayReview.receiptFiles=8",
          "todayReview.evalAbsorbed=8",
        ]),
        nextAction: expect.stringContaining("保持 no-write review"),
      }),
    );
    expect(moduleBlueprint?.nextAction).not.toContain("补 module_learning_pipeline_plan/review");
  });

  it("does not ask to rewrite module learning plan/review when only eval absorption is missing", () => {
    const report = buildAgentExamReport({
      checkedAt: "2026-05-12T00:00:00.000Z",
      live: false,
      l5: false,
      doctor: okCommand("doctor", {
        ok: true,
        boundary: "local_observability_only",
        liveTouched: false,
        summary: { passed: 12, failed: 0, skipped: 5 },
      }),
      trainingPlan: okCommand("training-plan", {
        activeProcesses: [{ pid: 123, role: "guard" }],
        latestEval: { name: "stable_hardened_eval", passed: 72, total: 72 },
        latestDataset: { examples: 9000 },
        latestTeacher: { failures: 0 },
        decisions: [{ id: "continue_medium_training" }],
      }),
      promotionAudit: okCommand("promotion-audit", {
        boundary: "local_brain_promotion_audit_only",
        promotionDecision: "safe",
        resolverMatchesLatestEval: true,
        realBugsFound: [],
        latestEval: {
          name: "stable_hardened_eval",
          passed: 72,
          total: 72,
          promotionReady: true,
        },
        selectedEval: {
          name: "stable_hardened_eval",
          passed: 72,
          total: 72,
          promotionReady: true,
        },
      }),
      moduleLearningReview: okCommand("module-review", {
        boundary: "module_learning_pipeline_review_only",
        updated: false,
        counts: {
          receiptFiles: 8,
          weakModuleLearning: 8,
          applicationReady: 8,
          evalAbsorbed: 0,
          invalidReceipts: 0,
          boundaryViolations: 0,
        },
      }),
      learningSedimentationAudit: okCommand("learning-audit", {
        ok: true,
        boundary: "local_learning_sedimentation_audit_only",
        assessment: "usable_but_not_model_absorbed",
        gaps: [{ id: "module_learning_review_has_weak_receipts", severity: "P2" }],
        chains: {
          moduleLearningPipeline: {
            planReceipts: 8,
            evalAbsorbed: 0,
            weakModuleLearning: 8,
            boundaryViolations: 0,
            latestReview: {
              path: "memory/module-learning-pipeline-reviews/2026-05-18.json",
              evalAbsorbed: 0,
              weakModuleLearning: 8,
              applicationReady: 8,
            },
          },
        },
      }),
      cognitiveIntegritySources: cognitiveSources,
    });

    const moduleBlueprint = report.commercialBlueprint.find(
      (item) => item.id === "module_learning_absorption",
    );
    expect(moduleBlueprint).toEqual(
      expect.objectContaining({
        status: "needs_receipts",
        evidence: expect.arrayContaining([
          "inventory.assessment=usable_but_not_model_absorbed",
          "inventory.planReceipts=8",
          "todayReview.receiptFiles=8",
          "todayReview.applicationReady=8",
        ]),
        nextAction: expect.stringContaining("已有 module_learning_pipeline_plan/review"),
      }),
    );
    expect(report.lanes.find((lane) => lane.lane === "learning_sedimentation_inventory")).toEqual(
      expect.objectContaining({
        evidence: expect.arrayContaining([
          "historicalEvalAbsorbed=0",
          "latestReview.evalAbsorbed=0",
          "latestReview.weakModuleLearning=8",
          "gaps=module_learning_review_has_weak_receipts",
        ]),
      }),
    );
    expect(moduleBlueprint?.nextAction).not.toContain("补 module_learning_pipeline_plan/review");
    expect(moduleBlueprint?.nextAction).toContain("不能重复写 plan 冒充吸收");
  });

  it("keeps module learning blueprint blocked when inventory is clean but today's review is weak", () => {
    const report = buildAgentExamReport({
      checkedAt: "2026-05-12T00:00:00.000Z",
      live: false,
      l5: false,
      doctor: okCommand("doctor", {
        ok: true,
        boundary: "local_observability_only",
        liveTouched: false,
        summary: { passed: 12, failed: 0, skipped: 5 },
      }),
      trainingPlan: okCommand("training-plan", {
        activeProcesses: [{ pid: 123, role: "guard" }],
        latestEval: { name: "stable_hardened_eval", passed: 72, total: 72 },
        latestDataset: { examples: 9000 },
        latestTeacher: { failures: 0 },
        decisions: [{ id: "continue_medium_training" }],
      }),
      promotionAudit: okCommand("promotion-audit", {
        boundary: "local_brain_promotion_audit_only",
        promotionDecision: "safe",
        resolverMatchesLatestEval: true,
        realBugsFound: [],
        latestEval: {
          name: "stable_hardened_eval",
          passed: 72,
          total: 72,
          promotionReady: true,
        },
        selectedEval: {
          name: "stable_hardened_eval",
          passed: 72,
          total: 72,
          promotionReady: true,
        },
      }),
      moduleLearningReview: okCommand("module-review", {
        boundary: "module_learning_pipeline_review_only",
        updated: false,
        counts: {
          receiptFiles: 1,
          weakModuleLearning: 1,
          applicationReady: 1,
          evalAbsorbed: 0,
          invalidReceipts: 0,
          boundaryViolations: 0,
        },
      }),
      learningSedimentationAudit: okCommand("learning-audit", {
        ok: true,
        boundary: "local_learning_sedimentation_audit_only",
        assessment: "usable_and_module_certifiable",
        chains: {
          moduleLearningPipeline: {
            planReceipts: 32,
            evalAbsorbed: 16,
            weakModuleLearning: 0,
            boundaryViolations: 0,
            latestReview: {
              path: "memory/module-learning-pipeline-reviews/2026-05-17.json",
              evalAbsorbed: 16,
              weakModuleLearning: 0,
              applicationReady: 0,
            },
          },
        },
      }),
      cognitiveIntegritySources: cognitiveSources,
    });

    const moduleBlueprint = report.commercialBlueprint.find(
      (item) => item.id === "module_learning_absorption",
    );
    expect(moduleBlueprint).toEqual(
      expect.objectContaining({
        status: "needs_receipts",
        evidence: expect.arrayContaining([
          "inventory.assessment=usable_and_module_certifiable",
          "todayReview.weakModuleLearning=1",
        ]),
        nextAction: expect.stringContaining("继续补 per-receipt eval/training"),
      }),
    );
  });

  it("downgrades training when the latest teacher batch still has failures", () => {
    const report = buildAgentExamReport({
      live: false,
      l5: false,
      doctor: okCommand("doctor", {
        ok: true,
        boundary: "local_observability_only",
        liveTouched: false,
        summary: { passed: 12, failed: 0, skipped: 5 },
      }),
      trainingPlan: okCommand("training-plan", {
        activeProcesses: [{ pid: 123, role: "guard" }],
        latestEval: { name: "candidate_hardened_eval", passed: 71, total: 72 },
        latestDataset: { examples: 9000 },
        latestTeacher: { failures: 1 },
        decisions: [{ id: "teacher_quality_repair" }],
      }),
      promotionAudit: okCommand("promotion-audit", {
        boundary: "local_brain_promotion_audit_only",
        promotionDecision: "rejected",
        resolverMatchesLatestEval: false,
        realBugsFound: ["latest_eval_not_promotion_ready"],
        latestEval: {
          name: "candidate_hardened_eval",
          passed: 71,
          total: 72,
          promotionReady: false,
        },
        selectedEval: {
          name: "candidate_hardened_eval",
          passed: 71,
          total: 72,
          promotionReady: false,
        },
      }),
      moduleLearningReview: okCommand("module-review", {
        boundary: "module_learning_pipeline_review_only",
        updated: false,
        counts: {
          receiptFiles: 2,
          weakModuleLearning: 1,
          invalidReceipts: 0,
          boundaryViolations: 0,
        },
      }),
      cognitiveIntegritySources: cognitiveSources,
    });

    expect(report.summary.nextBlocker).toBe("qwen_adapter_promotion");
    expect(report.lanes.find((lane) => lane.lane === "training_guard")).toEqual(
      expect.objectContaining({
        status: "warn",
        evidence: expect.arrayContaining(["teacherFailures=1"]),
      }),
    );
    expect(report.lanes.find((lane) => lane.lane === "qwen_adapter_promotion")).toEqual(
      expect.objectContaining({
        status: "fail",
        evidence: expect.arrayContaining(["realBugsFound=latest_eval_not_promotion_ready"]),
      }),
    );
    expect(report.lanes.find((lane) => lane.lane === "module_learning_internalization")).toEqual(
      expect.objectContaining({
        status: "warn",
        severity: "P2",
        nextAction: expect.stringContaining("per-receipt eval/training"),
      }),
    );
  });

  it("treats non-promotion-ready adapters as hold instead of a resolver failure", () => {
    const report = buildAgentExamReport({
      live: false,
      l5: false,
      doctor: okCommand("doctor", {
        ok: true,
        boundary: "local_observability_only",
        liveTouched: false,
        summary: { passed: 12, failed: 0, skipped: 5 },
      }),
      trainingPlan: okCommand("training-plan", {
        activeProcesses: [{ pid: 123, role: "guard" }],
        latestEval: { name: "training_seed_hardened_eval", passed: 65, total: 76 },
        latestDataset: { examples: 9000 },
        latestTeacher: { failures: 0 },
        decisions: [{ id: "eval_not_promotion_ready" }],
      }),
      promotionAudit: okCommand("promotion-audit", {
        boundary: "local_brain_promotion_audit_only",
        promotionDecision: "hold",
        resolverMatchesLatestEval: true,
        resolverMatchesLatestPassingEval: false,
        realBugsFound: [],
        latestEval: {
          name: "training_seed_hardened_eval",
          passed: 65,
          total: 76,
          promotionReady: false,
        },
        selectedEval: {
          name: "training_seed_hardened_eval",
          passed: 65,
          total: 76,
          promotionReady: false,
        },
      }),
      moduleLearningReview: okCommand("module-review", {
        boundary: "module_learning_pipeline_review_only",
        updated: false,
        counts: {
          receiptFiles: 1,
          weakModuleLearning: 0,
          invalidReceipts: 0,
          boundaryViolations: 0,
        },
      }),
      cognitiveIntegritySources: cognitiveSources,
    });

    expect(report.ok).toBe(true);
    expect(report.lanes.find((lane) => lane.lane === "qwen_adapter_promotion")).toEqual(
      expect.objectContaining({
        status: "warn",
        severity: "P2",
        issue: expect.stringContaining("正确暂停"),
        evidence: expect.arrayContaining(["promotionDecision=hold", "realBugsFound=none"]),
      }),
    );
  });

  it("treats live probes as probe evidence, not live-visible-fixed", () => {
    const report = buildAgentExamReport({
      live: true,
      l5: true,
      doctor: okCommand("doctor", {
        ok: true,
        boundary: "local_observability_only",
        liveTouched: false,
        summary: { passed: 12, failed: 0, skipped: 5 },
      }),
      trainingPlan: okCommand("training-plan", {
        activeProcesses: [{ pid: 123, role: "guard" }],
        latestEval: { name: "stable_hardened_eval", passed: 72, total: 72 },
        latestDataset: { examples: 9000 },
        latestTeacher: { failures: 0 },
        decisions: [{ id: "continue_medium_training" }],
      }),
      promotionAudit: okCommand("promotion-audit", {
        boundary: "local_brain_promotion_audit_only",
        promotionDecision: "safe",
        resolverMatchesLatestEval: true,
        realBugsFound: [],
        latestEval: {
          name: "stable_hardened_eval",
          passed: 72,
          total: 72,
          promotionReady: true,
        },
        selectedEval: {
          name: "stable_hardened_eval",
          passed: 72,
          total: 72,
          promotionReady: true,
        },
      }),
      moduleLearningReview: okCommand("module-review", {
        boundary: "module_learning_pipeline_review_only",
        updated: false,
        counts: {
          receiptFiles: 1,
          weakModuleLearning: 0,
          invalidReceipts: 0,
          boundaryViolations: 0,
        },
      }),
      cognitiveIntegritySources: cognitiveSources,
      externalChannelStatus: okCommand("external-channel-status", {
        ok: true,
        externalChannelBound: true,
        userVisibleObserved: false,
      }),
      channelProbe: okCommand("channels", { ok: true }),
      l5Battery: {
        ok: true,
        name: "l5",
        durationMs: 1,
        stdoutTail: "346 passed",
      },
    });

    expect(report.boundary).toBe("local_exam_with_live_probe");
    expect(report.liveTouched).toBe(true);
    expect(report.lanes.find((lane) => lane.lane === "live_visible_boundary")).toEqual(
      expect.objectContaining({
        status: "warn",
        boundary: "probe_evidence_not_user_visible_observed",
        issue: expect.stringContaining("channel probe 不是真实用户可见回复证据"),
      }),
    );
    expect(report.lanes.find((lane) => lane.lane === "external_visible_loop")).toEqual(
      expect.objectContaining({
        status: "warn",
        evidence: expect.arrayContaining([
          "user-visible-observed requires observation at the target software",
        ]),
      }),
    );
  });

  it("fails cognitive integrity when memory learning can be claimed without application proof", () => {
    const report = buildAgentExamReport({
      live: false,
      l5: false,
      doctor: okCommand("doctor", {
        ok: true,
        boundary: "local_observability_only",
        liveTouched: false,
        summary: { passed: 12, failed: 0, skipped: 5 },
      }),
      trainingPlan: okCommand("training-plan", {
        activeProcesses: [{ pid: 123, role: "guard" }],
        latestEval: { name: "stable_hardened_eval", passed: 72, total: 72 },
        latestDataset: { examples: 9000 },
        latestTeacher: { failures: 0 },
        decisions: [{ id: "continue_medium_training" }],
      }),
      promotionAudit: okCommand("promotion-audit", {
        boundary: "local_brain_promotion_audit_only",
        promotionDecision: "safe",
        resolverMatchesLatestEval: true,
        realBugsFound: [],
        latestEval: {
          name: "stable_hardened_eval",
          passed: 72,
          total: 72,
          promotionReady: true,
        },
        selectedEval: {
          name: "stable_hardened_eval",
          passed: 72,
          total: 72,
          promotionReady: true,
        },
      }),
      moduleLearningReview: okCommand("module-review", {
        boundary: "module_learning_pipeline_review_only",
        updated: false,
        counts: {
          receiptFiles: 1,
          weakModuleLearning: 0,
          invalidReceipts: 0,
          boundaryViolations: 0,
        },
      }),
      cognitiveIntegritySources: {
        ...cognitiveSources,
        systemPrompt: "learning is good",
      },
    });

    expect(report.ok).toBe(false);
    expect(report.summary.nextBlocker).toBe("memory_sedimentation_integrity");
    expect(report.lanes.find((lane) => lane.lane === "memory_sedimentation_integrity")).toEqual(
      expect.objectContaining({
        status: "fail",
        issue: expect.stringContaining("可能把存储、摘要、检索误写成模型已经学会"),
      }),
    );
  });

  it("runs module-learning review against the local OpenClaw workspace", async () => {
    const source = await fs.readFile(
      path.join(repoRoot, "scripts/operator/lcx-agent-exam.ts"),
      "utf8",
    );

    expect(source).toContain("DEFAULT_WORKSPACE_DIR");
    expect(source).toContain("scripts/operator/module-learning-pipeline-review.ts");
    expect(source).toContain("--workspace");
  });
});
