import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  agentCommandMock: vi.fn(),
  createDefaultDepsMock: vi.fn(() => ({})),
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
      result: { payloads: [{ text: "  kimi says hi  " }] },
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
