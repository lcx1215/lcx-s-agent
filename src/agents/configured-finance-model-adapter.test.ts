import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  createConfiguredFinanceModelAdapter,
  createFinanceModelCallBudget,
  FINANCE_PROVIDER_PAYMENT_COOLDOWN_MS,
  resolveConfiguredFinanceAuth,
} from "./configured-finance-model-adapter.js";
import type { ModelCallRequest } from "./logical-agent-model-router.js";
import {
  readModelRequestTrajectory,
  summarizeModelRequestTrajectory,
} from "./model-request-trajectory.js";
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("configured model payment cooldown", () => {
  function account(name: string) {
    const result = structuredClone(cfg);
    result.models!.providers!.fixture.apiKey = `payment-test-${name}`;
    result.models!.providers!.fixture.models.push({
      ...result.models!.providers!.fixture.models[0],
      id: "alternative",
    });
    return result;
  }

  const success = () =>
    new Response(
      JSON.stringify({
        id: "paid-transport-fixture",
        choices: [{ finish_reason: "stop", message: { content: "{}" } }],
      }),
    );

  it("shares payment failure across models and callers without charging another call", async () => {
    const config = account("shared");
    const before = JSON.stringify(config);
    const http = vi.fn(async () => new Response("private billing details", { status: 402 }));
    vi.stubGlobal("fetch", http);
    const budget = createFinanceModelCallBudget(3);
    const first = createConfiguredFinanceModelAdapter(config, { callBudget: budget });
    await expect(first.invoke(request, new AbortController().signal)).rejects.toMatchObject({
      code: "provider_payment_required",
    });
    const central = createConfiguredFinanceModelAdapter(config, {
      modelRef: "fixture/alternative",
      trajectorySource: "central_brain",
      callBudget: budget,
    });
    await expect(central.invoke(request, new AbortController().signal)).rejects.toMatchObject({
      code: "provider_payment_required",
    });
    expect(central.unavailableReason?.()).toBe("provider_payment_required");
    expect(central.observe?.(request)).toBeUndefined();
    expect(http).toHaveBeenCalledTimes(1);
    expect(budget.snapshot().reserved).toBe(1);
    expect(JSON.stringify(config)).toBe(before);
  });

  it("does not block a replacement credential or a different endpoint", async () => {
    const config = account("replacement");
    const http = vi.fn().mockResolvedValueOnce(new Response("", { status: 402 }));
    http.mockImplementation(async () => success());
    vi.stubGlobal("fetch", http);
    await expect(
      createConfiguredFinanceModelAdapter(config).invoke(request, new AbortController().signal),
    ).rejects.toMatchObject({ code: "provider_payment_required" });
    const changedKey = structuredClone(config);
    changedKey.models!.providers!.fixture.apiKey = "payment-test-another-credential";
    await createConfiguredFinanceModelAdapter(changedKey).invoke(
      request,
      new AbortController().signal,
    );
    const changedEndpoint = structuredClone(config);
    changedEndpoint.models!.providers!.fixture.baseUrl = "https://other-fixture.invalid/v1";
    await createConfiguredFinanceModelAdapter(changedEndpoint).invoke(
      request,
      new AbortController().signal,
    );
    expect(http).toHaveBeenCalledTimes(3);
  });

  it("permits recovery after a bounded cooldown without extending it on blocked calls", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_900_000_000_000);
    const config = account("recovery");
    const http = vi.fn().mockResolvedValueOnce(new Response("", { status: 402 }));
    http.mockImplementation(async () => success());
    vi.stubGlobal("fetch", http);
    const adapter = createConfiguredFinanceModelAdapter(config);
    await expect(adapter.invoke(request, new AbortController().signal)).rejects.toMatchObject({
      code: "provider_payment_required",
    });
    clock.mockReturnValue(1_900_000_000_000 + FINANCE_PROVIDER_PAYMENT_COOLDOWN_MS - 1);
    await expect(adapter.invoke(request, new AbortController().signal)).rejects.toMatchObject({
      code: "provider_payment_required",
    });
    clock.mockReturnValue(1_900_000_000_000 + FINANCE_PROVIDER_PAYMENT_COOLDOWN_MS);
    await adapter.invoke(request, new AbortController().signal);
    expect(adapter.unavailableReason?.()).toBeUndefined();
    expect(http).toHaveBeenCalledTimes(2);
  });

  it("persists only an opaque account key and cooldown for a fresh runtime", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "finance-payment-"));
    try {
      const config = account("durable");
      const http = vi.fn(async () => new Response("private billing details", { status: 402 }));
      vi.stubGlobal("fetch", http);
      await expect(
        createConfiguredFinanceModelAdapter(config, {
          availabilityStateDirectory: directory,
        }).invoke(request, new AbortController().signal),
      ).rejects.toMatchObject({ code: "provider_payment_required" });
      const [filename] = fs.readdirSync(directory);
      expect(filename).toMatch(/^[a-f0-9]{64}\.json$/u);
      const stored = fs.readFileSync(path.join(directory, filename), "utf8");
      expect(stored).not.toContain(config.models!.providers!.fixture.apiKey);
      expect(stored).not.toContain("private billing");
      expect(JSON.parse(stored)).toEqual({
        schema: "finance_provider_payment_cooldown_v1",
        until: expect.any(Number),
      });
      vi.resetModules();
      const freshRuntime = await import("./configured-finance-model-adapter.js");
      await expect(
        freshRuntime
          .createConfiguredFinanceModelAdapter(config, {
            modelRef: "fixture/alternative",
            availabilityStateDirectory: directory,
          })
          .invoke(request, new AbortController().signal),
      ).rejects.toMatchObject({ code: "provider_payment_required" });
      expect(http).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("loads production cooldown state in a separate process before transport", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "finance-payment-process-"));
    try {
      const config = account("child-process");
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("", { status: 402 })),
      );
      await expect(
        createConfiguredFinanceModelAdapter(config, {
          availabilityStateDirectory: path.join(directory, "model-provider-cooldowns"),
        }).invoke(request, new AbortController().signal),
      ).rejects.toMatchObject({ code: "provider_payment_required" });
      const moduleUrl = pathToFileURL(
        path.resolve("src/agents/configured-finance-model-adapter.ts"),
      );
      const script = `
        import { createConfiguredFinanceModelAdapter } from ${JSON.stringify(moduleUrl.href)};
        let transportCalls = 0;
        globalThis.fetch = async () => { transportCalls++; throw new Error("transport forbidden"); };
        const adapter = createConfiguredFinanceModelAdapter(${JSON.stringify(config)}, {
          modelRef: "fixture/alternative", trajectorySource: "central_brain"
        });
        try {
          await adapter.invoke(${JSON.stringify(request)}, new AbortController().signal);
          process.stdout.write(JSON.stringify({ code: "unexpected_success", transportCalls }));
        } catch (error) {
          process.stdout.write(JSON.stringify({ code: error.code, transportCalls }));
        }
      `;
      const output = execFileSync(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", script],
        {
          env: {
            ...process.env,
            NODE_ENV: "production",
            OPENCLAW_STATE_DIR: directory,
            LCX_MODEL_TRAJECTORY: "0",
          },
          encoding: "utf8",
          timeout: 30_000,
        },
      );
      expect(JSON.parse(output)).toEqual({ code: "provider_payment_required", transportCalls: 0 });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("blocks subsequent calls after a failure while preserving already dispatched requests", async () => {
    const config = account("concurrent");
    const pending: Array<(response: Response) => void> = [];
    const http = vi.fn(() => new Promise<Response>((resolve) => pending.push(resolve)));
    vi.stubGlobal("fetch", http);
    const first = createConfiguredFinanceModelAdapter(config);
    const second = createConfiguredFinanceModelAdapter(config, { modelRef: "fixture/alternative" });
    const results = Promise.allSettled([
      first.invoke(request, new AbortController().signal),
      second.invoke({ ...request, callId: "in-flight" }, new AbortController().signal),
    ]);
    await vi.waitFor(() => expect(http).toHaveBeenCalledTimes(2));
    pending[0](new Response("", { status: 402 }));
    await vi.waitFor(() => expect(first.unavailableReason?.()).toBe("provider_payment_required"));
    await expect(second.invoke(request, new AbortController().signal)).rejects.toMatchObject({
      code: "provider_payment_required",
    });
    expect(http).toHaveBeenCalledTimes(2);
    pending[1](success());
    expect((await results).map((result) => result.status)).toEqual(["rejected", "fulfilled"]);
  });

  it("keeps the classified failure and in-process block when persistence is unavailable", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "finance-payment-storage-"));
    try {
      const config = account("storage-unavailable");
      const http = vi.fn(async () => new Response("", { status: 402 }));
      vi.stubGlobal("fetch", http);
      const write = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
        throw new Error("fixture storage unavailable");
      });
      const options = { availabilityStateDirectory: directory };
      await expect(
        createConfiguredFinanceModelAdapter(config, options).invoke(
          request,
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: "provider_payment_required" });
      write.mockRestore();
      await expect(
        createConfiguredFinanceModelAdapter(config, options).invoke(
          request,
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: "provider_payment_required" });
      expect(fs.readdirSync(directory)).toEqual([]);
      expect(http).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
describe("configured research model transport", () => {
  it("uses the bounded role-specific output budget in the provider request", async () => {
    const outputBudgets: unknown[] = [];
    const http = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (typeof init?.body !== "string") {
        throw new Error("expected JSON request body");
      }
      const requestBody = JSON.parse(init.body) as Record<string, unknown>;
      outputBudgets.push(requestBody.max_tokens);
      return new Response(
        JSON.stringify({
          id: "role-budget-response",
          choices: [
            {
              finish_reason: "stop",
              message: { content: '{"kind":"plan","requirements":["e1"],"missingEvidence":[]}' },
            },
          ],
        }),
      );
    });
    vi.stubGlobal("fetch", http);
    const adapter = createConfiguredFinanceModelAdapter(cfg, {
      maxCalls: 3,
      maxTokens: 8_192,
      maxTokensByRole: {
        formatting: 16_384,
        portfolio_exposure: 16_384,
        research_draft: 16_384,
      },
    });
    await adapter.invoke(request, new AbortController().signal);
    await adapter.invoke({ ...request, role: "portfolio_exposure" }, new AbortController().signal);
    await adapter.invoke({ ...request, role: "formatting" }, new AbortController().signal);
    expect(outputBudgets).toEqual([16_384, 16_384, 16_384]);
  });

  it("uses only raw declared capacity by default and allows larger explicit limits", async () => {
    const config = structuredClone(cfg);
    config.models!.providers!.fixture.models[0].maxTokens = 384_000;
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (typeof init?.body !== "string") {
          throw new Error("expected serialized JSON body");
        }
        bodies.push(JSON.parse(init.body) as Record<string, unknown>);
        return new Response(
          JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "{}" } }] }),
        );
      }),
    );
    const signal = new AbortController().signal;
    await createConfiguredFinanceModelAdapter(config).invoke(request, signal);
    await createConfiguredFinanceModelAdapter(config, { maxTokens: 65_536 }).invoke(
      request,
      signal,
    );
    await createConfiguredFinanceModelAdapter(config, {
      maxTokensByRole: { research_draft: 90_000 },
    }).invoke(request, signal);
    Reflect.deleteProperty(config.models!.providers!.fixture.models[0], "maxTokens");
    await createConfiguredFinanceModelAdapter(config).invoke(request, signal);
    expect(bodies.map((body) => body.max_tokens)).toEqual([384_000, 65_536, 90_000, undefined]);
    expect(bodies[3]).not.toHaveProperty("max_tokens");
    for (const invalid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => createConfiguredFinanceModelAdapter(config, { maxTokens: invalid })).toThrow(
        "positive safe-integer",
      );
    }
  });

  it("rejects oversized local prompts without consuming a provider call", async () => {
    const http = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: "after-preflight",
            choices: [{ finish_reason: "stop", message: { content: "{}" } }],
          }),
        ),
    );
    vi.stubGlobal("fetch", http);
    const adapter = createConfiguredFinanceModelAdapter(cfg, { maxCalls: 1 });
    const oversized = {
      ...request,
      payload: {
        ...(request.payload as Record<string, unknown>),
        sharedContext: { portfolioAllocationContract: { padding: "x".repeat(6000) } },
      },
    };
    await expect(adapter.invoke(oversized, new AbortController().signal)).rejects.toMatchObject({
      code: "prompt_budget_exceeded",
    });
    expect(http).not.toHaveBeenCalled();
    await adapter.invoke(request, new AbortController().signal);
    expect(http).toHaveBeenCalledTimes(1);
  });

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
  it("attests canonical prompt coverage but leaves custom prompt coverage unknown", async () => {
    const http = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: "coverage-response",
            choices: [{ finish_reason: "stop", message: { content: "{}" } }],
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", http);
    const canonical = createConfiguredFinanceModelAdapter(cfg);
    await canonical.invoke(request, new AbortController().signal);
    const canonicalObservation = canonical.observe?.(request);
    expect(canonicalObservation?.evidenceCoverage).toMatchObject({
      boundary: "canonical_prompt",
      suppliedEvidenceIds: ["e1"],
      includedEvidenceIds: ["e1"],
      omittedEvidenceIds: [],
      clippedEvidenceIds: [],
    });
    expect(canonicalObservation?.evidenceCoverage?.promptSha256).toMatch(/^[a-f0-9]{64}$/u);

    const custom = createConfiguredFinanceModelAdapter(cfg, { buildPrompt: () => "custom" });
    await custom.invoke(request, new AbortController().signal);
    expect(custom.observe?.(request)?.evidenceCoverage).toBeUndefined();
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

  it("records attributed usage before rejecting a truncated model response", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "finance-usage-trajectory-"));
    const trajectoryPath = path.join(directory, "requests.jsonl");
    try {
      vi.stubEnv("LCX_MODEL_TRAJECTORY", "true");
      vi.stubEnv("LCX_MODEL_TRAJECTORY_FILE", trajectoryPath);
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                id: "fixture-response-id",
                usage: {
                  prompt_tokens: 120,
                  completion_tokens: 25,
                  total_tokens: 145,
                  prompt_tokens_details: { cached_tokens: 60 },
                  completion_tokens_details: { reasoning_tokens: 7 },
                },
                choices: [{ finish_reason: "length", message: { content: "PRIVATE_BODY" } }],
              }),
            ),
        ),
      );
      await expect(
        createConfiguredFinanceModelAdapter(cfg).invoke(request, new AbortController().signal),
      ).rejects.toThrow("output_truncated");

      let records = await readModelRequestTrajectory({ filePath: trajectoryPath });
      await vi.waitFor(async () => {
        records = await readModelRequestTrajectory({ filePath: trajectoryPath });
        expect(records).toHaveLength(3);
      });
      expect(records).toHaveLength(3);
      expect(records[0]).toMatchObject({
        stage: "attempt_started",
        callId: "call",
        correlationId: "run",
        taskId: "research_draft",
        role: "research_draft",
        attempt: 1,
      });
      expect(records[1]).toMatchObject({ stage: "response_received", httpStatus: 200 });
      expect(records[2]).toMatchObject({
        stage: "usage_received",
        promptTokens: 120,
        completionTokens: 25,
        totalTokens: 145,
        cachedInputTokens: 60,
        reasoningTokens: 7,
      });
      expect(JSON.stringify(records)).not.toContain("PRIVATE_BODY");
      expect(summarizeModelRequestTrajectory(records)).toMatchObject({
        attempts: 1,
        responses: 1,
        errors: 0,
        aborted: 0,
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
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

it("distinguishes payment-required transport failure without retaining the provider body", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("private billing detail", { status: 402 })),
  );
  const adapter = createConfiguredFinanceModelAdapter(cfg);
  await expect(adapter.invoke(request, new AbortController().signal)).rejects.toMatchObject({
    code: "provider_payment_required",
    message: "model adapter provider_payment_required",
  });
});
