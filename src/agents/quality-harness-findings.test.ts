import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createFinanceModelWorkflow } from "./finance-model-workflow.js";
import {
  buildQualityHarnessModelPrompt,
  buildQualityHarnessModelPromptWithCoverage,
} from "./local-text-model-adapter.js";
import { runQualityHarness, type QualityHarnessModelRequest } from "./quality-harness.js";

type Variant =
  | "anchor"
  | "unknown-anchor"
  | "fallback-review"
  | "valid"
  | "plain-pass"
  | "stale-artifact"
  | "stale-evidence"
  | "unknown-evidence"
  | "missing"
  | "duplicate"
  | "unknown-finding"
  | "bad-quote"
  | "unresolved"
  | "reject"
  | "unattested"
  | "self-review"
  | "evidence-audit"
  | "batch-context-valid"
  | "batch-context-unresolved"
  | "batch-context-missing-id";
async function run(variant: Variant) {
  const requests: QualityHarnessModelRequest[] = [];
  const requestsByCallId = new Map<string, QualityHarnessModelRequest>();
  const evidence = [
    { id: "window", text: "SP500 March 10; other sample March 9. Feed unavailable." },
    ...(variant.startsWith("batch-context-")
      ? Array.from({ length: 16 }, (_, index) => ({
          id: `other-${index}`,
          text: "Additional context; missing feed excluded.",
        }))
      : []),
  ];
  const workflow = createFinanceModelWorkflow(
    {
      agents: { defaults: { model: { primary: "a/fast", fallbacks: ["a/author", "b/reviewer"] } } },
    } as OpenClawConfig,
    {
      adapterFactory: (_cfg, options) => {
        const [provider, modelId] = options!.modelRef!.split("/");
        return {
          id: options!.modelRef!,
          provider,
          modelId,
          mode: "adapter",
          capabilities: ["quality_harness"],
          requiredTools: [],
          requiredSideEffects: [],
          observe:
            variant === "unattested"
              ? undefined
              : (call) => {
                  const payload = requestsByCallId.get(call.callId);
                  return {
                    callId: call.callId,
                    provider,
                    modelId,
                    kind: "model_inference",
                    transportRequestId: `test:${call.callId}`,
                    ...(variant.startsWith("batch-context-") && payload
                      ? {
                          evidenceCoverage:
                            buildQualityHarnessModelPromptWithCoverage(payload).evidenceCoverage,
                        }
                      : {}),
                  };
                },
          invoke: async (call) => {
            const req = call.payload as QualityHarnessModelRequest;
            requests.push(req);
            requestsByCallId.set(call.callId, req);
            if (variant.startsWith("batch-context-") && req.evidenceBatchMode) {
              return {
                kind: "review",
                review: {
                  verdict: req.evidenceBatchMode === "context_extraction" ? "revise" : "pass",
                  criticalFindings: [],
                  evidenceGaps:
                    req.evidenceBatchMode === "context_extraction"
                      ? ["The missing feed cannot support a claim."]
                      : [],
                  notes: req.evidence
                    .filter(
                      (entry, index) =>
                        !(
                          variant === "batch-context-missing-id" &&
                          req.evidenceBatchMode === "context_extraction" &&
                          index === 0
                        ),
                    )
                    .map((entry) => `[${entry.id}] Reviewed with the missing feed excluded.`),
                },
              };
            }
            if (req.stage === "draft" || req.stage === "format") {
              return {
                kind: "artifact",
                artifact: {
                  answer:
                    "SP500 starts March 10; the other sample starts March 9. Missing feed excluded.",
                  claims: [
                    {
                      id: "c1",
                      text: "SP500 starts March 10; the other sample starts March 9. Missing feed excluded.",
                      status: "supported",
                      evidenceIds: ["window"],
                    },
                  ],
                },
              };
            }
            if (
              ["extraction", "exposure", "adversarial"].includes(req.stage) ||
              (variant === "evidence-audit" && req.stage === "evidence")
            ) {
              return {
                kind: "review",
                review: {
                  verdict: variant === "reject" ? "reject" : "revise",
                  criticalFindings:
                    req.stage === "exposure"
                      ? []
                      : ["Do not state these windows start on the same date."],
                  evidenceGaps:
                    req.stage === "exposure" ? ["The missing feed cannot support a claim."] : [],
                  notes: ["Check required correction"],
                },
              };
            }
            const packet = req.findingPacket;
            if (
              req.stage === "precheck" &&
              packet &&
              variant !== "plain-pass" &&
              !(variant === "fallback-review" && provider === "b")
            ) {
              let resolutions = packet.findings.map((finding) => ({
                findingId: finding.id,
                status:
                  variant === "unresolved" ||
                  (variant === "batch-context-unresolved" &&
                    finding.role.startsWith("evidence_batch_extract_"))
                    ? "unresolved"
                    : "resolved",
                evidenceIds: [variant === "unknown-evidence" ? "invented" : "window"],
                artifactClaimId: variant === "unknown-anchor" ? "invented" : "c1",
                artifactQuote:
                  variant === "anchor" || variant === "unknown-anchor"
                    ? ""
                    : variant === "bad-quote"
                      ? "Same start date"
                      : "SP500 starts March 10; the other sample starts March 9. Missing feed excluded.",
                rationale:
                  "The final answer explicitly distinguishes dates and excludes the unsupported feed.",
              }));
              if (variant === "missing") {
                resolutions = resolutions.slice(1);
              }
              if (variant === "duplicate") {
                resolutions[1] = resolutions[0];
              }
              if (variant === "unknown-finding") {
                resolutions[0] = { ...resolutions[0], findingId: "e".repeat(64) };
              }
              return {
                kind: "review",
                review: {
                  verdict: "pass",
                  criticalFindings: [],
                  evidenceGaps: [],
                  notes: ["Checked final revision"],
                  findingClosure: {
                    artifactSha256:
                      variant === "stale-artifact" ? "0".repeat(64) : packet.artifactSha256,
                    evidenceSha256:
                      variant === "stale-evidence" ? "0".repeat(64) : packet.evidenceSha256,
                    resolutions,
                  },
                },
              };
            }
            return {
              kind: "review",
              review: {
                verdict: "pass",
                criticalFindings: [],
                evidenceGaps: [],
                notes: ["Checked"],
              },
            };
          },
        };
      },
    },
  );
  const routing =
    variant === "self-review"
      ? {
          ...workflow.routing,
          roles: {
            ...workflow.routing.roles,
            final_precheck: {
              ...(workflow.routing.roles?.final_precheck ?? workflow.routing.defaultPolicy),
              primary: "a/author",
              fallback: [],
              excludeModelsUsedBy: [],
            },
          },
        }
      : workflow.routing;
  const result = await runQualityHarness({
    request: {
      task: "Compare frozen windows.",
      evidence,
    },
    ...(variant.startsWith("batch-context-")
      ? {
          requireEvidenceCoverage: true,
          evidenceCoverage: {
            sourceEvidenceIds: evidence.map((entry) => entry.id),
            selectedEvidenceIds: evidence.map((entry) => entry.id),
            runnerOmittedEvidenceIds: [],
            runnerClippedEvidenceIds: [],
          },
        }
      : {}),
    modelRouting: routing,
    maxAttempts: 1,
    verify: async () => ({ status: "passed", summary: "Fixture checked", details: [] }),
  });
  return { result, requests };
}

describe("version-bound finding closure", () => {
  it("closes a batch extraction finding only after independent version-bound resolution", async () => {
    const { result, requests } = await run("batch-context-valid");
    expect(result.status, JSON.stringify(result.attempts)).toBe("verified");
    const finding = result.attempts[0].findings?.find(
      (finding) => finding.role === "evidence_batch_extract_2",
    );
    expect(finding).toMatchObject({ status: "resolved", reviewer: "b/reviewer" });
    expect(requests.find((req) => req.stage === "precheck")?.findingPacket?.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: finding?.id, role: "evidence_batch_extract_2" }),
      ]),
    );
    for (const variant of ["batch-context-unresolved", "batch-context-missing-id"] as const) {
      const { result: refused } = await run(variant);
      expect(refused.status, variant).toBe("quality-failed");
      expect(
        refused.attempts[0].gates.find((gate) => gate.id === "evidence_batch_reviews")?.passed,
      ).toBe(false);
    }
  });
  it("closes original date and adjacent evidence-gap/adversarial findings with retained provenance", async () => {
    const { result, requests } = await run("valid");
    expect(result.status, JSON.stringify(result.attempts)).toBe("verified");
    expect(result.attempts[0].findings).toHaveLength(3);
    expect(
      result.attempts[0].findings?.every(
        (finding) => finding.status === "resolved" && finding.reviewer === "b/reviewer",
      ),
    ).toBe(true);
    expect(
      result.attempts[0].stages.find((stage) => stage.agentId === "financial_extraction")
        ?.reviewVerdict,
    ).toBe("revise");
    const precheck = requests.find((req) => req.stage === "precheck")!;
    const prompt = buildQualityHarnessModelPrompt(precheck);
    for (const finding of precheck.findingPacket!.findings) {
      expect(prompt).toContain(finding.id);
    }
    expect(prompt).toContain(precheck.findingPacket!.artifactSha256);
    expect(prompt).toContain("finding_packet=");
    expect(prompt).toContain(precheck.findingPacket!.evidenceSha256);
    expect(prompt).toContain("the full normalized evidence set");
  });
  it("falls back from a structurally incomplete review to another non-author model", async () => {
    const { result } = await run("fallback-review");
    expect(result.status).toBe("verified");
    const calls = result.attempts[0].stages.find(
      (stage) => stage.agentId === "final_precheck",
    )!.modelCalls!;
    const contractFailures = calls.filter(
      (call) => call.outcome === "failed" && call.reason === "output_contract",
    );
    expect(contractFailures).toHaveLength(2);
    expect(
      contractFailures.every((call) => call.provider === "b" && call.modelId === "reviewer"),
    ).toBe(true);
    const repairRetryIndex = calls.findIndex(
      (call, index) =>
        index > 0 &&
        call.provider === contractFailures[0].provider &&
        call.modelId === contractFailures[0].modelId,
    );
    const fallbackIndex = calls.findIndex(
      (call) => call.provider === "a" && call.modelId === "fast" && call.outcome === "completed",
    );
    expect(repairRetryIndex).toBeGreaterThan(0);
    expect(fallbackIndex).toBeGreaterThan(repairRetryIndex);
    expect(result.attempts[0].findings?.every((finding) => finding.reviewer === "a/fast")).toBe(
      true,
    );
  });
  it("resolves an exact current claim anchor and stores its original text", async () => {
    const { result } = await run("anchor");
    expect(result.status).toBe("verified");
    expect(
      result.attempts[0].findings?.every(
        (finding) =>
          finding.resolution?.artifactClaimId === "c1" &&
          finding.resolution.artifactQuote ===
            "SP500 starts March 10; the other sample starts March 9. Missing feed excluded.",
      ),
    ).toBe(true);
  });
  it.each<Variant>([
    "unknown-anchor",
    "plain-pass",
    "stale-artifact",
    "stale-evidence",
    "unknown-evidence",
    "missing",
    "duplicate",
    "unknown-finding",
    "bad-quote",
    "unresolved",
    "reject",
    "unattested",
    "self-review",
    "evidence-audit",
  ])("fails closed for %s", async (variant) => {
    const { result } = await run(variant);
    expect(["quality-failed", "failed"]).toContain(result.status);
    expect(result.verification.status).toBe("not-requested");
    if (variant === "plain-pass") {
      expect(
        result.attempts[0].stages
          .find((stage) => stage.agentId === "final_precheck")
          ?.modelCalls?.some((call) => call.reason === "output_contract"),
      ).toBe(true);
    }
    if (variant === "bad-quote") {
      expect(
        result.attempts[0].findings?.some(
          (finding) => finding.closureFailure === "artifact_claim_anchor_invalid",
        ),
      ).toBe(true);
    }
  });
});
