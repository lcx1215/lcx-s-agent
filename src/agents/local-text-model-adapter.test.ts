import { describe, expect, it } from "vitest";
import {
  buildLocalRoleShadowPrompt,
  buildQualityHarnessModelPrompt,
  parseLocalModelJson,
  resolveLocalTextModelRuntimeConfig,
} from "./local-text-model-adapter.js";

describe("local text model adapter contract", () => {
  it("parses JSON after bounded runtime chatter", () => {
    expect(parseLocalModelJson('loading\n{"kind":"plan","requirements":[]}')).toEqual({
      kind: "plan",
      requirements: [],
    });
  });

  it("rejects output without a JSON object", () => {
    expect(() => parseLocalModelJson("not-json")).toThrow(
      "local text model output did not contain a JSON object",
    );
  });

  it("recovers a declared quality envelope when only its tail is malformed", () => {
    expect(
      parseLocalModelJson(
        '{"kind":"review","review":{"verdict":"pass","criticalFindings":[],"evidenceGaps":[],"notes":[]},"tail"',
      ),
    ).toEqual({
      kind: "review",
      review: { verdict: "pass", criticalFindings: [], evidenceGaps: [], notes: [] },
    });
  });

  it("builds a bounded prompt without exposing execution receipts", () => {
    const prompt = buildQualityHarnessModelPrompt({
      schemaVersion: 1,
      runId: "run-1",
      attempt: 1,
      stage: "intake",
      agentId: "data_cleaning",
      task: "review the supplied evidence",
      evidence: [{ id: "e1", text: "known fact" }],
      sharedContext: { researchOnly: true },
      dependencyOutputs: {},
      repairFeedback: [],
      instructions: "return a plan",
    });
    expect(prompt).toContain("stage=intake");
    expect(prompt).toContain("evidence=");
    expect(prompt).not.toContain("lcx_model_call_v1");
  });

  it("bounds dependency expansion and repeats the exact output contract", () => {
    const prompt = buildQualityHarnessModelPrompt({
      schemaVersion: 1,
      runId: "run-1",
      attempt: 2,
      stage: "evidence",
      agentId: "evidence_integrity",
      task: "review the supplied evidence",
      evidence: [{ id: "e1", text: "known fact" }],
      sharedContext: { researchOnly: true },
      dependencyOutputs: {
        data_cleaning: {
          status: "completed",
          output: {
            kind: "review",
            review: {
              verdict: "pass",
              criticalFindings: Array.from({ length: 100 }, () => "repeated finding"),
            },
          },
        },
      },
      repairFeedback: Array.from({ length: 100 }, () => "repeated feedback"),
      instructions: "return a review",
    });
    expect(prompt.length).toBeLessThan(8_000);
    expect(prompt).toContain(
      'Return only one JSON object. Exact schema: {"kind":"review","review":{"verdict":"pass","criticalFindings":[],"evidenceGaps":[],"notes":[]}}',
    );
  });

  it("requires an explicit adapter path", () => {
    expect(() => resolveLocalTextModelRuntimeConfig({ adapterPath: "  " })).toThrow(
      "local text model adapter requires an explicit adapter path",
    );
  });

  it("builds a compact role shadow prompt with explicit side-effect boundaries", () => {
    const prompt = buildLocalRoleShadowPrompt({
      schemaVersion: "lcx_local_role_shadow_v1",
      runId: "run-1",
      taskId: "data_cleaning",
      role: "data_cleaning",
      purpose: "clean supplied evidence",
      ask: "review the supplied evidence",
      evidence: ["known fact"],
      dependencyOutputs: {},
    });
    expect(prompt).toContain('"risk_boundaries":["research_only"]');
    expect(prompt).toContain("role=data_cleaning");
    expect(prompt).toContain("Do not invent current data");
  });

  it("keeps model downloads offline unless explicitly allowed", () => {
    expect(resolveLocalTextModelRuntimeConfig({ adapterPath: "/tmp/adapter" }).allowNetwork).toBe(
      false,
    );
    expect(
      resolveLocalTextModelRuntimeConfig({ adapterPath: "/tmp/adapter", allowNetwork: true })
        .allowNetwork,
    ).toBe(true);
  });
});
