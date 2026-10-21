import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildPipelineResult } from "../scripts/operator/lcx-commercial-answer-pipeline.js";
import {
  auditWorkflowHandoffs,
  type WorkflowHandoffEvidence,
} from "../scripts/operator/lcx-flow-graph.js";
import * as visibleGateOwner from "../src/agents/visible-answer-adoption-gate.js";
import { applyVisibleAnswerAdoptionGate } from "../src/agents/visible-answer-adoption-gate.js";
import { resetInboundDedupe } from "../src/auto-reply/reply/inbound-dedupe.js";
import { resetSystemEventsForTest } from "../src/infra/system-events.js";
import { probeOriginalLanguageReply } from "./fixtures/lcx-waterflow-language-probe.js";

const model = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../src/agents/pi-embedded-runner/run.js", () => ({
  runEmbeddedPiAgent: (params: unknown) => model.invoke(params),
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
vi.mock("../src/shared/global-evidence-projection-source.js", () => ({
  readCanonicalGlobalEvidenceProjectionCandidate: async () => null,
}));
const roots: string[] = [];
afterEach(async () => {
  resetInboundDedupe();
  resetSystemEventsForTest();
  model.invoke.mockReset();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function run(
  candidate: string,
  options: {
    ask?: string;
    queued?: boolean;
    partials?: string[];
    blocks?: string[];
    aborted?: boolean;
    timedOut?: boolean;
    mediaUrl?: string;
    flushBlocks?: boolean;
  } = {},
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-language-native-"));
  roots.push(root);
  const receiver: Array<Record<string, unknown>> = [];
  const workerInputs: Array<{ prompt?: string }> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    if (typeof init?.body !== "string") {
      throw new Error("original sender JSON body required");
    }
    receiver.push(JSON.parse(init.body) as Record<string, unknown>);
    return new Response("", { status: 200 });
  });
  const nativePresentationCalls: Array<{
    input: Parameters<typeof applyVisibleAnswerAdoptionGate>[0];
    output: ReturnType<typeof applyVisibleAnswerAdoptionGate>;
  }> = [];
  const originalGate = visibleGateOwner.applyVisibleAnswerAdoptionGate;
  vi.spyOn(visibleGateOwner, "applyVisibleAnswerAdoptionGate").mockImplementation((input) => {
    const output = originalGate(input);
    if (input.presentationOnly) {
      nativePresentationCalls.push({
        input: structuredClone(input),
        output: structuredClone(output),
      });
    }
    return output;
  });
  const partialReceiver: string[] = [];
  const controller = new AbortController();
  if (options.aborted) {
    controller.abort();
  }
  model.invoke.mockImplementation(
    async (input: {
      prompt?: string;
      onPartialReply?: (payload: { text: string }) => Promise<void>;
      onBlockReply?: (payload: { text: string }) => Promise<void>;
      onBlockReplyFlush?: () => Promise<void>;
    }) => {
      workerInputs.push({ prompt: input.prompt });
      for (const text of options.partials ?? []) {
        await input.onPartialReply?.({ text });
      }
      for (const text of options.blocks ?? []) {
        await input.onBlockReply?.({ text });
        if (options.flushBlocks !== false) {
          await input.onBlockReplyFlush?.();
        }
      }
      return {
        payloads: [
          { text: candidate, ...(options.mediaUrl ? { mediaUrl: options.mediaUrl } : {}) },
        ],
        meta: { agentMeta: { provider: "anthropic", model: "claude" }, timedOut: options.timedOut },
      };
    },
  );
  const probe = await probeOriginalLanguageReply(root, undefined, {
    ask: options.ask,
    queued: options.queued,
    abortSignal: controller.signal,
    onPartialReply: (payload) => {
      partialReceiver.push(payload.text ?? "");
    },
  });
  const ingress = await probe.submit(probe.message);
  const pipeline = buildPipelineResult(probe.message.text, candidate);
  const gate = applyVisibleAnswerAdoptionGate({
    userMessage: probe.message.text,
    answerText: candidate,
  });
  return {
    root,
    probe,
    ingress,
    workerInputs,
    receiver,
    pipeline,
    gate,
    candidate,
    partialReceiver,
    nativePresentationCalls,
  };
}

async function retain(name: string, sample: Awaited<ReturnType<typeof run>>) {
  const proofDir = process.env.LCX_WATERFLOW_LANGUAGE_PROOF_DIR ?? sample.root;
  await fs.mkdir(proofDir, { recursive: true });
  const proof = {
    boundary: "offline_original_reply_worker_model_and_receiver_substitutes",
    ingress: sample.ingress,
    resolverInput: sample.probe.inputs[0],
    workerInput: sample.workerInputs[0],
    candidate: sample.candidate,
    originalReplyResult: sample.probe.replyResults[0],
    dispatcherResult: sample.probe.dispatchResults[0],
    receiverRequest: sample.receiver[0],
    partialReceiver: sample.partialReceiver,
    nativePresentationCalls: sample.nativePresentationCalls,
    sessionWrite: sample.probe.sessionWrites[0],
    statusPatches: sample.probe.statusPatches,
    independentlyExecutedPipeline: sample.pipeline,
    independentlyExecutedGate: sample.gate,
    userVisibleObserved: false,
    feedbackConsumedByOriginalWorker: false,
  };
  const raw = JSON.stringify(proof, null, 2) + "\n";
  const sha256 = createHash("sha256").update(raw).digest("hex");
  const artifact = path.join(proofDir, `${name}-${sha256}.json`);
  await fs.writeFile(artifact, raw);
  const ref = (pointer: string) => ({ path: artifact, pointer, sha256 });
  const evidence: WorkflowHandoffEvidence[] = [
    {
      scenarioId: "external_visible_language_waterflow",
      environment: "offline_fixture",
      nodes: [
        {
          nodeId: "visible_answer_adoption_gate",
          scope: ref("/resolverInput/MessageSid"),
          output: ref("/nativePresentationCalls/0/output/text"),
        },
        {
          nodeId: "reply_flow_audit",
          scope: ref("/resolverInput/MessageSid"),
          output: ref("/originalReplyResult"),
          inputs: [
            { from: "visible_answer_adoption_gate", value: ref("/originalReplyResult/text") },
          ],
        },
      ],
    },
  ];
  const audit = (await auditWorkflowHandoffs(evidence)).filter(
    (entry) => entry.scenarioId === "external_visible_language_waterflow",
  );
  await fs.writeFile(
    path.join(proofDir, `${name}-fieldrefs-input.json`),
    JSON.stringify(evidence, null, 2) + "\n",
  );
  await fs.writeFile(
    path.join(proofDir, `${name}-fieldrefs-audit.json`),
    JSON.stringify(audit, null, 2) + "\n",
  );
  return audit;
}

describe("original external language reply consumer", () => {
  it("consumes the shared presentation normalizer through the actual reply worker, original dispatch and receiver", async () => {
    const sample = await run("100 的 10% 是 10。\n分发状态：已完成。");
    expect(sample.ingress.statusCode).toBe(202);
    expect(sample.workerInputs).toHaveLength(1);
    expect(sample.workerInputs[0].prompt).toContain(sample.probe.message.text);
    expect(sample.receiver).toHaveLength(1);
    expect(sample.receiver[0].text).toBe(sample.gate.text);
    expect(sample.gate.status).toBe("adopted");
    expect(sample.gate.text).toBe("100 的 10% 是 10。");
    expect(sample.receiver[0].text).not.toBe(sample.candidate);
    expect(sample.pipeline.visibleAnswerGate.status).toBe("adopted");
    expect(sample.pipeline.visibleAnswerGate).not.toHaveProperty("text");
    const audit = await retain("consumed-normalization-after", sample);
    expect(audit).toHaveLength(1);
    expect(audit[0].status).toBe("handoff_gap");
    expect(
      audit[0].gaps.some(
        (gap) =>
          gap.node === "reply_flow_audit" && gap.reason.includes("visible_answer_adoption_gate"),
      ),
    ).toBe(false);
    expect(sample.nativePresentationCalls).toHaveLength(1);
    expect(sample.nativePresentationCalls[0].input.answerText).toBe(sample.candidate);
    expect(sample.nativePresentationCalls[0].output.text).toBe(sample.receiver[0].text);
  });
  it("consumes the existing internal-detail failure and prevents the rejected candidate reaching the receiver", async () => {
    const sample = await run("control_room: 当前可用能力，answer_audit：通过。");
    expect(sample.gate.status).toBe("replaced");
    expect(sample.pipeline.terminalDecision).toBe("return_failed_reason");
    expect(sample.receiver[0].text).not.toBe(sample.candidate);
    expect(sample.receiver[0].text).toBe(sample.gate.text);
    expect(sample.probe.errors).toEqual([]);
    await retain("consumed-refusal-after", sample);
  });
  it("retains a normal direct answer through actual reply worker and does not manufacture a language workflow receipt", async () => {
    const sample = await run("100 的 10% 是 10。");
    expect(sample.receiver[0].text).toBe(sample.gate.text);
    expect(sample.probe.dispatchResults).toEqual([
      { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } },
    ]);
    expect(sample.probe.statusPatches).toEqual([
      { lastInboundAt: expect.any(Number) },
      { lastOutboundAt: expect.any(Number) },
    ]);
    await retain("normal-direct-answer-after", sample);
  });
  it.each([false, true])("uses the original queued outlet=%s presentation gate", async (queued) => {
    const sample = await run("100 的 10% 是 10。\n分发状态：已完成。", { queued });
    expect(sample.receiver.map((value) => value.text)).toEqual(["100 的 10% 是 10。"]);
    if (queued) {
      expect(sample.probe.replyResults).toEqual([]);
    }
  });
  it("keeps partial snapshots clean and buffers split internal prefixes before they reach the callback", async () => {
    const sample = await run("100 的 10% 是 10。\n分发状态：完成。", {
      partials: [
        "100 的 10% 是 10。",
        "100 的 10% 是 10。\n分发",
        "100 的 10% 是 10。\n分发状态：完成。",
      ],
    });
    expect(sample.partialReceiver).toEqual([
      "100 的 10% 是 10。",
      "100 的 10% 是 10。",
      "100 的 10% 是 10。",
    ]);
    expect(sample.receiver[0].text).toBe("100 的 10% 是 10。");
  });
  it("does not duplicate already dispatched clean text when block chunks contain a split internal tail", async () => {
    const sample = await run("", { blocks: ["100 的 10% 是 10。", "\n分发", "状态：完成。"] });
    expect(sample.receiver.map((value) => value.text)).toEqual(["100 的 10% 是 10。"]);
  });
  it.each([false, true])(
    "does not let split unsafe labels escape in queued=%s output",
    async (queued) => {
      const sample = await run("control_room: 当前可用能力，answer_audit：通过。", {
        queued,
        partials: ["control_", "control_room: 当前可用能力，answer_audit：通过。"],
        blocks: queued ? [] : ["control_", "room: 当前可用能力，answer_audit：通过。"],
      });
      expect(sample.partialReceiver).not.toContain("control_");
      expect(sample.receiver.every((value) => !String(value.text).includes("control_room"))).toBe(
        true,
      );
    },
  );
  it.each([
    ["现在的持仓需要关注什么？", "现有持仓先检查集中度、期限和融资情况。"],
    [
      "请说明 control_room 和 answer_audit 的技术接口",
      "control_room 和 answer_audit 是原有接口标签。",
    ],
  ])(
    "preserves sufficient ordinary research or explicit technical truth: %s",
    async (ask, candidate) => {
      const sample = await run(candidate, { ask });
      expect(sample.receiver[0].text).toBe(candidate);
    },
  );
  it.each(["aborted", "timedOut"] as const)(
    "retains council failure after %s instead of accepting a late completion claim",
    async (failure) => {
      const candidate = "Kimi、MiniMax、DeepSeek 已完成独立审阅。";
      const sample = await run(candidate, { [failure]: true });
      expect(sample.receiver.every((value) => value.text !== candidate)).toBe(true);
      expect(sample.receiver.map((value) => value.text).join(" ")).toContain("无法核实");
    },
  );
  it("keeps original protocol and source-required truth surfaces instead of inventing success", async () => {
    const candidate = "外部通道验收请求已识别。必须看同一轮外部通道入站和出站回执；目前未确认。";
    const sample = await run(candidate, { ask: "核对外部通道真实链路验收" });
    expect(sample.receiver[0].text).toBe(candidate);
    const source = applyVisibleAnswerAdoptionGate({
      presentationOnly: true,
      userMessage: "没有来源时只说失败原因、下一步、边界和证据。",
      answerText:
        "失败原因: 没有提供链接、本地文件或完整来源\n下一步: 先给 URL 或本地路径\n边界: 不搜索、不抓取、不学习\n证据: source-required test",
    });
    expect(source.status).toBe("adopted");
    expect(source.text).toContain("没有提供链接");
  });
  it("keeps media-only payloads on the original sender seam", async () => {
    const sample = await run("", { mediaUrl: "https://93.184.216.34/offline.png" });
    expect(sample.receiver[0].mediaUrls).toEqual(["https://93.184.216.34/offline.png"]);
  });
  it("buffers split work-order JSON and uses original presentation failure, while ordinary JSON stays allowed", async () => {
    const sample = await run("", {
      ask: "直接给结果，不要暴露内部 JSON。",
      blocks: ["{", '"work_order":"internal"}'],
    });
    expect(sample.receiver.map((value) => value.text).join(" ")).not.toContain("work_order");
    expect(sample.receiver.map((value) => value.text).join(" ")).toContain("候选回答不能采用");
    const decision = applyVisibleAnswerAdoptionGate({
      presentationOnly: true,
      streaming: true,
      userMessage: "返回示例 JSON",
      answerText: '{"value":10}',
    });
    expect(decision.text).toBe('{"value":10}');
  });
  it("keeps long block delivery incremental beyond the existing 12KB context window", async () => {
    const chunks = ["甲".repeat(8000), "乙".repeat(8000), "丙".repeat(100)];
    const sample = await run("", { ask: "输出正文", blocks: chunks });
    const sentText = sample.receiver.map((value) => String(value.text)).join("");
    expect(sentText).toBe(chunks.join(""));
    expect(
      sample.nativePresentationCalls.every(
        (call) => (call.output.pendingText?.length ?? 0) <= 12 * 1024,
      ),
    ).toBe(true);
    const held = applyVisibleAnswerAdoptionGate({
      userMessage: "不要暴露内部标签",
      answerText: "control_" + " ".repeat(20000),
      presentationOnly: true,
      streaming: true,
    });
    expect(held.text).toBe("");
    expect(held.pendingText?.length).toBeLessThanOrEqual(12 * 1024);
  });
  it("checks internal labels split by the original coalescer before dispatching any prefix", async () => {
    const sample = await run("", { blocks: ["control_", "room: ready"], flushBlocks: false });
    expect(sample.receiver).toHaveLength(1);
    expect(sample.receiver[0].text).not.toContain("control_");
    expect(sample.receiver[0].text).toContain("候选回答不能采用");
  });
});
