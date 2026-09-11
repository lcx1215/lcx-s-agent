import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  createConfiguredFinanceModelAdapter,
  resolveConfiguredFinanceAuth,
} from "./configured-finance-model-adapter.js";
import type { ModelCallRequest } from "./logical-agent-model-router.js";
const cfg: OpenClawConfig = {
  agents: { defaults: { model: { primary: "fixture/selected" } } },
  models: {
    providers: {
      fixture: {
        api: "openai-completions",
        baseUrl: "https://fixture.invalid/v1",
        apiKey: "fixture-credential",
        models: [
          {
            id: "selected",
            name: "Selected",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 32000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
};
const request: ModelCallRequest = {
  callId: "call",
  correlationId: "run",
  taskId: "research_draft",
  role: "research_draft",
  attempt: 1,
  provider: "fixture",
  modelId: "selected",
  payload: {
    schemaVersion: 1,
    runId: "run",
    attempt: 1,
    stage: "draft",
    agentId: "research_draft",
    task: "Compare the evidence",
    evidence: [{ id: "e1", text: "A 5% price return at 2026-09-09" }],
    sharedContext: {},
    dependencyOutputs: {},
    repairFeedback: [],
    instructions: "Cite e1",
  },
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
describe("configured research model transport", () => {
  it("reads static auth profiles and environment references without modifying the store", async () => {
    const profileCfg = structuredClone(cfg);
    delete profileCfg.models!.providers!.fixture.apiKey;
    const store = {
      version: 1,
      profiles: {
        "fixture:default": {
          type: "api_key" as const,
          provider: "fixture",
          key: "stored-fixture-key",
        },
      },
      usageStats: { "fixture:default": { cooldownUntil: 1 } },
    };
    const before = JSON.stringify(store);
    await expect(resolveConfiguredFinanceAuth(profileCfg, "fixture", store)).resolves.toEqual({
      apiKey: "stored-fixture-key",
      source: "auth_profile",
    });
    expect(JSON.stringify(store)).toBe(before);
    vi.stubEnv("LCX_TEST_FINANCE_KEY", "env-fixture-key");
    await expect(
      resolveConfiguredFinanceAuth(profileCfg, "fixture", {
        version: 1,
        profiles: {
          "fixture:env": {
            type: "api_key",
            provider: "fixture",
            keyRef: { source: "env", provider: "default", id: "LCX_TEST_FINANCE_KEY" },
          },
        },
      }),
    ).resolves.toEqual({ apiKey: "env-fixture-key", source: "auth_profile" });
  });
  it("does not borrow another provider key or refresh an OAuth profile", async () => {
    const profileCfg = structuredClone(cfg);
    delete profileCfg.models!.providers!.fixture.apiKey;
    const store = {
      version: 1,
      profiles: {
        wrong: { type: "api_key" as const, provider: "other", key: "wrong-key" },
        oauth: {
          type: "oauth" as const,
          provider: "fixture",
          access: "expired",
          refresh: "do-not-refresh",
          expires: 1,
        },
      },
    };
    const http = vi.fn();
    vi.stubGlobal("fetch", http);
    await expect(resolveConfiguredFinanceAuth(profileCfg, "fixture", store)).rejects.toThrow(
      "provider_auth",
    );
    expect(http).not.toHaveBeenCalled();
  });

  it("uses only the selected existing configuration and enforces a shared call budget", async () => {
    const http = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: "server-response",
            choices: [
              {
                finish_reason: "stop",
                message: { content: '{"kind":"plan","requirements":["e1"],"missingEvidence":[]}' },
              },
            ],
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", http);
    const before = JSON.stringify(cfg),
      adapter = createConfiguredFinanceModelAdapter(cfg, { maxCalls: 1 });
    expect(http).not.toHaveBeenCalled();
    await adapter.invoke(request, new AbortController().signal);
    expect(http).toHaveBeenCalledWith(
      "https://fixture.invalid/v1/chat/completions",
      expect.objectContaining({ method: "POST", redirect: "error" }),
    );
    expect(adapter.observe?.(request)?.transportRequestId).toBe("server-response");
    await expect(
      adapter.invoke({ ...request, callId: "second" }, new AbortController().signal),
    ).rejects.toThrow("call_budget_exhausted");
    expect(http).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(cfg)).toBe(before);
  });
  it("reserves at most one call when concurrent callers await credentials", async () => {
    const http = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: "concurrent",
            choices: [{ finish_reason: "stop", message: { content: "{}" } }],
          }),
        ),
    );
    vi.stubGlobal("fetch", http);
    const adapter = createConfiguredFinanceModelAdapter(cfg, { maxCalls: 1 });
    const outcomes = await Promise.allSettled(
      [1, 2].map((n) =>
        adapter.invoke({ ...request, callId: `concurrent-${n}` }, new AbortController().signal),
      ),
    );
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(http).toHaveBeenCalledTimes(1);
  });
  it("applies an explicit bounded role effort only to a supported transport", async () => {
    const supportedCfg = structuredClone(cfg);
    supportedCfg.models!.providers!.fixture.models[0].compat = { supportsReasoningEffort: true };
    const efforts: unknown[] = [];
    const http = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (typeof init?.body !== "string") {
        throw new Error("expected JSON request body");
      }
      const body = JSON.parse(init.body) as { reasoning_effort?: unknown };
      efforts.push(body.reasoning_effort);
      return new Response(
        JSON.stringify({
          id: "effort",
          choices: [{ finish_reason: "stop", message: { content: "{}" } }],
        }),
      );
    });
    vi.stubGlobal("fetch", http);
    const options = { reasoningEffortByRole: { research_draft: "low" as const } };
    const supported = createConfiguredFinanceModelAdapter(supportedCfg, options);
    await supported.invoke(request, new AbortController().signal);
    expect(efforts[0]).toBe("low");
    expect(supported.observe?.(request)?.reasoningEffort).toBe("low");
    const unsupported = createConfiguredFinanceModelAdapter(cfg, options);
    await unsupported.invoke(request, new AbortController().signal);
    expect(efforts[1]).toBeUndefined();
  });
  it("retains safe auth failure classification without persisting server error text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("fixture-sensitive-error", { status: 401 })),
    );
    const adapter = createConfiguredFinanceModelAdapter(cfg);
    await expect(adapter.invoke(request, new AbortController().signal)).rejects.toThrow(
      "provider_auth",
    );
    expect(adapter.observe?.(request)).toBeUndefined();
  });
  it("records transport separately from truncated output", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              id: "transport-only",
              choices: [{ finish_reason: "length", message: { content: '{"kind":' } }],
            }),
            { status: 200 },
          ),
      ),
    );
    const adapter = createConfiguredFinanceModelAdapter(cfg);
    await expect(adapter.invoke(request, new AbortController().signal)).rejects.toThrow(
      "output_truncated",
    );
    expect(adapter.observe?.(request)?.kind).toBe("provider_call");
  });
  it("requires an explicit existing provider/model instead of choosing one", () => {
    expect(() => createConfiguredFinanceModelAdapter({})).toThrow("explicit provider/model");
  });
  it("records terminal-delimiter normalization but rejects missing content or invalid escapes", async () => {
    const contents = [
      '{"kind":"review","review":{"notes":["fact"]]}}',
      '{"kind":"review","review":{"notes":["fact"}}',
      '{"kind":"review","review":{"notes":["unfinished',
      String.raw`{"kind":"review","review":{"notes":["bad\q"]}}`,
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              id: "fixture-json",
              choices: [{ finish_reason: "stop", message: { content: contents.shift() } }],
            }),
          ),
      ),
    );
    const adapter = createConfiguredFinanceModelAdapter(cfg);
    for (let n = 0; n < 2; n += 1) {
      await expect(adapter.invoke(request, new AbortController().signal)).resolves.toEqual({
        kind: "review",
        review: { notes: ["fact"] },
      });
      expect(adapter.observe?.(request)?.outputNormalization).toBe("terminal_delimiters");
    }
    for (let n = 0; n < 2; n += 1) {
      await expect(adapter.invoke(request, new AbortController().signal)).rejects.toThrow(
        "output_invalid",
      );
    }
  });
});
