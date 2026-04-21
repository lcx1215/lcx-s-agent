import { describe, expect, it, vi } from "vitest";
import {
  makeIsolatedAgentTurnJob,
  makeIsolatedAgentTurnParams,
  setupRunCronIsolatedAgentTurnSuite,
} from "./run.suite-helpers.js";
import {
  loadRunCronIsolatedAgentTurn,
  resolveAllowedModelRefMock,
  resolveAgentTimeoutMsMock,
  resolveAgentModelFallbacksOverrideMock,
  runEmbeddedPiAgentMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

// ---------- tests ----------

describe("runCronIsolatedAgentTurn — payload.fallbacks", () => {
  setupRunCronIsolatedAgentTurnSuite();

  it.each([
    {
      name: "passes payload.fallbacks as fallbacksOverride when defined",
      payload: {
        kind: "agentTurn",
        message: "test",
        fallbacks: ["anthropic/claude-sonnet-4-6", "openai/gpt-5"],
      },
      expectedFallbacks: ["anthropic/claude-sonnet-4-6", "openai/gpt-5"],
    },
    {
      name: "trims agent-level fallbacks to one fallback candidate for cron reliability",
      payload: { kind: "agentTurn", message: "test" },
      agentFallbacks: ["openai/gpt-4o", "anthropic/claude-sonnet-4-6", "moonshot/kimi-k2.5"],
      expectedFallbacks: ["anthropic/claude-sonnet-4-6"],
    },
    {
      name: "prefers a different-provider cron fallback when the pinned model already matches the first configured fallback",
      payload: {
        kind: "agentTurn",
        message: "test",
        model: "custom-api-deepseek-com/deepseek-chat",
      },
      agentFallbacks: [
        "custom-api-deepseek-com/deepseek-chat",
        "custom-api-deepseek-com/deepseek-reasoner",
        "minimax-portal/MiniMax-M2.5-highspeed",
        "moonshot/kimi-k2.5",
      ],
      expectedFallbacks: ["minimax-portal/MiniMax-M2.5-highspeed"],
    },
    {
      name: "payload.fallbacks=[] disables fallbacks even when agent config has them",
      payload: { kind: "agentTurn", message: "test", fallbacks: [] },
      agentFallbacks: ["openai/gpt-4o"],
      expectedFallbacks: [],
    },
  ])("$name", async ({ payload, agentFallbacks, expectedFallbacks }) => {
    if (agentFallbacks) {
      resolveAgentModelFallbacksOverrideMock.mockReturnValue(agentFallbacks);
    }
    if ("model" in payload && typeof payload.model === "string") {
      const [provider, ...rest] = payload.model.split("/");
      resolveAllowedModelRefMock.mockReturnValueOnce({
        ref: { provider, model: rest.join("/") },
      });
    }

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentTurnParams({
        job: makeIsolatedAgentTurnJob({ payload }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(runWithModelFallbackMock).toHaveBeenCalledOnce();
    expect(runWithModelFallbackMock.mock.calls[0][0].fallbacksOverride).toEqual(expectedFallbacks);
  });

  it("caps default cron embedded-attempt timeout to 180 seconds when no explicit timeoutSeconds is set", async () => {
    resolveAgentTimeoutMsMock.mockReturnValue(600_000);
    runWithModelFallbackMock.mockImplementationOnce(async ({ run }) => ({
      result: await run("openai", "gpt-4", {
        attempt: 1,
        total: 1,
        remainingCandidates: 1,
        remainingRunnableCandidates: 1,
      }),
      provider: "openai",
      model: "gpt-4",
      attempts: [],
    }));

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentTurnParams({
        job: makeIsolatedAgentTurnJob({
          payload: { kind: "agentTurn", message: "test" },
        }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledOnce();
    expect(runEmbeddedPiAgentMock.mock.calls[0][0].timeoutMs).toBe(180_000);
  });

  it("preserves explicit timeoutSeconds even when larger than the cron default cap", async () => {
    resolveAgentTimeoutMsMock.mockReturnValue(600_000);
    runWithModelFallbackMock.mockImplementationOnce(async ({ run }) => ({
      result: await run("openai", "gpt-4", {
        attempt: 1,
        total: 1,
        remainingCandidates: 1,
        remainingRunnableCandidates: 1,
      }),
      provider: "openai",
      model: "gpt-4",
      attempts: [],
    }));

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentTurnParams({
        job: makeIsolatedAgentTurnJob({
          payload: { kind: "agentTurn", message: "test", timeoutSeconds: 900 },
        }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledOnce();
    expect(runEmbeddedPiAgentMock.mock.calls[0][0].timeoutMs).toBe(600_000);
  });

  it("reserves cron wall-clock for a fallback model when explicit timeoutSeconds is set", async () => {
    resolveAgentTimeoutMsMock.mockReturnValue(300_000);
    let mockNow = 1_000_000;
    const dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => mockNow);
    runWithModelFallbackMock.mockImplementationOnce(
      async ({ provider, model, fallbacksOverride, run }) => {
        await expect(
          run(provider, model, {
            attempt: 1,
            total: 2,
            remainingCandidates: 2,
            remainingRunnableCandidates: 2,
          }),
        ).rejects.toThrow("primary failed");
        mockNow += 240_000;
        const fallbackRaw = fallbacksOverride?.[0];
        if (!fallbackRaw) {
          throw new Error("missing fallback");
        }
        const [fallbackProvider, ...fallbackModelParts] = fallbackRaw.split("/");
        return {
          result: await run(fallbackProvider, fallbackModelParts.join("/"), {
            attempt: 2,
            total: 2,
            remainingCandidates: 1,
            remainingRunnableCandidates: 1,
          }),
          provider: fallbackProvider,
          model: fallbackModelParts.join("/"),
          attempts: [{ provider, model, error: "primary failed", reason: "timeout" }],
        };
      },
    );
    runEmbeddedPiAgentMock
      .mockRejectedValueOnce(new Error("primary failed"))
      .mockResolvedValueOnce({
        payloads: [{ text: "fallback output" }],
        meta: { agentMeta: { usage: { input: 10, output: 20 } } },
      });

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentTurnParams({
        job: makeIsolatedAgentTurnJob({
          payload: {
            kind: "agentTurn",
            message: "test",
            timeoutSeconds: 300,
            fallbacks: ["moonshot/kimi-k2.5"],
          },
        }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(2);
    expect(runEmbeddedPiAgentMock.mock.calls[0][0].timeoutMs).toBeLessThanOrEqual(240_000);
    expect(runEmbeddedPiAgentMock.mock.calls[0][0].timeoutMs).toBeGreaterThan(230_000);
    expect(runEmbeddedPiAgentMock.mock.calls[1][0].timeoutMs).toBeLessThanOrEqual(60_000);
    expect(runEmbeddedPiAgentMock.mock.calls[1][0].timeoutMs).toBeGreaterThan(50_000);
    dateNowSpy.mockRestore();
  });

  it("reallocates cooled-primary budget to the first runnable fallback", async () => {
    resolveAgentTimeoutMsMock.mockReturnValue(90_000);
    const mockNow = 1_000_000;
    const dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => mockNow);
    runWithModelFallbackMock.mockImplementationOnce(
      async ({ provider, model, fallbacksOverride, run }) => {
        const fallbackRaw = fallbacksOverride?.[0];
        if (!fallbackRaw) {
          throw new Error("missing fallback");
        }
        const [fallbackProvider, ...fallbackModelParts] = fallbackRaw.split("/");
        return {
          result: await run(fallbackProvider, fallbackModelParts.join("/"), {
            attempt: 2,
            total: 2,
            remainingCandidates: 1,
            remainingRunnableCandidates: 1,
          }),
          provider: fallbackProvider,
          model: fallbackModelParts.join("/"),
          attempts: [{ provider, model, error: "timeout cooldown", reason: "timeout" }],
        };
      },
    );
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "fallback output" }],
      meta: { agentMeta: { usage: { input: 10, output: 20 } } },
    });

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentTurnParams({
        job: makeIsolatedAgentTurnJob({
          payload: {
            kind: "agentTurn",
            message: "test",
            timeoutSeconds: 90,
            model: "custom-api-deepseek-com/deepseek-reasoner",
            fallbacks: ["minimax-portal/MiniMax-M2.7"],
          },
        }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledOnce();
    expect(runEmbeddedPiAgentMock.mock.calls[0][0].timeoutMs).toBe(90_000);
    dateNowSpy.mockRestore();
  });
});
