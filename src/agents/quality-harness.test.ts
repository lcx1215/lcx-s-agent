import { describe, expect, it } from "vitest";
import {
  buildQualityHarnessPlan,
  QUALITY_HARNESS_REVIEW_AGENTS,
  QUALITY_HARNESS_STAGES,
  runQualityHarness,
  type QualityHarnessModelRequest,
  type QualityHarnessRequest,
  type QualityHarnessStageOutput,
} from "./quality-harness.js";

const request: QualityHarnessRequest = {
  task: "基于已提供材料写一份研究摘要，并明确证据缺口。",
  evidence: [{ id: "brief", text: "材料显示项目在 2026-09-03 有一个已记录的状态。" }],
};

function passReview(): QualityHarnessStageOutput {
  return {
    kind: "review",
    review: { verdict: "pass", criticalFindings: [], evidenceGaps: [], notes: ["checked"] },
  };
}

function artifact(evidenceId: string): QualityHarnessStageOutput {
  return {
    kind: "artifact",
    artifact: {
      answer: "候选摘要保留了材料边界。",
      claims: [
        {
          id: "claim-1",
          text: "材料记录了一个项目状态。",
          status: "supported",
          evidenceIds: [evidenceId],
        },
      ],
    },
  };
}

const financeRequest: QualityHarnessRequest = {
  task: "请根据最新证据判断 NVDA 当前股价和投资风险。",
  evidence: [
    {
      id: "market",
      text: "截至 2026-09-06，公开行情材料记录 NVDA 的价格为 480 美元。",
      source: "market-feed-test",
    },
  ],
};

function demoInvoker(params: {
  weakFormat?: boolean;
  adversarialFinding?: boolean;
  answer?: string;
  requests?: QualityHarnessModelRequest[];
}) {
  return async (raw: unknown): Promise<unknown> => {
    const current = raw as QualityHarnessModelRequest;
    params.requests?.push(current);
    if (current.stage === "intake") {
      return { kind: "plan", requirements: ["回答问题"], missingEvidence: [] };
    }
    if (current.stage === "adversarial" && params.adversarialFinding) {
      return {
        kind: "review",
        review: {
          verdict: "revise",
          criticalFindings: ["反方发现未处理的关键缺口"],
          evidenceGaps: [],
          notes: [],
        },
      };
    }
    if (current.stage === "draft" || current.stage === "format") {
      const weak = params.weakFormat && current.stage === "format" && current.attempt === 1;
      if (params.answer && current.stage === "format") {
        return {
          kind: "artifact",
          artifact: {
            answer: params.answer,
            claims: [
              {
                id: "claim-1",
                text: "材料记录了一个项目状态。",
                status: "supported",
                evidenceIds: ["market"],
              },
            ],
          },
        };
      }
      return artifact(weak ? "missing-evidence" : "brief");
    }
    return passReview();
  };
}

describe("quality harness", () => {
  it("derives its ten-stage plan from the existing default logical-agent DAG", () => {
    const plan = buildQualityHarnessPlan({ runId: "run-1", attempt: 1, request });
    expect(plan).toHaveLength(10);
    expect(plan.map((task) => task.id)).toEqual([
      "data_cleaning",
      "financial_extraction",
      "news_classification",
      "evidence_integrity",
      "risk_check",
      "portfolio_exposure",
      "research_draft",
      "adversarial_challenge",
      "formatting",
      "final_precheck",
    ]);
    expect(plan.map((task) => task.input.stage)).toEqual(QUALITY_HARNESS_STAGES);
    expect(plan.find((task) => task.id === "final_precheck")?.dependsOn).toEqual([
      "formatting",
      "risk_check",
      "evidence_integrity",
    ]);
  });

  it("requires the existing role DAG plus grounded artifact and three review gates", async () => {
    const requests: QualityHarnessModelRequest[] = [];
    const result = await runQualityHarness({
      request,
      modelId: "test-small-model",
      maxConcurrency: 2,
      modelInvoker: demoInvoker({ requests }),
      verify: async () => ({ status: "passed", summary: "local verifier passed", details: [] }),
      createRunId: () => "verified-run",
    });

    expect(result.status).toBe("verified");
    expect(result.quality.passed).toBe(true);
    expect(result.quality.independentRoleReviewCount).toBe(3);
    expect(result.quality.reviewAgents).toEqual(QUALITY_HARNESS_REVIEW_AGENTS);
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]?.gates.every((gate) => gate.passed)).toBe(true);
    expect(result.modelPool.maxLoadedModels).toBe(1);
    expect(result.modelPool.maxObservedModelConcurrency).toBe(1);
    expect(result.execution.realModelInferenceObserved).toBe(false);
    expect(requests.map((entry) => entry.stage)).toEqual(QUALITY_HARNESS_STAGES);
  });

  it("rejects a weak small-model artifact, then performs only one bounded repair attempt", async () => {
    const requests: QualityHarnessModelRequest[] = [];
    const result = await runQualityHarness({
      request,
      maxAttempts: 2,
      modelInvoker: demoInvoker({ weakFormat: true, requests }),
      verify: async () => ({ status: "passed", summary: "local verifier passed", details: [] }),
      createRunId: () => "repair-run",
    });

    expect(result.status).toBe("verified");
    expect(result.repair).toEqual({ attemptsUsed: 2, maxAttempts: 2, repairTriggered: true });
    expect(result.attempts.map((attempt) => attempt.status)).toEqual([
      "quality-failed",
      "quality-passed",
    ]);
    expect(result.attempts[0]?.gates.find((gate) => gate.id === "claims_grounded")?.passed).toBe(
      false,
    );
    expect(
      requests.filter((entry) => entry.attempt === 2)[0]?.repairFeedback.length,
    ).toBeGreaterThan(0);
  });

  it("does not let the adversarial role self-approve a critical finding", async () => {
    let verified = false;
    const result = await runQualityHarness({
      request,
      maxAttempts: 1,
      modelInvoker: demoInvoker({ adversarialFinding: true }),
      verify: async () => {
        verified = true;
        return { status: "passed", summary: "should not run", details: [] };
      },
    });

    expect(result.status).toBe("quality-failed");
    expect(verified).toBe(false);
    expect(
      result.attempts[0]?.gates.find((gate) => gate.id === "adversarial_review"),
    ).toMatchObject({
      passed: false,
    });
  });

  it("returns unverified when quality passes but no deterministic verifier is supplied", async () => {
    const result = await runQualityHarness({
      request,
      modelInvoker: demoInvoker({}),
      maxAttempts: 1,
    });

    expect(result.status).toBe("completed-unverified");
    expect(result.verification.status).toBe("not-requested");
    expect(result.quality.passed).toBe(true);
  });

  it("bounds verifier failure instead of looping forever", async () => {
    let verificationCalls = 0;
    const result = await runQualityHarness({
      request,
      maxAttempts: 2,
      modelInvoker: demoInvoker({}),
      verify: async () => {
        verificationCalls += 1;
        return { status: "failed", summary: "local check failed", details: ["check-1"] };
      },
    });

    expect(result.status).toBe("verification-failed");
    expect(verificationCalls).toBe(2);
    expect(result.attempts).toHaveLength(2);
  });

  it("deterministically rejects direct trade actions and ungrounded current numbers", async () => {
    const result = await runQualityHarness({
      request: financeRequest,
      maxAttempts: 1,
      modelInvoker: demoInvoker({ answer: "Buy NVDA now at 500 dollars." }),
      verify: async () => ({ status: "passed", summary: "should not run", details: [] }),
    });

    expect(result.status).toBe("quality-failed");
    expect(
      result.attempts[0]?.gates.find((gate) => gate.id === "finance_answer_safety"),
    ).toMatchObject({ passed: false });
  });

  it("aborts a verifier that exceeds its independent timeout", async () => {
    let aborted = false;
    const result = await runQualityHarness({
      request,
      maxAttempts: 1,
      verifierTimeoutMs: 10,
      modelInvoker: demoInvoker({}),
      verify: ({ signal }) =>
        new Promise(() => {
          signal.addEventListener("abort", () => {
            aborted = true;
          });
        }),
    });

    expect(result.status).toBe("blocked");
    expect(aborted).toBe(true);
    expect(result.verification.status).toBe("blocked");
    expect(result.verification.summary).toContain("timed out");
  });
});
