import { describe, expect, it } from "vitest";
import { buildAgentExamReport } from "../scripts/dev/lcx-agent-exam.js";

const okCommand = (name: string, json: Record<string, unknown>) =>
  ({
    ok: true,
    name,
    durationMs: 1,
    json,
    stdoutTail: JSON.stringify(json),
  }) as const;

describe("lcx-agent-exam", () => {
  it("keeps dev exam separate from live-visible proof by default", () => {
    const report = buildAgentExamReport({
      checkedAt: "2026-05-12T00:00:00.000Z",
      live: false,
      l5: false,
      doctor: okCommand("doctor", {
        ok: true,
        boundary: "dev_observability_only",
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
        boundary: "dev_local_brain_promotion_audit_only",
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
    });

    expect(report).toEqual(
      expect.objectContaining({
        ok: true,
        boundary: "dev_exam_only",
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
        boundary: "dev_fixed_not_live_fixed",
      }),
    );
    expect(report.lanes.find((lane) => lane.lane === "lark_feishu_visible_loop")).toEqual(
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
  });

  it("downgrades training when the latest teacher batch still has failures", () => {
    const report = buildAgentExamReport({
      live: false,
      l5: false,
      doctor: okCommand("doctor", {
        ok: true,
        boundary: "dev_observability_only",
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
        boundary: "dev_local_brain_promotion_audit_only",
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
  });

  it("treats live probes as probe evidence, not live-visible-fixed", () => {
    const report = buildAgentExamReport({
      live: true,
      l5: true,
      doctor: okCommand("doctor", {
        ok: true,
        boundary: "dev_observability_only",
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
        boundary: "dev_local_brain_promotion_audit_only",
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
      larkDiagnose: okCommand("lark", {
        ok: true,
        languageCandidates: {
          currentReplay: { candidateCount: 126, rejectedCount: 0 },
        },
      }),
      channelProbe: okCommand("channels", { ok: true }),
      l5Battery: {
        ok: true,
        name: "l5",
        durationMs: 1,
        stdoutTail: "346 passed",
      },
    });

    expect(report.boundary).toBe("dev_exam_with_live_probe");
    expect(report.liveTouched).toBe(true);
    expect(report.lanes.find((lane) => lane.lane === "live_visible_boundary")).toEqual(
      expect.objectContaining({
        status: "warn",
        boundary: "probe_fixed_not_live_visible_fixed",
        issue: expect.stringContaining("channel probe 不是真实用户可见回复证据"),
      }),
    );
    expect(report.lanes.find((lane) => lane.lane === "lark_feishu_visible_loop")).toEqual(
      expect.objectContaining({
        status: "warn",
        evidence: expect.arrayContaining([
          "live-visible-fixed=false unless fresh inbound plus matching reply is present",
        ]),
      }),
    );
  });
});
