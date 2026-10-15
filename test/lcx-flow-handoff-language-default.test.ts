import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sendExternalMessage } from "../extensions/external/src/send.js";
import * as commercialOwner from "../scripts/operator/lcx-commercial-answer-pipeline.js";
import {
  auditWorkflowHandoffs,
  type WorkflowHandoffEvidence,
} from "../scripts/operator/lcx-flow-graph.js";
import * as visible from "../src/agents/visible-answer-adoption-gate.js";
import * as replyHelpers from "../src/auto-reply/reply/agent-runner-helpers.js";
import * as replyAgentOwner from "../src/auto-reply/reply/agent-runner.js";
import { createFollowupRunner } from "../src/auto-reply/reply/followup-runner.js";
import * as preparedReply from "../src/auto-reply/reply/get-reply-run.js";
import * as defaultReply from "../src/auto-reply/reply/get-reply.js";
import { resetInboundDedupe } from "../src/auto-reply/reply/inbound-dedupe.js";
import { createMockTypingController } from "../src/auto-reply/reply/test-helpers.js";
import { onAgentEvent, type AgentEventPayload } from "../src/infra/agent-events.js";
import { resetSystemEventsForTest, peekSystemEvents } from "../src/infra/system-events.js";
import { probeOriginalDefaultLanguageReply } from "./fixtures/lcx-waterflow-language-default-probe.js";

const model = vi.hoisted(() => ({ invoke: vi.fn(), forbidden: [] as string[] }));
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
vi.mock("../src/agents/cli-runner.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/agents/cli-runner.js")>()),
  runCliAgent: () => {
    model.forbidden.push("CLI provider");
    throw new Error("offline provider forbidden");
  },
}));
vi.mock("../src/cron/store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/cron/store.js")>()),
  loadCronStore: async () => ({ version: 1, jobs: [] }),
}));
vi.mock("node:dns/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:dns/promises")>()),
  lookup: async () => [{ address: "93.184.216.34", family: 4 }],
}));
vi.mock("../src/shared/global-evidence-projection-source.js", () => ({
  readCanonicalGlobalEvidenceProjectionCandidate: async () => null,
}));

function denyProcess(kind: string) {
  return (..._args: unknown[]): never => {
    model.forbidden.push(kind);
    throw new Error(`offline transport forbidden: ${kind}`);
  };
}
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  const guarded = {
    ...original,
    spawn: denyProcess("spawn"),
    spawnSync: denyProcess("spawnSync"),
    exec: denyProcess("exec"),
    execSync: denyProcess("execSync"),
    execFile: denyProcess("execFile"),
    execFileSync: denyProcess("execFileSync"),
    fork: denyProcess("fork"),
  };
  return { ...guarded, default: guarded };
});
vi.mock("node:http", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:http")>();
  const guarded = {
    ...original,
    request: denyProcess("http.request"),
    get: denyProcess("http.get"),
  };
  return { ...guarded, default: guarded };
});
vi.mock("node:https", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:https")>();
  const guarded = {
    ...original,
    request: denyProcess("https.request"),
    get: denyProcess("https.get"),
  };
  return { ...guarded, default: guarded };
});

const roots: string[] = [];
afterEach(async () => {
  resetInboundDedupe();
  resetSystemEventsForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  model.invoke.mockReset();
  model.forbidden.length = 0;
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function run(
  fault?:
    | "missing"
    | "late"
    | "send_reject"
    | "sensitive_error"
    | "missing_input"
    | "cancelled_media"
    | "compaction_complete",
  commercial?:
    | "pass"
    | "block"
    | "scope_conflict"
    | "ask_conflict"
    | "missing"
    | "late"
    | "cancel"
    | "language_conflict"
    | "language_match",
  queued = false,
  cancelDuringTyping: boolean | "main" = false,
) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-default-language-"));
  roots.push(directory);
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
  const defaultCalls: unknown[] = [];
  const preparedCalls: unknown[] = [];
  const gateCalls: Array<{
    input: Parameters<typeof visible.applyVisibleAnswerAdoptionGate>[0];
    output: ReturnType<typeof visible.applyVisibleAnswerAdoptionGate>;
  }> = [];
  const receiver: Array<Record<string, unknown>> = [];
  const modelResponses: unknown[] = [];
  const modelFailures: string[] = [];
  const modelInputs: Array<{
    prompt?: string;
    extraSystemPrompt?: string;
    sessionId?: string;
    sessionKey?: string;
    workspaceDir?: string;
    agentDir?: string;
    runId?: string;
    onPartialReply?: (payload: { text: string; mediaUrl?: string }) => Promise<void>;
    onBlockReply?: (payload: { text: string; mediaUrl?: string }) => Promise<void>;
  }> = [];
  const auditCalls: Array<{
    ask: string;
    candidate: string;
    input: Parameters<typeof commercialOwner.buildPipelineResult>[2];
    caller: Parameters<typeof commercialOwner.buildPipelineResult>[3];
    output: ReturnType<typeof commercialOwner.buildPipelineResult>;
  }> = [];
  const actualReplyInputs: Parameters<typeof replyAgentOwner.runReplyAgent>[0][] = [];
  const originalReplyAgent = replyAgentOwner.runReplyAgent;
  vi.spyOn(replyAgentOwner, "runReplyAgent").mockImplementation(async (input) => {
    actualReplyInputs.push(input);
    return originalReplyAgent(input);
  });
  const queuedPayloads: Array<{ text?: string; isError?: boolean }> = [];
  let queuedInput:
    | { messageId?: string; commercialAuditAsk?: string; promptSha256: string; sessionKey?: string }
    | undefined;
  const originalAudit = commercialOwner.buildPipelineResult;
  vi.spyOn(commercialOwner, "buildPipelineResult").mockImplementation((...args) => {
    const output = originalAudit(...args);
    auditCalls.push({ ask: args[0], candidate: args[1], input: args[2], caller: args[3], output });
    return output;
  });
  const commercialAsk = "分析一下半导体板块最近的风险";
  const commercialCandidate =
    commercial === "block"
      ? "现在直接满仓买入 NVDA,加仓到 50% 仓位。"
      : commercial === "language_conflict" || commercial === "language_match"
        ? "半导体研究要点：当前缺少经网关校验的实时数据，先说明数据缺口。结构叙事：人工智能算力需求驱动。论点与反论点：需求强但估值高；若利率上行或库存周期反转则证伪。催化剂：财报与指引。风险与失效路径：关注库存、资本开支、出口管制。组合影响：仅作研究，不构成加减仓建议。下一步：补齐实时数据网关快照再定量。"
        : "半导体研究要点:当前缺少经网关校验的实时数据,先说明缺口。结构叙事:AI算力需求驱动。论点与反论点:需求强但估值高;若利率上行或库存周期反转则证伪。催化剂:财报与指引。风险与失效路径:关注库存、资本开支、出口管制。组合影响:仅作研究,不构成加减仓建议。下一步:补齐实时数据网关快照再定量。";
  const commercialAbort = new AbortController();
  let typingCancelObserved = false;
  if (cancelDuringTyping === "main") {
    const originalTyping = replyHelpers.signalTypingIfNeeded;
    vi.spyOn(replyHelpers, "signalTypingIfNeeded").mockImplementation(async (...args) => {
      await originalTyping(...args);
      typingCancelObserved = true;
      commercialAbort.abort(new Error("private main typing-wait cancellation"));
    });
  }
  const originalDefault = defaultReply.getReplyFromConfig;
  vi.spyOn(defaultReply, "getReplyFromConfig").mockImplementation(async (...args) => {
    const output = await originalDefault(...args);
    defaultCalls.push({ ctx: args[0], output });
    return output;
  });
  const originalPrepared = preparedReply.runPreparedReply;
  vi.spyOn(preparedReply, "runPreparedReply").mockImplementation(async (input) => {
    const output = await originalPrepared(input);
    preparedCalls.push({
      ctx: input.ctx,
      sessionKey: input.sessionKey,
      sessionId: input.sessionId,
      workspaceDir: input.workspaceDir,
      agentDir: input.agentDir,
      sessionEntry: input.sessionEntry,
      output,
    });
    return output;
  });
  const originalGate = visible.applyVisibleAnswerAdoptionGate;
  vi.spyOn(visible, "applyVisibleAnswerAdoptionGate").mockImplementation((input) => {
    const output = originalGate(input);
    gateCalls.push({ input, output });
    return output;
  });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const target = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    if (target !== "https://93.184.216.34/messages" || typeof init?.body !== "string") {
      model.forbidden.push(target);
      throw new Error("non-receiver transport forbidden");
    }
    receiver.push(JSON.parse(init.body) as Record<string, unknown>);
    return new Response(fault === "send_reject" ? "offline receiver rejected" : "", {
      status: fault === "send_reject" ? 500 : 200,
    });
  });
  model.invoke.mockImplementation(async (input: (typeof modelInputs)[number]) => {
    modelInputs.push({
      prompt: input.prompt,
      extraSystemPrompt: input.extraSystemPrompt,
      sessionId: input.sessionId,
      sessionKey: input.sessionKey,
      workspaceDir: input.workspaceDir,
      agentDir: input.agentDir,
      runId: input.runId,
    });
    if (fault === "missing" || fault === "sensitive_error") {
      const error =
        fault === "missing"
          ? "offline model unavailable"
          : "synthetic_vendor request failed; token=sk-offline-not-a-real-key-sixteen; path=/private/offline-provider/credentials.json; endpoint=https://93.184.216.34/private-model; trace=offline_internal_trace";
      modelFailures.push(error);
      throw new Error(error);
    }
    if (commercial) {
      await input.onPartialReply?.({ text: commercialCandidate });
      await input.onBlockReply?.({
        text: commercialCandidate,
        mediaUrl: "https://93.184.216.34/unaudited.png",
      });
      if (commercial === "cancel") {
        commercialAbort.abort(new Error("private cancellation"));
      }
    }
    const response = {
      payloads: [
        {
          text: commercial ? commercialCandidate : "100 的 10% 是 10。\n分发状态：只发控制室摘要。",
          ...(fault === "cancelled_media"
            ? { mediaUrl: "https://93.184.216.34/late-private.png" }
            : {}),
        },
      ],
      meta: {
        agentMeta: { provider: "anthropic", model: "claude-sonnet-4-5" },
        timedOut: fault === "late" || fault === "compaction_complete" || commercial === "late",
        aborted: fault === "cancelled_media",
        ...(fault === "compaction_complete"
          ? { timedOutDuringCompaction: true, promptCompleted: true }
          : {}),
      },
    };
    modelResponses.push(response);
    return response;
  });
  const probe = await probeOriginalDefaultLanguageReply(
    directory,
    commercial
      ? {
          ask: commercialAsk,
          replyOptions: {
            abortSignal: commercialAbort.signal,
            commercialAnswerAudit: {
              messageId:
                commercial === "scope_conflict"
                  ? "other-message"
                  : `external-${path.basename(directory)}`,
              askSha256: createHash("sha256")
                .update(commercial === "ask_conflict" ? "other ask" : commercialAsk)
                .digest("hex"),
              ...(commercial === "missing"
                ? {}
                : {
                    input:
                      commercial === "language_conflict"
                        ? { responseLanguage: "en" as const }
                        : commercial === "language_match"
                          ? { responseLanguage: "zh" as const }
                          : {},
                  }),
            },
          },
        }
      : {},
  );
  const nativeEvents: AgentEventPayload[] = [];
  const unsubscribe = onAgentEvent((event) => nativeEvents.push(structuredClone(event)));
  let ingress: Awaited<ReturnType<typeof probe.submit>>;
  try {
    ingress = await probe.submit(
      fault === "missing_input" ? { ...probe.message, text: undefined } : probe.message,
    );
    if (queued) {
      const input = actualReplyInputs[0];
      if (!input) {
        throw new Error("original get-reply-run did not create a followup input");
      }
      queuedInput = {
        messageId: input.followupRun.messageId,
        commercialAuditAsk: input.followupRun.commercialAuditAsk,
        promptSha256: createHash("sha256").update(input.followupRun.prompt).digest("hex"),
        sessionKey: input.followupRun.run.sessionKey,
      };
      const followup = createFollowupRunner({
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
            if (cancelDuringTyping === true) {
              typingCancelObserved = true;
              commercialAbort.abort(new Error("private typing-wait cancellation"));
              await Promise.resolve();
            }
          },
        }),
        typingMode: "instant",
        sessionKey: input.followupRun.run.sessionKey,
        defaultModel: "anthropic/claude-sonnet-4-5",
      });
      await followup(input.followupRun);
    }
  } finally {
    unsubscribe();
  }
  for (const call of auditCalls) {
    const invocation = call.output.auditInvocation;
    expect(invocation.status).toBe("observed");
    expect(invocation.identityBoundary).toBe("reply_caller_context_only");
    expect(invocation.caller).toEqual(call.caller);
    expect(invocation.inputs.askSha256).toBe(createHash("sha256").update(call.ask).digest("hex"));
    expect(invocation.inputs.candidateSha256).toBe(
      createHash("sha256").update(call.candidate).digest("hex"),
    );
    expect(invocation.inputSha256).toBe(
      createHash("sha256").update(JSON.stringify(invocation.inputs)).digest("hex"),
    );
    const consumer = nativeEvents.find(
      (event) =>
        event.data.auditReceiptSha256 ===
        createHash("sha256").update(JSON.stringify(call.output)).digest("hex"),
    );
    expect(consumer?.runId).toBe(invocation.caller?.runId);
    expect(consumer?.sessionKey).toBe(invocation.caller?.sessionKey);
    expect(consumer?.data.messageId).toBe(invocation.caller?.messageId);
    expect(consumer?.data.auditInvocation).toEqual(invocation);
    expect(modelInputs.some((input) => input.runId === invocation.caller?.runId)).toBe(true);
    expect(invocation.caller?.replyChannelAccountId).toBe(probe.inputs[0].AccountId);
  }
  const persistedSession = fault === "missing_input" ? null : await probe.readSessionStore();
  const proof = {
    boundary: "offline_default_original_reply_path",
    fault: fault ?? "positive",
    commercial,
    queued,
    queuedInput,
    queuedPayloads,
    typingCancelObserved,
    auditCalls,
    queuedDiagnostics:
      commercial === "language_conflict" && modelInputs[0]?.sessionKey
        ? peekSystemEvents(modelInputs[0].sessionKey)
        : [],
    ingress,
    message: probe.message,
    finalizedContext: probe.inputs,
    defaultCalls,
    preparedCalls,
    modelInputs,
    modelResponses,
    modelFailures,
    nativeEvents,
    gateCalls,
    receiver,
    dispatcher: probe.dispatchResults,
    sessionWrites: probe.sessionWrites,
    persistedSession,
    isolatedHome: process.env.HOME,
    modelInferenceObserved: false,
    lateTerminalObservation:
      fault === "late" ? "ordinary_timeout_rejected_after_root_minimal_fix" : "not_applicable",
    statusPatches: probe.statusPatches,
    errors: probe.errors,
    forbiddenTransports: [...model.forbidden],
    userVisibleObserved: false,
    completeCanonicalScene: false,
  };
  const proofDir = process.env.LCX_WATERFLOW_LANGUAGE_DEFAULT_PROOF_DIR;
  if (proofDir) {
    await fs.mkdir(proofDir, { recursive: true });
    const bytes = JSON.stringify(proof, null, 2) + "\n";
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const artifact = path.join(
      proofDir,
      `${queued ? "queued-" : ""}${commercial ?? fault ?? "positive"}-${sha256}.json`,
    );
    await fs.writeFile(artifact, bytes);
    if (!fault && !commercial) {
      const ref = (pointer: string) => ({ path: artifact, pointer, sha256 });
      const firstCall = defaultCalls[0] as { output: unknown };
      const consumerPointer = Array.isArray(firstCall.output)
        ? "/defaultCalls/0/output/0/text"
        : "/defaultCalls/0/output/text";
      const evidence: WorkflowHandoffEvidence[] = [
        {
          scenarioId: "external_visible_language_waterflow",
          environment: "offline_fixture",
          nodes: [
            {
              nodeId: "visible_answer_adoption_gate",
              scope: ref("/finalizedContext/0/MessageSid"),
              output: ref("/gateCalls/0/output/text"),
            },
            {
              nodeId: "reply_flow_audit",
              scope: ref("/finalizedContext/0/MessageSid"),
              inputs: [{ from: "visible_answer_adoption_gate", value: ref(consumerPointer) }],
              output: ref("/receiver/0/text"),
            },
          ],
        },
      ];
      const audit = (await auditWorkflowHandoffs(evidence)).find(
        (entry) => entry.scenarioId === "external_visible_language_waterflow",
      );
      expect(audit?.status).toBe("handoff_gap");
      await fs.writeFile(
        path.join(proofDir, "default-positive-field-audit.json"),
        JSON.stringify(
          { evidence, audit, defaultResolverWasInvoked: true, completeCanonicalScene: false },
          null,
          2,
        ) + "\n",
      );
    }
  }
  return proof;
}

describe("original external default reply caller", () => {
  it("rejects cancellation after original main typing await before final payload sealing", async () => {
    const proof = await run(undefined, "pass", false, "main");
    expect(proof.typingCancelObserved).toBe(true);
    expect(proof.forbiddenTransports).toEqual([]);
    expect(proof.auditCalls).toHaveLength(1);
    if (process.env.LCX_COMMERCIAL_TYPING_CANCEL_BEFORE === "1") {
      expect(proof.receiver.at(-1)?.text).toContain("半导体研究要点");
      return;
    }
    expect(JSON.stringify(proof.receiver)).not.toContain("半导体研究要点");
    const cancellation = proof.nativeEvents.find(
      (event) =>
        event.data.phase === "commercial_answer_terminal_gate" &&
        event.data.surface === "final_seal",
    );
    expect(cancellation?.data.decision).toBe("blocked");
    expect(cancellation?.data.failedReasons).toContain("commercial_reply_cancelled");
  });
  it("rejects cancellation during original followup typing await before actual delivery", async () => {
    const proof = await run(undefined, "pass", true, true);
    expect(proof.typingCancelObserved).toBe(true);
    expect(proof.forbiddenTransports).toEqual([]);
    expect(proof.auditCalls).toHaveLength(2);
    if (process.env.LCX_COMMERCIAL_TYPING_CANCEL_BEFORE === "1") {
      expect(proof.queuedPayloads).toHaveLength(1);
      expect(proof.receiver.at(-1)?.text).toContain("半导体研究要点");
      return;
    }
    expect(proof.queuedPayloads).toHaveLength(0);
    expect(proof.receiver).toHaveLength(1);
    const cancellation = proof.nativeEvents.find(
      (event) =>
        event.data.phase === "commercial_answer_terminal_gate" &&
        event.data.dispatchCancelled === true,
    );
    expect(cancellation?.data.decision).toBe("blocked");
    expect(cancellation?.data.failedReasons).toContain("commercial_reply_cancelled");
  });
  it("consumes original normalized readability bytes and the matched Chinese language input in one default reply", async () => {
    const proof = await run(undefined, "language_match");
    expect(proof.modelInputs).toHaveLength(1);
    expect(proof.modelInputs[0].extraSystemPrompt).toContain("LCX reply language: zh.");
    expect(proof.auditCalls).toHaveLength(1);
    const call = proof.auditCalls[0];
    expect(call.candidate).toMatch(/[\u3400-\u9fff]/u);
    expect(call.candidate).not.toMatch(/[A-Za-z]/u);
    expect(call.output.languageRoute).toMatchObject({
      selectedLanguage: "zh",
      status: "matched",
      candidateLanguage: "zh",
      requestSource: "bound_reply_host",
    });
    expect(call.output.controlRoomSummary.languageInput).toEqual({
      selectedLanguage: "zh",
      candidateCheckStatus: "matched",
    });
    expect(call.output.terminalDecision).toBe("adopt_visible_answer");
    const normalizer = proof.gateCalls[0];
    expect(normalizer.input).toMatchObject({
      presentationOnly: true,
      captureProcessEvidence: true,
      userMessage: proof.message.text,
    });
    expect(normalizer.output.status).toBe("adopted");
    const hash = createHash("sha256").update(normalizer.output.text).digest("hex");
    expect(normalizer.output.presentationProcessEvidence).toEqual({
      boundary: "original_presentation_suboperation_hashes_not_semantic_quality",
      normalizerOutputSha256: hash,
      readabilityInputSha256: hash,
    });
    expect(call.candidate).toBe(normalizer.output.text);
    // The source's terminal guard returns this reviewed payload into the later original presentation call.
    expect(proof.gateCalls[2].input).toMatchObject({
      presentationOnly: true,
      answerText: normalizer.output.text,
      userMessage: proof.modelInputs[0].prompt,
    });
    expect(proof.gateCalls[2].output.status).toBe("adopted");
    expect(proof.receiver).toHaveLength(1);
    expect(proof.receiver[0].text).toBe(proof.gateCalls[2].output.text);
    const terminal = proof.nativeEvents.find(
      (event) =>
        event.data.phase === "commercial_answer_terminal_gate" && event.data.decision === "adopted",
    );
    expect(terminal?.runId).toBe(call.output.auditInvocation.caller?.runId);
    expect(terminal?.data.messageId).toBe(proof.message.id);
    expect(proof.modelInputs[0].runId).toBe(terminal?.runId);
    expect(proof.forbiddenTransports).toEqual([]);
  });
  it("passes a bound English language instruction through the original default model input and rejects a Chinese-only candidate", async () => {
    const proof = await run(undefined, "language_conflict");
    expect(proof.defaultCalls).toHaveLength(1);
    expect(proof.preparedCalls).toHaveLength(1);
    expect(proof.modelInputs).toHaveLength(1);
    expect(proof.message.text).toMatch(/[\u3400-\u9fff]/u);
    expect(proof.modelInputs[0].extraSystemPrompt).toContain("LCX reply language: en.");
    expect(proof.auditCalls).toHaveLength(1);
    const receipt = proof.auditCalls[0].output;
    expect(receipt.languageRoute).toMatchObject({
      selectedLanguage: "en",
      status: "conflict",
      candidateLanguage: "zh",
      requestSource: "bound_reply_host",
      candidateSha256: createHash("sha256").update(proof.auditCalls[0].candidate).digest("hex"),
    });
    expect(receipt.failedReasons).toContain("commercial_response_language_conflict");
    expect(receipt.controlRoomSummary.text).not.toMatch(/[\u3400-\u9fff]/u);
    expect(proof.receiver).toHaveLength(1);
    expect(proof.receiver[0].text).toBe(receipt.controlRoomSummary.text);
    expect(JSON.stringify(proof.receiver)).not.toContain("unaudited.png");
    const terminal = proof.nativeEvents.find(
      (event) =>
        event.data.phase === "commercial_answer_terminal_gate" &&
        Array.isArray(event.data.failedReasons) &&
        event.data.failedReasons.includes("commercial_response_language_conflict"),
    );
    expect(terminal?.data.decision).toBe("blocked");
    expect(terminal?.data.refusalFeedback).toMatchObject({ status: "queued" });
    const diagnosticText = proof.queuedDiagnostics.find((text) =>
      text.includes("commercial_response_language_conflict"),
    );
    expect(diagnosticText).toBeDefined();
    const diagnostic: unknown = JSON.parse(diagnosticText ?? "null");
    expect(diagnostic).toMatchObject({
      schemaVersion: "lcx_commercial_refusal_feedback_v1",
      runId: receipt.auditInvocation.caller?.runId,
      messageId: proof.message.id,
      languageRoute: { selectedLanguage: "en", candidateLanguage: "zh", status: "conflict" },
      failedReasons: expect.arrayContaining(["commercial_response_language_conflict"]),
      semanticAdoption: "not_proven",
    });
    expect(proof.forbiddenTransports).toEqual([]);
    // This actual original queue write is observed; a subsequent model prompt is not run here.
  });
  it.each(["pass", "block", "scope_conflict", "cancel"] as const)(
    "consumes original get-reply-run followup identity for explicit commercial %s",
    async (kind) => {
      const proof = await run(undefined, kind, true);
      expect(proof.queuedInput?.commercialAuditAsk).toBe(proof.message.text);
      expect(proof.queuedInput?.messageId).toBe(proof.message.id);
      expect(proof.queuedPayloads).toHaveLength(1);
      expect(proof.forbiddenTransports).toEqual([]);
      const events = proof.nativeEvents.filter(
        (event) =>
          event.data.phase === "commercial_answer_terminal_gate" &&
          event.data.surface === "followup",
      );
      expect(events).toHaveLength(1);
      if (kind === "pass") {
        expect(events[0].data.decision).toBe("adopted");
        expect(proof.receiver.at(-1)?.text).toContain("半导体研究要点");
      } else {
        expect(events[0].data.decision).toBe("blocked");
        expect(proof.queuedPayloads[0].isError).toBe(true);
        expect(JSON.stringify(proof.receiver)).not.toContain("满仓买入");
        expect(JSON.stringify(proof.receiver)).not.toContain("unaudited.png");
      }
    },
  );
  it.each([
    "pass",
    "block",
    "scope_conflict",
    "ask_conflict",
    "missing",
    "late",
    "cancel",
  ] as const)("consumes explicit commercial %s before the original sender", async (kind) => {
    const proof = await run(undefined, kind);
    expect(proof.defaultCalls).toHaveLength(1);
    expect(proof.preparedCalls).toHaveLength(1);
    expect(proof.forbiddenTransports).toEqual([]);
    if (process.env.LCX_COMMERCIAL_REPLY_BEFORE === "1") {
      expect(proof.auditCalls).toHaveLength(0);
      if (kind === "block") {
        expect(JSON.stringify(proof.receiver)).toContain("满仓买入");
      }
      return;
    }
    expect(JSON.stringify(proof.receiver)).not.toContain("unaudited.png");
    const events = proof.nativeEvents.filter(
      (event) => event.data.phase === "commercial_answer_terminal_gate",
    );
    expect(events.length).toBeGreaterThan(0);
    if (kind === "pass") {
      expect(proof.auditCalls).toHaveLength(1);
      expect(proof.receiver).toHaveLength(1);
      expect(proof.receiver[0]?.text).toContain("半导体研究要点");
      expect(events.some((event) => event.data.decision === "adopted")).toBe(true);
    } else {
      expect(JSON.stringify(proof.receiver)).not.toContain("满仓买入");
      expect(events.some((event) => event.data.decision === "blocked")).toBe(true);
      const output = proof.defaultCalls[0] as { output: { isError?: boolean } };
      expect(output.output.isError).toBe(true);
      if (kind !== "block") {
        expect(proof.auditCalls).toHaveLength(0);
      }
    }
  });
  it("consumes one ingress through the untouched default resolver/prepared worker and actual sender", async () => {
    const proof = await run();
    expect(proof.ingress.statusCode).toBe(202);
    expect(proof.defaultCalls).toHaveLength(1);
    expect(proof.preparedCalls).toHaveLength(1);
    expect(proof.modelInputs).toHaveLength(1);
    expect(proof.modelInputs[0].prompt).toContain(proof.message.text);
    expect(proof.modelInputs[0].workspaceDir).toContain("lcx-default-language-");
    expect(proof.modelInputs[0].agentDir).toContain("lcx-default-language-");
    expect(JSON.stringify(proof.persistedSession)).toContain(
      proof.modelInputs[0].sessionId ?? "missing session identity",
    );
    expect(proof.receiver[0]?.replyToId).toBe(proof.message.id);
    expect(proof.receiver).toHaveLength(1);
    expect(proof.receiver[0].text).toContain("100 的 10% 是 10");
    expect(proof.receiver[0].text).not.toContain("分发状态");
    expect(proof.gateCalls.length).toBeGreaterThan(0);
    expect(proof.forbiddenTransports).toEqual([]);
  });
  it.each(["missing", "sensitive_error"] as const)(
    "keeps %s safe and attached to the current failed request",
    async (fault) => {
      const proof = await run(fault);
      expect(proof.modelInputs).toHaveLength(1);
      expect(JSON.stringify(proof.receiver)).not.toContain("100 的 10% 是 10");
      expect(proof.receiver).toHaveLength(1);
      const text = String(proof.receiver[0].text);
      expect(text).toMatch(/无法|失败|unavailable|failed|unable|retry|try again/iu);
      for (const marker of [
        "Logs:",
        "openclaw logs --follow",
        "sk-offline-not-a-real-key-sixteen",
        "/private/offline-provider/credentials.json",
        "https://93.184.216.34/private-model",
        "synthetic_vendor",
        "offline_internal_trace",
      ]) {
        expect(text).not.toContain(marker);
      }
      expect(proof.receiver[0].replyToId).toBe(proof.message.id);
      const output = proof.defaultCalls[0] as { output: { isError?: boolean; replyToId?: string } };
      expect(output.output.isError).toBe(true);
      expect(output.output.replyToId).toBe(proof.message.id);
      expect(proof.modelFailures).toHaveLength(1);
      const failure = proof.nativeEvents.find(
        (event) => event.data.phase === "reply_model_failure",
      );
      expect(failure?.data.status).toBe("failed");
      expect(failure?.data.reason).toEqual(expect.any(String));
      expect(failure?.runId).toBe(proof.modelInputs[0].runId);
      expect(failure?.sessionKey).toBe(proof.finalizedContext[0].SessionKey);
      expect(failure?.data.errorSha256).toBe(
        createHash("sha256").update(proof.modelFailures[0]).digest("hex"),
      );
      expect(JSON.stringify(failure?.data)).not.toContain("sk-offline-not-a-real-key-sixteen");
      expect(JSON.stringify(failure?.data)).not.toContain("/private/offline-provider");
      expect(proof.forbiddenTransports).toEqual([]);
    },
  );
  it("rejects ordinary text returned after the original timeout terminal", async () => {
    const proof = await run("late");
    expect(proof.modelResponses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ meta: expect.objectContaining({ timedOut: true }) }),
      ]),
    );
    expect(JSON.stringify(proof.receiver)).not.toContain("100 的 10% 是 10");
    expect(JSON.stringify(proof.receiver)).toContain("回复未完成");
    expect(JSON.stringify(proof.defaultCalls)).toContain('"isError":true');
    const stopped = proof.nativeEvents.find(
      (event) => event.data.phase === "reply_run_stopped_gate",
    );
    expect(stopped?.data.reason).toBe("reply_model_stopped");
    expect(stopped?.data.status).toBe("blocked");
    expect(stopped?.runId).toBe(proof.modelInputs[0].runId);
    expect(stopped?.sessionKey).toBe(proof.finalizedContext[0].SessionKey);
    expect(stopped?.data.candidateSha256).toBe(
      createHash("sha256").update("100 的 10% 是 10。\n分发状态：只发控制室摘要。").digest("hex"),
    );
    expect(proof.completeCanonicalScene).toBe(false);
    expect(proof.forbiddenTransports).toEqual([]);
  });
  it("rejects aborted final text and media through the same default outlet", async () => {
    const proof = await run("cancelled_media");
    expect(JSON.stringify(proof.modelResponses)).toContain("late-private.png");
    expect(JSON.stringify(proof.receiver)).not.toContain("late-private.png");
    expect(JSON.stringify(proof.receiver)).not.toContain("100 的 10% 是 10");
    expect(JSON.stringify(proof.receiver)).toContain("回复未完成");
    expect(proof.forbiddenTransports).toEqual([]);
  });
  it("preserves the original completed-prompt-before-compaction-timeout exception", async () => {
    const proof = await run("compaction_complete");
    expect(JSON.stringify(proof.modelResponses)).toContain('"promptCompleted":true');
    expect(proof.receiver[0].text).toContain("100 的 10% 是 10");
    expect(proof.receiver[0].text).not.toContain("分发状态");
    expect(proof.forbiddenTransports).toEqual([]);
  });
  it("rejects absent input before any default resolver or model consumer", async () => {
    const proof = await run("missing_input");
    expect(proof.ingress.statusCode).toBe(400);
    expect(proof.defaultCalls).toEqual([]);
    expect(proof.modelInputs).toEqual([]);
    expect(proof.receiver).toEqual([]);
    expect(proof.forbiddenTransports).toEqual([]);
  });
  it("does not confuse webhook acceptance with rejected outbound delivery", async () => {
    const proof = await run("send_reject");
    expect(proof.ingress.statusCode).toBe(202);
    expect(proof.receiver).toHaveLength(1);
    expect(proof.errors.join("\n")).toContain("500");
    expect(
      proof.statusPatches.some((patch) => "lastOutboundAt" in (patch as Record<string, unknown>)),
    ).toBe(false);
    expect(proof.forbiddenTransports).toEqual([]);
  });
});
