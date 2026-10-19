import { afterEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  createConfiguredFinanceModelAdapter,
  createFinanceModelCallBudget,
} from "./configured-finance-model-adapter.js";
import { buildQualityHarnessModelPromptWithCoverage } from "./local-text-model-adapter.js";
import {
  FINANCE_WORKFLOW_MAX_MODEL_INPUT_BYTES,
  type QualityHarnessModelRequest,
} from "./quality-harness-contract.js";

function request(): QualityHarnessModelRequest {
  const roles = [
    "data_cleaning",
    "financial_extraction",
    "news_classification",
    "evidence_integrity",
    "risk_check",
    "portfolio_exposure",
    "research_draft",
    "adversarial_challenge",
    "formatting",
    ...Array.from({ length: 5 }, (_, i) => `evidence_batch_extract_${i + 2}`),
    ...Array.from({ length: 6 }, (_, i) => `evidence_batch_review_${i + 1}`),
  ];
  return {
    schemaVersion: 1,
    runId: "retained-stage-handoff",
    attempt: 2,
    stage: "precheck",
    agentId: "final_precheck",
    task: "Review the entire final artifact and unresolved findings",
    evidence: [{ id: "source-1", text: "Bounded original source packet." }],
    sharedContext: { noExecutionAuthority: true },
    repairFeedback: [],
    instructions: "Preserve independent review and explicit unresolved findings.",
    dependencyOutputs: Object.fromEntries(
      roles.map((role, index) => [
        role,
        role === "formatting"
          ? {
              kind: "artifact",
              artifact: {
                answer: `Complete final answer ${"a".repeat(3500)} FINAL_ARTIFACT_TAIL`,
                claims: [
                  {
                    id: "claim-1",
                    text: "An uncertain interpretation",
                    status: "uncertain",
                    evidenceIds: ["source-1"],
                    uncertainty: "Method evidence remains incomplete",
                  },
                ],
              },
            }
          : {
              kind: "review",
              review: {
                verdict: "revise",
                criticalFindings: [`critical-${index}`],
                evidenceGaps: [`gap-${index}`],
                notes: [`${role}:${"x".repeat(3500)}:TAIL-${index}`],
              },
            },
      ]),
    ),
    findingPacket: {
      artifactSha256: "a".repeat(64),
      evidenceSha256: "b".repeat(64),
      findings: [
        {
          id: "unresolved-finding",
          role: "risk_check",
          category: "critical",
          text: "Do not erase the unsupported method inference.",
        },
      ],
    },
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("fits every large final-review dependency in the existing cloud ceiling without clipping", () => {
  const input = request();
  const serialized = JSON.stringify(input.dependencyOutputs);
  expect(serialized.length).toBeGreaterThan(44000);
  const before = JSON.stringify(input);
  const built = buildQualityHarnessModelPromptWithCoverage(input, {
    maxPromptBytes: FINANCE_WORKFLOW_MAX_MODEL_INPUT_BYTES,
  });
  expect(built.prompt).toContain(`previous=${serialized}`);
  expect(built.prompt).toContain("provided:20; included:20; values_may_be_clipped:false");
  expect(built.prompt).toContain("FINAL_ARTIFACT_TAIL");
  expect(built.prompt).toContain("unresolved-finding");
  expect(built.prompt).toContain("Never close a still-present error");
  expect(Buffer.byteLength(built.prompt)).toBeLessThanOrEqual(
    FINANCE_WORKFLOW_MAX_MODEL_INPUT_BYTES,
  );
  expect(JSON.stringify(input)).toBe(before);
  // The small local model retains its existing section cap.
  expect(() => buildQualityHarnessModelPromptWithCoverage(input)).toThrow("review prompt budget");
});

it("measures the complete UTF-8 prompt including findings against the unchanged ceiling", () => {
  const input = request();
  const built = buildQualityHarnessModelPromptWithCoverage(input, {
    maxPromptBytes: FINANCE_WORKFLOW_MAX_MODEL_INPUT_BYTES,
  });
  expect(() =>
    buildQualityHarnessModelPromptWithCoverage(input, {
      maxPromptBytes: Buffer.byteLength(built.prompt) - 1,
    }),
  ).toThrow("complete quality input exceeds");
  const unicode = {
    ...input,
    findingPacket: {
      ...input.findingPacket!,
      findings: [{ ...input.findingPacket!.findings[0], text: "中".repeat(90000) }],
    },
  };
  expect(JSON.stringify(unicode).length).toBeLessThan(FINANCE_WORKFLOW_MAX_MODEL_INPUT_BYTES);
  expect(() =>
    buildQualityHarnessModelPromptWithCoverage(unicode, {
      maxPromptBytes: FINANCE_WORKFLOW_MAX_MODEL_INPUT_BYTES,
    }),
  ).toThrow("complete quality input exceeds");
  expect(() =>
    buildQualityHarnessModelPromptWithCoverage(input, {
      maxPromptBytes: FINANCE_WORKFLOW_MAX_MODEL_INPUT_BYTES + 1,
    }),
  ).toThrow("invalid quality prompt budget");
});

it("still rejects a dropped stage rather than relaxing dependency coverage", () => {
  const input = request();
  expect(() =>
    buildQualityHarnessModelPromptWithCoverage(
      {
        ...input,
        dependencyOutputs: {
          ...input.dependencyOutputs,
          unplanned_stage: { marker: "must not disappear" },
        },
      },
      { maxPromptBytes: FINANCE_WORKFLOW_MAX_MODEL_INPUT_BYTES },
    ),
  ).toThrow("dependencies exceed");
});

const config: OpenClawConfig = {
  agents: { defaults: { model: { primary: "handoff/fixture" } } },
  models: {
    providers: {
      handoff: {
        api: "openai-completions",
        baseUrl: "https://quality-handoff.invalid/v1",
        apiKey: "offline-fixture",
        models: [
          {
            id: "fixture",
            name: "offline",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 1000000,
            maxTokens: 4096,
          },
        ],
      },
    },
  },
};
function invocation(input: QualityHarnessModelRequest) {
  return {
    callId: "offline-handoff",
    correlationId: input.runId,
    taskId: "final_precheck",
    role: "final_precheck" as const,
    attempt: 2,
    provider: "handoff",
    modelId: "fixture",
    payload: input,
  };
}

it("uses the original configured adapter once and transmits the full dependency tail", async () => {
  vi.stubEnv("LCX_MODEL_TRAJECTORY", "0");
  const http = vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (typeof init?.body !== "string") {
      throw new Error("expected serialized original model request");
    }
    const sent = JSON.parse(init.body);
    const prompt = sent.messages.map((message: { content: string }) => message.content).join("\n");
    expect(prompt).toContain(`previous=${JSON.stringify(request().dependencyOutputs)}`);
    expect(prompt).toContain("TAIL-19");
    expect(sent.max_tokens).toBe(256);
    return new Response(
      JSON.stringify({
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify({
                kind: "review",
                review: {
                  verdict: "revise",
                  criticalFindings: ["Original unresolved finding remains"],
                  evidenceGaps: [],
                  notes: ["No acceptance inferred from transport success"],
                },
              }),
            },
          },
        ],
      }),
      { status: 200 },
    );
  });
  vi.stubGlobal("fetch", http);
  const budget = createFinanceModelCallBudget(2);
  const adapter = createConfiguredFinanceModelAdapter(config, {
    maxTokens: 256,
    callBudget: budget,
  });
  await adapter.invoke(invocation(request()), new AbortController().signal);
  expect(http).toHaveBeenCalledTimes(1);
  expect(budget.snapshot()).toMatchObject({ limit: 2, reserved: 1, remaining: 1 });
});

it("rejects an oversized rendered cloud request before provider dispatch or budget reservation", async () => {
  vi.stubEnv("LCX_MODEL_TRAJECTORY", "0");
  const http = vi.fn(async () => {
    throw new Error("network forbidden");
  });
  vi.stubGlobal("fetch", http);
  const budget = createFinanceModelCallBudget(2);
  const adapter = createConfiguredFinanceModelAdapter(config, { callBudget: budget });
  const input = request();
  await expect(
    adapter.invoke(
      invocation({
        ...input,
        findingPacket: {
          ...input.findingPacket!,
          findings: [{ ...input.findingPacket!.findings[0], text: "中".repeat(90000) }],
        },
      }),
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: "prompt_budget_exceeded" });
  expect(http).not.toHaveBeenCalled();
  expect(budget.snapshot()).toMatchObject({ reserved: 0, remaining: 2 });
});
