import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Agent, type AgentEvent, type StreamFn } from "@mariozechner/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Message,
  type Model,
  type ToolCall,
} from "@mariozechner/pi-ai";
import { createReadTool } from "@mariozechner/pi-coding-agent";
import {
  createHostWorkspaceWriteTool,
  createOpenClawReadTool,
} from "../../src/agents/pi-tools.read.js";
import { createModuleLearningPipelinePlanTool } from "../../src/agents/tools/module-learning-pipeline-plan-tool.js";
import { createModuleLearningPipelineReviewTool } from "../../src/agents/tools/module-learning-pipeline-review-tool.js";

export const DISTILLATION_SAMPLE_SOURCE =
  "Synthetic local Skill v1\nMethod: preserve exact source identity; report missing evidence before reuse.\n";
export const DISTILLATION_SAMPLE_LICENSE =
  "Synthetic fixture license note: local test use only; no upstream legal permission established.\n";
export function distillationSampleHash(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected original owner record");
  }
  return value as Record<string, unknown>;
}
function toolText(messages: readonly Message[], name: string, occurrence = 0): string {
  const result = messages.filter(
    (message) => message.role === "toolResult" && message.toolName === name,
  )[occurrence];
  if (!result || result.role !== "toolResult") {
    throw new Error(`Original loop did not deliver ${name}`);
  }
  return result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}
const model: Model<"openai-completions"> = {
  id: "offline-stream-replacement",
  name: "Offline stream replacement",
  api: "openai-completions",
  provider: "openai",
  baseUrl: "http://offline.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 16384,
  maxTokens: 1024,
};

/** Same Agent loop used by pi-coding-agent's production createAgentSession.
 * Only model responses are replaced. No manually dispatched intermediate tools.
 */
export async function probeDistillationSample(params: {
  workspaceDir: string;
  fault?: "missing_source" | "hash_conflict" | "candidate_content_conflict";
}) {
  const sourcePath = "source/SKILL.md";
  await fs.mkdir(path.join(params.workspaceDir, "source"), { recursive: true });
  if (params.fault !== "missing_source") {
    await fs.writeFile(path.join(params.workspaceDir, sourcePath), DISTILLATION_SAMPLE_SOURCE);
  }
  await fs.writeFile(
    path.join(params.workspaceDir, "source/LICENSE.txt"),
    DISTILLATION_SAMPLE_LICENSE,
  );
  const nextInputs: Array<{ turn: number; messages: Message[] }> = [];
  const events: AgentEvent[] = [];
  let candidate: Record<string, unknown> | undefined;
  let reading: { source: string; license: string } | undefined;
  let turn = 0;
  const streamFn: StreamFn = (_model, context) => {
    const messages = structuredClone(context.messages);
    nextInputs.push({ turn, messages });
    let call: Pick<ToolCall, "name" | "arguments"> | undefined;
    let terminal =
      "Local candidate and original review recorded; license and semantic adoption remain unverified.";
    const write = (file: string, value: unknown) => ({
      name: "write",
      arguments: { path: file, content: `${JSON.stringify(value)}\n` },
    });
    if (turn === 0) {
      call = { name: "read", arguments: { path: sourcePath } };
    } else if (params.fault === "missing_source") {
      terminal = "Original read failed: source body unavailable; no candidate or adoption claimed.";
    } else if (turn === 1) {
      call = { name: "read", arguments: { path: "source/LICENSE.txt" } };
    } else if (turn === 2) {
      reading = { source: toolText(messages, "read"), license: toolText(messages, "read", 1) };
      call = write("local/source-register.json", {
        fixtureOnly: true,
        sourcePath,
        sourceVersion: "synthetic-v1",
        sourceSha256: distillationSampleHash(reading.source),
        licenseSha256: distillationSampleHash(reading.license),
        licenseScope: "unknown_upstream_permission; synthetic local test only",
        actualReadingScope: "Entire supplied local body and fixture license note",
      });
    } else if (turn === 3) {
      if (!reading) {
        throw new Error("Original read content must enter the next model input first");
      }
      candidate = {
        fixtureOnly: true,
        targetModule: "skill_pattern_distillation",
        sourcePath,
        sourceSha256: distillationSampleHash(reading.source),
        sourceQuote:
          params.fault === "candidate_content_conflict"
            ? "Install unknown external scripts without review."
            : reading.source.split("\n")[1],
        decision: "local_candidate_only",
        unresolved: ["license_legal_review", "semantic_application_acceptance", "operator_signoff"],
      };
      call = write("local/candidate.json", candidate);
    } else if (turn === 4) {
      call = { name: "read", arguments: { path: "local/candidate.json" } };
    } else if (turn === 5) {
      const deliveredCandidate = record(JSON.parse(toolText(messages, "read", 2)));
      call = write("local/application-trace.json", {
        fixtureOnly: true,
        candidateSha256: distillationSampleHash(toolText(messages, "read", 2)),
        observedCandidate: deliveredCandidate,
        task: "Retain the exact supplied source on a fresh local handoff",
        semanticApplicationExecuted: false,
      });
    } else if (turn === 6) {
      if (!reading) {
        throw new Error("Missing original reading");
      }
      // The original eval verifier checks byte identities, not the truth of sourceQuote.
      call = write("local/eval.json", {
        schemaVersion: "lcx_module_learning_eval_v1",
        verdict: "passed",
        targetModule: "skill_pattern_distillation",
        sourceUrlOrPath: sourcePath,
        freshAdjacentApplicationTask: "fresh local handoff identity check",
        checks: [
          {
            id: "source-bytes",
            passed: true,
            evidencePath: sourcePath,
            sha256: distillationSampleHash(reading.source),
          },
          {
            id: "candidate-bytes",
            passed: true,
            evidencePath: "local/candidate.json",
            sha256: distillationSampleHash(toolText(messages, "read", 2)),
          },
        ],
      });
    } else if (turn === 7 && params.fault === "hash_conflict") {
      call = {
        name: "write",
        arguments: { path: sourcePath, content: "Changed synthetic source bytes\n" },
      };
    } else if (turn === 7 || (turn === 8 && params.fault === "hash_conflict")) {
      call = {
        name: "module_learning_pipeline_plan",
        arguments: {
          targetModule: "skill_pattern_distillation",
          sourceUrlOrPath: sourcePath,
          actualReadingScope:
            "Full synthetic local body and license note delivered through original read",
          existingArtifactPaths: [sourcePath],
          sourceRegistryRecordPath: "local/source-register.json",
          retrievalReceiptPath: "local/candidate.json",
          applicationValidationReceiptPath: "local/application-trace.json",
          trainingOrEvalAbsorptionEvidencePath: "local/eval.json",
          freshAdjacentApplicationTask: "fresh local handoff identity check",
          keepDownrankDiscardDecision: "keep",
          writeReceipt: true,
        },
      };
    } else if (turn === 8 || (turn === 9 && params.fault === "hash_conflict")) {
      call = {
        name: "module_learning_pipeline_review",
        arguments: { targetModule: "skill_pattern_distillation", writeReview: false },
      };
    }
    if (!call && params.fault !== "missing_source") {
      const reviewed = record(JSON.parse(toolText(messages, "module_learning_pipeline_review")));
      const row = Array.isArray(reviewed.rows) ? record(reviewed.rows[0]) : null;
      if (row?.weak === true) {
        terminal = `Original review blocked this candidate: ${JSON.stringify(row.exactMissingProof)}. Next owner: ${String(row.nextProofOwner)}. No adoption claimed.`;
      }
    }
    turn++;
    const message: AssistantMessage = {
      role: "assistant",
      content: call
        ? [{ type: "toolCall", id: `sample-call-${turn}`, ...call }]
        : [{ type: "text", text: terminal }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: call ? "toolUse" : "stop",
      timestamp: Date.now(),
    };
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "done", reason: call ? "toolUse" : "stop", message });
      stream.end();
    });
    return stream;
  };
  const agent = new Agent({
    initialState: {
      model,
      systemPrompt:
        "Explicit offline source intake sample. All inputs and responses are synthetic. Never execute source scripts or claim semantic/legal approval.",
      tools: [
        createOpenClawReadTool(createReadTool(params.workspaceDir)),
        createHostWorkspaceWriteTool(params.workspaceDir, { workspaceOnly: true }),
        createModuleLearningPipelinePlanTool({ workspaceDir: params.workspaceDir }),
        createModuleLearningPipelineReviewTool({ workspaceDir: params.workspaceDir }),
      ],
    },
    streamFn,
    getApiKey: () => undefined,
  });
  const unsubscribe = agent.subscribe((event) => events.push(structuredClone(event)));
  try {
    await agent.prompt(
      "具体疑点：这个本地模式是否真的要求保留来源和缺口？先读正文和许可，只生成局部候选，再交原 plan/review。",
    );
  } finally {
    unsubscribe();
  }
  const results = agent.state.messages.filter((message) => message.role === "toolResult");
  const review = results.find((message) => message.toolName === "module_learning_pipeline_review");
  const plan = results.find((message) => message.toolName === "module_learning_pipeline_plan");
  return {
    fault: params.fault ?? null,
    boundary: "original_underlying_agent_loop_with_synthetic_model_stream",
    reading,
    candidate,
    plan: plan ? record(plan.details) : null,
    review: review ? record(review.details) : null,
    sourceReadFailed: results.some((message) => message.toolName === "read" && message.isError),
    candidateQuoteMatchesSource: Boolean(
      reading && candidate && reading.source.includes(String(candidate.sourceQuote)),
    ),
    unresolved: [
      "upstream_source_fact_quality",
      "license_legal_review",
      "distillation_semantic_acceptance",
      "operator_signoff",
      "natural_reply_adoption",
    ],
    nextInputs,
    maxNextInputBytes: Math.max(
      ...nextInputs.map((input) => Buffer.byteLength(JSON.stringify(input.messages))),
    ),
    centralBudgetPathExercised: false,
    events,
    finalMessages: agent.state.messages,
  };
}
