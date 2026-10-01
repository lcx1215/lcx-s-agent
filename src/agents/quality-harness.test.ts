import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { buildQualityHarnessModelPromptWithCoverage } from "./local-text-model-adapter.js";
import type {
  LogicalAgentModelAdapter,
  LogicalAgentModelRouting,
  ModelCallObservation,
} from "./logical-agent-model-router.js";
import { ModelAdapterError } from "./logical-agent-model-router.js";
import { supportingEvidenceIds } from "./quality-harness-quality.js";
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

describe("supporting evidence references", () => {
  it("excludes context, contrary and unknown citations while preserving legacy artifacts", () => {
    const claim: QualityHarnessArtifact["claims"][number] = {
      id: "claim-1",
      text: "A supported claim with one supporting and three non-supporting references.",
      status: "supported",
      evidenceIds: ["support", "context", "contrary", "unknown"],
      evidenceRelations: [
        { evidenceId: "support", relation: "supports" },
        { evidenceId: "context", relation: "context" },
        { evidenceId: "contrary", relation: "contradicts" },
        { evidenceId: "unknown", relation: "unknown" },
      ],
    };

    expect(supportingEvidenceIds(claim)).toEqual(["support"]);
    expect(supportingEvidenceIds({ ...claim, evidenceRelations: undefined })).toEqual([
      "support",
      "context",
      "contrary",
      "unknown",
    ]);
  });
});

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

function coveredEvidenceRouting(
  params: {
    requests?: QualityHarnessModelRequest[];
    batchResponses?: Array<{ request: QualityHarnessModelRequest; response: unknown }>;
    canonicalAuditPrompts?: string[];
    canonicalPrecheckPrompts?: string[];
    formatArtifact?: QualityHarnessArtifact;
    formatArtifactsByAttempt?: Readonly<Record<number, QualityHarnessArtifact>>;
    omitFinalAuditNoteId?: string;
    longExtractionNotes?: boolean;
    longAdversarialNotes?: boolean;
    failDraft?: boolean;
    failDraftAttempt?: number;
    failFinalAuditBudget?: boolean;
    revisePrecheckAttempt?: number;
    adversarialFindingAttempt?: number;
  } = {},
): LogicalAgentModelRouting {
  const observations = new Map<string, ModelCallObservation>();
  const adapter: LogicalAgentModelAdapter = {
    id: "covered-evidence-fixture",
    provider: "fixture",
    modelId: "covered-evidence-fixture",
    mode: "adapter",
    capabilities: ["quality_harness"],
    requiredTools: [],
    requiredSideEffects: [],
    invoke: async (call) => {
      const current = call.payload as QualityHarnessModelRequest;
      params.requests?.push(current);
      const rendered = buildQualityHarnessModelPromptWithCoverage(current);
      if (current.evidenceBatchMode === "final_artifact_audit") {
        params.canonicalAuditPrompts?.push(rendered.prompt);
      }
      if (current.stage === "precheck") {
        params.canonicalPrecheckPrompts?.push(rendered.prompt);
      }
      observations.set(call.callId, {
        callId: call.callId,
        provider: "fixture",
        modelId: "covered-evidence-fixture",
        transportRequestId: `fixture:${call.callId}`,
        kind: "model_inference",
        evidenceCoverage: rendered.evidenceCoverage,
      });
      if (
        current.stage === "draft" &&
        (params.failDraft || current.attempt === params.failDraftAttempt)
      ) {
        throw new Error("fixture draft failure");
      }
      if (current.evidenceBatchMode === "final_artifact_audit" && params.failFinalAuditBudget) {
        throw new ModelAdapterError("prompt_budget_exceeded");
      }
      if (current.stage === "intake") {
        return {
          kind: "plan",
          requirements: ["review all supplied evidence"],
          missingEvidence: [],
        };
      }
      if (current.stage === "draft" || current.stage === "format") {
        const attemptArtifact =
          current.stage === "format"
            ? params.formatArtifactsByAttempt?.[current.attempt]
            : undefined;
        if (attemptArtifact) {
          return { kind: "artifact", artifact: attemptArtifact };
        }
        if (current.stage === "format" && params.formatArtifact) {
          return { kind: "artifact", artifact: params.formatArtifact };
        }
        const evidenceId = current.evidence[0]?.id ?? "missing-evidence";
        return {
          kind: "artifact",
          artifact: {
            answer: "The supplied packet is summarized with its evidence limits retained.",
            claims: [
              {
                id: "claim-1",
                text: "The packet contains a recorded observation.",
                status: "supported",
                evidenceIds: [evidenceId],
              },
            ],
          },
        };
      }
      if (current.evidenceBatchMode) {
        const missingNote =
          current.evidenceBatchMode === "final_artifact_audit"
            ? params.omitFinalAuditNoteId
            : undefined;
        const notes = current.evidence
          .filter((entry) => entry.id !== missingNote)
          .map((entry) =>
            current.evidenceBatchMode === "context_extraction" && params.longExtractionNotes
              ? `[${entry.id}] CONTEXT_ONLY_PAYLOAD ${"x".repeat(900)}`
              : `[${entry.id}] reviewed against the formatted artifact.`,
          );
        const contradictions =
          current.evidenceBatchMode === "final_artifact_audit"
            ? current.evidence.filter((entry) =>
                entry.text.includes("contradicts the early thesis"),
              )
            : [];
        const response = {
          kind: "review",
          review: {
            verdict: contradictions.length > 0 ? "revise" : "pass",
            criticalFindings: contradictions.map(
              (entry) => `[${entry.id}] contradicts the summary.`,
            ),
            evidenceGaps: [],
            notes,
          },
        };
        params.batchResponses?.push({ request: current, response });
        return response;
      }
      if (current.stage === "adversarial" && current.attempt === params.adversarialFindingAttempt) {
        return {
          kind: "review",
          review: {
            verdict: "revise",
            criticalFindings: ["The previous artifact challenge remains unresolved."],
            evidenceGaps: [],
            notes: [],
          },
        };
      }
      if (current.stage === "adversarial" && params.longAdversarialNotes) {
        return {
          kind: "review",
          review: {
            verdict: "pass",
            criticalFindings: [],
            evidenceGaps: [],
            notes: Array.from(
              { length: 60 },
              (_, index) => `[adversarial-note-${index}] ${"x".repeat(900)}`,
            ),
          },
        };
      }
      if (current.stage === "precheck" && current.attempt === params.revisePrecheckAttempt) {
        return {
          kind: "review",
          review: {
            verdict: "revise",
            criticalFindings: ["fixture retry trigger"],
            evidenceGaps: [],
            notes: [],
          },
        };
      }
      return passReview();
    },
    observe: (call) => observations.get(call.callId),
  };
  return {
    revision: "covered-evidence-fixture-v1",
    adapters: [adapter],
    defaultPolicy: {
      primary: adapter.id,
      requiredCapabilities: ["quality_harness"],
      maxInputBytes: 1_000_000,
      timeoutMs: 1_000,
    },
  };
}

function coverageRequest(itemCount: number): {
  request: QualityHarnessRequest;
  evidenceCoverage: {
    sourceEvidenceIds: string[];
    selectedEvidenceIds: string[];
    runnerOmittedEvidenceIds: string[];
    runnerClippedEvidenceIds: string[];
  };
} {
  const evidence = Array.from({ length: itemCount }, (_, index) => ({
    id: `e-${String(index).padStart(3, "0")}`,
    text:
      index === 48
        ? "Late report contradicts the early thesis and refutes the summary."
        : `Fixture observation ${index}.`,
    source: "fixture-source",
  }));
  const evidenceIds = evidence.map((entry) => entry.id);
  return {
    request: {
      task: "Summarize this evidence packet while retaining contradictory reports.",
      evidence,
    },
    evidenceCoverage: {
      sourceEvidenceIds: evidenceIds,
      selectedEvidenceIds: evidenceIds,
      runnerOmittedEvidenceIds: [],
      runnerClippedEvidenceIds: [],
    },
  };
}

describe("quality harness", () => {
  it("retains the unapproved earlier artifact when a later attempt loses model coverage", async () => {
    const { request: evidenceRequest, evidenceCoverage } = coverageRequest(1);
    const routing = coveredEvidenceRouting({ revisePrecheckAttempt: 1 });
    const result = await runQualityHarness({
      request: evidenceRequest,
      maxAttempts: 2,
      requireEvidenceCoverage: true,
      evidenceCoverage,
      modelRouting: {
        ...routing,
        adapters: routing.adapters.map((adapter) => ({
          ...adapter,
          invoke: (call, signal) => {
            const payload = call.payload as QualityHarnessModelRequest;
            if (payload.attempt === 2 && call.role === "research_draft") {
              throw new ModelAdapterError("provider_payment_required");
            }
            return adapter.invoke(call, signal);
          },
        })),
      },
    });
    expect(result.attempts).toHaveLength(2);
    expect(result.status).toBe("quality-failed");
    expect(result.quality.passed).toBe(false);
    expect(result.finalArtifact?.claims).toHaveLength(1);
    expect(result.evidenceCoverage?.passed).toBe(false);
    expect(result.verification.status).toBe("failed");
  });

  it.each([
    "provider_payment_required",
    "provider_auth",
    "provider_rate_limit",
    "call_budget_exhausted",
  ] as const)(
    "does not restart a required stage after terminal model failure (%s)",
    async (reason) => {
      const requests: QualityHarnessModelRequest[] = [];
      const invoke = demoInvoker({ requests });
      const result = await runQualityHarness({
        request,
        maxAttempts: 2,
        modelRouting: {
          revision: "terminal-failure-fixture-v1",
          adapters: [
            {
              id: "fixture",
              provider: "fixture",
              modelId: "fixture",
              mode: "deterministic",
              capabilities: ["quality_harness"],
              requiredTools: [],
              requiredSideEffects: [],
              invoke: async (call) => {
                if (call.role === "research_draft") {
                  throw new ModelAdapterError(reason);
                }
                return invoke(call.payload);
              },
            },
          ],
          defaultPolicy: {
            primary: "fixture",
            requiredCapabilities: ["quality_harness"],
            maxInputBytes: 100_000,
            timeoutMs: 1_000,
          },
        },
      });
      expect(result.status).toBe("failed");
      expect(result.attempts).toHaveLength(1);
      expect(requests.some((entry) => entry.attempt === 2)).toBe(false);
      expect(result.execution.modelCalls.some((call) => call.reason === reason)).toBe(true);
    },
  );

  it("still repairs a semantic failure when a model fallback completed the required stage", async () => {
    const invoke = demoInvoker({ weakFormat: true });
    const adapter = {
      id: "primary",
      provider: "fixture",
      modelId: "primary",
      mode: "deterministic" as const,
      capabilities: ["quality_harness"],
      requiredTools: [],
      requiredSideEffects: [],
      invoke: async (call: Parameters<LogicalAgentModelAdapter["invoke"]>[0]) => {
        if (call.role === "research_draft") {
          throw new ModelAdapterError("provider_payment_required");
        }
        return invoke(call.payload);
      },
    };
    const result = await runQualityHarness({
      request,
      maxAttempts: 2,
      modelRouting: {
        revision: "successful-fallback-fixture-v1",
        adapters: [
          adapter,
          {
            ...adapter,
            id: "fallback",
            modelId: "fallback",
            invoke: (call) => invoke(call.payload),
          },
        ],
        defaultPolicy: {
          primary: "primary",
          fallback: ["fallback"],
          requiredCapabilities: ["quality_harness"],
          maxInputBytes: 100_000,
          timeoutMs: 1_000,
        },
      },
      verify: async () => ({ status: "passed", summary: "fixture verifier", details: [] }),
    });
    expect(result.status).toBe("verified");
    expect(result.attempts).toHaveLength(2);
    expect(
      result.execution.modelCalls.some((call) => call.reason === "provider_payment_required"),
    ).toBe(true);
  });

  it.each([
    [false, "format"],
    [true, "format"],
    [false, "precheck"],
    [true, "precheck"],
    [false, "grounding"],
    [true, "grounding"],
  ] as const)(
    "reuses only clean preparation after downstream failure (gap=%s, stage=%s)",
    async (gap, failedStage) => {
      const requests: QualityHarnessModelRequest[] = [];
      const invoke = demoInvoker({});
      const result = await runQualityHarness({
        request,
        maxAttempts: 2,
        modelInvoker: async (raw) => {
          const current = raw as QualityHarnessModelRequest;
          requests.push(current);
          if (current.attempt === 1 && current.stage === failedStage) {
            throw new Error("formatter contract failure");
          }
          if (failedStage === "grounding" && current.attempt === 1 && current.stage === "format") {
            return artifact("missing-evidence");
          }
          if (gap && current.attempt === 1 && current.stage === "extraction") {
            return {
              kind: "review",
              review: {
                verdict: "revise",
                criticalFindings: [],
                evidenceGaps: ["missing extraction"],
                notes: ["retry extraction"],
              },
            };
          }
          return invoke(raw);
        },
        verify: async () => ({ status: "passed", summary: "verified", details: [] }),
      });
      expect(result.status).toBe("verified");
      expect(result.attempts[1]?.reusedStageIds?.toSorted()).toEqual(
        gap ? [] : ["data_cleaning", "financial_extraction", "news_classification"],
      );
      expect(requests.filter((entry) => entry.stage === "extraction")).toHaveLength(gap ? 2 : 1);
      expect(requests.filter((entry) => entry.stage === "evidence")).toHaveLength(2);
      expect(requests.filter((entry) => entry.stage === "draft")).toHaveLength(2);
    },
  );

  it("fails closed before deterministic verification when controller coverage omits evidence", async () => {
    const verify = vi.fn(async () => ({
      status: "passed" as const,
      summary: "verified",
      details: [],
    }));
    const receipt = await runQualityHarness({
      request,
      maxAttempts: 1,
      modelInvoker: demoInvoker({}),
      requireEvidenceCoverage: true,
      evidenceCoverage: {
        sourceEvidenceIds: ["market", "contradiction"],
        selectedEvidenceIds: ["market"],
        runnerOmittedEvidenceIds: ["contradiction"],
        runnerClippedEvidenceIds: [],
      },
      verify,
    });

    expect(receipt.status).toBe("quality-failed");
    expect(receipt.verification.status).toBe("failed");
    expect(receipt.verification.details.join("\n")).toContain("contradiction");
    expect(receipt.evidenceCoverage).toMatchObject({
      passed: false,
      controller: { runnerOmittedEvidenceIds: ["contradiction"] },
    });
    expect(receipt.attempts[0]?.gates.find((gate) => gate.id === "evidence_coverage")?.passed).toBe(
      false,
    );
    expect(verify).not.toHaveBeenCalled();
  });

  it("rejects evidence handoff attestations that do not identify a built prompt", async () => {
    const observations = new Map<string, ModelCallObservation>();
    const invoke = demoInvoker({});
    const adapter: LogicalAgentModelAdapter = {
      id: "unverified-boundary",
      provider: "fixture",
      modelId: "fixture-model",
      mode: "adapter",
      capabilities: ["json"],
      requiredTools: [],
      requiredSideEffects: [],
      invoke: async (call) => {
        observations.set(call.callId, {
          callId: call.callId,
          provider: "fixture",
          modelId: "fixture-model",
          transportRequestId: call.callId,
          kind: "model_inference",
          evidenceCoverage: {
            boundary: "structured_request_handoff",
            suppliedEvidenceIds: ["brief"],
            includedEvidenceIds: ["brief"],
            omittedEvidenceIds: [],
            clippedEvidenceIds: [],
          } as unknown as NonNullable<ModelCallObservation["evidenceCoverage"]>,
        });
        return invoke(call.payload);
      },
      observe: (call) => observations.get(call.callId),
    };
    const receipt = await runQualityHarness({
      request,
      maxAttempts: 1,
      modelRouting: {
        revision: "unverified-boundary-v1",
        adapters: [adapter],
        defaultPolicy: {
          primary: adapter.id,
          requiredCapabilities: ["json"],
          maxInputBytes: 100_000,
          timeoutMs: 1_000,
        },
      },
      requireEvidenceCoverage: true,
      evidenceCoverage: {
        sourceEvidenceIds: ["brief"],
        selectedEvidenceIds: ["brief"],
        runnerOmittedEvidenceIds: [],
        runnerClippedEvidenceIds: [],
      },
    });

    expect(receipt.status).toBe("quality-failed");
    expect(receipt.evidenceCoverage?.issues.join("\n")).toContain(
      "evidence_coverage_boundary_mismatch",
    );
  });

  it("sends a contradiction after item 48 to a later final-artifact audit", async () => {
    const { request: evidenceRequest, evidenceCoverage } = coverageRequest(49);
    const requests: QualityHarnessModelRequest[] = [];
    const batchResponses: Array<{ request: QualityHarnessModelRequest; response: unknown }> = [];
    const verify = vi.fn(async () => ({
      status: "passed" as const,
      summary: "verified",
      details: [],
    }));
    const receipt = await runQualityHarness({
      request: evidenceRequest,
      maxAttempts: 1,
      modelRouting: coveredEvidenceRouting({ requests, batchResponses }),
      requireEvidenceCoverage: true,
      evidenceCoverage,
      verify,
    });

    const lateEvidenceId = evidenceRequest.evidence[48]?.id;
    expect(lateEvidenceId).toBe("e-048");
    const primaryAudit = requests.find(
      (entry) => entry.agentId === "evidence_integrity" && !entry.evidenceBatchMode,
    );
    expect(primaryAudit?.evidence.some((entry) => entry.id === lateEvidenceId)).toBe(false);
    expect(primaryAudit?.instructions).toContain(
      "those IDs being absent from this raw packet is not an evidence gap",
    );
    const lateExtraction = requests.find(
      (entry) =>
        entry.evidenceBatchMode === "context_extraction" &&
        entry.evidence.some((item) => item.id === lateEvidenceId),
    );
    expect(lateExtraction?.instructions).toContain(
      "Evidence assigned to other packets is not a local evidence gap",
    );
    expect(receipt.evidenceCoverage?.batches?.flatMap((batch) => batch.evidenceIds)).toContain(
      lateEvidenceId,
    );
    const lateAudit = requests.find(
      (entry) =>
        entry.evidenceBatchMode === "final_artifact_audit" &&
        entry.evidence.some((item) => item.id === lateEvidenceId),
    );
    expect(lateAudit?.dependencyOutputs.formatting).toMatchObject({
      status: "completed",
      output: {
        kind: "artifact",
        auditProjection: { artifactSha256: expect.stringMatching(/^[a-f0-9]{64}$/u) },
        artifact: { answer: expect.stringContaining("SHA-256") },
      },
    });
    const lateAuditResponse = batchResponses.find(
      ({ request: batchRequest }) =>
        batchRequest.evidenceBatchMode === "final_artifact_audit" &&
        batchRequest.evidence.some((item) => item.id === lateEvidenceId),
    )?.response;
    expect(lateAuditResponse).toMatchObject({
      kind: "review",
      review: {
        verdict: "revise",
        criticalFindings: [expect.stringContaining(lateEvidenceId)],
      },
    });
    expect(receipt.status).toBe("quality-failed");
    expect(
      receipt.attempts[0]?.gates.find((gate) => gate.id === "evidence_batch_reviews"),
    ).toMatchObject({ passed: false, reason: expect.stringContaining("final artifact audit") });
    expect(verify).not.toHaveBeenCalled();
  });

  it("passes the current batch claim declarations and full artifact identity to final-audit prompts", async () => {
    const { request: evidenceRequest, evidenceCoverage } = coverageRequest(1);
    const tailClaim = "TAIL_CLAIM_WITH_UNSUPPORTED_ASSERTION";
    const canonicalAuditPrompts: string[] = [];
    const formattedArtifact: QualityHarnessArtifact = {
      answer: `${"Formatted artifact context. ".repeat(360)}TAIL_ANSWER_CONTEXT`,
      claims: [
        {
          id: "claim-1",
          text: "First retained analysis detail. ".repeat(120),
          status: "uncertain",
          evidenceIds: ["e-000"],
          uncertainty: "The supplied batch does not resolve this claim.",
        },
        {
          id: "claim-2",
          text: "Second retained analysis detail. ".repeat(120),
          status: "uncertain",
          evidenceIds: ["e-000"],
          uncertainty: "The supplied batch does not resolve this claim.",
        },
        {
          id: "claim-tail",
          text: tailClaim,
          status: "uncertain",
          evidenceIds: ["e-000"],
          uncertainty: "Tail claim retained for full-artifact review.",
        },
      ],
    };
    expect(formattedArtifact.answer.length).toBeLessThan(12_000);
    expect(JSON.stringify(formattedArtifact).length).toBeGreaterThan(16_000);
    expect(JSON.stringify(formattedArtifact).length).toBeLessThan(44_000);
    const receipt = await runQualityHarness({
      request: evidenceRequest,
      maxAttempts: 1,
      modelRouting: coveredEvidenceRouting({
        canonicalAuditPrompts,
        formatArtifact: formattedArtifact,
      }),
      requireEvidenceCoverage: true,
      evidenceCoverage,
    });

    expect(canonicalAuditPrompts.length).toBeGreaterThan(0);
    expect(canonicalAuditPrompts[0]).toMatch(/artifactSha256[^a-f0-9]+[a-f0-9]{64}/u);
    expect(canonicalAuditPrompts[0]).not.toContain("TAIL_ANSWER_CONTEXT");
    expect(canonicalAuditPrompts[0]).toContain(tailClaim);
    expect(canonicalAuditPrompts[0]).toContain("the original answer is intentionally omitted");
    expect(canonicalAuditPrompts[0]).toContain("complete formatted artifact's SHA-256 identity");
    expect(canonicalAuditPrompts[0]).toContain("the full final_precheck");
    expect(canonicalAuditPrompts[0]).toContain("exactly one note for each supplied evidence ID");
    expect(canonicalAuditPrompts[0]).toContain("Flag unsupported claims or contradictions");
    expect(canonicalAuditPrompts[0]).not.toContain("Review the complete final formatted artifact");
    expect(canonicalAuditPrompts[0]).toContain(
      "Never reproduce, summarize, or quote the artifact itself.",
    );
    expect(receipt.evidenceCoverage?.issues).not.toContain(
      "evidence_batch_model_call_no_attempt:evidence_batch_review_1",
    );
  });

  it("keeps batch audits bounded while retaining each batch's original cited claims", async () => {
    const { request: evidenceRequest, evidenceCoverage } = coverageRequest(49);
    const requests: QualityHarnessModelRequest[] = [];
    const canonicalAuditPrompts: string[] = [];
    const artifact: QualityHarnessArtifact = {
      answer: `UNRELATED_ANSWER_PAYLOAD ${"answer-context ".repeat(500)}`,
      claims: [
        {
          id: "claim-e000",
          text: "Original declaration for e-000: early earnings estimate is uncertain.",
          status: "uncertain",
          evidenceIds: ["e-000"],
          uncertainty: "The packet contains no confirming source.",
        },
        {
          id: "claim-e048",
          text: "Original declaration for e-048: late report contradicts the thesis.",
          status: "uncertain",
          evidenceIds: ["e-048"],
          uncertainty: "The report's scope is limited.",
        },
        {
          id: "unrelated-claim",
          text: "UNRELATED_CLAIM_PAYLOAD",
          status: "uncertain",
          evidenceIds: ["e-047"],
          uncertainty: "Unrelated to the current packet.",
        },
      ],
    };
    const receipt = await runQualityHarness({
      request: evidenceRequest,
      maxAttempts: 1,
      modelRouting: coveredEvidenceRouting({
        requests,
        canonicalAuditPrompts,
        formatArtifact: artifact,
      }),
      requireEvidenceCoverage: true,
      evidenceCoverage,
    });

    const auditRequests = requests.filter(
      (entry) => entry.evidenceBatchMode === "final_artifact_audit",
    );
    expect(auditRequests.length).toBeGreaterThan(1);
    expect(canonicalAuditPrompts).toHaveLength(auditRequests.length);
    const firstBatchIndex = auditRequests.findIndex((entry) =>
      entry.evidence.some(({ id }) => id === "e-000"),
    );
    const lateBatchIndex = auditRequests.findIndex((entry) =>
      entry.evidence.some(({ id }) => id === "e-048"),
    );
    expect(firstBatchIndex).toBeGreaterThanOrEqual(0);
    expect(lateBatchIndex).toBeGreaterThanOrEqual(0);
    const firstPrompt = canonicalAuditPrompts[firstBatchIndex] ?? "";
    const latePrompt = canonicalAuditPrompts[lateBatchIndex] ?? "";
    expect(firstPrompt).toContain(
      "Original declaration for e-000: early earnings estimate is uncertain.",
    );
    expect(firstPrompt).not.toContain("Original declaration for e-048");
    expect(latePrompt).toContain(
      "Original declaration for e-048: late report contradicts the thesis.",
    );
    expect(latePrompt).not.toContain("Original declaration for e-000");
    for (const prompt of canonicalAuditPrompts) {
      expect(prompt).toMatch(/artifactSha256[^a-f0-9]+[a-f0-9]{64}/u);
      expect(prompt).not.toContain("UNRELATED_ANSWER_PAYLOAD");
      expect(prompt.length).toBeLessThan(25_000);
    }
    const hashes = canonicalAuditPrompts.map(
      (prompt) => prompt.match(/artifactSha256[^a-f0-9]+([a-f0-9]{64})/u)?.[1],
    );
    expect(new Set(hashes).size).toBe(1);
    expect(hashes[0]).toMatch(/^[a-f0-9]{64}$/u);
    expect(receipt.evidenceCoverage?.passed).toBe(true);
  });

  it("preserves the complete formatted artifact through canonical precheck formatting", async () => {
    const { request: evidenceRequest, evidenceCoverage } = coverageRequest(1);
    const canonicalPrecheckPrompts: string[] = [];
    const artifactTail = "PRECHECK_ARTIFACT_TAIL_AFTER_SIX_THOUSAND_CHARS";
    const formattedArtifact: QualityHarnessArtifact = {
      answer: `${"Full formatted artifact context. ".repeat(240)}${artifactTail}`,
      claims: [
        {
          id: "claim-1",
          text: "The packet contains a recorded observation.",
          status: "supported",
          evidenceIds: ["e-000"],
        },
      ],
    };
    expect(JSON.stringify(formattedArtifact).length).toBeGreaterThan(6_000);

    await runQualityHarness({
      request: evidenceRequest,
      maxAttempts: 1,
      modelRouting: coveredEvidenceRouting({
        canonicalPrecheckPrompts,
        formatArtifact: formattedArtifact,
      }),
      requireEvidenceCoverage: true,
      evidenceCoverage,
    });

    expect(canonicalPrecheckPrompts.length).toBeGreaterThan(0);
    expect(canonicalPrecheckPrompts[0]).toContain(artifactTail);
  });

  it("bounds final-precheck handoffs while binding closure to the full evidence set", async () => {
    const { request: evidenceRequest, evidenceCoverage } = coverageRequest(49);
    const requests: QualityHarnessModelRequest[] = [];
    const batchResponses: Array<{ request: QualityHarnessModelRequest; response: unknown }> = [];
    const canonicalPrecheckPrompts: string[] = [];
    const artifactTail = "FINAL_ARTIFACT_SENTINEL";
    const formattedArtifact: QualityHarnessArtifact = {
      answer: `Final artifact remains complete. ${artifactTail}`,
      claims: [
        {
          id: "claim-1",
          text: "The packet contains a recorded observation.",
          status: "supported",
          evidenceIds: ["e-000"],
        },
      ],
    };

    const receipt = await runQualityHarness({
      request: evidenceRequest,
      maxAttempts: 1,
      modelRouting: coveredEvidenceRouting({
        requests,
        batchResponses,
        canonicalPrecheckPrompts,
        formatArtifact: formattedArtifact,
        longAdversarialNotes: true,
      }),
      requireEvidenceCoverage: true,
      evidenceCoverage,
    });

    const precheck = requests.find((entry) => entry.stage === "precheck");
    expect(
      precheck,
      JSON.stringify(
        receipt.attempts[0]?.stages.map(({ taskId, status, error }) => ({ taskId, status, error })),
      ),
    ).toBeDefined();
    const fullAdversarialReview = {
      kind: "review",
      review: {
        verdict: "pass",
        criticalFindings: [],
        evidenceGaps: [],
        notes: Array.from(
          { length: 60 },
          (_, index) => `[adversarial-note-${index}] ${"x".repeat(900)}`,
        ),
      },
    };
    expect(JSON.stringify(fullAdversarialReview).length).toBeGreaterThan(44_000);
    expect(JSON.stringify(precheck?.dependencyOutputs).length).toBeLessThan(44_000);
    expect(precheck?.dependencyOutputs.formatting).toMatchObject({
      output: { artifact: formattedArtifact },
    });
    expect(precheck?.dependencyOutputs.evidence_batch_extract_2).toMatchObject({
      output: {
        projection: "lcx_quality_precheck_stage_summary_v1",
        outputSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
    });
    expect(precheck?.dependencyOutputs.adversarial_challenge).toMatchObject({
      output: {
        projection: "lcx_quality_precheck_stage_summary_v1",
        review: {
          noteCount: 60,
          notesOmittedCount: 56,
          verdict: "pass",
        },
        outputSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
    });
    const adversarialProjection = precheck?.dependencyOutputs.adversarial_challenge as {
      output?: { review?: { notes?: readonly { text: string; truncated: boolean }[] } };
    };
    expect(adversarialProjection.output?.review?.notes).toHaveLength(4);
    expect(adversarialProjection.output?.review?.notes?.[0]?.text).toContain(
      "[adversarial-note-0]",
    );
    expect(adversarialProjection.output?.review?.notes?.[0]?.truncated).toBe(true);
    expect(precheck?.dependencyOutputs.evidence_batch_review_4).toMatchObject({
      output: { review: { notes: expect.arrayContaining([expect.stringContaining("[e-048]")]) } },
    });
    expect(precheck?.findingPacket?.evidenceSha256).toBe(
      createHash("sha256")
        .update(JSON.stringify(normalizeQualityRequest(evidenceRequest).evidence))
        .digest("hex"),
    );
    const prompt = canonicalPrecheckPrompts[0] ?? "";
    expect(prompt).toContain(artifactTail);
    expect(prompt.match(new RegExp(artifactTail, "gu"))).toHaveLength(1);
    expect(prompt).toContain("adversarial-note-0");
    expect(prompt).not.toContain("adversarial-note-5");
  });

  it("reports dependency-blocked batch calls distinctly without passing evidence coverage", async () => {
    const { request: evidenceRequest, evidenceCoverage } = coverageRequest(1);
    const receipt = await runQualityHarness({
      request: evidenceRequest,
      maxAttempts: 1,
      modelRouting: coveredEvidenceRouting({ failDraft: true }),
      requireEvidenceCoverage: true,
      evidenceCoverage,
    });

    expect(receipt.status).toBe("quality-failed");
    expect(receipt.evidenceCoverage?.passed).toBe(false);
    expect(receipt.evidenceCoverage?.issues).toContain(
      "evidence_batch_model_call_blocked:evidence_batch_review_1",
    );
    expect(receipt.evidenceCoverage?.issues).not.toContain(
      "evidence_batch_model_call_no_attempt:evidence_batch_review_1",
    );
    expect(
      receipt.attempts[0]?.stages.find((stage) => stage.taskId === "evidence_batch_review_1")
        ?.status,
    ).toBe("blocked");
  });

  it("reports attempted failed batch calls with an allowlisted reason and remains fail-closed", async () => {
    const { request: evidenceRequest, evidenceCoverage } = coverageRequest(1);
    const receipt = await runQualityHarness({
      request: evidenceRequest,
      maxAttempts: 1,
      modelRouting: coveredEvidenceRouting({ failFinalAuditBudget: true }),
      requireEvidenceCoverage: true,
      evidenceCoverage,
    });

    expect(receipt.status).toBe("quality-failed");
    expect(receipt.evidenceCoverage?.passed).toBe(false);
    expect(receipt.evidenceCoverage?.issues).toContain(
      "evidence_batch_model_call_attempt_failed:evidence_batch_review_1:1:prompt_budget_exceeded",
    );
    expect(receipt.evidenceCoverage?.issues).not.toContain(
      "evidence_batch_model_call_no_attempt:evidence_batch_review_1",
    );
    expect(receipt.evidenceCoverage?.issues).not.toContain(
      "evidence_batch_model_call_blocked:evidence_batch_review_1",
    );
    expect(
      receipt.attempts[0]?.stages.find((stage) => stage.taskId === "evidence_batch_review_1")
        ?.modelCalls,
    ).toMatchObject([{ outcome: "failed", reason: "prompt_budget_exceeded" }]);
    expect(JSON.stringify(receipt.evidenceCoverage?.issues)).not.toMatch(
      /fixture draft failure|secret|token/u,
    );
  });

  it("does not borrow completed batch audits from an earlier attempt", async () => {
    const { request: evidenceRequest, evidenceCoverage } = coverageRequest(1);
    const receipt = await runQualityHarness({
      request: evidenceRequest,
      maxAttempts: 2,
      modelRouting: coveredEvidenceRouting({
        revisePrecheckAttempt: 1,
        failDraftAttempt: 2,
      }),
      requireEvidenceCoverage: true,
      evidenceCoverage,
    });

    expect(receipt.attempts).toHaveLength(2);
    expect(
      receipt.attempts[0]?.stages.find((stage) => stage.taskId === "evidence_batch_review_1"),
    ).toMatchObject({ status: "completed", modelCalls: [{ outcome: "completed" }] });
    expect(
      receipt.attempts[1]?.stages.find((stage) => stage.taskId === "evidence_batch_review_1"),
    ).toMatchObject({ status: "blocked", modelCalls: [] });
    expect(
      receipt.execution.modelCalls.some(
        (call) => call.taskId === "evidence_batch_review_1" && call.outcome === "completed",
      ),
    ).toBe(true);
    expect(receipt.evidenceCoverage?.passed).toBe(false);
    expect(receipt.evidenceCoverage?.issues).toContain(
      "evidence_batch_model_call_blocked:evidence_batch_review_1",
    );
    expect(receipt.evidenceCoverage?.issues).not.toContain(
      "evidence_batch_model_call_no_attempt:evidence_batch_review_1",
    );
  });

  it("blocks verification when a final batch review omits an evidence ID note", async () => {
    const { request: evidenceRequest, evidenceCoverage } = coverageRequest(1);
    const verify = vi.fn(async () => ({
      status: "passed" as const,
      summary: "verified",
      details: [],
    }));
    const receipt = await runQualityHarness({
      request: evidenceRequest,
      maxAttempts: 1,
      modelRouting: coveredEvidenceRouting({ omitFinalAuditNoteId: "e-000" }),
      requireEvidenceCoverage: true,
      evidenceCoverage,
      verify,
    });

    expect(receipt.status).toBe("quality-failed");
    expect(
      receipt.attempts[0]?.gates.find((gate) => gate.id === "evidence_batch_reviews"),
    ).toMatchObject({ passed: false, reason: expect.stringContaining("e-000") });
    expect(verify).not.toHaveBeenCalled();
  });

  it("blocks before model invocation when evidence needs more than four batches", async () => {
    const { request: evidenceRequest, evidenceCoverage } = coverageRequest(65);
    const requests: QualityHarnessModelRequest[] = [];
    const verify = vi.fn(async () => ({
      status: "passed" as const,
      summary: "verified",
      details: [],
    }));
    const receipt = await runQualityHarness({
      request: evidenceRequest,
      maxAttempts: 1,
      modelRouting: coveredEvidenceRouting({ requests }),
      requireEvidenceCoverage: true,
      evidenceCoverage,
      verify,
    });

    expect(receipt.status).toBe("quality-failed");
    expect(receipt.evidenceCoverage?.issues.join("\n")).toContain(
      "evidence_batch_limit_exceeded:4",
    );
    expect(receipt.attempts[0]?.planStatus).toBe("blocked");
    expect(receipt.attempts[0]?.stages).toEqual([]);
    expect(requests).toEqual([]);
    expect(verify).not.toHaveBeenCalled();
  });

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

  it("forwards cross-batch extraction to every downstream reviewer without a DAG cycle", () => {
    const extra = [{ id: "second", text: "independent batch" }];
    const plan = buildQualityHarnessPlan({
      runId: "batch-wiring",
      attempt: 1,
      request,
      evidenceBatches: [request.evidence, extra],
      auditEvidenceBatches: true,
    });
    for (const id of [
      "news_classification",
      "evidence_integrity",
      "risk_check",
      "portfolio_exposure",
      "research_draft",
      "adversarial_challenge",
      "formatting",
      "final_precheck",
    ]) {
      expect(plan.find((task) => task.id === id)?.dependsOn).toContain("evidence_batch_extract_2");
    }
    expect(plan.find((task) => task.id === "evidence_batch_extract_2")?.dependsOn).toEqual([
      "data_cleaning",
    ]);
    expect(plan.find((task) => task.id === "data_cleaning")?.dependsOn).toBeUndefined();
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

  it("repairs a sole finance answer safety failure by reusing upstream stages and reauditing the final artifact", async () => {
    const requests: QualityHarnessModelRequest[] = [];
    const verifyAnswers: string[] = [];
    const invalidArtifact: QualityHarnessArtifact = {
      answer: "NVDA 的价格变化为 0.05%。",
      claims: [
        {
          id: "market-price",
          text: "截至 2026-09-06，NVDA 的价格为 480 美元。",
          status: "supported",
          evidenceIds: ["market"],
        },
      ],
    };
    const repairedArtifact: QualityHarnessArtifact = {
      answer: "截至 2026-09-06，公开行情材料记录 NVDA 的价格为 480 美元。",
      claims: [
        {
          id: "market-price",
          text: "截至 2026-09-06，NVDA 的价格为 480 美元。",
          status: "supported",
          evidenceIds: ["market"],
        },
      ],
    };
    const result = await runQualityHarness({
      request: financeRequest,
      maxAttempts: 2,
      requireEvidenceCoverage: true,
      evidenceCoverage: {
        sourceEvidenceIds: ["market"],
        selectedEvidenceIds: ["market"],
        runnerOmittedEvidenceIds: [],
        runnerClippedEvidenceIds: [],
      },
      modelRouting: coveredEvidenceRouting({
        requests,
        formatArtifactsByAttempt: { 1: invalidArtifact, 2: repairedArtifact },
      }),
      verify: async ({ artifact: checked }) => {
        verifyAnswers.push(checked.answer);
        return {
          status: "passed",
          summary: "unchanged deterministic verifier passed",
          details: [],
        };
      },
    });

    expect(result.status).toBe("verified");
    expect(result.attempts.map((attempt) => attempt.status)).toEqual([
      "quality-failed",
      "quality-passed",
    ]);
    expect(result.attempts[0]?.gates.filter((gate) => !gate.passed).map((gate) => gate.id)).toEqual(
      ["finance_answer_safety"],
    );
    expect(result.attempts[1]?.reusedStageIds?.toSorted()).toEqual([
      "data_cleaning",
      "evidence_integrity",
      "financial_extraction",
      "news_classification",
      "portfolio_exposure",
      "research_draft",
      "risk_check",
    ]);
    const retryRequests = requests.filter((entry) => entry.attempt === 2);
    expect(retryRequests.filter((entry) => entry.stage === "format")).toHaveLength(1);
    expect(
      retryRequests.filter((entry) => entry.evidenceBatchMode === "final_artifact_audit"),
    ).toHaveLength(1);
    expect(retryRequests.filter((entry) => entry.stage === "precheck")).toHaveLength(1);
    expect(retryRequests.filter((entry) => entry.stage === "adversarial")).toHaveLength(1);
    expect(retryRequests.some((entry) => entry.stage === "risk")).toBe(false);
    expect(retryRequests.some((entry) => entry.stage === "draft")).toBe(false);
    expect(verifyAnswers).toEqual([repairedArtifact.answer]);
    expect(result.evidenceCoverage?.passed).toBe(true);
  });

  it("reruns adversarial review on the repaired artifact and remains failed when the prior finding persists", async () => {
    const requests: QualityHarnessModelRequest[] = [];
    const invalidArtifact: QualityHarnessArtifact = {
      answer: "NVDA 的价格变化为 0.05%。",
      claims: [
        {
          id: "market-price",
          text: "截至 2026-09-06，NVDA 的价格为 480 美元。",
          status: "supported",
          evidenceIds: ["market"],
        },
      ],
    };
    const repairedArtifact: QualityHarnessArtifact = {
      answer: "截至 2026-09-06，公开行情材料记录 NVDA 的价格为 480 美元。",
      claims: [
        {
          id: "market-price",
          text: "截至 2026-09-06，NVDA 的价格为 480 美元。",
          status: "supported",
          evidenceIds: ["market"],
        },
      ],
    };
    const verify = vi.fn(async () => ({
      status: "passed" as const,
      summary: "must not run while adversarial finding remains",
      details: [],
    }));
    const result = await runQualityHarness({
      request: financeRequest,
      maxAttempts: 2,
      requireEvidenceCoverage: true,
      evidenceCoverage: {
        sourceEvidenceIds: ["market"],
        selectedEvidenceIds: ["market"],
        runnerOmittedEvidenceIds: [],
        runnerClippedEvidenceIds: [],
      },
      modelRouting: coveredEvidenceRouting({
        requests,
        formatArtifactsByAttempt: { 1: invalidArtifact, 2: repairedArtifact },
        adversarialFindingAttempt: 2,
      }),
      verify,
    });

    expect(result.status).toBe("quality-failed");
    expect(result.attempts[0]?.gates.filter((gate) => !gate.passed).map((gate) => gate.id)).toEqual(
      ["finance_answer_safety"],
    );
    expect(
      result.attempts[1]?.gates.filter((gate) => !gate.passed).map((gate) => gate.id),
    ).toContain("adversarial_review");
    expect(
      requests.filter((entry) => entry.attempt === 2 && entry.stage === "adversarial"),
    ).toHaveLength(1);
    expect(verify).not.toHaveBeenCalled();
  });

  it("keeps the full repair path when finance answer safety is not the only failed gate", async () => {
    const requests: QualityHarnessModelRequest[] = [];
    const result = await runQualityHarness({
      request: financeRequest,
      maxAttempts: 2,
      modelInvoker: demoInvoker({
        answer: "NVDA 的价格变化为 0.05%。",
        adversarialFinding: true,
        requests,
      }),
    });
    expect(result.attempts[0]?.gates.filter((gate) => !gate.passed).map((gate) => gate.id)).toEqual(
      expect.arrayContaining(["finance_answer_safety", "adversarial_review"]),
    );
    expect(result.attempts[1]?.reusedStageIds?.toSorted()).toEqual([
      "data_cleaning",
      "financial_extraction",
      "news_classification",
    ]);
    expect(requests.filter((entry) => entry.attempt === 2 && entry.stage === "draft")).toHaveLength(
      1,
    );
    expect(
      requests.filter((entry) => entry.attempt === 2 && entry.stage === "adversarial"),
    ).toHaveLength(1);
  });

  it("does not let the scoped repair bypass finance answer safety when the revised artifact remains unsafe", async () => {
    const requests: QualityHarnessModelRequest[] = [];
    const verify = vi.fn(async () => ({
      status: "passed" as const,
      summary: "must not run for unsafe answer",
      details: [],
    }));
    const unsafeArtifact: QualityHarnessArtifact = {
      answer: "NVDA 的价格变化为 0.05%。",
      claims: [
        {
          id: "market-price",
          text: "截至 2026-09-06，NVDA 的价格为 480 美元。",
          status: "supported",
          evidenceIds: ["market"],
        },
      ],
    };
    const result = await runQualityHarness({
      request: financeRequest,
      maxAttempts: 2,
      requireEvidenceCoverage: true,
      evidenceCoverage: {
        sourceEvidenceIds: ["market"],
        selectedEvidenceIds: ["market"],
        runnerOmittedEvidenceIds: [],
        runnerClippedEvidenceIds: [],
      },
      modelRouting: coveredEvidenceRouting({
        requests,
        formatArtifactsByAttempt: { 1: unsafeArtifact, 2: unsafeArtifact },
      }),
      verify,
    });

    expect(result.status).toBe("quality-failed");
    expect(result.attempts).toHaveLength(2);
    expect(
      result.attempts.map(
        (attempt) => attempt.gates.find((gate) => gate.id === "finance_answer_safety")?.passed,
      ),
    ).toEqual([false, false]);
    expect(verify).not.toHaveBeenCalled();
    expect(requests.some((entry) => entry.attempt === 2 && entry.stage === "precheck")).toBe(true);
    expect(
      requests.some(
        (entry) => entry.attempt === 2 && entry.evidenceBatchMode === "final_artifact_audit",
      ),
    ).toBe(true);
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

  it("does not treat a scheduled execution time as a completed fill", async () => {
    const run = async (answer: string) =>
      runQualityHarness({
        request: financeRequest,
        maxAttempts: 1,
        modelInvoker: demoInvoker({ answer }),
        verify: async () => ({ status: "passed", summary: "verified", details: [] }),
      });

    const scheduled = await run("The strategy is executed at the next tradable point.");
    expect(
      scheduled.attempts[0]?.gates.find((gate) => gate.id === "finance_answer_safety"),
    ).toMatchObject({ passed: true });
    const description =
      "The trend sign is provisional and is not the rule's executed monthly signal.";
    const described = await run(description);
    expect(
      described.attempts[0]?.gates.find((gate) => gate.id === "finance_answer_safety"),
    ).toMatchObject({ passed: true });

    for (const answer of [
      "Filled NVDA at the open.",
      "fIlLeD NVDA at the open.",
      "Filled at $100.",
      "Filled 100 shares at the open.",
      "Executed at $100.",
      "Executed NVDA at the open.",
      "executed nvda at the open.",
      "已成交 NVDA。",
      "该笔交易已执行。",
      `${description} Executed NVDA at the open.`,
    ]) {
      const receipt = await run(answer);
      expect(
        receipt.attempts[0]?.gates.find((gate) => gate.id === "finance_answer_safety"),
        answer,
      ).toMatchObject({ passed: false, reason: expect.stringContaining("execution claim") });
    }
  });

  it("distinguishes a volatility window label from an uncited market value", async () => {
    const run = async (answer: string) =>
      runQualityHarness({
        request: financeRequest,
        maxAttempts: 1,
        modelInvoker: demoInvoker({ answer }),
        verify: async () => ({ status: "passed", summary: "verified", details: [] }),
      });
    const label =
      "No 12-month daily-return volatility series is supplied for SPY; current risk cannot be sized.";
    const described = await run(label);
    expect(
      described.attempts[0]?.gates.find((gate) => gate.id === "finance_answer_safety"),
    ).toMatchObject({ passed: true });
    const ungrounded = await run(`${label} SPY current price is 12 dollars.`);
    expect(
      ungrounded.attempts[0]?.gates.find((gate) => gate.id === "finance_answer_safety"),
    ).toMatchObject({ passed: false, reason: expect.stringContaining("12dollars") });
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
    "SPY当前价格60美元。",
    "合成案例价格100美元，SPY实际当前价格100美元。",
    "政策上限5%，BTC当前收益率5%。",
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
  it("does not reuse a synthetic duration claim for a separate real latency assertion", async () => {
    expect(
      await gate(
        "SPY合成案例行情年龄30秒。SPY当前真实行情延迟30秒。",
        [
          {
            id: "duration",
            text: "SPY合成案例行情年龄30秒。",
            status: "supported",
            evidenceIds: ["fixture"],
          },
        ],
        [{ ...synthetic, text: "SPY合成案例行情年龄30秒。" }],
      ),
    ).toMatchObject({ passed: false });
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

describe("institutional counterevidence laundering", () => {
  it.each(["contradicts", "context", "unknown", "supports"] as const)(
    "only supporting evidence can ground a number (%s)",
    async (relation) => {
      const result = await runQualityHarness({
        request: {
          task: "Review the current NVDA stock price evidence",
          evidence: [
            { id: "policy", source: "policy", text: "Research only; no execution authority." },
            { id: "quote", source: "fixture-feed", text: "As of 2026-09-06 NVDA price 480 USD." },
          ],
        },
        maxAttempts: 1,
        verify: () => ({ status: "passed", summary: "fixture verifier", details: [] }),
        modelInvoker: async (raw) => {
          const current = raw as QualityHarnessModelRequest;
          if (current.stage === "intake") {
            return { kind: "plan", requirements: ["bounded research"], missingEvidence: [] };
          }
          if (current.stage === "draft" || current.stage === "format") {
            return {
              kind: "artifact",
              artifact: {
                answer: "NVDA current price is 480 USD. Research only.",
                claims: [
                  {
                    id: "price",
                    text: "NVDA current price is 480 USD.",
                    status: "supported",
                    evidenceIds: ["policy", "quote"],
                    epistemicClass: "source_observation",
                    evidenceRelations: [
                      { evidenceId: "policy", relation: "supports" },
                      { evidenceId: "quote", relation },
                    ],
                  },
                ],
              },
            };
          }
          return passReview();
        },
      });
      if (relation === "supports") {
        expect(result.status).toBe("verified");
      } else {
        expect(result.status).toBe("quality-failed");
        expect(
          result.attempts[0].gates.find((gate) => gate.id === "finance_answer_safety")?.passed,
        ).toBe(false);
      }
    },
  );
});

describe("deterministic evidence scope", () => {
  it("overrides caller assertions and carries repeated reports to every role and the receipt", async () => {
    const requests: QualityHarnessModelRequest[] = [];
    const result = await runQualityHarness({
      request: {
        task: "Summarize this research packet.",
        evidence: [
          { id: "brief", text: "one report", source: "https://one.test/a" },
          { id: "copy", text: "one report", source: "https://two.test/b" },
        ],
        sharedContext: {
          evidenceMultiplicity: { independentSourceCount: 99, semanticTruth: "verified" },
        },
      },
      modelInvoker: demoInvoker({ requests }),
      maxAttempts: 1,
      verify: () => ({ status: "passed", summary: "references checked only", details: [] }),
    });
    expect(requests.length).toBeGreaterThan(0);
    for (const stage of requests) {
      expect(stage.sharedContext.evidenceMultiplicity).toMatchObject({
        distinctPacketGroups: 1,
        duplicateGroups: [["brief", "copy"]],
        independentSourceCount: null,
        semanticTruth: "not_assessed",
      });
    }
    expect(result.evidenceScope).toMatchObject({
      independentSourceCount: null,
      semanticTruth: "not_assessed",
    });
  });
});
