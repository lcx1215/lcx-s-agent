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
import { summarizeQualityModelDiversity } from "./quality-harness.js";
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
  it("deduplicates configured candidates and separates draft from review without inferring quality", () => {
    const manifest = inspectFinanceModelWorkflow(cfg);
    expect(manifest.models).toHaveLength(3);
    expect(manifest.slots).toMatchObject({ reasoning: "a/reason", review: "b/review" });
    expect(manifest.distinctDraftAndReviewModels).toBe(true);
  });
  it("bounds final-review effort on supported adapters while preserving provider-default opt-out", () => {
    for (const reasoningPolicy of ["bounded_workflow", "provider_default"] as const) {
      const efforts: unknown[] = [];
      createFinanceModelWorkflow(cfg, {
        reasoningPolicy,
        adapterFactory: (_config, options) => {
          efforts.push(options?.reasoningEffortByRole?.final_precheck);
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
        invoke: async () => {
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
