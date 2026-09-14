import { describe, expect, it } from "vitest";
import {
  buildLocalRoleShadowPrompt,
  buildQualityHarnessModelPrompt,
  parseLocalModelJson,
  parseLocalBaseModelJson,
  resolveLocalTextModelRuntimeConfig,
} from "./local-text-model-adapter.js";

describe("local text model adapter contract", () => {
  it("keeps nested draft claims and more than eight evidence IDs visible to reviewers", () => {
    const ids = Array.from({ length: 21 }, (_, n) => `e-${n}`);
    const prompt = buildQualityHarnessModelPrompt({
      schemaVersion: 1,
      runId: "review",
      attempt: 1,
      stage: "adversarial",
      agentId: "adversarial_challenge",
      task: "check the draft",
      evidence: ids.map((id) => ({ id, text: "fact" })),
      sharedContext: {},
      repairFeedback: [],
      instructions: "review",
      dependencyOutputs: {
        research_draft: {
          status: "completed",
          output: {
            kind: "artifact",
            artifact: {
              answer: "observed values",
              claims: [
                { id: "c1", text: "all instruments", status: "supported", evidenceIds: ids },
              ],
            },
          },
        },
      },
    });
    const previous = prompt.split("previous=")[1]?.split("\n")[0];
    expect(previous).toContain('"evidenceIds":' + JSON.stringify(ids));
    expect(previous).not.toContain("[bounded]");
  });
  it("only unwraps complete JSON fences for base specialists", () => {
    expect(parseLocalBaseModelJson('```json\n{"label":"finance"}\n```')).toEqual({
      label: "finance",
    });
    expect(() => parseLocalBaseModelJson('{"facts":[{"quote":"text"}],"tail"')).toThrow();
    expect(() => parseLocalBaseModelJson('commentary {"label":"finance"}')).toThrow();
  });

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
    expect(prompt.length).toBeLessThan(20_000);
    expect(prompt).toContain('verdict:"pass"|"revise"|"reject"');
    expect(prompt).toContain("instructions=return a review");
    expect(prompt).toContain("context=");
    expect(prompt).toContain("previous=");
  });

  it("supports explicitly selected base weights without loading an incompatible LoRA", () => {
    expect(
      resolveLocalTextModelRuntimeConfig({
        adapterPath: "",
        baseModel: true,
        modelId: "/local/new-model",
      }),
    ).toMatchObject({
      baseModel: true,
      adapterPath: "",
      modelId: "/local/new-model",
      allowNetwork: false,
    });
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

  it("bounds large finance evidence and dependency expansion before local inference", () => {
    const prompt = buildLocalRoleShadowPrompt({
      schemaVersion: "lcx_local_role_shadow_v1",
      runId: "run-1",
      taskId: "risk_check",
      role: "risk_check",
      purpose: "review evidence risk",
      ask: "review the supplied evidence",
      evidence: Array.from({ length: 24 }, (_, index) => `evidence-${index}:${"x".repeat(4_000)}`),
      dependencyOutputs: Object.fromEntries(
        Array.from({ length: 18 }, (_, index) => [
          `task-${index}`,
          { output: "y".repeat(4_000), status: "completed" },
        ]),
      ),
    });
    expect(prompt.length).toBeLessThan(20_000);
    expect(prompt).toContain("evidence-0:");
    expect(prompt).not.toContain("evidence-23:");
    expect(prompt).toContain("task-0");
    expect(prompt).not.toContain("task-17");
    expect(prompt).toContain(
      "evidence_coverage=provided:24; included:12; text_may_be_clipped:true",
    );
    expect(prompt).toContain(
      "dependency_coverage=provided:18; included:6; values_may_be_clipped:true",
    );
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

it("does not silently drop later evidence, stage instructions or analysis requirements", () => {
  const prompt = buildQualityHarnessModelPrompt({
    schemaVersion: 1,
    runId: "coverage",
    attempt: 1,
    stage: "draft",
    agentId: "research_draft",
    task: "Compare returns",
    evidence: Array.from({ length: 20 }, (_, i) => ({
      id: `e${i}`,
      text: `asset-${i} return 5% ` + "fact ".repeat(400),
    })),
    sharedContext: { supportingAnalysisContract: { scenarios: "three conditional scenarios" } },
    dependencyOutputs: {},
    repairFeedback: [],
    instructions: "Compare equivalent periods and preserve uncertainty.",
  });
  expect(prompt).toContain("[e19] asset-19");
  expect(prompt).toContain("Compare equivalent periods");
  expect(prompt).toContain("three conditional scenarios");
  expect(prompt).toContain("evidence_coverage=provided:20; included:20; text_may_be_clipped:true");
  expect(prompt).not.toContain('"answer":"bounded answer"');
});

it("aligns allowed evidence IDs with entries that fit the final prompt section", () => {
  const prompt = buildQualityHarnessModelPrompt({
    schemaVersion: 1,
    runId: "section-limit",
    attempt: 1,
    stage: "draft",
    agentId: "research_draft",
    task: "Compare supplied observations",
    evidence: Array.from({ length: 48 }, (_, index) => ({
      id: `source-${index}`,
      text: `fact-${index} ` + "value ".repeat(100),
      source: `source-${index} ` + "x".repeat(600),
    })),
    sharedContext: {},
    dependencyOutputs: {},
    repairFeedback: [],
    instructions: "Compare only included observations.",
  });

  expect(prompt).toContain("evidence_coverage=provided:48; included:");
  expect(prompt).toContain("text_may_be_clipped:true");
  expect(prompt).not.toContain("[source-47]");
  expect(prompt).not.toContain('"source-47"');
});
