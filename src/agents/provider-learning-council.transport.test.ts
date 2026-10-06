import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

import { buildLearningCouncilArtifactJsonRelativePath } from "../hooks/bundled/lobster-brain-registry.js";
import { resolveMinimaxDefaultTextModelId } from "./minimax-model-catalog.js";
import {
  __testing,
  resolveLearningCouncilTransport,
  resolveLearningCouncilDisabledRoles,
  runExternalLearningCouncil,
} from "./provider-learning-council.js";

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
    it("uses the configured replacement for a legacy role without claiming the old provider", async () => {
      vi.stubEnv("OPENCLAW_LEARNING_COUNCIL_KIMI_MODEL", "custom-api-deepseek-com/deepseek-v4-pro");
      const value = await run({
        payloads: [{ text: "answer" }],
        meta: {
          agentMeta: {
            provider: "custom-api-deepseek-com",
            model: "deepseek-v4-pro",
            sessionId: "fixture",
          },
        },
      });
      expect(value).toMatchObject({
        success: true,
        model: "custom-api-deepseek-com/deepseek-v4-pro",
        providerFamily: "custom-api-deepseek-com",
        requestedModelHealth: "healthy",
      });
      expect(value.heading).toBe("Synthesis (custom-api-deepseek-com/deepseek-v4-pro)");
    });
    it("keeps the same role usable with another configured API", async () => {
      vi.stubEnv("OPENCLAW_LEARNING_COUNCIL_KIMI_MODEL", "replacement-provider/reviewer-v1");
      const value = await run({
        payloads: [{ text: "answer" }],
        meta: {
          agentMeta: {
            provider: "replacement-provider",
            model: "reviewer-v1",
            sessionId: "fixture",
          },
        },
      });
      expect(value).toMatchObject({
        success: true,
        model: "replacement-provider/reviewer-v1",
        providerFamily: "replacement-provider",
        requestedModelHealth: "healthy",
      });
      expect(value.heading).toBe("Synthesis (replacement-provider/reviewer-v1)");
    });
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

describe("council visible evidence labels", () => {
  const role = (name: "kimi" | "deepseek", health: "healthy" | "mismatched" | "unknown") => ({
    role: name,
    capability: "synthesis" as const,
    model: "requested/model",
    providerFamily: "requested",
    heading: name,
    success: true,
    text: "usable content",
    requestedModelHealth: health,
    ...(health === "unknown"
      ? {}
      : {
          actualProvider: health === "healthy" ? "requested" : "replacement",
          actualModel: "model",
        }),
  });
  it("describes only attempted role outputs when MiniMax is disabled", () => {
    const lead = __testing.renderLearningCouncilReadableLead({
      userMessage: "fixture",
      status: "full",
      roles: [role("kimi", "healthy"), role("deepseek", "healthy")],
      rescues: [],
      mutableFactWarnings: [],
      sourceCoverageWarnings: [],
    });
    expect(lead).toContain("本轮角色产出：kimi、deepseek");
    expect(lead).not.toContain("三模型");
    expect(lead).not.toContain("minimax");
  });
  it("keeps fallback content useful while stating unproven requested-model health", () => {
    const lead = __testing.renderLearningCouncilReadableLead({
      userMessage: "fixture",
      status: "full",
      roles: [role("kimi", "mismatched"), role("deepseek", "unknown")],
      rescues: [],
      mutableFactWarnings: [],
      sourceCoverageWarnings: [],
    });
    expect(lead).toContain("本轮角色产出：kimi、deepseek");
    expect(lead).toContain("替代模型 replacement/model");
    expect(lead).toContain("deepseek: 请求模型健康未证实 (unknown)");
  });
  it("labels review inputs with actual model or unknown rather than requested configuration", () => {
    const prompt = __testing.buildMiniMaxSystemPrompt({
      userMessage: "fixture",
      kimiText: "usable",
      kimiModel: __testing.actualCouncilModel(role("kimi", "mismatched")),
      deepseekText: "usable",
      deepseekModel: __testing.actualCouncilModel(role("deepseek", "unknown")),
    });
    expect(prompt).toContain("runtime model: replacement/model");
    expect(prompt).toContain("runtime model: unknown");
    expect(prompt).not.toContain("requested/model");
  });
});

describe("council optional role retirement", () => {
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_LEARNING_COUNCIL_KIMI_MODEL", "");
    vi.stubEnv("OPENCLAW_LEARNING_COUNCIL_MINIMAX_MODEL", "");
    vi.stubEnv("LCX_LEARNING_COUNCIL_TRANSPORT", "in-process");
    hoisted.agentCommandMock.mockReset();
    hoisted.gatewayMock.mockReset();
  });
  const cfg = {
    agents: { defaults: { models: { "custom-api-deepseek-com/deepseek-v4-flash": {} } } },
  };
  it("retires unselected Kimi and MiniMax roles", () => {
    expect(resolveLearningCouncilDisabledRoles(cfg)).toEqual(["kimi", "minimax"]);
  });
  it.each(["moonshot/kimi-k2.6", "moonshot/kimi-k2.5"])(
    "keeps explicitly allowed Kimi %s",
    (model) => {
      expect(
        resolveLearningCouncilDisabledRoles({ agents: { defaults: { models: { [model]: {} } } } }),
      ).toEqual(["minimax"]);
    },
  );
  it.each(["minimax", "minimax-portal"])("keeps explicitly allowed %s", (provider) => {
    expect(
      resolveLearningCouncilDisabledRoles({
        agents: {
          defaults: { models: { [`${provider}/${resolveMinimaxDefaultTextModelId()}`]: {} } },
        },
      }),
    ).toEqual(["kimi"]);
  });
  it("keeps trusted replacement overrides ahead of the allowlist", () => {
    vi.stubEnv("OPENCLAW_LEARNING_COUNCIL_KIMI_MODEL", "replacement/synthesis");
    vi.stubEnv("OPENCLAW_LEARNING_COUNCIL_MINIMAX_MODEL", "replacement/challenge");
    expect(resolveLearningCouncilDisabledRoles(cfg)).toEqual([]);
  });
  it("never resolves the retired Kimi fallback on a direct role attempt", async () => {
    await expect(__testing.runLearningCouncilRole({ ...roleParams, cfg })).rejects.toThrow(
      /retired/u,
    );
    expect(hoisted.agentCommandMock).not.toHaveBeenCalled();
  });
  it("executes only the selected extraction model and records retired roles as skipped", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "council-retirement-"));
    try {
      hoisted.agentCommandMock.mockResolvedValue({
        payloads: [{ text: "fixture answer" }],
        meta: { agentMeta: { provider: "custom-api-deepseek-com", model: "deepseek-v4-flash" } },
      });
      const reply = await runExternalLearningCouncil({
        cfg,
        userMessage: "fixture",
        routeAgentId: "main",
        sessionKey: "fixture",
        messageId: "retirement",
        workspaceDir,
      });
      expect(hoisted.agentCommandMock).toHaveBeenCalledTimes(1);
      expect(hoisted.agentCommandMock.mock.calls[0]?.[0]).toMatchObject({
        model: "custom-api-deepseek-com/deepseek-v4-flash",
      });
      expect(hoisted.gatewayMock).not.toHaveBeenCalled();
      expect(reply).toContain("本轮角色产出：deepseek；失败或未完成：无");
      const artifact = JSON.parse(
        await fs.readFile(
          path.join(workspaceDir, buildLearningCouncilArtifactJsonRelativePath("retirement")),
          "utf8",
        ),
      ) as {
        status: string;
        skippedRoles: Array<{ role: string }>;
        roles: Array<{ role: string }>;
        rescues: unknown[];
      };
      expect(artifact.status).toBe("full");
      expect(artifact.skippedRoles.map((entry) => entry.role)).toEqual(["kimi", "minimax"]);
      expect(artifact.roles.map((entry) => entry.role)).toEqual(["deepseek"]);
      expect(artifact.rescues).toEqual([]);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });
});
