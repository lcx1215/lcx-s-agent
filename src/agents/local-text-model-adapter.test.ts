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
