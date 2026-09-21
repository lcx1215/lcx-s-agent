import { afterEach, describe, expect, it, vi } from "vitest";
import { runCentralHarnessCycle } from "./harness-loop.js";
import type { CentralPerception, CentralToolSpec } from "./types.js";

const perception: CentralPerception = {
  observedAt: "2026-09-21T00:00:00Z",
  ownerTotals: {},
  controlRoom: {},
  backlog: [],
  boundaries: [],
};
const brain = {
  propose: async () => ({
    kind: "proposed" as const,
    provider: "fixture",
    modelId: "fixture",
    plan: { actions: [{ ownerId: "fixture" }, { ownerId: "fixture" }], note: "fixture" },
  }),
};
function registry(execute: CentralToolSpec["execute"]) {
  return new Map<string, CentralToolSpec>([
    [
      "fixture",
      {
        ownerId: "fixture",
        name: "fixture",
        label: "fixture",
        description: "fixture",
        allowedSideEffects: [],
        boundary: [],
        approve: () => ({ ok: true }),
        execute,
      },
    ],
  ]);
}
afterEach(() => vi.useRealTimers());

describe("central cycle cancellation and failure closure", () => {
  it("settles a terminal receipt when a brain ignores the deadline signal", async () => {
    vi.useFakeTimers();
    const settle = vi.fn(async () => ({
      runId: "test",
      observedAt: perception.observedAt,
      approved: [],
      blocked: [],
    }));
    const pending = runCentralHarnessCycle({
      perception,
      registry: registry(async () => ({})),
      brain: { propose: () => new Promise(() => {}) },
      deadlineMs: Date.now() + 10,
      settle,
    });
    await vi.advanceTimersByTimeAsync(2_010);
    const receipt = await pending;
    expect(receipt.brainCall.outcome).toBe("failed");
    expect(receipt.nextAction).toBe("halt_and_report");
    expect(settle).toHaveBeenCalledWith(receipt);
  });

  it("settles promptly when a dispatched owner ignores its signal", async () => {
    vi.useFakeTimers();
    const execute = vi.fn(() => new Promise<Record<string, unknown>>(() => {}));
    const pending = runCentralHarnessCycle({
      perception,
      brain,
      registry: registry(execute),
      deadlineMs: Date.now() + 10,
    });
    await vi.advanceTimersByTimeAsync(2_010);
    const receipt = await pending;
    expect(execute).toHaveBeenCalledTimes(1);
    expect(receipt.steps[0].status).toBe("ran_failed");
    expect(receipt.steps[0].failureReason).toContain("cleanup_unconfirmed");
    expect(receipt.nextAction).toBe("halt_and_report");
  });

  it("propagates caller cancellation and does not dispatch subsequent owners", async () => {
    const controller = new AbortController();
    const execute = vi.fn(async (_args: Readonly<Record<string, unknown>>, signal: AbortSignal) => {
      controller.abort(new Error("operator cancelled"));
      signal.throwIfAborted();
      return {};
    });
    const receipt = await runCentralHarnessCycle({
      perception,
      brain,
      registry: registry(execute),
      signal: controller.signal,
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(receipt.steps.map((step) => step.status)).toEqual(["ran_failed", "ran_failed"]);
    expect(receipt.nextAction).toBe("halt_and_report");
  });

  it("does not call the brain when already cancelled", async () => {
    const propose = vi.fn(brain.propose);
    const receipt = await runCentralHarnessCycle({
      perception,
      brain: { propose },
      registry: registry(async () => ({})),
      signal: AbortSignal.abort(new Error("cancelled")),
    });
    expect(propose).not.toHaveBeenCalled();
    expect(receipt.brainCall.outcome).toBe("failed");
  });

  it("requests explicit follow-up for failed dispatch", async () => {
    const receipt = await runCentralHarnessCycle({
      perception,
      brain,
      registry: registry(async () => {
        throw new Error("fixture dispatch failure");
      }),
    });
    expect(receipt.nextAction).toBe("follow_up_on_failed_dispatch");
    expect(receipt.steps[0].failureReason).toContain("fixture dispatch failure");
  });
});
