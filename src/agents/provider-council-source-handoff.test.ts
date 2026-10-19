import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { afterEach, expect, it, vi } from "vitest";
import {
  buildPipelineResult,
  readProviderCouncilEvidence,
  planCommercialAnswerRequirements,
} from "../../scripts/operator/lcx-commercial-answer-pipeline.js";
import * as commercialOwner from "../../scripts/operator/lcx-commercial-answer-pipeline.js";
import {
  auditWorkflowHandoffs,
  type WorkflowHandoffEvidence,
} from "../../scripts/operator/lcx-flow-graph.js";
import { buildQueuedSystemPrompt } from "../auto-reply/reply/session-updates.js";
import { buildLearningCouncilArtifactJsonRelativePath } from "../hooks/bundled/lobster-brain-registry.js";
import { peekSystemEvents, resetSystemEventsForTest } from "../infra/system-events.js";
import { createCommercialAnswerReplyGate } from "./commercial-answer-reply-gate.js";
import * as attributionOwner from "./provider-council-evidence.js";
import {
  runExternalLearningCouncil,
  __testing as councilTesting,
} from "./provider-learning-council.js";

const model = vi.hoisted(() => ({ invoke: vi.fn(), gateway: vi.fn() }));
vi.mock("../commands/agent.js", () => ({
  agentCommand: (...args: unknown[]) => model.invoke(...args),
}));
vi.mock("../gateway/call.js", () => ({
  callGateway: (...args: unknown[]) => model.gateway(...args),
  randomIdempotencyKey: () => "offline-source-handoff",
}));
vi.mock("../cli/deps.js", () => ({ createDefaultDeps: () => ({}) }));
vi.mock("../runtime.js", () => ({
  defaultRuntime: { log: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock("../infra/operational-anomalies.js", () => ({ recordOperationalAnomaly: vi.fn() }));
const roots: string[] = [];
afterEach(async () => {
  resetSystemEventsForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  model.invoke.mockReset();
  model.gateway.mockReset();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

it.each([true, false])(
  "captures original planner -> actual role request only when opted in (%s)",
  async (capture) => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "council-planner-request-"));
    roots.push(workspace);
    vi.stubEnv("LCX_LEARNING_COUNCIL_TRANSPORT", "in-process");
    vi.stubEnv("OPENCLAW_LEARNING_COUNCIL_KIMI_MODEL", "moonshot/kimi-k2.6");
    vi.stubEnv("OPENCLAW_LEARNING_COUNCIL_MINIMAX_MODEL", "minimax-portal/MiniMax-M2.7");
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
    const calls: {
      model: string;
      message: string;
      sessionKey: string;
      extraSystemPrompt: string;
      thinking: string;
      timeout: string;
    }[] = [];
    model.invoke.mockImplementation(async (input: (typeof calls)[number]) => {
      calls.push({ ...input });
      const slash = input.model.indexOf("/");
      return {
        payloads: [
          {
            text: "## Synthesis\n- Keep one bounded method.\n## Extracted lessons\n- Preserve review boundaries.\n## Challenges\n- Check original evidence before acting.",
          },
        ],
        meta: {
          agentMeta: { provider: input.model.slice(0, slash), model: input.model.slice(slash + 1) },
        },
      };
    });
    const ask = "研究GitHub repo、Kimi和MiniMax多审一轮，中文英文双语，值得内化，别做表面总结。";
    const sessionKey = "private-planner-session";
    const messageId = "private-planner-message";
    await runExternalLearningCouncil({
      cfg: {
        agents: {
          defaults: { workspace, models: { "custom-api-deepseek-com/deepseek-v4-flash": {} } },
        },
      },
      userMessage: ask,
      routeAgentId: "main",
      sessionKey,
      messageId,
      workspaceDir: workspace,
      ...(capture ? { captureProcessEvidence: true } : {}),
    });
    const artifactBytes = await fs.readFile(
      path.join(workspace, buildLearningCouncilArtifactJsonRelativePath(messageId)),
    );
    type RequestEvidence = {
      role: string;
      userMessageSha256: string;
      sessionKey: string;
      extraSystemPromptSha256: string;
      thinking: string;
      timeoutSeconds: number;
    };
    const artifact = JSON.parse(artifactBytes.toString("utf8")) as {
      roles: Array<{ requestReadback?: unknown; processEvidence?: unknown }>;
      processEvidence?: {
        planner: {
          userMessageSha256: string;
          sessionKey: string;
          messageId: string;
          directives: Record<string, boolean>;
          inputSha256: string;
        };
        planningCalls: Array<{
          callId: string;
          planningFields: Record<string, boolean>;
          builderInputSha256: string;
          builtSystemPromptSha256: string;
          dispatchInput: RequestEvidence;
          dispatchInputSha256: string;
          receivedInput: RequestEvidence;
          receivedInputSha256: string;
        }>;
      };
    };
    expect(calls).toHaveLength(4);
    expect(network).not.toHaveBeenCalled();
    expect(model.gateway).not.toHaveBeenCalled();
    if (!capture) {
      expect(artifact.processEvidence).toBeUndefined();
      expect(artifact.roles.every((role) => !role.requestReadback && !role.processEvidence)).toBe(
        true,
      );
      return;
    }
    const hash = (value: unknown) =>
      createHash("sha256").update(JSON.stringify(value)).digest("hex");
    const evidence = artifact.processEvidence;
    if (!evidence) {
      throw new Error("original writer omitted opt-in planning evidence");
    }
    expect(evidence.planner).toMatchObject({ userMessageSha256: hash(ask), sessionKey, messageId });
    expect(evidence.planner.directives).toEqual({
      kimiHeavy: true,
      minimaxHeavy: true,
      bilingualComprehension: true,
      internalizationFocus: true,
      antiShallowSummary: true,
      durableLearningDiscipline: true,
      broadKnowledgeDistillation: false,
    });
    expect(evidence.planner.inputSha256).toBe(
      hash({ userMessage: ask, sessionKey, messageId, directives: evidence.planner.directives }),
    );
    expect(evidence.planningCalls.map((call) => call.callId)).toEqual([
      "kimi",
      "deepseek",
      "minimax_primary",
      "minimax_extra",
    ]);
    for (const call of evidence.planningCalls) {
      const actual = calls.find((input) => input.sessionKey === call.receivedInput.sessionKey);
      if (!actual) {
        throw new Error("planning call has no actual local model request");
      }
      const originalModelInput = {
        role: call.dispatchInput.role,
        userMessageSha256: hash(actual.message),
        sessionKey: actual.sessionKey,
        extraSystemPromptSha256: hash(actual.extraSystemPrompt),
        thinking: actual.thinking,
        timeoutSeconds: Number(actual.timeout),
      };
      expect(call.receivedInput).toEqual(originalModelInput);
      expect(call.dispatchInput).toEqual(originalModelInput);
      expect(call.receivedInputSha256).toBe(hash(originalModelInput));
      expect(call.dispatchInputSha256).toBe(call.receivedInputSha256);
      for (const [field, value] of Object.entries(call.planningFields)) {
        expect(value).toBe(evidence.planner.directives[field]);
      }
      expect(call.builderInputSha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(call.builtSystemPromptSha256).toMatch(/^[a-f0-9]{64}$/u);
    }
    expect(evidence.planningCalls[2].receivedInput.sessionKey).not.toBe(
      evidence.planningCalls[3].receivedInput.sessionKey,
    );
    const retain = process.env.LCX_COUNCIL_PLANNER_ROLE_PROOF_DIR;
    if (retain) {
      await fs.mkdir(retain, { recursive: true });
      await fs.writeFile(path.join(retain, "original-artifact.json"), artifactBytes);
      await fs.writeFile(
        path.join(retain, "actual-model-request-hashes.json"),
        JSON.stringify(
          {
            boundary:
              "original planner/builders/dispatch/role/writer; model transport local substitute, not semantic adoption",
            artifactSha256: createHash("sha256").update(artifactBytes).digest("hex"),
            requests: calls.map((call) => ({
              sessionKey: call.sessionKey,
              userMessageSha256: hash(call.message),
              extraSystemPromptSha256: hash(call.extraSystemPrompt),
            })),
          },
          null,
          2,
        ) + "\n",
      );
    }
  },
);

it("passes real council role content and first challenge into the second original role call", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "council-source-handoff-"));
  roots.push(workspace);
  vi.stubEnv("LCX_LEARNING_COUNCIL_TRANSPORT", "in-process");
  vi.stubEnv("OPENCLAW_LEARNING_COUNCIL_KIMI_MODEL", "moonshot/kimi-k2.6");
  vi.stubEnv("OPENCLAW_LEARNING_COUNCIL_MINIMAX_MODEL", "minimax-portal/MiniMax-M2.7");
  vi.spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("network forbidden in offline council source proof"),
  );
  const ask =
    "Kimi、MiniMax、DeepSeek 的证据冲突如何处理？MiniMax 多审一轮，不把角色完成当来源可信。";
  const messageId = "offline-original-council-source-handoff";
  const synthesis =
    "## Synthesis\n- SYNTHESIS_SOURCE_ALPHA: the underlying evidence is unresolved.\n## Freshness and caveats\n- Original source registry proof was not supplied.\n## Provisional anchors\n- Keep this conclusion provisional.";
  const extraction =
    "## Extracted lessons\n- EXTRACTION_SOURCE_BETA: challenge the synthesis evidence.\n## Candidate follow-ups\n- Request original source bytes.\n## Weak evidence\n- Source trust remains unresolved.";
  const firstChallenge =
    "## What holds up\n- Original role content arrived.\n## Challenges\n- FIRST_CHALLENGE_GAMMA: do not decide this evidence conflict by majority.\n## Evidence gaps\n- The primary-source record is missing.";
  const secondChallenge =
    "## What holds up\n- The prior challenge arrived.\n## Challenges\n- SECOND_CHALLENGE_DELTA: keep the source conflict unresolved.\n## Evidence gaps\n- Need original source and validity period.";
  const calls: Array<{
    model: string;
    sessionKey: string;
    message: string;
    extraSystemPrompt: string;
    returnedText: string;
    lane: string;
    senderIsOwner: boolean;
    consumerReadback: { synthesis?: string; extraction?: string; priorChallenge?: string };
  }> = [];
  const modelResponses: unknown[] = [];
  let challengeCount = 0;
  model.invoke.mockImplementation(
    async (input: {
      model: string;
      sessionKey: string;
      message: string;
      extraSystemPrompt: string;
      lane: string;
      senderIsOwner: boolean;
    }) => {
      const consumerReadback: { synthesis?: string; extraction?: string; priorChallenge?: string } =
        {};
      let text: string;
      if (input.model.startsWith("moonshot/")) {
        text = synthesis;
      } else if (input.model.startsWith("custom-api-deepseek-com/")) {
        text = extraction;
      } else {
        challengeCount++;
        expect(input.extraSystemPrompt).toContain(synthesis);
        expect(input.extraSystemPrompt).toContain(extraction);
        consumerReadback.synthesis = input.extraSystemPrompt.slice(
          input.extraSystemPrompt.indexOf(synthesis),
          input.extraSystemPrompt.indexOf(synthesis) + synthesis.length,
        );
        consumerReadback.extraction = input.extraSystemPrompt.slice(
          input.extraSystemPrompt.indexOf(extraction),
          input.extraSystemPrompt.indexOf(extraction) + extraction.length,
        );
        if (challengeCount === 2) {
          expect(input.extraSystemPrompt).toContain(firstChallenge);
          consumerReadback.priorChallenge = input.extraSystemPrompt.slice(
            input.extraSystemPrompt.indexOf(firstChallenge),
            input.extraSystemPrompt.indexOf(firstChallenge) + firstChallenge.length,
          );
        }
        text = challengeCount === 1 ? firstChallenge : secondChallenge;
      }
      calls.push({ ...input, returnedText: text, consumerReadback });
      const slash = input.model.indexOf("/");
      const response = {
        payloads: [{ text }],
        meta: {
          agentMeta: { provider: input.model.slice(0, slash), model: input.model.slice(slash + 1) },
        },
      };
      modelResponses.push(structuredClone(response));
      return response;
    },
  );
  const nativeFinalReply = await runExternalLearningCouncil({
    cfg: {
      agents: {
        defaults: { workspace, models: { "custom-api-deepseek-com/deepseek-v4-flash": {} } },
      },
    },
    userMessage: ask,
    routeAgentId: "main",
    sessionKey: "offline",
    messageId,
    workspaceDir: workspace,
    captureProcessEvidence: true,
  });
  expect(calls).toHaveLength(4);
  expect(challengeCount).toBe(2);
  expect(calls[2].consumerReadback).toEqual({ synthesis, extraction });
  expect(calls[3].consumerReadback).toEqual({
    synthesis,
    extraction,
    priorChallenge: firstChallenge,
  });
  const originalArtifactPath = path.join(
    workspace,
    buildLearningCouncilArtifactJsonRelativePath(messageId),
  );
  const originalArtifactBytes = await fs.readFile(originalArtifactPath, "utf8");
  const artifact = JSON.parse(originalArtifactBytes) as {
    messageId: string;
    roles: Array<{
      role: string;
      text: string;
      actualProvider?: string;
      actualModel?: string;
      requestedModelHealth?: string;
      success: boolean;
      processEvidence?: { responseResultInputSha256: string; attributionOutputSha256: string };
    }>;
    processEvidence?: { roleInputs: Array<{ role: string; attributionSha256: string }> };
    finalReply: string;
  };
  expect(artifact.roles.find((role) => role.role === "minimax")?.text).toContain(
    "SECOND_CHALLENGE_DELTA",
  );
  expect(artifact.finalReply).toBe(nativeFinalReply);
  const kimi = artifact.roles.find((role) => role.role === "kimi");
  if (!kimi?.processEvidence) {
    throw new Error("actual Kimi assessment witness not returned");
  }
  const kimiCallIndex = calls.findIndex((call) => call.model.startsWith("moonshot/"));
  expect(kimiCallIndex).toBeGreaterThanOrEqual(0);
  const kimiTransportSha = createHash("sha256")
    .update(JSON.stringify(modelResponses[kimiCallIndex]))
    .digest("hex");
  expect(kimi.processEvidence.responseResultInputSha256).toBe(kimiTransportSha);
  const actualAttribution = {
    actualProvider: kimi.actualProvider,
    actualModel: kimi.actualModel,
    requestedModelHealth: kimi.requestedModelHealth,
    success: kimi.success,
  };
  const attributionSha = createHash("sha256")
    .update(JSON.stringify(actualAttribution))
    .digest("hex");
  expect(kimi.processEvidence.attributionOutputSha256).toBe(attributionSha);
  expect(
    artifact.processEvidence?.roleInputs.find((role) => role.role === "kimi")?.attributionSha256,
  ).toBe(attributionSha);
  expect(calls.every((call) => call.lane === "learning-council" && !call.senderIsOwner)).toBe(true);
  const readerInput = await readProviderCouncilEvidence(originalArtifactPath, messageId);
  const verifierCalls: Array<{
    input: Parameters<typeof attributionOwner.verifyProviderCouncilEvidence>;
    output: ReturnType<typeof attributionOwner.verifyProviderCouncilEvidence>;
  }> = [];
  const nativeVerify = attributionOwner.verifyProviderCouncilEvidence;
  vi.spyOn(attributionOwner, "verifyProviderCouncilEvidence").mockImplementation((...args) => {
    const output = nativeVerify(...args);
    verifierCalls.push({ input: args, output });
    return output;
  });
  // The original caller returned this exact body; no hand-authored completion candidate is inserted.
  const terminal = buildPipelineResult(ask, nativeFinalReply, { providerEvidence: readerInput });
  const consumedIndex = verifierCalls.findIndex(
    (call) => call.output === terminal.consumedEvidence.providerCouncil,
  );
  expect(consumedIndex).toBeGreaterThanOrEqual(0);
  expect(terminal.consumedEvidence.providerCouncil.status).toBe("verified");
  expect(terminal.consumedEvidence.providerCouncil.semanticAdoption).toBe("not_proven");
  expect(verifierCalls[consumedIndex].input.slice(0, 3)).toEqual([
    ask,
    nativeFinalReply,
    readerInput,
  ]);
  expect(verifierCalls[consumedIndex].input[3]).toBeUndefined();
  const rejectedInputs = {
    missing: buildPipelineResult(ask, nativeFinalReply),
    hashConflict: buildPipelineResult(ask, nativeFinalReply, {
      providerEvidence: { ...readerInput, sha256: "0".repeat(64) },
    }),
    foreignMessage: buildPipelineResult(ask, nativeFinalReply, {
      providerEvidence: { ...readerInput, messageId: "different-original-message" },
    }),
  };
  for (const result of Object.values(rejectedInputs)) {
    expect(result.terminalDecision).toBe("return_failed_reason");
    expect(result.failedReasons).toContain("provider_council_completion_without_verified_receipt");
  }
  expect(rejectedInputs.missing.consumedEvidence.providerCouncil.status).toBe("missing");
  expect(rejectedInputs.hashConflict.consumedEvidence.providerCouncil.gaps).toContain(
    "provider_council_source_hash_conflict",
  );
  expect(rejectedInputs.foreignMessage.consumedEvidence.providerCouncil.gaps).toContain(
    "provider_council_message_scope_conflict",
  );
  const gateBuilderCalls: Array<{
    input: Parameters<typeof commercialOwner.buildPipelineResult>;
    output: ReturnType<typeof commercialOwner.buildPipelineResult>;
  }> = [];
  const originalBuilder = commercialOwner.buildPipelineResult;
  vi.spyOn(commercialOwner, "buildPipelineResult").mockImplementation((...args) => {
    const output = originalBuilder(...args);
    gateBuilderCalls.push({ input: args, output });
    return output;
  });
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const firstCaller = {
    runId: "original-council-review-first",
    messageId,
    sessionKey: "offline-council-feedback-session",
    replyChannelAccountId: "offline-channel-account",
  };
  const badEvidence = { ...readerInput, sha256: "0".repeat(64) };
  const firstGate = createCommercialAnswerReplyGate({
    request: { messageId, askSha256: hash(ask), input: { providerEvidence: badEvidence } },
    messageId,
    ask,
  });
  const firstRefusal = firstGate.check({ text: nativeFinalReply }, "final", false, firstCaller);
  expect(firstRefusal.payload.isError).toBe(true);
  const firstReceipt = gateBuilderCalls[0]?.output;
  if (!firstReceipt) {
    throw new Error("actual first native audit receipt not captured");
  }
  expect(firstRefusal.trace).toMatchObject({
    nativeTerminalDecision: firstReceipt.terminalDecision,
    controlRoomSummary: firstReceipt.controlRoomSummary,
    auditReceiptSha256: hash(JSON.stringify(firstReceipt)),
  });
  expect(firstRefusal.trace).toMatchObject({
    decision: "blocked",
    refusalFeedback: { status: "queued" },
  });
  const originalQueuedDiagnostics = peekSystemEvents(firstCaller.sessionKey);
  const historicalSystemPrompt = await buildQueuedSystemPrompt({
    cfg: {},
    sessionKey: firstCaller.sessionKey,
    isMainSession: false,
    isNewSession: true,
  });
  expect(historicalSystemPrompt).toContain("## Runtime System Events (gateway-generated)");
  expect(historicalSystemPrompt).toContain("provider_council_source_hash_conflict");
  expect(peekSystemEvents(firstCaller.sessionKey)).toEqual([]);
  const nextCaller = { ...firstCaller, runId: "original-council-review-next" };
  const nextBadGate = createCommercialAnswerReplyGate({
    request: { messageId, askSha256: hash(ask), input: { providerEvidence: badEvidence } },
    messageId,
    ask,
    historicalSystemPrompt,
  });
  const continuedRefusal = nextBadGate.check(
    { text: nativeFinalReply },
    "final",
    false,
    nextCaller,
  );
  const nextInvalid = gateBuilderCalls.at(-1)!.output.consumedEvidence.providerCouncil;
  expect(continuedRefusal.payload.isError).toBe(true);
  expect(nextInvalid.status).toBe("invalid");
  expect(nextInvalid.reviewFeedbackUse).toMatchObject({
    priorRunId: firstCaller.runId,
    priorMessageId: messageId,
    disposition: "unresolved",
    remainingGaps: ["provider_council_source_hash_conflict"],
    resolvedGaps: [],
  });
  const correctReadback = await readProviderCouncilEvidence(originalArtifactPath, messageId);
  const repairedCaller = { ...firstCaller, runId: "original-council-review-source-reread" };
  const freshGate = createCommercialAnswerReplyGate({
    request: { messageId, askSha256: hash(ask), input: { providerEvidence: correctReadback } },
    messageId,
    ask,
    historicalSystemPrompt,
  });
  const reassessedReply = freshGate.check(
    { text: nativeFinalReply },
    "final",
    false,
    repairedCaller,
  );
  const currentAudit = gateBuilderCalls.at(-1)!.output;
  expect(currentAudit.consumedEvidence.providerCouncil).toMatchObject({
    status: "verified",
    sourceSha256: correctReadback.sha256,
    semanticAdoption: "not_proven",
    reviewFeedbackUse: {
      priorRunId: firstCaller.runId,
      disposition: "reassessed",
      remainingGaps: [],
      resolvedGaps: ["provider_council_source_hash_conflict"],
    },
  });
  const reassessment = verifierCalls.findLast(
    (call) => call.output === currentAudit.consumedEvidence.providerCouncil,
  );
  expect(reassessment?.input[3]).toMatchObject({
    priorRunId: firstCaller.runId,
    sessionKey: firstCaller.sessionKey,
    replyChannelAccountId: firstCaller.replyChannelAccountId,
    gaps: ["provider_council_source_hash_conflict"],
  });
  expect(currentAudit.failedReasons).not.toContain(
    "provider_council_completion_without_verified_receipt",
  );
  expect(currentAudit.failedReasons.length).toBeGreaterThan(0);
  expect(reassessedReply.trace).toMatchObject({ decision: "blocked" });
  const reviewFeedbackHandoff = {
    firstCaller,
    firstRefusal,
    originalQueuedDiagnostics,
    historicalSystemPrompt,
    nextCaller,
    continuedRefusal,
    correctReadback,
    repairedCaller,
    reassessedReply,
    gateBuilderCalls,
  };
  expect(model.gateway).not.toHaveBeenCalled();
  expect(globalThis.fetch).not.toHaveBeenCalled();
  const proofDir = process.env.LCX_WATERFLOW_COUNCIL_SOURCE_PROOF_DIR ?? workspace;
  await fs.mkdir(proofDir, { recursive: true });
  const raw =
    JSON.stringify(
      {
        boundary:
          "original_council_orchestration_and_reader_with_explicit_model_transport_substitute",
        modelCalls: calls,
        modelResponses,
        reviewFeedbackHandoff,
        nativeFinalReply,
        originalArtifactBytes,
        artifact,
        readerInput,
        verifierCalls,
        terminal,
        rejectedInputs,
        sourceRegistryFactsObserved: false,
        outerReviewFeedbackConsumerObserved: true,
        semanticAdoption: "not_proven",
        providerCalls: 0,
        userVisibleObserved: false,
      },
      null,
      2,
    ) + "\n";
  const sha256 = createHash("sha256").update(raw).digest("hex");
  const proofPath = path.join(proofDir, `original-worker-source-${sha256}.json`);
  await fs.writeFile(proofPath, raw);
  const ref = (pointer: string) => ({ path: proofPath, sha256, pointer });
  const evidence: WorkflowHandoffEvidence[] = [
    {
      scenarioId: "provider_council_evidence_waterflow",
      environment: "offline_fixture",
      nodes: [
        {
          nodeId: "provider_evidence",
          scope: ref("/artifact/messageId"),
          output: ref("/originalArtifactBytes"),
        },
        {
          nodeId: "source_registry",
          scope: ref("/readerInput/messageId"),
          output: ref("/readerInput/sha256"),
          inputs: [{ from: "provider_evidence", value: ref("/readerInput/content") }],
        },
        {
          nodeId: "source_conflict_review",
          scope: ref(`/verifierCalls/${consumedIndex}/output/messageId`),
          output: ref(`/verifierCalls/${consumedIndex}/output`),
          inputs: [
            {
              from: "source_registry",
              value: ref(`/verifierCalls/${consumedIndex}/output/sourceSha256`),
            },
          ],
        },
        {
          nodeId: "review_panel",
          scope: ref("/terminal/consumedEvidence/providerCouncil/messageId"),
          output: ref("/terminal"),
          inputs: [
            {
              from: "source_conflict_review",
              value: ref("/terminal/consumedEvidence/providerCouncil"),
            },
          ],
        },
      ],
    },
  ];
  const audit = (await auditWorkflowHandoffs(evidence)).find(
    (entry) => entry.scenarioId === evidence[0].scenarioId,
  );
  expect(audit?.status).toBe("handoff_gap");
  expect(
    audit?.gaps.some((gap) => gap.reason === "consumer_did_not_receive_output:review_panel"),
  ).toBe(true);
  expect(
    audit?.gaps.some((gap) =>
      [
        "handoff_value_conflict:provider_evidence",
        "handoff_value_conflict:source_registry",
        "handoff_value_conflict:source_conflict_review",
      ].includes(gap.reason),
    ),
  ).toBe(false);
  await fs.writeFile(
    path.join(proofDir, "original-worker-fieldrefs-input.json"),
    JSON.stringify(evidence, null, 2) + "\n",
  );
  await fs.writeFile(
    path.join(proofDir, "original-worker-fieldrefs-audit.json"),
    JSON.stringify(audit, null, 2) + "\n",
  );
});

it("original acceleration caller sends real question requirements into all actual role requests", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "council-question-requirements-"));
  roots.push(workspace);
  vi.stubEnv("LCX_LEARNING_COUNCIL_TRANSPORT", "in-process");
  vi.stubEnv("OPENCLAW_LEARNING_COUNCIL_KIMI_MODEL", "moonshot/kimi-k2.6");
  vi.stubEnv("OPENCLAW_LEARNING_COUNCIL_MINIMAX_MODEL", "minimax-portal/MiniMax-M2.7");
  const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
  const calls: { message: string; sessionKey: string; extraSystemPrompt: string; model: string }[] =
    [];
  model.invoke.mockImplementation(async (input: (typeof calls)[number]) => {
    calls.push({ ...input });
    const slash = input.model.indexOf("/");
    return {
      payloads: [
        {
          text: "## Synthesis\n- Preserve bounded methods.\n## Extracted lessons\n- Retain original evidence.\n## Challenges\n- Do not promote a proposal by assertion.",
        },
      ],
      meta: {
        agentMeta: { provider: input.model.slice(0, slash), model: input.model.slice(slash + 1) },
      },
    };
  });
  const sourcePath = path.resolve(
    import.meta.dirname,
    "../../scripts/operator/lcx-provider-council-acceleration.ts",
  );
  const source = await fs.readFile(sourcePath, "utf8");
  const ast = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true);
  const declaration = ast.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === "runCouncil",
  );
  if (!declaration) {
    throw new Error("original acceleration runCouncil missing");
  }
  const plannerCalls: {
    ask: string;
    output: ReturnType<typeof planCommercialAnswerRequirements>;
  }[] = [];
  let received: Parameters<typeof runExternalLearningCouncil>[0] | undefined;
  const context = vm.createContext({
    process: { env: process.env },
    Date,
    createHash,
    loadConfig: () => ({
      agents: {
        defaults: { workspace, models: { "custom-api-deepseek-com/deepseek-v4-flash": {} } },
      },
    }),
    planCommercialAnswerRequirements: (ask: string) => {
      const output = planCommercialAnswerRequirements(ask);
      plannerCalls.push({ ask, output });
      return output;
    },
    runExternalLearningCouncil: (input: Parameters<typeof runExternalLearningCouncil>[0]) => {
      received = input;
      return runExternalLearningCouncil(input);
    },
  });
  const originalBody = declaration.getText(ast);
  const compiled = ts.transpileModule(`${originalBody}\nglobalThis.originalCaller=runCouncil;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  new vm.Script(compiled, { filename: sourcePath }).runInContext(context);
  const ask = "Kimi、MiniMax 多审一轮，研究最新金融来源与GitHub CLI可复用方法；不允许交易。";
  const response = await (
    context.originalCaller as (
      ask: string,
      options: { workspaceDir: string; routeAgentId: string },
      disabled: boolean,
    ) => Promise<{ messageId: string; text: string }>
  )(ask, { workspaceDir: workspace, routeAgentId: "main" }, false);
  const supplied = received;
  if (!supplied?.questionRequirements) {
    throw new Error("actual original caller omitted requirements");
  }
  const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const actualPlan = plannerCalls[0].output;
  expect(plannerCalls).toHaveLength(1);
  expect(plannerCalls[0].ask).toBe(ask);
  expect(supplied.questionRequirements).toEqual({
    askSha256: createHash("sha256").update(ask).digest("hex"),
    needs: actualPlan.needs
      .filter((need) => need.required)
      .map(({ id, reason }) => ({ id, reason })),
  });
  const bytes = await fs.readFile(
    path.join(workspace, buildLearningCouncilArtifactJsonRelativePath(response.messageId)),
  );
  const artifact = JSON.parse(bytes.toString("utf8")) as {
    processEvidence: {
      questionRequirements: NonNullable<
        ReturnType<typeof councilTesting.buildQuestionRequirementsContext>["evidence"]
      >;
      planningCalls: {
        callId: string;
        dispatchInput: { questionRequirementsContextSha256?: string };
        receivedInput: { sessionKey: string; questionRequirementsContextSha256?: string };
      }[];
    };
  };
  const evidence = artifact.processEvidence.questionRequirements;
  expect(evidence.status).toBe("provided");
  expect(evidence.receivedInputSha256).toBe(hash(supplied.questionRequirements));
  expect(evidence.inputSha256).toBe(hash(evidence.input));
  expect(evidence.inputBoundary).toBe("bounded_projection_not_complete_received_input");
  expect(calls).toHaveLength(4);
  for (const call of calls) {
    const match = call.extraSystemPrompt.match(
      /(\[LCX question requirements: advisory only; checks not completed; no source approval\][\s\S]*?\[\/LCX question requirements\])/u,
    );
    if (!match) {
      throw new Error("actual model request omitted bounded context");
    }
    expect(Buffer.byteLength(match[1], "utf8")).toBeLessThanOrEqual(1024);
    const contextPayload = JSON.parse(match[1].split("\n")[1]);
    expect(contextPayload.needs).toEqual(evidence.input.needs);
    expect(contextPayload.askSha256).toBe(supplied.questionRequirements.askSha256);
    const actualRole = artifact.processEvidence.planningCalls.find(
      (role) => role.receivedInput.sessionKey === call.sessionKey,
    );
    expect(actualRole?.receivedInput.questionRequirementsContextSha256).toBe(hash(match[1]));
    expect(actualRole?.dispatchInput.questionRequirementsContextSha256).toBe(hash(match[1]));
    expect(call.message).toBe(ask);
  }
  expect(network).not.toHaveBeenCalled();
  expect(model.gateway).not.toHaveBeenCalled();
  const retain = process.env.LCX_COUNCIL_QUESTION_REQUIREMENTS_PROOF_DIR;
  if (retain) {
    await fs.mkdir(retain, { recursive: true });
    await fs.writeFile(path.join(retain, "original-artifact.json"), bytes);
    await fs.writeFile(
      path.join(retain, "original-caller-ports.json"),
      JSON.stringify(
        {
          boundary:
            "original runCouncil body and pure planner delegated; private configuration and local model transport. Acceleration main/admission not executed, no natural adoption claim",
          sourcePath,
          sourceSha256: createHash("sha256").update(source).digest("hex"),
          originalBodySha256: createHash("sha256").update(originalBody).digest("hex"),
          plannerInput: {
            askSha256: supplied.questionRequirements.askSha256,
            decisionMode: "research_only_default",
          },
          plannerOutput: supplied.questionRequirements,
          councilReceived: supplied.questionRequirements,
          artifactSha256: createHash("sha256").update(bytes).digest("hex"),
          actualModelRequests: calls.map((call) => ({
            sessionKey: call.sessionKey,
            askSha256: createHash("sha256").update(call.message).digest("hex"),
            promptSha256: hash(call.extraSystemPrompt),
          })),
        },
        null,
        2,
      ) + "\n",
    );
  }
});

it("keeps absent requirements legacy and refuses mismatched ask context without model calls", async () => {
  const ask = "研究最新金融来源";
  const plan = planCommercialAnswerRequirements(ask);
  const request = {
    askSha256: createHash("sha256").update(ask).digest("hex"),
    needs: plan.needs.filter((need) => need.required).map(({ id, reason }) => ({ id, reason })),
  };
  expect(councilTesting.buildQuestionRequirementsContext(ask)).toEqual({
    context: "",
    evidence: undefined,
  });
  const rejected = councilTesting.buildQuestionRequirementsContext("不同问题", request);
  expect(rejected.context).toBe("");
  expect(rejected.evidence?.status).toBe("scope_conflict");
  const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const accepted = councilTesting.buildQuestionRequirementsContext(ask, request);
  for (const result of [accepted, rejected]) {
    if (!result.evidence) {
      throw new Error("original metadata missing");
    }
    expect(result.evidence.receivedInputSha256).toBe(hash(request));
    expect(result.evidence.inputSha256).toBe(hash(result.evidence.input));
    expect(result.evidence.inputBoundary).toBe("bounded_projection_not_complete_received_input");
  }
  const genuine = accepted.context;
  expect(councilTesting.questionRequirementsContextHash(`ask quote: ${genuine}`)).toBeUndefined();
  expect(
    councilTesting.questionRequirementsContextHash(`ask quote: ${genuine}`, genuine),
  ).toBeUndefined();
  expect(model.invoke).not.toHaveBeenCalled();
  expect(model.gateway).not.toHaveBeenCalled();
  const retained = process.env.LCX_COUNCIL_QUESTION_METADATA_PROOF_DIR;
  if (retained) {
    const caller = JSON.parse(
      await fs.readFile(path.join(retained, "original-caller-ports.json"), "utf8"),
    );
    const artifact = JSON.parse(
      await fs.readFile(path.join(retained, "original-artifact.json"), "utf8"),
    );
    const readback = councilTesting.buildQuestionRequirementsContext(
      artifact.userMessage,
      caller.plannerOutput,
    );
    expect(readback.evidence?.receivedInputSha256).toBe(hash(caller.plannerOutput));
    expect(readback.evidence?.inputSha256).toBe(hash(readback.evidence?.input));
    expect(readback.evidence?.contextSha256).toBe(
      artifact.processEvidence.questionRequirements.contextSha256,
    );
    await fs.writeFile(
      path.join(retained, "metadata-readback.json"),
      JSON.stringify(
        {
          boundary:
            "new pure original helper metadata; prior original role artifact and actual requests unchanged, no model rerun",
          receivedPacketSha256: hash(caller.plannerOutput),
          readback,
        },
        null,
        2,
      ) + "\n",
    );
  }
});
