import { describe, expect, it } from "vitest";
import {
  buildLocalRoleShadowPrompt,
  createLocalQualityHarnessAdapter,
  buildQualityHarnessModelPrompt,
  buildQualityHarnessModelPromptWithCoverage,
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

it("returns adapter-authored prompt coverage IDs and a stable digest", () => {
  const request = {
    schemaVersion: 1 as const,
    runId: "coverage-proof",
    attempt: 1,
    stage: "draft" as const,
    agentId: "research_draft",
    task: "Review supplied evidence",
    evidence: [
      { id: "early", text: "positive observation", source: "feed" },
      { id: "clipped", text: "x".repeat(2_500), source: "s".repeat(350) },
      { id: "contradiction", text: "contrary observation", source: "feed" },
    ],
    sharedContext: {},
    dependencyOutputs: {},
    repairFeedback: [],
    instructions: "Keep coverage complete",
  };
  const first = buildQualityHarnessModelPromptWithCoverage(request);
  const second = buildQualityHarnessModelPromptWithCoverage(request);
  expect(first.evidenceCoverage).toMatchObject({
    boundary: "canonical_prompt",
    suppliedEvidenceIds: ["early", "clipped", "contradiction"],
    includedEvidenceIds: ["early", "clipped", "contradiction"],
    omittedEvidenceIds: [],
    clippedEvidenceIds: ["clipped"],
  });
  expect(first.evidenceCoverage.promptSha256).toMatch(/^[a-f0-9]{64}$/u);
  expect(first.evidenceCoverage.promptSha256).toBe(second.evidenceCoverage.promptSha256);

  const complete = buildQualityHarnessModelPromptWithCoverage({
    ...request,
    evidence: [{ id: "complete", text: "all supplied text", source: "feed" }],
  });
  expect(complete.evidenceCoverage).toMatchObject({
    suppliedEvidenceIds: ["complete"],
    includedEvidenceIds: ["complete"],
    omittedEvidenceIds: [],
    clippedEvidenceIds: [],
  });
});

it("names evidence omitted by both the 48-item and evidence-section budgets", () => {
  const base = {
    schemaVersion: 1 as const,
    runId: "coverage-budget",
    attempt: 1,
    stage: "draft" as const,
    agentId: "research_draft",
    task: "Review supplied evidence",
    sharedContext: {},
    dependencyOutputs: {},
    repairFeedback: [],
    instructions: "Preserve all evidence",
  };
  const overItemLimit = buildQualityHarnessModelPromptWithCoverage({
    ...base,
    evidence: [
      ...Array.from({ length: 48 }, (_, index) => ({ id: `early-${index}`, text: "fact" })),
      { id: "contradiction-after-48", text: "contrary fact" },
    ],
  });
  expect(overItemLimit.evidenceCoverage.omittedEvidenceIds).toEqual(["contradiction-after-48"]);

  const overSectionLimit = buildQualityHarnessModelPromptWithCoverage({
    ...base,
    evidence: [
      ...Array.from({ length: 40 }, (_, index) => ({
        id: `section-fill-${index}`,
        text: "x".repeat(300),
        source: "s".repeat(300),
      })),
      { id: "section-omission", text: "contrary fact" },
    ],
  });
  expect(overSectionLimit.evidenceCoverage.omittedEvidenceIds).toContain("section-omission");
});

it.each(["draft", "format", "risk"] as const)(
  "preserves caller evidence kinds and scopes numeric generation instructions at %s",
  (stage) => {
    const promptFor = (typed: boolean) =>
      buildQualityHarnessModelPrompt({
        schemaVersion: 1,
        runId: "typed-numeric",
        attempt: 1,
        stage,
        agentId:
          stage === "draft" ? "research_draft" : stage === "format" ? "formatting" : "risk_check",
        task: "Compare supplied synthetic cases",
        evidence: [
          {
            id: "policy",
            text: "预算1000测试单位",
            source: "controller",
            ...(typed ? { kind: "policy" as const } : {}),
          },
          {
            id: "fixture",
            text: "行情年龄30秒",
            source: "fixture",
            ...(typed ? { kind: "synthetic_fixture" as const } : {}),
          },
        ],
        sharedContext: {},
        dependencyOutputs: {},
        repairFeedback: [],
        instructions: "Keep evidence boundaries",
      });
    const typed = promptFor(true);
    expect(typed).toContain("caller_kind=policy");
    expect(typed).toContain("caller_kind=synthetic_fixture");
    expect(typed.includes("Typed nonmarket numeric assertion contract")).toBe(stage !== "risk");
    if (stage !== "risk") {
      expect(typed).toContain("claims.text verbatim as a standalone local sentence");
      expect(typed).toContain("still require matching source and timestamp");
      expect(typed).toContain("Other prose and strategy analysis remain flexible");
    }
    const untyped = promptFor(false);
    expect(untyped).not.toContain("caller_kind=");
    expect(untyped).not.toContain("Typed nonmarket numeric assertion contract");
  },
);

it("denies unqualified local research and final-review authority before model loading", async () => {
  const adapter = createLocalQualityHarnessAdapter(
    resolveLocalTextModelRuntimeConfig({
      adapterPath: "/absent/adapter",
      pythonPath: "/absent/python",
    }),
  );
  expect(adapter.roleScope).toEqual([]);
  await expect(
    adapter.invoke(
      {
        callId: "test",
        correlationId: "test",
        taskId: "test",
        role: "final_precheck",
        attempt: 1,
        provider: adapter.provider,
        modelId: adapter.modelId,
        payload: {},
      },
      new AbortController().signal,
    ),
  ).rejects.toThrow("local_quality_authority_unqualified");
});

it("preserves producer contracts outside clipped instructions and limits IDs to visible evidence", () => {
  const contract = {
    outputPath: "artifact.supportingAnalysis.financeFrameworkProducerInputs",
    requiredFields: ["allowedActionAuthority"],
    description: "x".repeat(4500),
    allowedActionAuthority: "research_only",
    sourceArtifactIds: ["visible", "omitted"],
  };
  const prompt = buildQualityHarnessModelPrompt({
    schemaVersion: 1,
    runId: "producer",
    attempt: 1,
    stage: "draft",
    agentId: "research_draft",
    task: "review",
    evidence: [{ id: "visible", text: "fact" }],
    sharedContext: {
      userConstraints: { padding: "x".repeat(5000), financeFrameworkProducerContract: contract },
    },
    instructions: "x".repeat(3000),
    repairFeedback: [],
    dependencyOutputs: {},
  });
  const line = prompt.split("\n").find((line) => line.startsWith("producer_input_contract="))!;
  expect(JSON.parse(line.slice("producer_input_contract=".length))).toEqual({
    ...contract,
    sourceArtifactIds: ["visible"],
  });
  expect(() =>
    buildQualityHarnessModelPrompt({
      schemaVersion: 1,
      runId: "oversized",
      attempt: 1,
      stage: "draft",
      agentId: "research_draft",
      task: "review",
      evidence: [{ id: "visible", text: "fact" }],
      sharedContext: {
        userConstraints: {
          financeFrameworkProducerContract: { ...contract, description: "x".repeat(21000) },
        },
      },
      instructions: "review",
      repairFeedback: [],
      dependencyOutputs: {},
    }),
  ).toThrow("exceeds prompt budget");
});

it.each(["draft", "format"] as const)(
  "keeps thesis handoff instructions visible in a long %s request",
  (stage) => {
    const contract = { declaredInstruments: ["SPY"], executionAuthority: "none" };
    const request = {
      schemaVersion: 1 as const,
      runId: "thesis",
      attempt: 1,
      stage,
      agentId: stage === "draft" ? "research_draft" : "formatting",
      task: "x".repeat(5000),
      instructions: "x".repeat(3000),
      evidence: [{ id: "e1", text: "SPY observation" }],
      sharedContext: {
        padding: "x".repeat(5000),
        financeThesisProposalContract: contract,
        supportingAnalysisContract: {
          causalHypotheses: "two hypotheses",
          scenarios: "three scenarios",
        },
      },
      dependencyOutputs: {},
      repairFeedback: [],
    };
    const prompt = buildQualityHarnessModelPrompt(request);
    const line = prompt.split("\n").find((line) => line.startsWith("thesis_proposal_contract="))!;
    expect(JSON.parse(line.slice("thesis_proposal_contract=".length))).toEqual(contract);
    expect(prompt).toContain("invalidationConditions:string[]");
    expect(prompt).toContain('For status="uncertain", uncertainty is REQUIRED');
    expect(prompt).toContain("supportingAnalysis?:object");
    expect(prompt).toContain("Formatting must preserve valid proposals");
    expect(prompt).toContain("Omit proposals when evidence does not support one");
    const analysis = prompt
      .split("\n")
      .find((line) => line.startsWith("supporting_analysis_contract="))!;
    expect(JSON.parse(analysis.slice("supporting_analysis_contract=".length))).toEqual(
      request.sharedContext.supportingAnalysisContract,
    );
    expect(prompt).toContain("Formatting must preserve required structured analysis");
    expect(() =>
      buildQualityHarnessModelPrompt({
        ...request,
        sharedContext: { supportingAnalysisContract: { padding: "x".repeat(5001) } },
      }),
    ).toThrow("supporting analysis contract exceeds prompt budget");
    expect(() =>
      buildQualityHarnessModelPrompt({
        ...request,
        sharedContext: {
          financeThesisProposalContract: { padding: "x".repeat(5001) },
        },
      }),
    ).toThrow("exceeds prompt budget");
  },
);
