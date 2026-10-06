import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  createFinanceModelWorkflow,
  inspectFinanceModelWorkflow,
  validateFinanceWorkflowOutput,
} from "./finance-model-workflow.js";
import {
  LogicalAgentModelRouter,
  ModelAdapterError,
  type ModelCallReceipt,
} from "./logical-agent-model-router.js";
import {
  runQualityHarness,
  summarizeQualityModelDiversity,
  type QualityHarnessModelRequest,
} from "./quality-harness.js";
const cfg = {
  agents: {
    defaults: { model: { primary: "a/fast", fallbacks: ["a/fast", "a/reason", "b/review"] } },
  },
} as OpenClawConfig;
const request = {
  agentId: "risk_check",
  stage: "risk",
  evidence: [{ id: "e1" }],
  task: "Review supplied facts",
};
const review = {
  kind: "review",
  review: {
    verdict: "pass",
    criticalFindings: [],
    evidenceGaps: [],
    notes: ["Checked supplied evidence"],
  },
};
describe("ontology backed finance workflow", () => {
  it("honors persistent slots without turning unrelated fallbacks into authors", () => {
    const manifest = inspectFinanceModelWorkflow(cfg, {
      slotModels: { fast: "a/fast", reasoning: "a/fast", review: "b/review" },
    });
    expect(manifest.models).toEqual(["a/fast", "b/review"]);
    expect(manifest.slots).toMatchObject({ reasoning: "a/fast", review: "b/review" });
    expect(manifest.distinctDraftAndReviewModels).toBe(true);
  });

  it("deduplicates configured candidates and separates draft from review without inferring quality", () => {
    const manifest = inspectFinanceModelWorkflow(cfg);
    expect(manifest.models).toHaveLength(3);
    expect(manifest.slots).toMatchObject({ reasoning: "a/reason", review: "b/review" });
    expect(manifest.distinctDraftAndReviewModels).toBe(true);
  });
  it("bounds final-review effort on supported adapters while preserving provider-default opt-out", () => {
    const roleTokenBudgets = new Map<string, unknown[]>();
    for (const reasoningPolicy of ["bounded_workflow", "provider_default"] as const) {
      const efforts: unknown[] = [];
      const tokenBudgets: unknown[] = [];
      roleTokenBudgets.set(reasoningPolicy, tokenBudgets);
      createFinanceModelWorkflow(cfg, {
        reasoningPolicy,
        adapterFactory: (_config, options) => {
          efforts.push(
            options?.reasoningEffortByRole?.final_precheck,
            options?.reasoningEffortByRole?.evidence_integrity,
          );
          tokenBudgets.push(options?.maxTokensByRole);
          return {
            id: options!.modelRef!,
            provider: "test",
            modelId: options!.modelRef!,
            mode: "adapter",
            capabilities: ["quality_harness"],
            requiredTools: [],
            requiredSideEffects: [],
            invoke: async () => review,
          };
        },
      });
      expect(
        efforts.every(
          (effort) => effort === (reasoningPolicy === "bounded_workflow" ? "low" : undefined),
        ),
      ).toBe(true);
    }
    const boundedTokens = roleTokenBudgets.get("bounded_workflow") ?? [];
    expect(boundedTokens.length).toBeGreaterThan(0);
    expect(boundedTokens.every((tokens) => tokens === undefined)).toBe(true);
    expect(roleTokenBudgets.get("provider_default")?.every((tokens) => tokens === undefined)).toBe(
      true,
    );
  });
  it("preserves an explicit large token limit without injecting role overrides", () => {
    const seen: Array<{ maxTokens?: number; maxTokensByRole?: unknown }> = [];
    createFinanceModelWorkflow(cfg, {
      maxTokens: 65_536,
      adapterFactory: (_cfg, options) => {
        seen.push({ maxTokens: options?.maxTokens, maxTokensByRole: options?.maxTokensByRole });
        return {
          id: "fixture",
          provider: "fixture",
          modelId: options!.modelRef!,
          mode: "adapter",
          capabilities: ["quality_harness"],
          requiredTools: [],
          requiredSideEffects: [],
          invoke: async () => review,
        };
      },
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(
      seen.every(
        (options) => options.maxTokens === 65_536 && options.maxTokensByRole === undefined,
      ),
    ).toBe(true);
  });
  it("preserves independent review deadlines when faster workflow roles use a shorter timeout", () => {
    const adapterTimeouts: number[] = [];
    const workflow = createFinanceModelWorkflow(cfg, {
      timeoutMs: 120_000,
      adapterFactory: (_config, options) => {
        adapterTimeouts.push(options!.timeoutMs!);
        return {
          id: options!.modelRef!,
          provider: "test",
          modelId: options!.modelRef!,
          mode: "adapter",
          capabilities: ["quality_harness"],
          requiredTools: [],
          requiredSideEffects: [],
          invoke: async () => review,
        };
      },
    });
    const roles = workflow.routing.roles!;

    expect(roles.adversarial_challenge?.timeoutMs).toBe(180_000);
    expect(roles.final_precheck?.timeoutMs).toBe(180_000);
    expect(roles.research_draft?.timeoutMs).toBe(120_000);
    expect(adapterTimeouts.length).toBeGreaterThan(0);
    expect(adapterTimeouts.every((timeoutMs) => timeoutMs === 180_000)).toBe(true);
  });
  it("rejects role spoofing, contradictory pass and nonexistent evidence", () => {
    expect(validateFinanceWorkflowOutput("risk_check", review, request)).toBe(true);
    expect(validateFinanceWorkflowOutput("news_classification", review, request)).toBe(false);
    expect(
      validateFinanceWorkflowOutput(
        "risk_check",
        { ...review, review: { ...review.review, evidenceGaps: ["missing"] } },
        request,
      ),
    ).toBe(false);
    expect(
      validateFinanceWorkflowOutput(
        "research_draft",
        {
          kind: "artifact",
          artifact: {
            answer: "A bounded conclusion based on supplied facts",
            claims: [{ id: "c1", text: "Fact", status: "supported", evidenceIds: ["invented"] }],
          },
        },
        { ...request, agentId: "research_draft", stage: "draft" },
      ),
    ).toBe(false);
  });
  it("accepts the declared evidence batch extraction stage without weakening role checks", () => {
    const batch = {
      ...request,
      agentId: "evidence_integrity",
      stage: "extraction",
      evidenceBatchMode: "context_extraction",
    };
    expect(validateFinanceWorkflowOutput("evidence_integrity", review, batch)).toBe(true);
    for (const changed of [
      { evidenceBatchMode: undefined },
      { evidenceBatchMode: "final_artifact_audit" },
      { stage: "draft" },
      { agentId: "financial_extraction" },
    ]) {
      expect(
        validateFinanceWorkflowOutput("evidence_integrity", review, { ...batch, ...changed }),
      ).toBe(false);
    }
    expect(
      validateFinanceWorkflowOutput(
        "evidence_integrity",
        {
          ...review,
          review: { ...review.review, evidenceGaps: ["missing source"] },
        },
        batch,
      ),
    ).toBe(false);
    expect(
      validateFinanceWorkflowOutput(
        "evidence_integrity",
        {
          ...review,
          review: { ...review.review, notes: [] },
        },
        batch,
      ),
    ).toBe(false);
  });
  it("accepts visible cross-batch citations but rejects undeclared or unseen IDs", () => {
    const input = {
      ...request,
      agentId: "research_draft",
      stage: "draft",
      evidenceCoverage: { selectedEvidenceIds: ["e1", "e2", "e3"] },
      dependencyOutputs: {
        evidence_batch_extract_2: {
          status: "completed",
          output: {
            kind: "review",
            review: {
              ...review.review,
              notes: ["[e2] Supplied context", "[invented] Unknown reference"],
            },
          },
        },
      },
    };
    const output = (id: string) => ({
      kind: "artifact",
      artifact: {
        answer: "The supplied historical observation has limited scope.",
        claims: [
          {
            id: "c1",
            text: "The observation covers one historical period.",
            status: "supported",
            evidenceIds: [id],
          },
        ],
      },
    });
    expect(validateFinanceWorkflowOutput("research_draft", output("e2"), input)).toBe(true);
    for (const id of ["e3", "invented"]) {
      expect(validateFinanceWorkflowOutput("research_draft", output(id), input)).toBe(false);
    }
  });
  it("rejects named-instrument claims citing only a summary and accepts direct coverage", () => {
    const input = {
      ...request,
      agentId: "formatting",
      stage: "format",
      evidence: [{ id: "finance-model:BTCUSDT" }, { id: "summary" }],
    };
    const output = (evidenceIds: string[]) => ({
      kind: "artifact",
      artifact: {
        answer: "BTCUSDT has a documented drawdown.",
        claims: [
          {
            id: "c1",
            text: "BTCUSDT has a documented drawdown.",
            status: "supported",
            evidenceIds,
          },
        ],
      },
    });
    expect(validateFinanceWorkflowOutput("formatting", output(["summary"]), input)).toBe(false);
    expect(
      validateFinanceWorkflowOutput(
        "formatting",
        output(["summary", "finance-model:BTCUSDT"]),
        input,
      ),
    ).toBe(true);
  });
  it("falls back on output contract failure and shares a terminal call budget", async () => {
    const payloads: unknown[] = [];
    const before = JSON.stringify(request);
    const workflow = createFinanceModelWorkflow(cfg, {
      maxCalls: 2,
      adapterFactory: (_cfg, options) => ({
        id: options!.modelRef!,
        provider: "test",
        modelId: options!.modelRef!,
        mode: "deterministic",
        capabilities: ["quality_harness"],
        requiredTools: [],
        requiredSideEffects: [],
        invoke: async ({ payload }) => {
          payloads.push(payload);
          options!.callBudget!.reserve();
          return options!.modelRef === "a/reason" ? {} : review;
        },
      }),
    });
    const router = new LogicalAgentModelRouter(workflow.routing);
    const receipts: ModelCallReceipt[] = [];
    const args = {
      role: "risk_check" as const,
      taskId: "risk",
      correlationId: "test",
      payload: request,
      capabilities: { allowedTools: [], allowedSideEffects: [], forbiddenSideEffects: [] },
      signal: new AbortController().signal,
      dispatch: async (fn: () => Promise<unknown>) => fn(),
      record: (r: ModelCallReceipt) => {
        receipts.push(r);
      },
    };
    expect(await router.invoke(args)).toEqual(review);
    expect((payloads[1] as { repairFeedback: string[] }).repairFeedback[0]).toContain(
      "Previous attempt rejected",
    );
    expect((payloads[1] as typeof request).evidence).toEqual(request.evidence);
    expect(JSON.stringify(request)).toBe(before);
    expect(receipts.map((r) => r.reason ?? r.outcome)).toEqual(["output_contract", "completed"]);
    await expect(router.invoke(args)).rejects.toThrow("call_budget_exhausted");
    expect(receipts).toHaveLength(3);
    const completed = { ...receipts[1], realModelInferenceObserved: true };
    expect(
      summarizeQualityModelDiversity([
        { ...completed, role: "research_draft" },
        { ...completed, role: "final_precheck" },
      ]).hasDistinctReviewModel,
    ).toBe(false);
    expect(
      summarizeQualityModelDiversity([
        { ...completed, role: "research_draft" },
        { ...completed, role: "final_precheck", modelId: "different" },
      ]).hasDistinctReviewModel,
    ).toBe(true);
    expect(workflow.callBudget.snapshot().reserved).toBe(2);
  });
  it("rejects specialist role scope before invocation", async () => {
    let invoked = false;
    const workflow = createFinanceModelWorkflow(cfg, {
      adapterFactory: (_cfg, options) => ({
        id: options!.modelRef!,
        provider: "test",
        modelId: options!.modelRef!,
        mode: "deterministic",
        capabilities: ["quality_harness"],
        requiredTools: [],
        requiredSideEffects: [],
        roleScope: ["news_classification"],
        invoke: async () => {
          invoked = true;
          throw new ModelAdapterError("process_error");
        },
      }),
    });
    const receipts: ModelCallReceipt[] = [];
    await expect(
      new LogicalAgentModelRouter(workflow.routing).invoke({
        role: "risk_check",
        taskId: "risk",
        correlationId: "test",
        payload: request,
        capabilities: { allowedTools: [], allowedSideEffects: [], forbiddenSideEffects: [] },
        signal: new AbortController().signal,
        dispatch: async (fn) => fn(),
        record: (r) => {
          receipts.push(r);
        },
      }),
    ).rejects.toThrow("role_scope_constraint");
    expect(invoked).toBe(false);
    expect(receipts.every((r) => !r.adapterInvoked)).toBe(true);
  });
});

it("preserves long intake tasks within the per-requirement output contract", async () => {
  const workflow = createFinanceModelWorkflow(cfg, {
    adapterFactory: (_cfg, options) => ({
      id: options!.modelRef!,
      provider: "test",
      modelId: options!.modelRef!,
      mode: "adapter",
      capabilities: ["quality_harness"],
      requiredTools: [],
      requiredSideEffects: [],
      invoke: async () => review,
    }),
  });
  const intake = workflow.routing.adapters.find((a) => a.id === "finance-deterministic-intake")!;
  const task = "Review profitable exits and actual costs. ".repeat(100);
  const payload = { agentId: "data_cleaning", stage: "intake", task, evidence: [{ id: "facts" }] };
  const output = await intake.invoke(
    {
      callId: "long-task",
      correlationId: "long-task",
      taskId: "long-task",
      role: "data_cleaning",
      attempt: 1,
      provider: "lcx",
      modelId: "deterministic-intake-v1",
      payload,
    },
    new AbortController().signal,
  );
  expect(validateFinanceWorkflowOutput("data_cleaning", output, payload)).toBe(true);
  const requirements = (output as { requirements: string[] }).requirements;
  expect(requirements.slice(0, -1).join("")).toBe(task);
  expect(requirements.every((text) => text.length <= 1000)).toBe(true);
});

it.each(["provider_rate_limit", "provider_auth", "provider_payment_required"] as const)(
  "quarantines an unavailable adapter (%s) without spending later dispatches",
  async (failureCode) => {
    const calls: string[] = [];
    const workflow = createFinanceModelWorkflow(cfg, {
      maxCalls: 3,
      adapterFactory: (_config, options) => ({
        id: options!.modelRef!,
        provider: "test",
        modelId: options!.modelRef!,
        mode: "deterministic",
        capabilities: ["quality_harness"],
        requiredTools: [],
        requiredSideEffects: [],
        invoke: async () => {
          options!.callBudget!.reserve();
          calls.push(options!.modelRef!);
          if (options!.modelRef === "a/reason") {
            throw new ModelAdapterError(failureCode);
          }
          return review;
        },
      }),
    });
    const receipts: ModelCallReceipt[] = [];
    // Separate routers share one run's adapters, as producer and quality phases do.
    for (const correlationId of ["producer", "quality"]) {
      const router = new LogicalAgentModelRouter(workflow.routing);
      await expect(
        router.invoke({
          role: "risk_check",
          taskId: "risk",
          correlationId,
          payload: request,
          capabilities: { allowedTools: [], allowedSideEffects: [], forbiddenSideEffects: [] },
          signal: new AbortController().signal,
          dispatch: async (fn) => fn(),
          record: (receipt) => receipts.push(receipt),
        }),
      ).resolves.toEqual(review);
    }
    expect(calls).toEqual(["a/reason", "a/fast", "a/fast"]);
    expect(workflow.callBudget.snapshot()).toEqual({ limit: 3, reserved: 3, remaining: 0 });
    expect(receipts[2]).toMatchObject({
      outcome: "rejected",
      reason: failureCode,
      adapterInvoked: false,
    });
  },
);

it("reports exact final closure defects without accepting missing or invented resolutions", () => {
  const workflow = createFinanceModelWorkflow(cfg, {
    adapterFactory: (_cfg, options) => ({
      id: options!.modelRef!,
      provider: "test",
      modelId: options!.modelRef!,
      mode: "deterministic",
      capabilities: ["quality_harness"],
      requiredTools: [],
      requiredSideEffects: [],
      invoke: async () => review,
    }),
  });
  const input = {
    ...request,
    agentId: "final_precheck",
    stage: "precheck",
    findingPacket: {
      artifactSha256: "a".repeat(64),
      evidenceSha256: "b".repeat(64),
      findings: [{ id: "c".repeat(64) }],
    },
  };
  const contract = workflow.routing.roles!.final_precheck!.outputContract!;
  expect(contract.validate(review, input)).toBe(false);
  expect(contract.describeFailure!(review, input)).toContain("findingClosure is missing");
  const output = {
    kind: "review",
    review: {
      ...review.review,
      findingClosure: {
        artifactSha256: "d".repeat(64),
        evidenceSha256: "b".repeat(64),
        resolutions: [],
      },
    },
  };
  expect(contract.describeFailure!(output, input)).toContain("hashes do not match");
  output.review.findingClosure.artifactSha256 = "a".repeat(64);
  expect(contract.describeFailure!(output, input)).toContain(
    "every finding_packet findingId exactly once",
  );
});

it("repairs a malformed draft once in the same model instead of restarting orchestration", async () => {
  const calls: string[] = [];
  const payloads: Array<{ repairFeedback?: string[] }> = [];
  const artifact = {
    kind: "artifact",
    artifact: {
      answer: "A supplied observation.",
      claims: [
        { id: "c1", text: "A supplied observation.", status: "supported", evidenceIds: ["e1"] },
      ],
    },
  };
  const workflow = createFinanceModelWorkflow(cfg, {
    maxCalls: 2,
    adapterFactory: (_config, options) => ({
      id: options!.modelRef!,
      provider: "test",
      modelId: options!.modelRef!,
      mode: "deterministic",
      capabilities: ["quality_harness"],
      requiredTools: [],
      requiredSideEffects: [],
      invoke: async ({ payload }) => {
        options!.callBudget!.reserve();
        calls.push(options!.modelRef!);
        payloads.push(payload as { repairFeedback?: string[] });
        return calls.length === 1 ? {} : artifact;
      },
    }),
  });
  const router = new LogicalAgentModelRouter(workflow.routing);
  const result = await router.invoke({
    role: "research_draft",
    taskId: "draft",
    correlationId: "bounded-repair",
    payload: { ...request, agentId: "research_draft", stage: "draft" },
    capabilities: { allowedTools: [], allowedSideEffects: [], forbiddenSideEffects: [] },
    signal: new AbortController().signal,
    dispatch: async (fn) => fn(),
    record: () => {},
  });
  expect(result).toEqual(artifact);
  expect(calls).toEqual(["a/reason", "a/reason"]);
  expect(payloads[1].repairFeedback?.[0]).toContain("Previous attempt rejected");
  expect(workflow.callBudget.snapshot().remaining).toBe(0);
});

it("repairs a truncated adversarial review once on the same independent model", async () => {
  const calls: Array<{ role: string; model: string }> = [];
  const payloads: Array<{ repairFeedback?: string[] }> = [];
  const receipts: ModelCallReceipt[] = [];
  const artifact = {
    kind: "artifact",
    artifact: {
      answer: "A supplied observation.",
      claims: [
        { id: "c1", text: "A supplied observation.", status: "supported", evidenceIds: ["e1"] },
      ],
    },
  };
  let reviewAttempts = 0;
  const workflow = createFinanceModelWorkflow(cfg, {
    maxCalls: 3,
    adapterFactory: (_config, options) => ({
      id: options!.modelRef!,
      provider: "test",
      modelId: options!.modelRef!,
      mode: "deterministic",
      capabilities: ["quality_harness"],
      requiredTools: [],
      requiredSideEffects: [],
      invoke: async (call) => {
        options!.callBudget!.reserve();
        calls.push({ role: call.role, model: options!.modelRef! });
        payloads.push(call.payload as { repairFeedback?: string[] });
        if (call.role === "research_draft") {
          return artifact;
        }
        if (call.role === "adversarial_challenge" && reviewAttempts++ === 0) {
          throw new ModelAdapterError("output_truncated");
        }
        return review;
      },
    }),
  });
  const router = new LogicalAgentModelRouter(workflow.routing);
  const shared = {
    capabilities: { allowedTools: [], allowedSideEffects: [], forbiddenSideEffects: [] },
    signal: new AbortController().signal,
    dispatch: async (fn: () => Promise<unknown>) => fn(),
    record: (receipt: ModelCallReceipt) => receipts.push(receipt),
  };
  await router.invoke({
    ...shared,
    role: "research_draft",
    taskId: "draft",
    correlationId: "independent-review-retry",
    payload: { ...request, agentId: "research_draft", stage: "draft" },
  });
  await expect(
    router.invoke({
      ...shared,
      role: "adversarial_challenge",
      taskId: "adversarial",
      correlationId: "independent-review-retry",
      payload: { ...request, agentId: "adversarial_challenge", stage: "adversarial" },
    }),
  ).resolves.toEqual(review);

  expect(calls).toEqual([
    { role: "research_draft", model: "a/reason" },
    { role: "adversarial_challenge", model: "b/review" },
    { role: "adversarial_challenge", model: "b/review" },
  ]);
  expect(payloads[2]?.repairFeedback?.[0]).toContain(
    "Previous adversarial review response was truncated",
  );
  expect(
    receipts.map((receipt) => [receipt.role, receipt.modelId, receipt.outcome, receipt.reason]),
  ).toEqual([
    ["research_draft", "a/reason", "completed", undefined],
    ["adversarial_challenge", "b/review", "failed", "output_truncated"],
    ["adversarial_challenge", "b/review", "completed", undefined],
  ]);
  expect(workflow.callBudget.snapshot()).toEqual({ limit: 3, reserved: 3, remaining: 0 });
});

it("repairs a truncated final review locally without rerunning the quality DAG", async () => {
  const calls: Array<{ role: string; model: string; payload: QualityHarnessModelRequest }> = [];
  const artifact = {
    kind: "artifact",
    artifact: {
      answer: "A supplied observation.",
      claims: [
        { id: "c1", text: "A supplied observation.", status: "supported", evidenceIds: ["e1"] },
      ],
    },
  };
  const workflow = createFinanceModelWorkflow(cfg, {
    adapterFactory: (_config, options) => ({
      id: options!.modelRef!,
      provider: "test",
      modelId: options!.modelRef!,
      mode: "deterministic",
      capabilities: ["quality_harness"],
      requiredTools: [],
      requiredSideEffects: [],
      invoke: async (call) => {
        options!.callBudget!.reserve();
        const payload = call.payload as QualityHarnessModelRequest;
        calls.push({ role: call.role, model: options!.modelRef!, payload });
        if (call.role === "research_draft" || call.role === "formatting") {
          return artifact;
        }
        if (call.role === "final_precheck") {
          if (calls.filter((entry) => entry.role === "final_precheck").length === 1) {
            throw new ModelAdapterError("output_truncated");
          }
          return {
            ...review,
            review: {
              ...review.review,
              findingClosure: {
                artifactSha256: payload.findingPacket!.artifactSha256,
                evidenceSha256: payload.findingPacket!.evidenceSha256,
                resolutions: [],
              },
            },
          };
        }
        return review;
      },
    }),
  });
  const result = await runQualityHarness({
    request: {
      task: "Review supplied facts",
      evidence: [{ id: "e1", text: "A supplied observation." }],
    },
    modelRouting: workflow.routing,
    maxConcurrency: 2,
    maxAttempts: 2,
    verify: () => ({ status: "passed", summary: "Fixture references are valid.", details: [] }),
  });

  expect(
    result.status,
    JSON.stringify({
      attempts: result.attempts.map((attempt) => ({
        status: attempt.status,
        gates: attempt.gates.filter((gate) => !gate.passed),
        errors: attempt.stages.filter((stage) => stage.status !== "completed"),
      })),
      verification: result.verification,
    }),
  ).toBe("verified");
  expect(result.attempts).toHaveLength(1);
  expect(calls.filter((call) => call.role === "research_draft")).toHaveLength(1);
  expect(calls.filter((call) => call.role === "formatting")).toHaveLength(1);
  const finalCalls = calls.filter((call) => call.role === "final_precheck");
  expect(finalCalls).toHaveLength(2);
  expect(finalCalls[1].model).toBe(finalCalls[0].model);
  expect(finalCalls[0].model).not.toBe(calls.find((call) => call.role === "research_draft")!.model);
  expect(finalCalls[1].payload.repairFeedback[0]).toContain("Previous final review was truncated");
});

it.each([
  ["output_truncated", 3],
  ["output_invalid", 3],
  ["output_invalid", 2],
] as const)(
  "adds bounded schema-preserving feedback for %s formatting repair",
  async (code, maxCalls) => {
    const calls: Array<{ role: string; model: string; payload: unknown }> = [];
    const artifact = {
      kind: "artifact",
      artifact: {
        answer: "A supplied observation.",
        claims: [
          { id: "c1", text: "A supplied observation.", status: "supported", evidenceIds: ["e1"] },
        ],
      },
    };
    const workflow = createFinanceModelWorkflow(cfg, {
      maxCalls,
      slotModels: { fast: "a/fast", reasoning: "a/reason", review: "b/review" },
      adapterFactory: (_config, options) => ({
        id: options!.modelRef!,
        provider: "test",
        modelId: options!.modelRef!,
        mode: "deterministic",
        capabilities: ["quality_harness"],
        requiredTools: [],
        requiredSideEffects: [],
        invoke: async (call) => {
          options!.callBudget!.reserve();
          calls.push({ role: call.role, model: options!.modelRef!, payload: call.payload });
          if (
            call.role === "formatting" &&
            calls.filter((item) => item.role === "formatting").length === 1
          ) {
            throw new ModelAdapterError(code);
          }
          return artifact;
        },
      }),
    });
    const router = new LogicalAgentModelRouter(workflow.routing);
    const capabilities = {
      allowedTools: [],
      allowedSideEffects: [],
      forbiddenSideEffects: [],
    } as const;
    const invoke = (role: "research_draft" | "formatting") =>
      router.invoke({
        role,
        taskId: role,
        correlationId: "formatting-truncation-feedback",
        payload: {
          ...request,
          agentId: role,
          stage: role === "research_draft" ? "draft" : "format",
          evidence: [{ id: "e1" }],
        },
        capabilities,
        signal: new AbortController().signal,
        dispatch: async (fn) => fn(),
        record: () => {},
      });

    await invoke("research_draft");
    if (maxCalls === 2) {
      await expect(invoke("formatting")).rejects.toThrow("call_budget_exhausted");
      expect(calls.map((call) => call.role)).toEqual(["research_draft", "formatting"]);
      expect(workflow.callBudget.snapshot()).toEqual({ limit: 2, reserved: 2, remaining: 0 });
      return;
    }
    await expect(invoke("formatting")).resolves.toEqual(artifact);
    const formattingCalls = calls.filter((item) => item.role === "formatting");
    expect(formattingCalls.map((item) => item.model)).toEqual(["a/reason", "a/reason"]);
    expect(formattingCalls[1]?.payload).toMatchObject({
      repairFeedback: [
        expect.stringContaining(
          code === "output_invalid"
            ? "could not be parsed as valid JSON"
            : "Previous formatting response was truncated",
        ),
      ],
    });
    expect(workflow.routing.roles?.formatting?.retryAffinityTruncationOnce).toBe(true);
    expect(workflow.callBudget.snapshot()).toEqual({ limit: 3, reserved: 3, remaining: 0 });
  },
);
