import { afterEach, describe, expect, it, vi } from "vitest";
import { runCentralHarnessCycle, nextCycleContinuation, compactReceipts } from "./harness-loop.js";
import type { CentralPerception, CentralToolSpec, CentralRunReceipt } from "./types.js";

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
    plan: {
      actions: [
        { ownerId: "fixture", args: { page: 1 } },
        { ownerId: "fixture", args: { page: 2 } },
      ],
      note: "fixture",
    },
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

describe("bounded central coordination", () => {
  const propose = (actions: { ownerId: string; args?: Record<string, unknown> }[]) => ({
    propose: async () => ({
      kind: "proposed" as const,
      provider: "fixture",
      modelId: "fixture",
      plan: { actions, note: "bounded fixture" },
    }),
  });
  it.each([false, true])(
    "blocks only exact canonical duplicates after normal approval (planOnly=%s)",
    async (planOnly) => {
      const execute = vi.fn(async () => ({ observedOk: true, receipt: { status: "ready" } }));
      const tools = registry(execute);
      const approve = vi.spyOn(tools.get("fixture")!, "approve");
      const receipt = await runCentralHarnessCycle({
        perception,
        registry: tools,
        planOnly,
        capabilityOwnerIds: new Set(["fixture"]),
        brain: propose([
          { ownerId: "fixture", args: { account: "a", cursor: "1", nested: { a: 1, b: 2 } } },
          { ownerId: "fixture", args: { nested: { b: 2, a: 1 }, cursor: "1", account: "a" } },
          { ownerId: "fixture", args: { account: "a", cursor: "2", nested: { a: 1, b: 2 } } },
          { ownerId: "fixture", args: { account: "b", cursor: "1", nested: { a: 1, b: 2 } } },
        ]),
      });
      expect(approve).toHaveBeenCalledTimes(4);
      expect(execute).toHaveBeenCalledTimes(3);
      expect(receipt.steps.map((step) => step.status)).toEqual([
        "ran_ok",
        "blocked_by_gate",
        "ran_ok",
        "ran_ok",
      ]);
      expect(receipt.steps[1].gateReason).toBe("duplicate_action");
      expect(receipt.steps[0].outcome).toBeDefined();
    },
  );
  it("follows actual capability results within production continuation bounds", async () => {
    const options = {
      perception,
      brain: propose([{ ownerId: "fixture" }]),
      registry: registry(async () => ({ receipt: { status: "ready", quantity: 10 } })),
      capabilityOwnerIds: new Set(["fixture"]),
      planOnly: true,
    };
    const first = await runCentralHarnessCycle(options);
    expect(first.nextAction).toBe("follow_up_on_capability_results");
    expect(nextCycleContinuation(first, 1, 3)).toEqual({
      run: true,
      because: "capability_results",
    });
    expect(nextCycleContinuation(first, 1, 1)).toEqual({
      run: false,
      because: "max_cycles_reached",
    });
    expect(compactReceipts([first], 3, new Set(["fixture"]))[0].outcomes[0].outcome).toMatchObject({
      status: "ready",
      quantity: 10,
    });
    const repeated = await runCentralHarnessCycle(options);
    expect(nextCycleContinuation(repeated, 2, 3, first)).toEqual({
      run: false,
      because: "unchanged_result",
    });
    const gated = {
      ...first,
      nextAction: "review_blocked_proposals",
      steps: first.steps.map((step) => ({
        ...step,
        status: "blocked_by_gate" as const,
        gateReason: "denied",
      })),
    };
    expect(nextCycleContinuation(gated, 2, 3, gated)).toEqual({
      run: false,
      because: "unchanged_failure",
    });
    const failed = {
      ...gated,
      nextAction: "follow_up_on_failed_dispatch",
      steps: first.steps.map((step) => ({
        ...step,
        status: "ran_failed" as const,
        failureReason: "unavailable",
      })),
    };
    expect(nextCycleContinuation(failed, 2, 3, failed)).toEqual({
      run: false,
      because: "unchanged_failure",
    });
    const stopped = await runCentralHarnessCycle({ ...options, brain: propose([]) });
    expect(nextCycleContinuation(stopped, 2, 3, first)).toEqual({
      run: false,
      because: "nothing_left_to_follow_up",
    });
    const planned = await runCentralHarnessCycle({
      ...options,
      capabilityOwnerIds: new Set<string>(),
    });
    expect(planned.steps[0].status).toBe("approved");
    expect(planned.nextAction).toBe("continue");
    const unclassified = await runCentralHarnessCycle({
      ...options,
      planOnly: false,
      capabilityOwnerIds: undefined,
    });
    expect(unclassified.nextAction).toBe("continue");
  });
  it("uses the production continuation gate to consume absent then ready capability receipts", async () => {
    const receipts: CentralRunReceipt[] = [];
    const capabilities = new Set(["fixture"]);
    const calls: string[] = [];
    const execute = async (args: Readonly<Record<string, unknown>>) => {
      calls.push(String(args.directory));
      return {
        receipt:
          args.directory === "primary" ? { status: "absent" } : { status: "ready", quantity: 10 },
      };
    };
    for (let cycle = 1; cycle <= 3; cycle++) {
      const backlog = compactReceipts(receipts, 3, capabilities);
      const status = backlog.at(-1)?.outcomes[0]?.outcome?.status;
      const receipt = await runCentralHarnessCycle({
        perception: { ...perception, backlog },
        registry: registry(execute),
        planOnly: true,
        capabilityOwnerIds: capabilities,
        brain: propose(
          status === "ready"
            ? []
            : [
                {
                  ownerId: "fixture",
                  args: { directory: status === "absent" ? "backup" : "primary" },
                },
              ],
        ),
      });
      receipts.push(receipt);
      if (!nextCycleContinuation(receipt, cycle, 3, receipts.at(-2)).run) {
        break;
      }
    }
    expect(calls).toEqual(["primary", "backup"]);
    expect(receipts).toHaveLength(3);
    expect(receipts.at(-1)?.actionsProposed).toBe(0);
  });
});
