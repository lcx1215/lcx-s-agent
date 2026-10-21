import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createFinanceModelWorkflow } from "../../src/agents/finance-model-workflow.js";
import * as runner from "../../src/agents/finance-research-runner.js";
import { buildQualityHarnessModelPromptWithCoverage } from "../../src/agents/local-text-model-adapter.js";
import { ModelAdapterError } from "../../src/agents/logical-agent-model-router.js";
import type { QualityHarnessModelRequest } from "../../src/agents/quality-harness-contract.js";
import { probeOriginalCaseflow } from "../fixtures/lcx-waterflow-caseflow-probe.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true })));
});

it("measures the shared configured committee and quality repair call budget offline", async () => {
  const nativeRun = runner.runFinanceResearchRun;
  const measurements: unknown[] = [];
  for (const { maxCalls, mode } of [
    { maxCalls: 18, mode: "repair" },
    { maxCalls: 24, mode: "repair" },
    { maxCalls: 48, mode: "repair" },
    { maxCalls: 24, mode: "quality_disabled" },
    { maxCalls: 24, mode: "quality_unconfigured" },
    { maxCalls: 24, mode: "preparation_failed" },
    { maxCalls: 24, mode: "quality_rejected" },
  ]) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-budget-probe-"));
    roots.push(root);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline budget probe only"));
    const calls: { role: string; stage: string; quality: boolean }[] = [];
    let workflow: ReturnType<typeof createFinanceModelWorkflow> | undefined;
    let prechecks = 0;
    const intercepted = vi
      .spyOn(runner, "runFinanceResearchRun")
      .mockImplementation(async (options) => {
        const invoke = options.modelInvoker!;
        workflow = createFinanceModelWorkflow(
          {
            tools: {
              financeModelSlots: { fast: "a/fast", reasoning: "a/reason", review: "b/review" },
            },
          },
          {
            maxCalls,
            adapterFactory: (_cfg, adapterOptions) => {
              const [provider, modelId] = adapterOptions!.modelRef!.split("/");
              const payloads = new Map<string, QualityHarnessModelRequest>();
              return {
                id: adapterOptions!.modelRef!,
                provider,
                modelId,
                mode: "adapter",
                capabilities: ["quality_harness"],
                requiredTools: [],
                requiredSideEffects: [],
                invoke: async (call, signal) => {
                  adapterOptions!.callBudget!.reserve();
                  const payload = call.payload as QualityHarnessModelRequest;
                  payloads.set(call.callId, payload);
                  calls.push({
                    role: call.role,
                    stage: payload.stage,
                    quality: !!payload.findingPacket,
                  });
                  if (mode === "preparation_failed" && payload.stage === "draft") {
                    throw new ModelAdapterError("provider_auth");
                  }
                  if (payload.stage === "precheck" && payload.findingPacket) {
                    prechecks++;
                    const rejected = mode === "quality_rejected" || prechecks === 1;
                    return {
                      kind: "review",
                      review: {
                        verdict: rejected ? "revise" : "pass",
                        criticalFindings: rejected ? ["offline first-pass correction"] : [],
                        evidenceGaps: [],
                        notes: ["Offline final packet review."],
                        findingClosure: {
                          artifactSha256: payload.findingPacket.artifactSha256,
                          evidenceSha256: payload.findingPacket.evidenceSha256,
                          resolutions: [],
                        },
                      },
                    };
                  }
                  return invoke(payload, signal);
                },
                observe: (call) => ({
                  callId: call.callId,
                  provider,
                  modelId,
                  kind: "model_inference",
                  transportRequestId: `offline:${call.callId}`,
                  evidenceCoverage: buildQualityHarnessModelPromptWithCoverage(
                    payloads.get(call.callId)!,
                  ).evidenceCoverage,
                }),
              };
            },
          },
        );
        return nativeRun({
          ...options,
          modelInvoker: undefined,
          modelRouting: workflow.routing,
          qualityEnabled: mode !== "quality_disabled",
          qualityModelRouting: mode === "quality_unconfigured" ? undefined : workflow.routing,
        });
      });
    const probe = await probeOriginalCaseflow({ directory: root, caseId: `budget-${maxCalls}` });
    expect(intercepted).toHaveBeenCalledTimes(1);
    expect(calls.length).toBeLessThanOrEqual(maxCalls);
    measurements.push({
      maxCalls,
      mode,
      calls,
      budget: workflow!.callBudget.snapshot(),
      status: probe.receipt.status,
      committee: probe.receipt.committee,
      quality: probe.receipt.quality,
    });
    if (mode === "quality_disabled" || mode === "quality_unconfigured") {
      expect(probe.receipt.committee?.model.purpose).toBe("full_review");
      expect(probe.receipt.committee?.coverage.equivalenceStatus).toBe("committee_candidate");
      expect(probe.receipt.quality).toBeUndefined();
      expect(probe.receipt.status).toBe("needs_review");
    } else if (mode === "preparation_failed") {
      expect(probe.receipt.status).toBe("needs_review");
      expect(probe.receipt.quality).toBeUndefined();
      expect(probe.receipt.gates).toContainEqual({
        id: "quality",
        passed: false,
        reason: "not_run:research_preparation_failed",
      });
      expect(prechecks).toBe(0);
    } else if (mode === "quality_rejected") {
      expect(probe.receipt.status).toBe("needs_review");
      expect(probe.receipt.quality?.status).toBe("quality-failed");
      expect(prechecks).toBe(2);
    } else if (maxCalls === 18) {
      expect(probe.receipt.status).toBe("needs_review");
      expect(["quality-failed", "failed"]).toContain(probe.receipt.quality?.status);
      expect(
        probe.receipt.quality?.attempts.some((attempt) =>
          attempt.stages.some((stage) =>
            stage.modelCalls?.some((call) => call.reason === "call_budget_exhausted"),
          ),
        ),
      ).toBe(true);
    } else {
      expect(probe.receipt.status).toBe("candidate");
      expect(probe.receipt.quality?.status).toBe("verified");
      expect(probe.receipt.quality?.attempts).toHaveLength(2);
      expect(probe.receipt.quality?.quality.independentRoleReviewCount).toBe(3);
    }
    vi.restoreAllMocks();
  }
  if (process.env.LCX_FINANCE_BUDGET_PROOF) {
    await fs.writeFile(
      process.env.LCX_FINANCE_BUDGET_PROOF,
      JSON.stringify(measurements, null, 2) + "\n",
    );
  }
});
