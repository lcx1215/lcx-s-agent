import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  agentCommandMock: vi.fn(),
  gatewayMock: vi.fn(),
  createDefaultDepsMock: vi.fn(() => ({})),
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: (...args: unknown[]) => hoisted.gatewayMock(...args),
  randomIdempotencyKey: () => "fixture-key",
}));

vi.mock("../commands/agent.js", () => ({
  agentCommand: (...args: unknown[]) => hoisted.agentCommandMock(...args),
}));

vi.mock("../cli/deps.js", () => ({
  createDefaultDeps: () => hoisted.createDefaultDepsMock(),
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: { log: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { __testing, resolveLearningCouncilTransport } from "./provider-learning-council.js";

describe("learning council transport", () => {
  beforeEach(() => {
    hoisted.agentCommandMock.mockReset();
    hoisted.createDefaultDepsMock.mockClear();
  });

  it("defaults to the in-process agent loop", () => {
    expect(resolveLearningCouncilTransport({})).toBe("in-process");
  });

  it("accepts explicit aliases for both transports", () => {
    expect(resolveLearningCouncilTransport({ LCX_LEARNING_COUNCIL_TRANSPORT: "local" })).toBe(
      "in-process",
    );
    expect(resolveLearningCouncilTransport({ LCX_LEARNING_COUNCIL_TRANSPORT: "in-process" })).toBe(
      "in-process",
    );
    expect(resolveLearningCouncilTransport({ LCX_LEARNING_COUNCIL_TRANSPORT: "gateway" })).toBe(
      "gateway",
    );
    expect(resolveLearningCouncilTransport({ LCX_LEARNING_COUNCIL_TRANSPORT: "ws" })).toBe(
      "gateway",
    );
  });

  it("rejects an unknown transport instead of silently picking one", () => {
    expect(() =>
      resolveLearningCouncilTransport({ LCX_LEARNING_COUNCIL_TRANSPORT: "grpc" }),
    ).toThrow(/LCX_LEARNING_COUNCIL_TRANSPORT/u);
  });

  it("shapes the in-process agent result like the gateway agent response", async () => {
    hoisted.agentCommandMock.mockResolvedValue({
      payloads: [{ text: "  kimi says hi  " }, { text: "   " }, {}],
      meta: { durationMs: 1 },
    });

    const response = await __testing.runLearningCouncilRoleInProcess({
      agentId: "main",
      sessionKey: "learning-council:main:kimi",
      message: "hello",
      model: "moonshot/kimi-k2.6",
      thinking: "off",
      timeoutSeconds: 900,
      extraSystemPrompt: "be brief",
    });

    expect(response).toEqual({
      status: "ok",
      summary: "completed",
      result: {
        payloads: [{ text: "  kimi says hi  " }, { text: "   " }, {}],
        meta: { durationMs: 1 },
      },
    });
    expect(hoisted.agentCommandMock).toHaveBeenCalledTimes(1);
    const [opts] = hoisted.agentCommandMock.mock.calls[0] as [Record<string, unknown>];
    expect(opts).toMatchObject({
      message: "hello",
      agentId: "main",
      sessionKey: "learning-council:main:kimi",
      model: "moonshot/kimi-k2.6",
      lane: "learning-council",
      timeout: "900",
      extraSystemPrompt: "be brief",
      senderIsOwner: false,
    });
  });

  it("reports an empty payload list instead of inventing text", async () => {
    hoisted.agentCommandMock.mockResolvedValue({ payloads: [], meta: {} });

    const response = await __testing.runLearningCouncilRoleInProcess({
      agentId: "main",
      sessionKey: "learning-council:main:deepseek",
      message: "hello",
      model: "custom-api-deepseek-com/deepseek-v4-flash",
      thinking: "off",
      timeoutSeconds: 900,
      extraSystemPrompt: "",
    });

    expect(response.result?.payloads).toEqual([]);
  });
});

const agentMeta = { provider: "moonshot", model: "kimi-k2.6", sessionId: "fixture" };
const roleParams = {
  cfg: { agents: { defaults: { models: { "moonshot/kimi-k2.6": {} } } } },
  role: "kimi" as const,
  userMessage: "synthetic",
  routeAgentId: "main",
  baseSessionKey: "fixture",
  timeoutSeconds: 1,
  thinking: "off" as const,
  extraSystemPrompt: "",
};

describe.each(["in-process", "gateway"] as const)(
  "council result evidence over %s",
  (transport) => {
    beforeEach(() => {
      vi.stubEnv("OPENCLAW_LEARNING_COUNCIL_KIMI_MODEL", "");
    });
    async function run(result: unknown, status = "ok", summary = "completed") {
      hoisted.agentCommandMock.mockResolvedValue(result);
      hoisted.gatewayMock.mockResolvedValue({ status, summary, result });
      return __testing.runLearningCouncilRole({ ...roleParams, transport });
    }
    it("reports actual matching model and valid answer as healthy", async () => {
      const value = await run({ payloads: [{ text: "answer" }], meta: { agentMeta } });
      expect(value).toMatchObject({
        success: true,
        text: "answer",
        actualProvider: "moonshot",
        actualModel: "kimi-k2.6",
        requestedModelHealth: "healthy",
      });
    });
    it.each([
      { payloads: [{ text: "provider exploded", isError: true }], meta: { agentMeta } },
      {
        payloads: [{ text: "answer" }],
        meta: { agentMeta, error: { kind: "retry_limit", message: "failed" } },
      },
      { payloads: [{ text: "answer" }], meta: { agentMeta, stopReason: "error" } },
      { payloads: [{ text: "answer" }], meta: { agentMeta, timedOut: true } },
      { payloads: [{ text: "answer" }], meta: { agentMeta, aborted: true } },
      {
        payloads: [{ text: "answer" }],
        meta: { agentMeta, pendingToolCalls: [{ id: "1", name: "tool", arguments: "{}" }] },
      },
      { payloads: [{ text: "answer" }], meta: { agentMeta, stopReason: "tool_calls" } },
      { payloads: [] },
    ])("rejects nonfinal/error/empty output %#", async (result) => {
      expect(await run(result)).toMatchObject({ success: false, text: "" });
    });
    it("accepts only the completed-prompt compaction timeout exception", async () => {
      const meta = {
        agentMeta,
        timedOut: true,
        aborted: true,
        timedOutDuringCompaction: true,
        promptCompleted: true,
      };
      expect(await run({ payloads: [{ text: "answer" }], meta })).toMatchObject({ success: true });
      expect(
        await run({ payloads: [{ text: "answer" }], meta: { ...meta, promptCompleted: false } }),
      ).toMatchObject({ success: false });
      expect(await run({ payloads: [{ text: "error", isError: true }], meta })).toMatchObject({
        success: false,
      });
      expect(
        await run({
          payloads: [{ text: "answer" }],
          meta: { ...meta, error: { kind: "retry_limit", message: "failed" } },
        }),
      ).toMatchObject({ success: false });
    });
    it("records fallback separately from requested model health", async () => {
      expect(
        await run({
          payloads: [{ text: "answer" }],
          meta: { agentMeta: { ...agentMeta, provider: "different", model: "fallback" } },
        }),
      ).toMatchObject({
        success: true,
        model: "moonshot/kimi-k2.6",
        actualProvider: "different",
        actualModel: "fallback",
        requestedModelHealth: "mismatched",
      });
    });
    it("does not invent model identity without runtime metadata", async () => {
      expect(await run({ payloads: [{ text: "answer" }] })).toMatchObject({
        success: true,
        requestedModelHealth: "unknown",
        actualProvider: undefined,
        actualModel: undefined,
      });
    });
  },
);

it("requires gateway ok status and never uses its control summary as answer text", async () => {
  hoisted.gatewayMock.mockResolvedValue({
    status: "error",
    result: { payloads: [{ text: "answer" }] },
  });
  expect(
    await __testing.runLearningCouncilRole({ ...roleParams, transport: "gateway" }),
  ).toMatchObject({ success: false });
  hoisted.gatewayMock.mockResolvedValue({ status: "ok", summary: "completed" });
  expect(
    await __testing.runLearningCouncilRole({ ...roleParams, transport: "gateway" }),
  ).toMatchObject({ success: false, text: "" });
});

afterEach(() => {
  vi.unstubAllEnvs();
});
