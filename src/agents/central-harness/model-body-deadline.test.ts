import { createServer } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { runCentralHarnessCycle } from "./harness-loop.js";
import { createCentralBrain } from "./model-brain.js";

const perception = {
  observedAt: "2026-10-10T08:00:00Z",
  ownerTotals: {},
  controlRoom: {},
  backlog: [],
  boundaries: ["no_execution_authority"],
};
function config(baseUrl: string): OpenClawConfig {
  return {
    agents: { defaults: { model: { primary: "local/fixture" } } },
    models: {
      providers: {
        local: {
          api: "openai-completions",
          baseUrl,
          apiKey: "offline-body-deadline-fixture",
          models: [
            {
              id: "fixture",
              name: "Fixture",
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
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("does not enter HTTP after request preparation crosses the earlier host cycle deadline", async () => {
  vi.useFakeTimers();
  const deadlineMs = Date.now() + 100;
  const cfg = config("https://cycle-deadline-fixture.invalid/v1");
  Object.defineProperty(cfg.models!.providers!.local, "headers", {
    get: () => {
      vi.setSystemTime(deadlineMs + 1);
      return {};
    },
  });
  const fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          id: "fixture",
          choices: [{ finish_reason: "stop", message: { content: '{"actions":[]}' } }],
        }),
      ),
  );
  vi.stubGlobal("fetch", fetch);
  const receipt = await runCentralHarnessCycle({
    perception,
    deadlineMs,
    registry: new Map(),
    brain: createCentralBrain(cfg),
  });
  expect(fetch).not.toHaveBeenCalled();
  expect(receipt.brainCall.outcome).toBe("failed");
  expect(receipt.steps).toEqual([]);
  expect(receipt.nextAction).toBe("halt_and_report");
});

it("settles the original harness after localhost HTTP 200 stalls and rejects late actions", async () => {
  const dispatch = vi.fn();
  let lateTimer: ReturnType<typeof setTimeout> | undefined;
  const server = createServer((request, response) => {
    request.resume();
    response.writeHead(200, { "content-type": "application/json" });
    response.flushHeaders();
    lateTimer = setTimeout(
      () =>
        response.end(
          JSON.stringify({
            id: "late",
            choices: [
              {
                finish_reason: "stop",
                message: { content: JSON.stringify({ actions: [{ ownerId: "never", args: {} }] }) },
              },
            ],
          }),
        ),
      500,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("fixture server address unavailable");
    }
    const receipt = await runCentralHarnessCycle({
      perception,
      deadlineMs: Date.now() + 250,
      registry: new Map(),
      execute: dispatch,
      brain: createCentralBrain(config(`http://127.0.0.1:${address.port}/v1`)),
    });
    expect(receipt.brainCall).toMatchObject({
      provider: "local",
      modelId: "fixture",
      outcome: "failed",
      modelCall: { transport: { stage: "cancelled", cleanupStatus: "confirmed", httpStatus: 200 } },
    });
    expect(receipt.steps).toEqual([]);
    expect(receipt.nextAction).toBe("halt_and_report");
    const settled = JSON.stringify(receipt);
    await new Promise((resolve) => setTimeout(resolve, 550));
    expect(JSON.stringify(receipt)).toBe(settled);
    expect(dispatch).not.toHaveBeenCalled();
    expect(receipt.liveTouched).toBe(false);
  } finally {
    if (lateTimer) {
      clearTimeout(lateTimer);
    }
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it("keeps cleanup unconfirmed when the local body cancel does not settle", async () => {
  const response = new Response(
    new ReadableStream<Uint8Array>({ cancel: () => new Promise(() => {}) }),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response),
  );
  const receipt = await runCentralHarnessCycle({
    perception,
    deadlineMs: Date.now() + 50,
    registry: new Map(),
    brain: createCentralBrain(config("https://body-fixture.invalid/v1")),
  });
  expect(receipt.brainCall.modelCall?.transport).toMatchObject({
    stage: "cancelled",
    cleanupStatus: "unconfirmed",
    httpStatus: 200,
  });
  expect(receipt.brainCall.outcome).toBe("failed");
  expect(receipt.steps).toEqual([]);
  expect(receipt.nextAction).toBe("halt_and_report");
});
