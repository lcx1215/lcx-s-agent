import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sendExternalMessage } from "../extensions/external/src/send.js";
import {
  auditWorkflowHandoffs,
  type WorkflowHandoffEvidence,
} from "../scripts/operator/lcx-flow-graph.js";
import * as commercialOwner from "../src/agents/commercial-answer-pipeline.js";
import { createCommercialAnswerReplyGate } from "../src/agents/commercial-answer-reply-gate.js";
import * as groundingOwner from "../src/agents/finance-answer-grounding-gate.js";
import type { FinanceResearchRunReceipt } from "../src/agents/finance-research-runner.js";
import * as replyHelpers from "../src/auto-reply/reply/agent-runner-helpers.js";
import * as replyAgentOwner from "../src/auto-reply/reply/agent-runner.js";
import { createFollowupRunner } from "../src/auto-reply/reply/followup-runner.js";
import { resetInboundDedupe } from "../src/auto-reply/reply/inbound-dedupe.js";
import * as sessionPromptOwner from "../src/auto-reply/reply/session-updates.js";
import { createMockTypingController } from "../src/auto-reply/reply/test-helpers.js";
import {
  onAgentEvent,
  getAgentRunContext,
  resetAgentRunContextForTest,
  type AgentEventPayload,
} from "../src/infra/agent-events.js";
import { peekSystemEventEntries, resetSystemEventsForTest } from "../src/infra/system-events.js";
import { prepareOriginalFinanceModuleMain } from "./fixtures/lcx-waterflow-finance-module-main-probe.js";
import {
  executeOfflineFinanceResearchTool,
  publishOriginalFinanceResult,
} from "./fixtures/lcx-waterflow-finance-reply-probe.js";
import { probeOriginalDefaultLanguageReply } from "./fixtures/lcx-waterflow-language-default-probe.js";
import { probeOriginalLanguageReply } from "./fixtures/lcx-waterflow-language-probe.js";
const model = vi.hoisted(() => ({ invoke: vi.fn() }));
const configuredTransport = vi.hoisted(() => ({
  invoke: vi.fn(async () => {
    throw new Error("Configured finance provider transport forbidden in offline module proof");
  }),
}));
vi.mock("../src/agents/configured-finance-model-adapter.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/agents/configured-finance-model-adapter.js")>()),
  createConfiguredFinanceModelAdapter: (_config: unknown, options: { modelRef?: string }) => ({
    id: `private-forbidden:${options.modelRef}`,
    provider: "fixture",
    modelId: options.modelRef ?? "never-provider",
    mode: "adapter",
    capabilities: ["quality_harness"],
    requiredTools: [],
    requiredSideEffects: [],
    invoke: configuredTransport.invoke,
  }),
}));
vi.mock("../src/agents/model-fallback.js", () => ({
  runWithModelFallback: async (params: {
    provider: string;
    model: string;
    run: (provider: string, model: string) => Promise<unknown>;
  }) => ({
    result: await params.run(params.provider, params.model),
    provider: params.provider,
    model: params.model,
  }),
}));
vi.mock("../src/agents/pi-embedded.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/agents/pi-embedded.js")>()),
  queueEmbeddedPiMessage: () => false,
  runEmbeddedPiAgent: (params: unknown) => model.invoke(params),
}));
// The real reply owner can already be imported during a barrel's partial-mock factory.
// Guard the same model I/O export at its defining module as well.
vi.mock("../src/agents/pi-embedded-runner/run.js", () => ({
  runEmbeddedPiAgent: (params: unknown) => model.invoke(params),
}));
vi.mock("../src/agents/cli-runner.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/agents/cli-runner.js")>()),
  runCliAgent: () => {
    throw new Error("CLI provider forbidden in offline language proof");
  },
}));
vi.mock("../src/auto-reply/reply/queue.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/auto-reply/reply/queue.js")>()),
  enqueueFollowupRun: () => {
    throw new Error("offline proof must not schedule");
  },
  scheduleFollowupDrain: () => {},
}));
vi.mock("../src/cron/store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/cron/store.js")>()),
  loadCronStore: async () => ({ version: 1, jobs: [] }),
}));
vi.mock("node:dns/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:dns/promises")>()),
  lookup: async () => [{ address: "93.184.216.34", family: 4 }],
}));
vi.mock("../src/shared/global-evidence-projection-source.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/shared/global-evidence-projection-source.js")>()),
  readCanonicalGlobalEvidenceProjectionCandidate: async () => null,
}));

const roots: string[] = [];
afterEach(async () => {
  resetInboundDedupe();
  resetSystemEventsForTest();
  resetAgentRunContextForTest();
  model.invoke.mockReset();
  configuredTransport.invoke.mockClear();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

type ObservedToolReviewFeedback = {
  sourceRef: string;
  sourceSha256: string;
  nextAction: string;
  remainingSoftReplans: number;
  failures: Array<{ moduleId: string; missingEvidence: string[] }>;
  failedGates: Array<{ id: string; reason: string }>;
  qualityFeedback: string[];
  qualityFeedbackRefs?: Array<{ pointer: string; truncated: boolean }>;
  omittedQualityFeedback: number;
};
type ProbeOptions = {
  value?: number;
  text?: string;
  sourceFault?: "missing_source" | "quality_failure";
  hashConflict?: boolean;
  wrongAccount?: boolean;
  wrongRun?: boolean;
  aborted?: boolean;
  timedOut?: boolean;
  stream?: boolean;
  beforeToolBlock?: string;
  extraText?: string;
  cancelDuringTyping?: boolean;
  afterCandidateText?: string;
  afterCandidateMediaUrl?: string;
  queued?: boolean;
  missingOriginalAsk?: boolean;
  defaultIngress?: boolean;
  modules?: "normal" | "missing_producer" | "quality_failure";
};
async function run(options: ProbeOptions = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-finance-reply-"));
  roots.push(root);
  const modulePreparation = options.modules
    ? await prepareOriginalFinanceModuleMain({
        directory: root,
        ...(options.modules !== "normal" ? { fault: options.modules } : {}),
      })
    : undefined;
  const ask =
    modulePreparation?.input.ask ?? "Review supplied BTC evidence and retain uncertainty.";
  const receiver: Array<Record<string, unknown>> = [];
  const events: AgentEventPayload[] = [];
  const auditCalls: Array<{
    ask: string;
    candidate: string;
    input: Parameters<typeof commercialOwner.buildPipelineResult>[2];
    caller: Parameters<typeof commercialOwner.buildPipelineResult>[3];
    output: ReturnType<typeof commercialOwner.buildPipelineResult>;
  }> = [];
  const originalAudit = commercialOwner.buildPipelineResult;
  vi.spyOn(commercialOwner, "buildPipelineResult").mockImplementation((...args) => {
    const output = originalAudit(...args);
    auditCalls.push({ ask: args[0], candidate: args[1], input: args[2], caller: args[3], output });
    return output;
  });
  const partials: string[] = [];
  const hostGroundingCalls: Array<{
    input: Parameters<typeof groundingOwner.checkAnswerGrounding>[0];
    output: ReturnType<typeof groundingOwner.checkAnswerGrounding>;
  }> = [];
  const originalGrounding = groundingOwner.checkAnswerGrounding;
  vi.spyOn(groundingOwner, "checkAnswerGrounding").mockImplementation((input) => {
    const output = originalGrounding(input);
    hostGroundingCalls.push({ input: structuredClone(input), output: structuredClone(output) });
    return output;
  });
  const unsubscribe = onAgentEvent((event) => {
    events.push(structuredClone(event));
  });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const receiverUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    if (receiverUrl !== "https://93.184.216.34/messages") {
      throw new Error("Non-receiver HTTP is forbidden in the offline finance proof");
    }
    if (typeof init?.body !== "string") {
      throw new Error("Original reply transport must send a JSON string body");
    }
    receiver.push(JSON.parse(init.body) as Record<string, unknown>);
    return new Response("", { status: 200 });
  });
  let modelNextInput: unknown;
  let nextDecision:
    | {
        action:
          | "retain_research_stop_optional_learning_retry"
          | "stop_research_reply"
          | "diagnostic_unobserved";
        reason: string;
        sourceSha256: string;
        sourceRef: string;
        learningRetryStarted: false;
        visibleBody?: string;
        boundary: string;
      }
    | undefined;
  let producer: Awaited<ReturnType<typeof executeOfflineFinanceResearchTool>> | undefined;
  let candidate: string | undefined;
  const controller = new AbortController();
  let typingCancelObserved = false;
  if (options.cancelDuringTyping && !options.queued) {
    const originalTyping = replyHelpers.signalTypingIfNeeded;
    vi.spyOn(replyHelpers, "signalTypingIfNeeded").mockImplementation(async (...args) => {
      typingCancelObserved = true;
      controller.abort(new Error("private finance typing-wait cancellation"));
      return originalTyping(...args);
    });
  }
  let modelInvocations = 0;
  let originalRunContext: ReturnType<typeof getAgentRunContext>;
  model.invoke.mockImplementation(
    async (input: {
      runId: string;
      sessionKey: string;
      model?: string;
      provider?: string;
      onPartialReply?: (payload: { text: string }) => Promise<void>;
      onBlockReply?: (payload: { text: string }) => Promise<void>;
      onBlockReplyFlush?: () => Promise<void>;
    }) => {
      modelInvocations++;
      if (options.queued && modelInvocations === 1) {
        // The original default caller creates its own followup input without a model answer.
        return {
          payloads: [],
          meta: { agentMeta: { provider: "anthropic", model: "claude-sonnet-4-5" } },
        };
      }
      if (options.beforeToolBlock) {
        await input.onBlockReply?.({ text: options.beforeToolBlock });
        await input.onBlockReplyFlush?.();
      }
      if (modulePreparation) {
        originalRunContext = getAgentRunContext(input.runId);
        if (!originalRunContext || originalRunContext.sessionKey !== input.sessionKey) {
          throw new Error("original queued caller did not register this run/session context");
        }
      }
      producer = await executeOfflineFinanceResearchTool(
        root,
        options.sourceFault,
        modulePreparation
          ? {
              preparation: modulePreparation,
              signal: controller.signal,
              host: { runId: input.runId, sessionKey: input.sessionKey },
            }
          : undefined,
      );
      await publishOriginalFinanceResult({
        ...input,
        runId: options.wrongRun ? `${input.runId}-other` : input.runId,
        result: producer.result,
        ...(modulePreparation ? { allowContextRegistration: false } : {}),
      });
      // The transport substitute consumes the ACTUAL original tool-return JSON text.
      const resultContent = producer.result.content.find((block) => block.type === "text");
      if (!resultContent || typeof resultContent.text !== "string") {
        throw new Error("native tool JSON text missing");
      }
      const details = JSON.parse(resultContent.text) as {
        receiptPath: string;
        receiptSha256?: string;
        reviewFeedback?: ObservedToolReviewFeedback;
      };
      const raw = await fs.readFile(details.receiptPath);
      const nativeReceipt = modulePreparation
        ? (JSON.parse(raw.toString("utf8")) as FinanceResearchRunReceipt & {
            toolInvocation: {
              status: string;
              caller: { runId: string; sessionKey: string; toolCallId: string };
              native: { batchCorrelationId?: string; qualityRunId?: string };
              payloadSha256: string;
            };
          })
        : undefined;
      const receiptSha256 = details.receiptSha256 ?? createHash("sha256").update(raw).digest("hex");
      modelNextInput = {
        toolCallId: "finance-call",
        toolResult: structuredClone(producer.result),
        consumedToolJSON: details,
        ...(modulePreparation
          ? {
              nativeReceiptSha256: createHash("sha256").update(raw).digest("hex"),
              storedToolInvocation: nativeReceipt?.toolInvocation,
              actualModuleExecution: nativeReceipt?.moduleExecution,
              causalEvidence: nativeReceipt?.batch?.committeeEvidence.find(
                (entry) => entry.id === "finance-module:causal_map",
              ),
              originalHostContext: originalRunContext,
            }
          : {}),
      };
      const value = options.value ?? 999;
      const reference = {
        toolCallId: "finance-call",
        receiptSha256: options.hashConflict ? "a".repeat(64) : receiptSha256,
        snapshotPointer: "/batch/jobs/0/receipt/snapshot",
        instrument: modulePreparation ? "SPY" : "BTCUSDT",
        asOf: modulePreparation?.input.asOf ?? "2026-07-01T12:00:00.000Z",
        ...(modulePreparation?.input.portfolioContext?.accountId
          ? { accountId: modulePreparation.input.portfolioContext.accountId }
          : {}),
        ...(options.wrongAccount ? { accountId: "unobserved-account" } : {}),
      };
      candidate =
        options.text ??
        `BTCUSDT price is ${value} USD.${options.extraText ? ` ${options.extraText}` : ""}\n\n\`\`\`figures\n${JSON.stringify([{ kind: "observed", name: "last_price", value, unit: "USD" }])}\n\`\`\`\n\`\`\`finance_evidence\n${JSON.stringify(reference)}\n\`\`\``;
      if (modulePreparation) {
        const nodes = nativeReceipt?.moduleExecution?.nodes ?? [];
        const learning = nodes.find((node) => node.moduleId === "finance_learning_memory");
        const causal = nodes.find((node) => node.moduleId === "causal_map");
        const causalEvidence = nativeReceipt?.batch?.committeeEvidence.find(
          (entry) => entry.id === "finance-module:causal_map",
        );
        const causalAnalysis = causalEvidence
          ? (
              JSON.parse(causalEvidence.text) as {
                analysis?: { keyCausalChain?: string; invalidation?: string };
              }
            ).analysis
          : undefined;
        const feedback = details.reviewFeedback;
        if (
          !feedback ||
          feedback.sourceSha256 !== receiptSha256 ||
          feedback.sourceRef !== details.receiptPath
        ) {
          throw new Error("actual bounded tool feedback source binding missing");
        }
        const qualityFailure = feedback.failedGates.find((gate) => gate.id === "quality");
        const nativeQualityFeedbackReads: Array<{ pointer: string; value: string }> = [];
        const qualityFinding = feedback.qualityFeedback
          .map((preview, index) => {
            const reference = feedback.qualityFeedbackRefs?.[index];
            if (!reference?.truncated) {
              return preview;
            }
            const indices = /^\/quality\/attempts\/(\d+)\/feedback\/(\d+)$/u.exec(
              reference.pointer,
            );
            const value = indices
              ? nativeReceipt?.quality?.attempts[Number(indices[1])]?.feedback[Number(indices[2])]
              : undefined;
            if (
              createHash("sha256").update(raw).digest("hex") !== feedback.sourceSha256 ||
              typeof value !== "string" ||
              !value.startsWith(preview.replace(/ \[truncated\]$/u, ""))
            ) {
              throw new Error("original bounded quality feedback readback mismatch");
            }
            nativeQualityFeedbackReads.push({ pointer: reference.pointer, value });
            return value;
          })
          .find((finding) => finding.includes("closure_missing_or_invalid"));
        const learningGap = feedback.failures
          .find((failure) => failure.moduleId === "finance_learning_memory")
          ?.missingEvidence.find((gap) => gap === "retrievable_finance_capability_card");
        const optionalStop =
          feedback.nextAction === "stop" &&
          feedback.remainingSoftReplans === 0 &&
          learningGap !== undefined;
        nextDecision = {
          action: qualityFailure
            ? "stop_research_reply"
            : optionalStop
              ? "retain_research_stop_optional_learning_retry"
              : "diagnostic_unobserved",
          reason: qualityFailure
            ? (qualityFinding ?? qualityFailure.reason)
            : optionalStop
              ? `Stop optional learning retry: ${learningGap}; original optional replan budget exhausted. Preserve the already successful source and causal research.`
              : "No decision-dependent bounded feedback was observed.",
          sourceSha256: feedback.sourceSha256,
          sourceRef: feedback.sourceRef,
          learningRetryStarted: false,
          boundary: "offline_scripted_tool_feedback_decision_not_natural_adoption_or_authority",
        };
        modelNextInput = {
          ...(modelNextInput as Record<string, unknown>),
          reviewFeedbackReadback: structuredClone(feedback),
          nativeQualityFeedbackReads,
          nextDecision,
        };
        const diagnostic =
          learningGap ?? learning?.missingEvidence.join(", ") ?? "learning_not_observed";
        const body = qualityFailure
          ? `Research reply stopped: ${nextDecision.reason}. Repair the original Quality finding closure before adopting this research. No additional module retry or execution authority.`
          : causal?.status === "succeeded"
            ? `SPY price is ${value} USD. ${nativeReceipt?.quality?.finalArtifact?.answer} Research hypothesis: ${causalAnalysis?.keyCausalChain}. Invalidation: ${causalAnalysis?.invalidation}. Learning remains blocked: ${diagnostic}. ${nextDecision.reason} No execution authority.`
            : `The required causal module remains unavailable: ${causal?.missingEvidence.join(", ") ?? "causal_not_observed"}. Learning remains blocked: ${diagnostic}.`;
        nextDecision.visibleBody = body;
        candidate = `${body}\n\n\`\`\`figures\n${JSON.stringify([{ kind: "observed", name: "last_price", value, unit: "USD" }])}\n\`\`\`\n\`\`\`finance_evidence\n${JSON.stringify(reference)}\n\`\`\``;
      }
      if (options.stream) {
        await input.onPartialReply?.({ text: `BTCUSDT price is ${value}` });
        await input.onPartialReply?.({ text: `BTCUSDT price is ${value} USD.` });
        await input.onBlockReply?.({ text: `BTCUSDT price is ${value} USD.` });
        await input.onBlockReplyFlush?.();
      }
      if (options.aborted) {
        controller.abort();
      }
      return {
        payloads: [
          { text: candidate },
          ...(options.afterCandidateText ? [{ text: options.afterCandidateText }] : []),
          ...(options.afterCandidateMediaUrl ? [{ mediaUrl: options.afterCandidateMediaUrl }] : []),
        ],
        meta: {
          agentMeta: {
            provider: "anthropic",
            model: options.defaultIngress ? (input.model ?? "claude-sonnet-4-5") : "claude",
          },
          timedOut: options.timedOut,
        },
      };
    },
  );
  let actualReplyInput: Parameters<typeof replyAgentOwner.runReplyAgent>[0] | undefined;
  const originalReplyAgent = replyAgentOwner.runReplyAgent;
  if (options.queued || options.defaultIngress) {
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    for (const key of [
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "OPENROUTER_API_KEY",
      "MINIMAX_API_KEY",
      "DEEPSEEK_API_KEY",
      "GOOGLE_API_KEY",
      "GEMINI_API_KEY",
      "MOONSHOT_API_KEY",
    ]) {
      vi.stubEnv(key, "");
    }
    vi.spyOn(replyAgentOwner, "runReplyAgent").mockImplementation(async (input) => {
      actualReplyInput = input;
      return originalReplyAgent(input);
    });
  }
  const rawProbe =
    options.queued || options.defaultIngress
      ? await probeOriginalDefaultLanguageReply(root, {
          ask,
          replyOptions: { abortSignal: controller.signal },
        })
      : await probeOriginalLanguageReply(root, undefined, {
          ask,
          abortSignal: controller.signal,
          onPartialReply: (payload) => {
            partials.push(payload.text ?? "");
          },
        });
  const probe = {
    ...rawProbe,
    replyResults: "replyResults" in rawProbe ? rawProbe.replyResults : [],
  };
  const ingress = await probe.submit(probe.message);
  const queuedPayloads: Array<{
    text?: string;
    mediaUrl?: string;
    mediaUrls?: string[];
    isError?: boolean;
  }> = [];
  if (options.queued) {
    const input = actualReplyInput;
    if (!input) {
      throw new Error("original default reply caller did not produce a queued input");
    }
    const queued = options.missingOriginalAsk
      ? { ...input.followupRun, commercialAuditAsk: undefined }
      : input.followupRun;
    await createFollowupRunner({
      opts: {
        ...input.opts,
        onBlockReply: async (payload) => {
          queuedPayloads.push(structuredClone(payload));
          await sendExternalMessage({
            account: probe.account,
            target: probe.message.conversationId,
            text: payload.text ?? "",
            mediaUrls: payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : undefined),
            replyToId: payload.replyToId,
          });
        },
      },
      typing: createMockTypingController({
        startTypingOnText: async () => {
          if (options.cancelDuringTyping) {
            typingCancelObserved = true;
            controller.abort(new Error("private queued finance typing-wait cancellation"));
          }
        },
      }),
      typingMode: "instant",
      sessionKey: queued.run.sessionKey,
      defaultModel: "anthropic/claude-sonnet-4-5",
    })(queued);
  }
  unsubscribe();
  return {
    root,
    probe,
    receiver,
    events,
    partials,
    modelNextInput,
    nextDecision,
    producer,
    candidate,
    ingress,
    hostGroundingCalls,
    auditCalls,
    typingCancelObserved,
    queuedPayloads,
    queuedInput: actualReplyInput?.followupRun,
  };
}
async function retain(name: string, sample: Awaited<ReturnType<typeof run>>) {
  if (!process.env.LCX_FINANCE_REPLY_PROOF_DIR) {
    return;
  }
  await fs.mkdir(process.env.LCX_FINANCE_REPLY_PROOF_DIR, { recursive: true });
  let originalReceiptReadback:
    | { sourcePath: string; retainedPath: string; sha256: string; configuredProviderCalls: number }
    | undefined;
  if (sample.producer && "invocation" in sample.producer.producer) {
    const details = sample.producer.result.details as {
      receiptPath: string;
      receiptSha256: string;
    };
    const bytes = await fs.readFile(details.receiptPath);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    expect(sha256).toBe(details.receiptSha256);
    const retainedPath = path.join(process.env.LCX_FINANCE_REPLY_PROOF_DIR, `${name}-receipt.json`);
    await fs.writeFile(retainedPath, bytes);
    originalReceiptReadback = {
      sourcePath: details.receiptPath,
      retainedPath,
      sha256,
      configuredProviderCalls: configuredTransport.invoke.mock.calls.length,
    };
  }
  await fs.writeFile(
    path.join(process.env.LCX_FINANCE_REPLY_PROOF_DIR, `${name}-original-outlet.json`),
    JSON.stringify(
      {
        boundary:
          "offline_original_producer_publisher_reply_dispatcher_sender_receiver_substitutes",
        invocation: (
          sample.events as Array<{
            runId: string;
            sessionKey?: string;
            stream: string;
            data: { phase?: string };
          }>
        ).find((event) => event.stream === "tool" && event.data.phase === "result"),
        resolverInput: sample.probe.inputs[0],
        hostGroundingCalls: sample.hostGroundingCalls,
        auditCalls: sample.auditCalls,
        typingCancelObserved: sample.typingCancelObserved,
        queuedInput: sample.queuedInput,
        queuedPayloads: sample.queuedPayloads,
        ingress: sample.ingress,
        source: sample.producer?.producer,
        ...(originalReceiptReadback ? { originalReceiptReadback } : {}),
        events: sample.events,
        modelNextInput: sample.modelNextInput,
        nextDecision: sample.nextDecision,
        candidate: sample.candidate,
        reply: sample.probe.replyResults,
        receiver: sample.receiver,
        partials: sample.partials,
      },
      null,
      2,
    ) + "\n",
  );
}
describe("same-attempt original finance modules to queued reply", () => {
  it.each(["normal", "missing_producer", "quality_failure"] as const)(
    "hands %s native module results through the actual queued caller",
    async (fault) => {
      const sample = await run({ queued: true, value: 100, modules: fault });
      await retain(`same-attempt-modules-${fault}`, sample);
      const execution = sample.producer;
      expect(configuredTransport.invoke).not.toHaveBeenCalled();
      if (!execution || !("invocation" in execution.producer)) {
        throw new Error("original module research invocation missing");
      }
      const producer = execution.producer;
      expect(producer.productionHandoffGap).toBe("production_controller_context_handoff_not_wired");
      expect(producer.invocation).toMatchObject({
        signalPresent: true,
        callerSignalPresent: true,
        configuredProviderCallsAllowed: false,
      });
      expect(producer.invocation.toolInput.ask).toBe(sample.probe.message.text);
      for (const field of [
        "ask",
        "asOf",
        "targets",
        "moduleSelection",
        "executeModules",
      ] as const) {
        expect(producer.invocation.runnerInput[field]).toEqual(
          producer.invocation.toolInput[field],
        );
      }
      const event = sample.events.find(
        (entry) => entry.stream === "tool" && entry.data.phase === "result",
      );
      expect(event?.sessionKey).toBe(sample.queuedInput?.run.sessionKey);
      const toolDetails = execution.result.details as {
        receiptPath: string;
        receiptSha256: string;
        toolInvocation: {
          status: string;
          caller: { runId: string; sessionKey: string; toolCallId: string };
          native: { batchCorrelationId?: string; qualityRunId?: string };
          payloadSha256: string;
        };
      };
      const writtenBytes = await fs.readFile(toolDetails.receiptPath);
      const written = JSON.parse(writtenBytes.toString("utf8")) as {
        toolInvocation: typeof toolDetails.toolInvocation;
      };
      const { toolInvocation, ...nativePayload } = written;
      expect(toolInvocation).toEqual(toolDetails.toolInvocation);
      expect(toolInvocation).toMatchObject({
        status: "observed",
        caller: {
          runId: event?.runId,
          sessionKey: sample.queuedInput?.run.sessionKey,
          toolCallId: "finance-call",
        },
        native: { batchCorrelationId: producer.receipt.batch?.correlationId },
      });
      expect(toolInvocation.native.qualityRunId).toBe(producer.receipt.quality?.runId);
      expect(toolInvocation.native.batchCorrelationId).not.toBe(toolInvocation.caller.runId);
      expect(toolInvocation.payloadSha256).toBe(
        createHash("sha256")
          .update(JSON.stringify(nativePayload, null, 2) + "\n")
          .digest("hex"),
      );
      expect(nativePayload).toEqual(producer.receipt);
      expect(toolDetails.receiptSha256).toBe(
        createHash("sha256").update(writtenBytes).digest("hex"),
      );
      expect(event?.data.result).toMatchObject({
        details: {
          receiptSha256: toolDetails.receiptSha256,
          toolInvocation,
        },
      });
      expect(sample.modelNextInput).toMatchObject({
        nativeReceiptSha256: toolDetails.receiptSha256,
        storedToolInvocation: toolInvocation,
      });
      const nativeModuleInput = producer.moduleInvocation;
      if (!nativeModuleInput || !producer.receipt.moduleExecution?.inputReadback) {
        throw new Error("actual original module executor input missing");
      }
      const moduleReadback = producer.receipt.moduleExecution.inputReadback;
      const inputHash = (value: unknown) =>
        createHash("sha256").update(JSON.stringify(value)).digest("hex");
      expect(moduleReadback.batchSha256).toBe(inputHash(nativeModuleInput.batch));
      expect(moduleReadback.askSha256).toBe(
        createHash("sha256").update(nativeModuleInput.ask).digest("hex"),
      );
      for (const pin of moduleReadback.readyJobReceipts) {
        const actualJob = nativeModuleInput.batch.jobs[pin.jobIndex];
        expect(actualJob.status).toBe("ready");
        expect(pin.requestSha256).toBe(inputHash(actualJob.request));
        expect(pin.receiptSha256).toBe(inputHash(actualJob.receipt));
      }
      expect(moduleReadback.readyJobReceipts.length).toBeGreaterThan(0);
      const learning = producer.receipt.moduleExecution?.nodes.find(
        (node) => node.moduleId === "finance_learning_memory",
      );
      expect(learning).toMatchObject({
        status: "blocked_missing_evidence",
        missingEvidence: expect.arrayContaining(["retrievable_finance_capability_card"]),
        toolCalls: [expect.objectContaining({ toolName: "finance_learning_capability_apply" })],
      });
      const learningReadback = learning?.toolCalls[0].inputReadback;
      expect(learningReadback?.bodyOmitted).toBe(false);
      expect(learningReadback?.args).toMatchObject({
        queryText: expect.stringContaining(nativeModuleInput.ask),
        maxCandidates: 3,
        writeUsageReceipt: true,
      });
      expect(learningReadback?.argsSha256).toBe(inputHash(learningReadback?.args));
      const learningBody = producer.receipt.batch?.committeeEvidence.find(
        (entry) => entry.id === `finance-module:${learning?.nodeId}:diagnostic`,
      );
      if (!learningBody) {
        throw new Error("original Apply diagnostic readback missing");
      }
      const learningConsumer = JSON.parse(learningBody.text) as {
        toolOutput: { queryText: string };
      };
      expect(learningConsumer.toolOutput.queryText).toBe(learningReadback?.args?.queryText);
      expect(moduleReadback.learningQuerySha256).toBe(
        createHash("sha256").update(String(learningReadback?.args?.queryText)).digest("hex"),
      );
      const causal = producer.receipt.moduleExecution?.nodes.find(
        (node) => node.moduleId === "causal_map",
      );
      const tracker = sample.events.find(
        (entry) => entry.data.phase === "finance_reply_evidence_gate",
      );
      expect(tracker?.runId).toBe(event?.runId);
      if (fault === "normal") {
        expect(causal?.status).toBe("succeeded");
        const producerCall = causal?.toolCalls.find(
          (call) => call.toolName === "finance_framework_causal_map_producer",
        );
        expect(producerCall?.inputReadback?.argsSha256).toBe(
          inputHash(nativeModuleInput.domainProducerInputs?.causal_map),
        );
        const body = producer.receipt.batch?.committeeEvidence.find(
          (entry) => entry.id === "finance-module:causal_map",
        );
        expect(body).toBeDefined();
        if (!body) {
          throw new Error("actual causal evidence missing");
        }
        const sourceUse = producer.sourceBodyUses.find(
          (use) =>
            use.evidenceSummary ===
            nativeModuleInput.domainProducerInputs?.causal_map?.evidenceSummary,
        );
        if (!sourceUse) {
          throw new Error("scripted committee did not read this exact causal source body");
        }
        expect(sourceUse.evidenceId).toBe("finance-model:SPY");
        expect(sourceUse.sourceSha256).toBe(
          createHash("sha256").update(sourceUse.sourceText).digest("hex"),
        );
        expect(
          producer.committeeRequests.some((request) =>
            request.evidence.some(
              (entry) => entry.id === sourceUse.evidenceId && entry.text === sourceUse.sourceText,
            ),
          ),
        ).toBe(true);
        expect(nativeModuleInput.domainProducerInputs?.causal_map?.sourceArtifacts).toContain(
          sourceUse.evidenceId,
        );
        const causalEntry = producer.frameworkReadback?.artifact?.entries.find(
          (entry) => entry.domain === "causal_map",
        );
        expect(causalEntry?.evidenceSummary).toBe(sourceUse.evidenceSummary);
        expect(causalEntry?.sourceArtifacts).toContain(sourceUse.evidenceId);
        expect(causalEntry?.keyCausalChain).toContain(sourceUse.observedCount);
        expect(causalEntry?.keyCausalChain).toContain(sourceUse.historyWindow);
        expect(causalEntry?.keyCausalChain).toContain(sourceUse.quoteTimestamp);
        expect(causalEntry?.whatChangesMyMind).toContain(sourceUse.quoteTimestamp);
        expect(producer.frameworkReadback?.sha256).toBe(
          createHash("sha256")
            .update(producer.frameworkReadback?.text ?? "")
            .digest("hex"),
        );
        const actualCausalConsumer = JSON.parse(body.text) as {
          toolOutput: {
            inspect: { entry: { evidenceSummary: string; sourceArtifacts: string[] } };
          };
        };
        expect(actualCausalConsumer.toolOutput.inspect.entry.evidenceSummary).toBe(
          sourceUse.evidenceSummary,
        );
        expect(actualCausalConsumer.toolOutput.inspect.entry.sourceArtifacts).toContain(
          sourceUse.evidenceId,
        );
        const analysis = (
          JSON.parse(body.text) as {
            analysis: { keyCausalChain: string; invalidation: string };
          }
        ).analysis;
        expect(
          producer.qualityRequests.some((request) =>
            request.evidence.some((entry) => entry.id === body?.id && entry.text === body.text),
          ),
        ).toBe(true);
        expect(
          producer.qualityRequests.some((request) => {
            const execution = request.sharedContext?.financeModuleExecution as
              | { nodes: unknown[] }
              | undefined;
            return execution?.nodes.some(
              (node) => JSON.stringify(node) === JSON.stringify(learning),
            );
          }),
        ).toBe(true);
        expect(tracker?.data.status).toBe("verified");
        expect(sample.auditCalls).toHaveLength(1);
        expect(sample.auditCalls[0].caller?.runId).toBe(event?.runId);
        expect(sample.auditCalls[0].caller?.runId).toBe(toolInvocation.caller.runId);
        expect(sample.auditCalls[0].output.terminalDecision).toBe("adopt_visible_answer");
        expect(JSON.stringify(sample.receiver)).toContain("retrievable_finance_capability_card");
        expect(JSON.stringify(sample.receiver)).toContain(analysis.keyCausalChain);
        expect(JSON.stringify(sample.receiver)).toContain(analysis.invalidation);
        expect(JSON.stringify(sample.receiver)).not.toContain("finance_evidence");
      } else if (fault === "missing_producer") {
        expect(causal?.missingEvidence).toContain(
          "domain_producer_input:finance_framework_causal_map_producer",
        );
        expect(producer.receipt.status).toBe("needs_review");
        expect(producer.qualityRequests).toEqual([]);
        expect(tracker?.data.status).toBe("blocked");
        expect(sample.auditCalls).toHaveLength(0);
        expect(sample.receiver.length).toBeGreaterThan(0);
        expect(JSON.stringify(sample.receiver)).not.toContain("The required causal module");
      } else {
        expect(causal?.status).toBe("succeeded");
        expect(producer.receipt.gates.find((gate) => gate.id === "source")?.passed).toBe(true);
        expect(producer.receipt.gates.find((gate) => gate.id === "quality")?.passed).toBe(false);
        const originalFeedback = producer.receipt.quality?.attempts.at(-1)?.feedback ?? [];
        expect(
          originalFeedback.some((finding) => finding.includes("closure_missing_or_invalid")),
        ).toBe(true);
        expect(sample.nextDecision?.action).toBe("stop_research_reply");
        expect(sample.nextDecision?.reason).toContain("closure_missing_or_invalid");
        expect(sample.modelNextInput).toMatchObject({
          nativeQualityFeedbackReads: [
            {
              pointer: expect.stringMatching(/^\/quality\/attempts\/\d+\/feedback\/\d+$/u),
              value: sample.nextDecision?.reason,
            },
          ],
        });
        expect(sample.nextDecision?.sourceSha256).toBe(toolDetails.receiptSha256);
        expect(sample.candidate).toContain(sample.nextDecision?.reason);
        expect(sample.candidate).not.toContain("Research hypothesis:");
        expect(tracker?.data.status).toBe("blocked");
        expect(
          (tracker?.data.reasons as string[] | undefined)?.some((reason) =>
            reason.startsWith("quality_gate_failed"),
          ),
        ).toBe(true);
        expect(sample.auditCalls).toHaveLength(0);
        expect(JSON.stringify(sample.receiver)).toContain("quality_gate_failed");
      }
      if (fault === "normal") {
        expect(sample.nextDecision?.action).toBe("retain_research_stop_optional_learning_retry");
        expect(sample.nextDecision?.reason).toContain("retrievable_finance_capability_card");
        expect(sample.nextDecision?.learningRetryStarted).toBe(false);
        expect(sample.nextDecision?.sourceSha256).toBe(toolDetails.receiptSha256);
        expect(JSON.stringify(sample.receiver)).toContain("Stop optional learning retry");
        expect(producer.receipt.quality?.status).toBe("verified");
      }
      expect(producer.moduleInvocation).toBeDefined();
      expect(producer.moduleInvocationCount).toBe(1);
      expect(
        sample.events.filter(
          (entry) =>
            entry.stream === "tool" &&
            entry.data.phase === "result" &&
            entry.data.name === "finance_research_run",
        ),
      ).toHaveLength(1);
    },
    30_000,
  );
});

describe("original financial tool event to original external reply outlet", () => {
  it("queues the actual original finance result into the shared terminal audit", async () => {
    const sample = await run({ queued: true, value: 100 });
    await retain(
      process.env.LCX_FINANCE_QUEUE_BEFORE === "1" ? "queued-before" : "queued-after",
      sample,
    );
    expect(sample.queuedInput?.commercialAuditAsk).toBe(sample.probe.message.text);
    if (process.env.LCX_FINANCE_QUEUE_BEFORE === "1") {
      expect(sample.auditCalls).toHaveLength(0);
      expect(JSON.stringify(sample.receiver)).toContain("finance_evidence");
    } else {
      expect(sample.auditCalls).toHaveLength(1);
      expect(sample.auditCalls[0].ask).toBe(sample.probe.message.text);
      expect(sample.auditCalls[0].candidate).toBe("BTCUSDT price is 100 USD.");
      expect(sample.auditCalls[0].output.terminalDecision).toBe("adopt_visible_answer");
      expect(sample.receiver.map((row) => row.text)).toEqual(["BTCUSDT price is 100 USD."]);
      const event = sample.events.find(
        (row) => row.data.surface === "followup" && row.data.auditInvocation,
      );
      expect(event?.runId).toBe(sample.auditCalls[0].caller?.runId);
      expect(event?.data.auditInvocation).toEqual(sample.auditCalls[0].output.auditInvocation);
      expect(
        sample.events
          .filter((row) => row.data.phase === "finance_reply_evidence_gate")
          .every((row) => row.data.auditInput === undefined),
      ).toBe(true);
    }
  });
  it.each([
    { sourceFault: "missing_source", reason: "source_gate_failed" },
    { sourceFault: "quality_failure", reason: "quality_gate_failed" },
    { wrongRun: true, reason: "finance_tool_result_not_observed_in_current_scope" },
    { hashConflict: true, reason: "finance_receipt_reference_hash_conflict" },
    { wrongAccount: true, reason: "finance_snapshot_account_conflict" },
    { aborted: true, reason: "finance_reply_run_cancelled" },
    { timedOut: true, reason: "finance_reply_run_cancelled" },
    { missingOriginalAsk: true, reason: "commercial_original_ask_not_observed" },
  ] as Array<ProbeOptions & { reason: string }>)(
    "holds queued finance at the original boundary $reason",
    async (options) => {
      const sample = await run({
        ...options,
        queued: true,
        value: 100,
        afterCandidateMediaUrl: "https://private-receiver.invalid/failed-finance.png",
      });
      await retain(`queued-${options.reason}`, sample);
      expect(JSON.stringify(sample.receiver)).not.toContain("100 USD");
      expect(JSON.stringify(sample.receiver)).not.toContain("failed-finance.png");
      expect(
        sample.events.some((event) => JSON.stringify(event.data).includes(options.reason)),
      ).toBe(true);
      expect(sample.queuedPayloads.every((payload) => payload.isError)).toBe(true);
    },
  );
  it("holds queued research trade language and later media with one actual native audit", async () => {
    const sample = await run({
      queued: true,
      value: 100,
      extraText: "现在直接满仓买入 BTCUSDT。",
      afterCandidateMediaUrl: "https://private-receiver.invalid/queued-blocked.png",
    });
    await retain("queued-native-research-trade-media-block", sample);
    expect(sample.auditCalls).toHaveLength(1);
    expect(sample.auditCalls[0].input?.financeDecisionMode).toBe("research_only");
    expect(sample.auditCalls[0].output.terminalDecision).toBe("return_failed_reason");
    expect(JSON.stringify(sample.receiver)).not.toContain("满仓买入");
    expect(JSON.stringify(sample.receiver)).not.toContain("queued-blocked.png");
  });
  it("does not dispatch queued finance cancelled after actual typing wait", async () => {
    const sample = await run({ queued: true, value: 100, cancelDuringTyping: true });
    await retain("queued-native-typing-cancel", sample);
    expect(sample.typingCancelObserved).toBe(true);
    expect(sample.auditCalls).toHaveLength(1);
    expect(sample.auditCalls[0].output.terminalDecision).toBe("adopt_visible_answer");
    expect(sample.receiver).toHaveLength(0);
    expect(sample.events.some((event) => event.data.dispatchCancelled === true)).toBe(true);
  });
  it("uses the original verified receipt to select the native audit without a host option", async () => {
    const sample = await run({ value: 100 });
    await retain("automatic-native-audit", sample);
    expect(sample.auditCalls).toHaveLength(1);
    const call = sample.auditCalls[0];
    expect(call.input?.financeDecisionMode).toBe(
      sample.producer?.producer.receipt.plan.decisionMode,
    );
    const sourceReceipt = sample.producer?.producer.receipt.batch?.jobs[0]?.receipt;
    expect(
      sourceReceipt && "snapshot" in sourceReceipt ? sourceReceipt.snapshot : undefined,
    ).toEqual(call.input?.snapshot);
    expect(call.candidate).toBe("BTCUSDT price is 100 USD.");
    expect(call.input?.requireGrounding).not.toBe(true);
    expect(call.output.terminalDecision).toBe("adopt_visible_answer");
    const event = sample.events.find(
      (entry) => entry.data.selection === "verified_finance_reference",
    );
    expect(event?.data.auditInvocation).toEqual(call.output.auditInvocation);
    expect(event?.runId).toBe(call.caller?.runId);
    expect(event?.data.auditReceiptSha256).toBe(
      createHash("sha256").update(JSON.stringify(call.output)).digest("hex"),
    );
    expect(
      sample.events
        .filter((entry) => entry.data.phase === "finance_reply_evidence_gate")
        .every((entry) => entry.data.auditInput === undefined),
    ).toBe(true);
    expect(sample.receiver.map((entry) => entry.text)).toEqual([call.candidate]);
  });
  it("blocks original native research-mode trade language after source and grounding have passed", async () => {
    const sample = await run({ value: 100, extraText: "现在直接满仓买入 BTCUSDT。" });
    await retain("automatic-native-trade-block", sample);
    expect(sample.auditCalls).toHaveLength(1);
    expect(sample.auditCalls[0].input?.financeDecisionMode).toBe("research_only");
    expect(sample.auditCalls[0].output.terminalDecision).toBe("return_failed_reason");
    expect(JSON.stringify(sample.receiver)).not.toContain("满仓买入");
    expect(
      sample.events.some(
        (entry) =>
          entry.data.selection === "verified_finance_reference" &&
          entry.data.decision === "blocked",
      ),
    ).toBe(true);
  });
  it("does not send an automatically audited candidate cancelled in the original final typing await", async () => {
    const sample = await run({ value: 100, cancelDuringTyping: true });
    await retain("automatic-native-typing-cancel", sample);
    expect(sample.typingCancelObserved).toBe(true);
    expect(sample.auditCalls).toHaveLength(1);
    expect(sample.auditCalls[0].output.terminalDecision).toBe("adopt_visible_answer");
    expect(JSON.stringify(sample.receiver)).not.toContain("100 USD");
    expect(
      sample.events.some(
        (entry) =>
          entry.data.surface === "final_seal" &&
          entry.data.selection === "verified_finance_reference" &&
          entry.data.decision === "blocked",
      ),
    ).toBe(true);
  });
  it("keeps the failed same-run audit when a later final payload omits its finance declaration", async () => {
    const sample = await run({
      value: 100,
      extraText: "现在直接满仓买入 BTCUSDT。",
      afterCandidateText: "Later unreferenced candidate must remain blocked.",
    });
    await retain("automatic-native-sticky-failure", sample);
    expect(sample.auditCalls).toHaveLength(1);
    expect(sample.auditCalls[0].output.terminalDecision).toBe("return_failed_reason");
    expect(JSON.stringify(sample.receiver)).not.toContain("Later unreferenced candidate");
    expect(
      sample.events.filter((event) => event.data.selection === "verified_finance_reference"),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ data: expect.objectContaining({ decision: "blocked" }) }),
      ]),
    );
  });
  it("clears a later media-only final payload after the same-run audit failed", async () => {
    const mediaUrl = "https://private-receiver.invalid/blocked-media.png";
    const sample = await run({
      value: 100,
      extraText: "现在直接满仓买入 BTCUSDT。",
      afterCandidateMediaUrl: mediaUrl,
    });
    await retain(
      process.env.LCX_FINANCE_MEDIA_BEFORE === "1"
        ? "automatic-media-before"
        : "automatic-media-after",
      sample,
    );
    expect(sample.auditCalls).toHaveLength(1);
    expect(sample.auditCalls[0].output.terminalDecision).toBe("return_failed_reason");
    if (process.env.LCX_FINANCE_MEDIA_BEFORE === "1") {
      expect(JSON.stringify(sample.receiver)).toContain(mediaUrl);
    } else {
      expect(JSON.stringify(sample.receiver)).not.toContain(mediaUrl);
      expect(
        sample.receiver.every(
          (row) =>
            row.mediaUrl === undefined &&
            (!Array.isArray(row.mediaUrls) || row.mediaUrls.length === 0),
        ),
      ).toBe(true);
    }
  });
  it("blocks the reproduced price drift at the original reply outlet", async () => {
    const sample = await run();
    await retain(process.env.LCX_FINANCE_REPLY_BEFORE === "1" ? "before" : "after", sample);
    expect(sample.producer?.producer.receipt.batch?.jobs[0]?.receipt).toBeDefined();
    expect(sample.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stream: "tool",
          data: expect.objectContaining({ phase: "result", name: "finance_research_run" }),
        }),
      ]),
    );
    if (process.env.LCX_FINANCE_REPLY_BEFORE === "1") {
      expect(JSON.stringify(sample.receiver)).toContain("999 USD");
    } else {
      expect(JSON.stringify(sample.receiver)).not.toContain("999 USD");
      expect(JSON.stringify(sample.receiver)).toContain("finance_grounding_ungrounded");
    }
  });
  it("actually dispatches the original clean grounded candidate once", async () => {
    const sample = await run({ value: 100, stream: true });
    await retain("grounded", sample);
    expect(sample.receiver.map((row) => row.text)).toEqual(["BTCUSDT price is 100 USD."]);
    expect(sample.partials.every((text) => text === "")).toBe(true);
    expect(sample.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({
            phase: "finance_reply_evidence_gate",
            status: "verified",
          }),
        }),
      ]),
    );
    if (process.env.LCX_FINANCE_REPLY_PROOF_DIR) {
      const proofPath = path.join(
        process.env.LCX_FINANCE_REPLY_PROOF_DIR,
        "grounded-original-outlet.json",
      );
      const sha256 = createHash("sha256")
        .update(await fs.readFile(proofPath))
        .digest("hex");
      const ref = (pointer: string) => ({ path: proofPath, sha256, pointer });
      const evidence: WorkflowHandoffEvidence = {
        scenarioId: "external_finance_research_waterflow",
        environment: "offline_fixture",
        nodes: [
          {
            nodeId: "source_registry",
            scope: ref("/invocation/runId"),
            output: ref("/source/receipt/batch/jobs/0/receipt/snapshot"),
          },
          {
            nodeId: "visible_reply",
            scope: ref("/invocation/runId"),
            output: ref("/receiver/0/text"),
          },
        ],
      };
      const audits = await auditWorkflowHandoffs([evidence]);
      const audit = audits.find((row) => row.scenarioId === evidence.scenarioId);
      expect(audit?.status).toBe("handoff_gap");
      expect(audit?.gaps.some((gap) => gap.reason.includes("finance_learning_memory"))).toBe(true);
      await fs.writeFile(
        path.join(process.env.LCX_FINANCE_REPLY_PROOF_DIR, "original-fieldrefs-input.json"),
        JSON.stringify(evidence, null, 2) + "\n",
      );
      await fs.writeFile(
        path.join(process.env.LCX_FINANCE_REPLY_PROOF_DIR, "original-fieldrefs-audit.json"),
        JSON.stringify(audit, null, 2) + "\n",
      );
    }
    const details = sample.producer?.result.details as {
      receiptPath: string;
      receiptSha256: string;
    };
    expect(details.receiptSha256).toBe(
      createHash("sha256")
        .update(await fs.readFile(details.receiptPath))
        .digest("hex"),
    );
  });
  it("does not leak unsupported claim prefixes through partial or block streaming", async () => {
    const sample = await run({ stream: true });
    await retain("stream-drift", sample);
    expect(JSON.stringify(sample.receiver)).not.toContain("999 USD");
    expect(sample.partials.every((text) => text === "")).toBe(true);
  });
  it("does not duplicate a clean block actually delivered before research streaming was held", async () => {
    const text = "The explanation is complete.";
    const sample = await run({ text, stream: true, beforeToolBlock: text });
    expect(sample.receiver.map((row) => row.text)).toEqual([text]);
  });
  it.each([
    { sourceFault: "missing_source", reason: "source_gate_failed" },
    { sourceFault: "quality_failure", reason: "quality_gate_failed" },
    { wrongRun: true, reason: "finance_tool_result_not_observed_in_current_scope" },
    { hashConflict: true, reason: "finance_receipt_reference_hash_conflict" },
    { wrongAccount: true, reason: "finance_snapshot_account_conflict" },
    { aborted: true, reason: "finance_reply_run_cancelled" },
    { timedOut: true, reason: "finance_reply_run_cancelled" },
  ] as Array<ProbeOptions & { reason: string }>)(
    "retains the actual original outlet failure $reason",
    async (options) => {
      const sample = await run(options);
      await retain(options.reason, sample);
      expect(JSON.stringify(sample.receiver)).not.toContain("999 USD");
      expect(
        sample.events.some(
          (event) =>
            (event.data.phase === "finance_reply_evidence_gate" ||
              event.data.phase === "commercial_answer_terminal_gate") &&
            (event.data.status === "blocked" || event.data.decision === "blocked") &&
            JSON.stringify(event.data.reasons ?? event.data.failedReasons).includes(options.reason),
        ),
      ).toBe(true);
      expect(JSON.stringify(sample.probe.replyResults)).toContain('"isError":true');
    },
  );
  it.each([
    "2 + 2 = 4",
    "protocol: tool_result, owner state queried",
    "Evidence is incomplete; this is a research explanation.",
  ])("keeps ordinary unreferenced replies unchanged: %s", async (text) => {
    const sample = await run({ text });
    expect(sample.receiver.map((row) => row.text)).toEqual([text]);
    expect(sample.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({
            phase: "finance_reply_evidence_gate",
            status: "not_observed",
          }),
        }),
      ]),
    );
  });
});

describe("native commercial refusal reaches the existing next session prompt", () => {
  it.each([false, true])(
    "queues one bound refusal from the original outlet queued=%s and the next model sees the reason",
    async (queued) => {
      const sample = await run({
        queued,
        defaultIngress: true,
        value: 100,
        extraText: "现在直接满仓买入 BTCUSDT。",
        afterCandidateMediaUrl: "https://private-receiver.invalid/refused-later-media.png",
      });
      expect(sample.auditCalls).toHaveLength(1);
      const caller = sample.auditCalls[0].output.auditInvocation.caller;
      if (!caller?.sessionKey) {
        throw new Error("native caller session missing");
      }
      const key = caller.sessionKey;
      const entries = peekSystemEventEntries(key).filter((event) =>
        event.contextKey?.startsWith("commercial-refusal:"),
      );
      expect(entries).toHaveLength(1);
      expect(Buffer.byteLength(entries[0].text)).toBeLessThanOrEqual(2048);
      const diagnostic = JSON.parse(entries[0].text) as {
        failedReasons: string[];
        auditReceiptSha256: string;
        runId: string;
        messageId: string;
      };
      expect(diagnostic.failedReasons).toContain("direct_trade_or_position_action_language");
      expect(diagnostic.runId).toBe(caller.runId);
      expect(diagnostic.messageId).toBe(caller.messageId);
      expect(entries[0].text).not.toContain("满仓买入");
      expect(entries[0].text).not.toContain("BTCUSDT");
      expect(diagnostic.auditReceiptSha256).toBe(
        createHash("sha256").update(JSON.stringify(sample.auditCalls[0].output)).digest("hex"),
      );
      expect(
        await sessionPromptOwner.buildQueuedSystemPrompt({
          cfg: {},
          sessionKey: `${key}:foreign`,
          isMainSession: false,
          isNewSession: false,
        }),
      ).toBeUndefined();
      expect(
        peekSystemEventEntries(key).filter((event) =>
          event.contextKey?.startsWith("commercial-refusal:"),
        ),
      ).toHaveLength(1);
      const originalPrompt = sessionPromptOwner.buildQueuedSystemPrompt;
      const promptReads: { sessionKey: string; result?: string }[] = [];
      vi.spyOn(sessionPromptOwner, "buildQueuedSystemPrompt").mockImplementation(async (params) => {
        const result = await originalPrompt(params);
        promptReads.push({ sessionKey: params.sessionKey, result });
        return result;
      });
      const nextModelInputs: { runId: string; sessionKey: string; extraSystemPrompt?: string }[] =
        [];
      model.invoke.mockImplementation(
        async (params: { runId: string; sessionKey: string; extraSystemPrompt?: string }) => {
          nextModelInputs.push({
            runId: params.runId,
            sessionKey: params.sessionKey,
            extraSystemPrompt: params.extraSystemPrompt,
          });
          const corrected = params.extraSystemPrompt?.includes(
            "direct_trade_or_position_action_language",
          );
          return {
            payloads: [
              {
                text: corrected
                  ? "I retained uncertainty because the previous draft contained direct_trade_or_position_action_language; no action is authorized."
                  : "Missing refusal diagnostic.",
              },
            ],
            meta: { agentMeta: { provider: "anthropic", model: "claude-sonnet-4-5" } },
          };
        },
      );
      vi.stubEnv("OPENCLAW_TEST_FAST", "1");
      const nextProbe = await probeOriginalDefaultLanguageReply(sample.root, {
        ask: "Compare concentrated and diversified portfolios at a conceptual level.",
      });
      const nextMessage = { ...nextProbe.message, id: `${nextProbe.message.id}-refusal-followup` };
      const beforeNextSessionStore = await nextProbe.readSessionStore();
      const nextEvents: AgentEventPayload[] = [];
      const unsubscribeNext = onAgentEvent((event) => nextEvents.push(structuredClone(event)));
      let nextSubmit: Awaited<ReturnType<typeof nextProbe.submit>>;
      try {
        nextSubmit = await nextProbe.submit(nextMessage);
      } finally {
        unsubscribeNext();
      }
      const nextDiagnostics = {
        nextSubmit,
        sessionKey: key,
        beforeNextSessionStore,
        afterNextSessionStore: await nextProbe.readSessionStore(),
        messageId: nextMessage.id,
        inputs: nextProbe.inputs,
        dispatchResults: nextProbe.dispatchResults,
        errors: nextProbe.errors,
        statusPatches: nextProbe.statusPatches,
        nextEvents,
        promptReads,
        nextModelInputs,
        remainingEvents: peekSystemEventEntries(key),
        receiver: sample.receiver,
      };
      if (process.env.LCX_FINANCE_REPLY_PROOF_DIR) {
        await fs.writeFile(
          path.join(
            process.env.LCX_FINANCE_REPLY_PROOF_DIR,
            `native-refusal-next-submit-${queued ? "queue" : "main"}.json`,
          ),
          JSON.stringify(nextDiagnostics, null, 2) + "\n",
        );
      }
      expect(nextSubmit.statusCode).toBe(202);
      expect(nextProbe.errors).toEqual([]);
      expect(nextModelInputs).toHaveLength(1);
      expect(nextModelInputs[0].sessionKey).toBe(key);
      expect(nextModelInputs[0].extraSystemPrompt).toContain(entries[0].text);
      expect(
        promptReads.some((row) => row.sessionKey === key && row.result?.includes(entries[0].text)),
      ).toBe(true);
      expect(JSON.stringify(sample.receiver)).toContain(
        "I retained uncertainty because the previous draft",
      );
      expect(
        peekSystemEventEntries(key).filter((event) =>
          event.contextKey?.startsWith("commercial-refusal:"),
        ),
      ).toHaveLength(0);
      await retain(`native-refusal-feedback-${queued ? "queue" : "main"}`, sample);
      const nativePath = path.join(sample.root, "native-refusal-audit-observation.json");
      const nativeBytes =
        JSON.stringify({ auditCalls: sample.auditCalls, events: sample.events }, null, 2) + "\n";
      await fs.writeFile(nativePath, nativeBytes);
      const nativeSHA = createHash("sha256").update(nativeBytes).digest("hex");
      const future = {
        boundary:
          "offline_original_system_event_prompt_model_transport_response_only_not_natural_adoption",
        nativeCaller: caller,
        entries,
        promptReads,
        nextModelInputs,
        nextDiagnostics,
        semanticAdoption: "not_proven",
        persistence: "not_provided_process_queue_only",
      };
      const futurePath = path.join(sample.root, "native-refusal-next-observation.json");
      const futureBytes = JSON.stringify(future, null, 2) + "\n";
      await fs.writeFile(futurePath, futureBytes);
      const observed: WorkflowHandoffEvidence = {
        scenarioId: "commercial_answer_pipeline_waterflow",
        environment: "offline_fixture",
        nodes: [
          {
            nodeId: "local_contract_audit",
            scope: {
              path: nativePath,
              sha256: nativeSHA,
              pointer: "/auditCalls/0/output/auditInvocation/caller/runId",
            },
            output: {
              path: nativePath,
              sha256: nativeSHA,
              pointer: "/auditCalls/0/output/financeDecision",
            },
          },
        ],
        feedbackReads: [
          {
            kind: "commercial_refusal_diagnostic",
            from: "local_contract_audit",
            to: "local_brain_planner",
            receipt: {
              path: futurePath,
              sha256: createHash("sha256").update(futureBytes).digest("hex"),
              pointer: "",
            },
          },
        ],
      };
      const positiveAudit = (await auditWorkflowHandoffs([observed])).find(
        (row) => row.scenarioId === observed.scenarioId,
      );
      if (process.env.LCX_FINANCE_REPLY_PROOF_DIR) {
        await fs.writeFile(
          path.join(
            process.env.LCX_FINANCE_REPLY_PROOF_DIR,
            `native-refusal-feedback-audit-${queued ? "queue" : "main"}.json`,
          ),
          JSON.stringify(
            {
              observation: observed,
              result: positiveAudit,
              actualNative: { auditCalls: sample.auditCalls, events: sample.events },
              actualNextReadback: future,
              semanticAdoption: "not_proven",
            },
            null,
            2,
          ) + "\n",
        );
      }
      expect(positiveAudit?.gaps.some((gap) => gap.reason.startsWith("feedback_read_"))).toBe(
        false,
      );
      expect(positiveAudit?.status).toBe("handoff_gap");
      expect(positiveAudit?.gaps.length).toBeGreaterThan(0);
      if (queued) {
        const faults = [
          "next_session",
          "diagnostic_hash",
          "prompt_missing",
          "same_run",
          "reason_missing",
          "producer_pin",
          "inbound_session",
        ] as const;
        for (const fault of faults) {
          const invalid = structuredClone(future);
          if (fault === "next_session") {
            invalid.nextModelInputs[0].sessionKey = `${key}:foreign`;
          }
          if (fault === "diagnostic_hash" || fault === "reason_missing") {
            const text = JSON.parse(invalid.entries[0].text) as {
              auditReceiptSha256: string;
              failedReasons: string[];
            };
            if (fault === "diagnostic_hash") {
              text.auditReceiptSha256 = "f".repeat(64);
            } else {
              text.failedReasons = [];
            }
            invalid.entries[0].text = JSON.stringify(text);
          }
          if (fault === "prompt_missing") {
            invalid.nextModelInputs[0].extraSystemPrompt = "No consumed system event.";
          }
          if (fault === "inbound_session") {
            invalid.nextDiagnostics.inputs[0].SessionKey = `${key}:foreign`;
          }
          if (fault === "same_run") {
            invalid.nextModelInputs[0].runId = caller.runId ?? "";
          }
          const bytes = JSON.stringify(invalid, null, 2) + "\n";
          const invalidPath = path.join(sample.root, `native-refusal-fault-${fault}.json`);
          await fs.writeFile(invalidPath, bytes);
          const evidence = structuredClone(observed);
          evidence.feedbackReads![0].receipt = {
            path: invalidPath,
            sha256: createHash("sha256").update(bytes).digest("hex"),
            pointer: "",
          };
          if (fault === "producer_pin") {
            evidence.nodes[0].scope.sha256 = "e".repeat(64);
          }
          const audit = (await auditWorkflowHandoffs([evidence])).find(
            (row) => row.scenarioId === observed.scenarioId,
          );
          expect(
            audit?.gaps.some(
              (gap) =>
                gap.reason.startsWith("feedback_read_") || gap.reason === "receipt_hash_conflict",
            ),
          ).toBe(true);
        }
      }
      if (process.env.LCX_FINANCE_REPLY_PROOF_DIR) {
        await fs.writeFile(
          path.join(
            process.env.LCX_FINANCE_REPLY_PROOF_DIR,
            `native-refusal-feedback-audit-${queued ? "queue" : "main"}.json`,
          ),
          JSON.stringify(
            { observation: observed, result: positiveAudit, semanticAdoption: "not_proven" },
            null,
            2,
          ) + "\n",
        );
      }

      if (process.env.LCX_FINANCE_REPLY_PROOF_DIR) {
        await fs.writeFile(
          path.join(
            process.env.LCX_FINANCE_REPLY_PROOF_DIR,
            `native-refusal-next-input-${queued ? "queue" : "main"}.json`,
          ),
          JSON.stringify(
            {
              boundary:
                "offline_original_system_event_prompt_model_transport_response_only_not_natural_adoption",
              nativeCaller: caller,
              entries,
              promptReads,
              nextModelInputs,
              nextDiagnostics,
              receiver: sample.receiver,
              semanticAdoption: "not_proven",
              persistence: "not_provided_process_queue_only",
            },
            null,
            2,
          ) + "\n",
        );
      }
    },
  );
  it("does not enqueue a cancelled original finance attempt", async () => {
    const sample = await run({
      queued: true,
      aborted: true,
      value: 100,
      extraText: "现在直接满仓买入 BTCUSDT。",
    });
    expect(sample.auditCalls).toHaveLength(0);
    expect(sample.queuedInput?.run.sessionKey).toBeDefined();
    const key = sample.queuedInput?.run.sessionKey;
    if (!key) {
      throw new Error("original queued session missing");
    }
    expect(
      peekSystemEventEntries(key).some((event) =>
        event.contextKey?.startsWith("commercial-refusal:"),
      ),
    ).toBe(false);
    await retain("native-refusal-cancelled-no-feedback", sample);
  });
  it("keeps a real native refusal without independent host identity out of the event queue", () => {
    const ask = "Review this candidate without execution authority.";
    const gate = createCommercialAnswerReplyGate({
      ask,
      messageId: "private-missing-host",
      request: {
        messageId: "private-missing-host",
        askSha256: createHash("sha256").update(ask).digest("hex"),
        input: { financeDecisionMode: "research_only" },
      },
    });
    const decision = gate.check({ text: "现在直接满仓买入 BTCUSDT。" }, "final", false, {
      runId: "private-run",
      messageId: "private-missing-host",
    });
    expect(decision.trace).toMatchObject({
      decision: "blocked",
      nativeTerminalDecision: "return_failed_reason",
      refusalFeedback: {
        status: "not_observed",
        reason: "native_refusal_host_binding_not_observed",
      },
    });
    expect(peekSystemEventEntries("agent:main:main")).toEqual([]);
  });
  it("does not enqueue an old native caller refusal after a newer finance run started", () => {
    const ask = "Review this candidate without execution authority.";
    const gate = createCommercialAnswerReplyGate({
      ask,
      messageId: "private-old-message",
      request: {
        messageId: "private-old-message",
        askSha256: createHash("sha256").update(ask).digest("hex"),
        input: { financeDecisionMode: "research_only" },
      },
    });
    gate.startFinanceRun("private-new-run");
    const decision = gate.check({ text: "现在直接满仓买入 BTCUSDT。" }, "final", false, {
      runId: "private-old-run",
      messageId: "private-old-message",
      sessionKey: "private-late-caller-session",
    });
    expect(decision.trace).toMatchObject({
      decision: "blocked",
      nativeTerminalDecision: "return_failed_reason",
      refusalFeedback: {
        status: "not_observed",
        reason: "native_refusal_host_binding_not_observed",
      },
    });
    expect(peekSystemEventEntries("private-late-caller-session")).toEqual([]);
  });
});
