import { describe, expect, it } from "vitest";
import type {
  LogicalAgentModelAdapter,
  ModelCallObservation,
} from "./logical-agent-model-router.js";
import {
  buildQualityHarnessPlan,
  QUALITY_HARNESS_REVIEW_AGENTS,
  QUALITY_HARNESS_STAGES,
  runQualityHarness,
  normalizeQualityRequest,
  type QualityHarnessArtifact,
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
  it("passes one shared fact packet to every specialist and reviewer", async () => {
    const requests: QualityHarnessModelRequest[] = [];
    await runQualityHarness({
      request: {
        ...request,
        sharedContext: {
          snapshotId: "snapshot-20260907",
          decisionMode: "conditional_trade_candidate",
          sourceTimestamp: "2026-09-07T09:00:00+08:00",
        },
      },
      maxAttempts: 1,
      modelInvoker: demoInvoker({ requests }),
      createRunId: () => "shared-context-run",
    });

    expect(requests).toHaveLength(10);
    expect(new Set(requests.map((entry) => entry.sharedContext.snapshotId))).toEqual(
      new Set(["snapshot-20260907"]),
    );
    expect(
      requests.every((entry) => entry.sharedContext.decisionMode === "conditional_trade_candidate"),
    ).toBe(true);
  });

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
      "financial_extraction",
      "news_classification",
      "portfolio_exposure",
      "adversarial_challenge",
      "research_draft",
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
      modelInvoker: demoInvoker({ answer: "Sell Microsoft." }),
      verify: async () => ({ status: "passed", summary: "should not run", details: [] }),
    });

    expect(result.status).toBe("quality-failed");
    expect(
      result.attempts[0]?.gates.find((gate) => gate.id === "finance_answer_safety"),
    ).toMatchObject({ passed: false });
  });

  it("rejects portfolio sizing language in research-only mode", async () => {
    const result = await runQualityHarness({
      request: financeRequest,
      maxAttempts: 1,
      modelInvoker: demoInvoker({ answer: "Allocate 50% of your portfolio to NVDA." }),
      verify: async () => ({ status: "passed", summary: "should not run", details: [] }),
    });

    expect(result.status).toBe("quality-failed");
    expect(
      result.attempts[0]?.gates.find((gate) => gate.id === "finance_answer_safety"),
    ).toMatchObject({ passed: false });
  });

  it("allows a conditional candidate while still rejecting execution claims", async () => {
    const candidate = await runQualityHarness({
      request: {
        ...financeRequest,
        sharedContext: { decisionMode: "conditional_trade_candidate" },
      },
      maxAttempts: 1,
      modelInvoker: demoInvoker({
        answer: "Conditional trade candidate: Buy NVDA if the trigger holds; review only.",
      }),
      verify: async () => ({ status: "passed", summary: "candidate contract passed", details: [] }),
    });

    expect(candidate.status).toBe("verified");
    expect(
      candidate.attempts[0]?.gates.find((gate) => gate.id === "finance_answer_safety"),
    ).toMatchObject({ passed: true });

    const executionClaim = await runQualityHarness({
      request: {
        ...financeRequest,
        sharedContext: { decisionMode: "conditional_trade_candidate" },
      },
      maxAttempts: 1,
      modelInvoker: demoInvoker({
        answer: "Conditional trade candidate: Buy NVDA if the trigger holds; order filled.",
      }),
      verify: async () => ({ status: "passed", summary: "should not run", details: [] }),
    });

    expect(executionClaim.status).toBe("quality-failed");
    expect(
      executionClaim.attempts[0]?.gates.find((gate) => gate.id === "finance_answer_safety"),
    ).toMatchObject({ passed: false });
  });

  it("does not equate a percentage with a currency amount", async () => {
    const result = await runQualityHarness({
      request: {
        ...financeRequest,
        evidence: [
          {
            id: "market",
            text: "截至 2026-09-06，公开材料记录利润率为 10%。",
            source: "market-feed-test",
          },
        ],
      },
      maxAttempts: 1,
      modelInvoker: demoInvoker({ answer: "当前价格为 $10。" }),
      verify: async () => ({ status: "passed", summary: "should not run", details: [] }),
    });

    expect(result.status).toBe("quality-failed");
    expect(
      result.attempts[0]?.gates.find((gate) => gate.id === "finance_answer_safety"),
    ).toMatchObject({ passed: false });
  });

  it("preserves signs when matching current-data numbers", async () => {
    const result = await runQualityHarness({
      request: {
        ...financeRequest,
        evidence: [
          {
            id: "market",
            text: "截至 2026-09-06，公开行情材料记录涨跌幅为 +5%。",
            source: "market-feed-test",
          },
        ],
      },
      maxAttempts: 1,
      modelInvoker: async (raw) => {
        const current = raw as QualityHarnessModelRequest;
        if (current.stage === "intake") {
          return { kind: "plan", requirements: ["回答问题"], missingEvidence: [] };
        }
        if (current.stage === "draft" || current.stage === "format") {
          return {
            kind: "artifact",
            artifact: {
              answer: "NVDA 当前涨跌幅为 -5%。",
              claims: [
                {
                  id: "claim-1",
                  text: "NVDA 当前涨跌幅为 -5%。",
                  status: "supported",
                  evidenceIds: ["market"],
                },
              ],
            },
          };
        }
        return passReview();
      },
      verify: async () => ({ status: "passed", summary: "should not run", details: [] }),
    });

    expect(result.status).toBe("quality-failed");
    expect(
      result.attempts[0]?.gates.find((gate) => gate.id === "finance_answer_safety"),
    ).toMatchObject({ passed: false });
  });

  it("requires current-data numbers to be grounded by the same claim and its evidence", async () => {
    const result = await runQualityHarness({
      request: {
        ...financeRequest,
        evidence: [
          {
            id: "qqq",
            text: "截至 2026-09-06，QQQ 的价格为 $100。",
            source: "market-feed-test",
          },
          {
            id: "aapl",
            text: "截至 2026-09-06，AAPL 的价格为 $200。",
            source: "market-feed-test",
          },
        ],
      },
      maxAttempts: 1,
      modelInvoker: async (raw) => {
        const current = raw as QualityHarnessModelRequest;
        if (current.stage === "intake") {
          return { kind: "plan", requirements: ["回答问题"], missingEvidence: [] };
        }
        if (current.stage === "draft" || current.stage === "format") {
          return {
            kind: "artifact",
            artifact: {
              answer: "AAPL 当前价格为 $100。",
              claims: [
                {
                  id: "claim-1",
                  text: "AAPL 当前价格为 $100。",
                  status: "supported",
                  evidenceIds: ["qqq"],
                },
              ],
            },
          };
        }
        return passReview();
      },
      verify: async () => ({ status: "passed", summary: "should not run", details: [] }),
    });

    expect(result.status).toBe("quality-failed");
    expect(
      result.attempts[0]?.gates.find((gate) => gate.id === "finance_answer_safety"),
    ).toMatchObject({ passed: false });
  });

  it("requires the evidence carrying each current number to have its own timestamp", async () => {
    const result = await runQualityHarness({
      request: {
        ...financeRequest,
        evidence: [
          {
            id: "market",
            text: "NVDA 的价格为 480 美元。",
            source: "market-feed-test",
          },
          {
            id: "fresh",
            text: "截至 2026-09-06，市场材料已更新。",
            source: "market-feed-test",
          },
        ],
      },
      maxAttempts: 1,
      modelInvoker: async (raw) => {
        const current = raw as QualityHarnessModelRequest;
        if (current.stage === "intake") {
          return { kind: "plan", requirements: ["回答问题"], missingEvidence: [] };
        }
        if (current.stage === "draft" || current.stage === "format") {
          return {
            kind: "artifact",
            artifact: {
              answer: "NVDA 当前价格为 480 美元。",
              claims: [
                {
                  id: "claim-1",
                  text: "市场记录了 NVDA 价格。",
                  status: "supported",
                  evidenceIds: ["market", "fresh"],
                },
              ],
            },
          };
        }
        return passReview();
      },
      verify: async () => ({ status: "passed", summary: "should not run", details: [] }),
    });

    expect(result.status).toBe("quality-failed");
    expect(
      result.attempts[0]?.gates.find((gate) => gate.id === "finance_answer_safety"),
    ).toMatchObject({ passed: false });
  });

  it("blocks an invoked verifier that returns not-requested", async () => {
    const result = await runQualityHarness({
      request,
      maxAttempts: 1,
      modelInvoker: demoInvoker({}),
      verify: async () => ({
        status: "not-requested",
        summary: "verifier declined to run",
        details: [],
      }),
    });

    expect(result.status).toBe("blocked");
    expect(result.attempts[0]?.status).toBe("verification-blocked");
  });

  it("requires both a source and timestamp for current finance numbers", async () => {
    const result = await runQualityHarness({
      request: {
        ...financeRequest,
        evidence: [
          {
            id: "market",
            text: "公开行情材料记录 NVDA 的价格为 480 美元。",
            source: "market-feed-test",
          },
        ],
      },
      maxAttempts: 1,
      modelInvoker: demoInvoker({ answer: "NVDA 当前价格为 480 美元。" }),
      verify: async () => ({ status: "passed", summary: "should not run", details: [] }),
    });

    expect(result.status).toBe("quality-failed");
    expect(
      result.attempts[0]?.gates.find((gate) => gate.id === "finance_answer_safety"),
    ).toMatchObject({ passed: false });
  });

  it("does not let unrelated evidence satisfy a Chinese company claim", async () => {
    const result = await runQualityHarness({
      request: {
        ...financeRequest,
        evidence: [
          {
            id: "msft",
            text: "截至 2026-09-06，微软的价格为 200 美元。",
            source: "market-feed-test",
          },
        ],
      },
      maxAttempts: 1,
      modelInvoker: async (raw) => {
        const current = raw as QualityHarnessModelRequest;
        if (current.stage === "intake") {
          return { kind: "plan", requirements: ["回答问题"], missingEvidence: [] };
        }
        if (current.stage === "draft" || current.stage === "format") {
          return {
            kind: "artifact",
            artifact: {
              answer: "苹果当前价格为 200 美元。",
              claims: [
                {
                  id: "claim-1",
                  text: "苹果当前价格为 200 美元。",
                  status: "supported",
                  evidenceIds: ["msft"],
                },
              ],
            },
          };
        }
        return passReview();
      },
      verify: async () => ({ status: "passed", summary: "should not run", details: [] }),
    });

    expect(result.status).toBe("quality-failed");
    expect(
      result.attempts[0]?.gates.find((gate) => gate.id === "finance_answer_safety"),
    ).toMatchObject({ passed: false });
  });

  it("does not treat a required current-data date as a financial number", async () => {
    const result = await runQualityHarness({
      request: {
        ...financeRequest,
        evidence: [
          {
            id: "aapl",
            text: "截至 2026-09-06，AAPL 的价格为 $100。",
            source: "market-feed-test",
          },
        ],
      },
      maxAttempts: 1,
      modelInvoker: async (raw) => {
        const current = raw as QualityHarnessModelRequest;
        if (current.stage === "intake") {
          return { kind: "plan", requirements: ["回答问题"], missingEvidence: [] };
        }
        if (current.stage === "draft" || current.stage === "format") {
          return {
            kind: "artifact",
            artifact: {
              answer: "截至 2026-09-06，AAPL 当前价格为 $100。",
              claims: [
                {
                  id: "claim-1",
                  text: "截至 2026-09-06，AAPL 当前价格为 $100。",
                  status: "supported",
                  evidenceIds: ["aapl"],
                },
              ],
            },
          };
        }
        return passReview();
      },
      verify: async () => ({ status: "passed", summary: "should not run", details: [] }),
    });

    expect(result.status).toBe("verified");
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

describe("quality harness model evidence", () => {
  it.each(["deterministic", "injected", "adapter"] as const)(
    "keeps %s evidence distinct from caller claims",
    async (mode) => {
      const observations = new Map<string, ModelCallObservation>();
      const invoke = demoInvoker({});
      const adapter: LogicalAgentModelAdapter = {
        id: "test",
        provider: "test-local",
        modelId: "fixture-model",
        mode,
        capabilities: ["json"],
        requiredTools: [],
        requiredSideEffects: ["local_compute"],
        invoke: async (call) => {
          observations.set(call.callId, {
            ...call,
            transportRequestId: "fixture",
            kind: "model_inference",
          });
          return { ...((await invoke(call.payload)) as object), realModelInferenceObserved: true };
        },
        observe: (call) => observations.get(call.callId),
      };
      const result = await runQualityHarness({
        request,
        maxAttempts: 1,
        modelRouting: {
          revision: "fixture-v1",
          adapters: [adapter],
          defaultPolicy: {
            primary: "test",
            requiredCapabilities: ["json"],
            maxInputBytes: 100_000,
            timeoutMs: 1000,
          },
        },
      });
      expect(result.status).toBe("completed-unverified");
      expect(result.execution.modelCalls).toHaveLength(10);
      expect(result.execution.modelId).toBe("test-local/fixture-model");
      expect(result.execution.evidenceMode).toBe(mode === "adapter" ? "adapter-attested" : mode);
      expect(result.execution.realModelInferenceObserved).toBe(mode === "adapter");
      expect(result.execution.allModelCallsAttested).toBe(mode === "adapter");
      expect(result.execution.providerCallsMade).toBe("not-observed");
    },
  );

  it("audits legacy invokers conservatively even if their output claims real inference", async () => {
    const invoke = demoInvoker({});
    const result = await runQualityHarness({
      request,
      modelInvoker: async (raw) => ({
        ...((await invoke(raw)) as object),
        realModelInferenceObserved: true,
      }),
      maxAttempts: 1,
    });
    expect(result.execution.modelCalls).toHaveLength(10);
    expect(result.execution.modelId).toBe("Qwen/Qwen3-0.6B");
    expect(result.execution.evidenceMode).toBe("injected");
    expect(result.execution.realModelInferenceObserved).toBe(false);
  });
});

it("cancels the harness model run and does not start a repair attempt", async () => {
  const controller = new AbortController();
  let calls = 0;
  const result = await runQualityHarness({
    request,
    signal: controller.signal,
    maxAttempts: 2,
    modelRouting: {
      revision: "cancel-fixture-v1",
      adapters: [
        {
          id: "cancel",
          provider: "test-local",
          modelId: "test",
          mode: "deterministic",
          capabilities: [],
          requiredTools: [],
          requiredSideEffects: ["local_compute"],
          invoke: async (_, signal) =>
            new Promise((_, reject) => {
              calls += 1;
              signal.addEventListener("abort", () => reject(new Error("cancelled")), {
                once: true,
              });
              controller.abort();
            }),
        },
      ],
      defaultPolicy: {
        primary: "cancel",
        requiredCapabilities: [],
        maxInputBytes: 100_000,
        timeoutMs: 1000,
      },
    },
  });
  expect(result.status).toBe("failed");
  expect(result.attempts).toHaveLength(1);
  expect(calls).toBe(1);
  expect(result.execution.modelCalls[0]?.outcome).toBe("aborted");
});

it("cancels an uncooperative verifier without reporting verification success", async () => {
  const controller = new AbortController();
  let verifierAborted = false;
  const result = await runQualityHarness({
    request,
    signal: controller.signal,
    modelInvoker: demoInvoker({}),
    verify: async ({ signal }) =>
      new Promise(() => {
        signal.addEventListener(
          "abort",
          () => {
            verifierAborted = true;
          },
          { once: true },
        );
        controller.abort();
      }),
  });
  expect(result.status).toBe("blocked");
  expect(result.verification.summary).toBe("quality verifier cancelled");
  expect(result.attempts).toHaveLength(1);
  expect(verifierAborted).toBe(true);
});

/** Runs the harness with a stubbed model and returns the finance-safety gate. */
async function currentDataSafetyGate(
  evidenceText: string,
  answer: string,
  claimText: string,
): Promise<{ passed: boolean; reason?: string }> {
  const result = await runQualityHarness({
    request: {
      task: "请根据最新证据判断 台积电 当前股价和投资风险。",
      evidence: [{ id: "market", text: evidenceText, source: "market-feed-test" }],
    },
    maxAttempts: 1,
    modelInvoker: async (raw) => {
      const current = raw as QualityHarnessModelRequest;
      if (current.stage === "intake") {
        return { kind: "plan", requirements: ["回答问题"], missingEvidence: [] };
      }
      const artifact = {
        kind: "artifact",
        artifact: {
          answer,
          claims: [
            { id: "claim-1", text: claimText, status: "supported", evidenceIds: ["market"] },
          ],
        },
      };
      if (current.stage === "format" || current.stage === "draft") {
        return current.stage === "format"
          ? artifact
          : {
              kind: "artifact",
              artifact: {
                answer: "候选摘要保留了材料边界。",
                claims: [
                  {
                    id: "c",
                    text: "候选摘要无数字。",
                    status: "supported",
                    evidenceIds: ["market"],
                  },
                ],
              },
            };
      }
      return {
        kind: "review",
        review: { verdict: "pass", criticalFindings: [], evidenceGaps: [], notes: ["checked"] },
      };
    },
    createRunId: () => "entity-abbrev-probe",
  });
  const gate = result.attempts[0]?.gates.find((entry) => entry.id === "finance_answer_safety");
  return { passed: gate?.passed === true, reason: gate?.reason };
}

/**
 * A shared abbreviation must not make a mismatched pair look matched.
 *
 * `claimMatchesEvidenceEntity` accepts the pair when *any* extracted entity is shared, and
 * `financeEntities` reads every upper-case token as an entity unless it is in
 * `NON_ENTITY_TOKENS`. So with the term unlisted, "AAA 的 RSI 是 80" and "BBB 的 RSI 为 80" share
 * the entity RSI and the pair is reported as matched — while AAA and BBB are different instruments.
 * Measured by removing RSI / MACD / EPS from the blocklist: all three pairs then passed the gate.
 *
 * Note the numbers must match in both halves, otherwise the "current-data numbers without matching
 * cited evidence" check fires first and hides what the entity comparison actually did.
 */
describe("a shared abbreviation does not mask an entity mismatch", () => {
  const cases = [
    { label: "RSI", term: "RSI" },
    { label: "MACD", term: "MACD" },
    { label: "EPS", term: "EPS" },
  ] as const;

  for (const { label, term } of cases) {
    it(`refuses a claim about AAA backed by evidence about BBB that shares ${label}`, async () => {
      const answer = `AAA 的 ${term} 是 80。`;
      const evidence = `截至 2026-09-06，公开行情材料记录 BBB 的 ${term} 为 80。`;
      const gate = await currentDataSafetyGate(evidence, answer, answer);
      expect(gate.passed).toBe(false);
    });
  }

  it("still accepts a pair that names the same instrument", async () => {
    const answer = "AAA 当前价格是 100 美元。";
    const evidence = "截至 2026-09-06，公开行情材料记录 AAA 的价格为 100 美元。";
    const gate = await currentDataSafetyGate(evidence, answer, answer);
    expect(gate.passed).toBe(true);
  });
});

it("summarizes both providers and retains failed fallback evidence", async () => {
  const invoke = demoInvoker({});
  const adapter = (id: string): LogicalAgentModelAdapter => ({
    id,
    provider: id,
    modelId: "same-model-name",
    mode: "injected",
    capabilities: [],
    requiredTools: [],
    requiredSideEffects: ["local_compute"],
    invoke: async (call) => {
      if (id === "primary") {
        throw new Error("fixture failure");
      }
      return invoke(call.payload);
    },
  });
  const result = await runQualityHarness({
    request,
    maxAttempts: 1,
    modelRouting: {
      revision: "identity-test",
      adapters: [adapter("primary"), adapter("fallback")],
      defaultPolicy: {
        primary: "primary",
        fallback: ["fallback"],
        requiredCapabilities: [],
        maxInputBytes: 100_000,
        timeoutMs: 1000,
      },
    },
  });
  expect(result.execution.modelId).toBe(
    "multiple: primary/same-model-name, fallback/same-model-name",
  );
  expect(
    result.execution.modelCalls.some(
      (call) => call.provider === "primary" && call.outcome === "failed",
    ),
  ).toBe(true);
  expect(
    result.execution.modelCalls.some(
      (call) => call.provider === "fallback" && call.outcome === "completed",
    ),
  ).toBe(true);
});
it("labels zero routed calls and dependency-blocked stages not-executed", async () => {
  let calls = 0;
  const result = await runQualityHarness({
    request,
    maxAttempts: 1,
    modelRouting: {
      revision: "no-execution",
      adapters: [
        {
          id: "blocked",
          provider: "never",
          modelId: "never",
          mode: "injected",
          capabilities: [],
          requiredTools: [],
          requiredSideEffects: ["local_compute"],
          invoke: async () => {
            calls++;
            return {};
          },
        },
      ],
      defaultPolicy: {
        primary: "blocked",
        requiredCapabilities: ["unavailable"],
        maxInputBytes: 100_000,
        timeoutMs: 1000,
      },
    },
  });
  expect(calls).toBe(0);
  expect(result.execution.modelId).toBe("not-executed");
  expect(
    result.attempts[0].stages
      .filter((stage) => stage.status === "blocked")
      .every((stage) => stage.modelId === "not-executed"),
  ).toBe(true);
});

describe("typed nonmarket finance evidence", () => {
  const policy = {
    id: "policy",
    kind: "policy" as const,
    source: "controller-test",
    text: "合成控制策略：预算上限1000测试单位，行情超出60秒上限拒绝执行。",
  };
  const synthetic = {
    id: "fixture",
    kind: "synthetic_fixture" as const,
    source: "fixture-test",
    text: "合成SPY案例：候选500测试单位，行情年龄30秒。",
  };
  async function gate(
    answer: string,
    claims: QualityHarnessArtifact["claims"],
    evidence: QualityHarnessRequest["evidence"] = [policy, synthetic],
  ) {
    const result = await runQualityHarness({
      request: { task: "分析美股与加密的合成规则案例，非实时行情，不得执行交易。", evidence },
      maxAttempts: 1,
      modelInvoker: async (raw) => {
        const stage = (raw as QualityHarnessModelRequest).stage;
        if (stage === "intake") {
          return { kind: "plan", requirements: ["区分案例与行情"], missingEvidence: [] };
        }
        if (stage === "draft" || stage === "format") {
          return { kind: "artifact", artifact: { answer, claims } };
        }
        return passReview();
      },
    });
    return result.attempts[0].gates.find((entry) => entry.id === "finance_answer_safety");
  }
  const claims = [
    {
      id: "p",
      text: "LLM与固定规则共享预算上限1000测试单位和60秒上限。",
      status: "supported" as const,
      evidenceIds: ["policy"],
    },
    {
      id: "f",
      text: "SPY合成案例为500测试单位，行情年龄30秒。",
      status: "supported" as const,
      evidenceIds: ["fixture"],
    },
  ];
  const answer =
    "LLM与固定规则共享预算上限1000测试单位和60秒上限。SPY合成案例为500测试单位，行情年龄30秒。以上非实时行情，不得执行。";
  it("grounds source-cited policy and synthetic quantities without inventing timestamps", async () => {
    expect(await gate(answer, claims)).toMatchObject({ passed: true });
    expect(normalizeQualityRequest({ task: "test", evidence: [policy] }).evidence[0].kind).toBe(
      "policy",
    );
  });
  it.each([
    "SPY当前价格1000美元。",
    "假设这是非实时行情，SPY最新收益率30%。",
    "SPY市值500美元。",
    "BTC当前价格500美元。",
  ])("does not launder a real quote through fixture values: %s", async (quote) => {
    expect(
      await gate(answer + quote, [
        ...claims,
        { id: "quote", text: quote, status: "supported", evidenceIds: ["policy", "fixture"] },
      ]),
    ).toMatchObject({ passed: false });
  });
  it.each(["SPY合成案例为501测试单位。", "SPY合成案例为500秒。", "SPY合成案例为30测试单位。"])(
    "rejects mismatched numeric occurrence %s",
    async (changed) => {
      expect(await gate(changed, claims)).toMatchObject({ passed: false });
    },
  );
  it("does not infer trusted kind from synthetic words or skip absent sources", async () => {
    expect(
      await gate(answer, claims, [
        { ...policy, kind: undefined },
        { ...synthetic, kind: undefined },
      ]),
    ).toMatchObject({ passed: false });
    expect(
      await gate(answer, claims, [
        { ...policy, source: undefined },
        { ...synthetic, source: undefined },
      ]),
    ).toMatchObject({ passed: false });
  });
  it("keeps timestamped market quotes valid alongside nonmarket quantities", async () => {
    const quote = "SPY当前价格500美元。";
    expect(
      await gate(
        answer + quote,
        [...claims, { id: "market", text: quote, status: "supported", evidenceIds: ["market"] }],
        [
          policy,
          synthetic,
          { id: "market", text: "截至2026-09-20，SPY价格500美元。", source: "market-test" },
        ],
      ),
    ).toMatchObject({ passed: true });
  });
  it("requires the same cited evidence and entity for each nonmarket occurrence", async () => {
    expect(
      await gate("SPY合成案例500测试单位。", [
        {
          id: "wrong",
          text: "SPY合成案例500测试单位。",
          status: "supported",
          evidenceIds: ["policy"],
        },
      ]),
    ).toMatchObject({ passed: false });
    expect(await gate("BTC合成案例500测试单位。", claims)).toMatchObject({ passed: false });
  });
  it("rejects unknown evidence kinds", () => {
    expect(() =>
      normalizeQualityRequest({
        task: "test",
        evidence: [JSON.parse('{"id":"x","text":"test","kind":"assumed"}')],
      }),
    ).toThrow("evidence.kind");
  });
});
