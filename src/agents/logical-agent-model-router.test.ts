import { describe, expect, it, vi } from "vitest";
import {
  type LogicalAgentModelAdapter,
  type LogicalAgentModelRouting,
  type LogicalAgentRoleModelPolicy,
  type ModelCallObservation,
} from "./logical-agent-model-router.js";
import {
  createInMemoryLogicalAgentCheckpointStore,
  LogicalAgentPool,
  runLogicalAgentPlan,
  type LogicalAgentExecutionContext,
} from "./logical-agent-pool.js";

const policy: LogicalAgentRoleModelPolicy = {
  primary: "small",
  requiredCapabilities: ["json"],
  maxInputBytes: 1024,
  timeoutMs: 1000,
};
function adapter(
  id: string,
  extra: Partial<LogicalAgentModelAdapter> = {},
): LogicalAgentModelAdapter {
  return {
    id,
    provider: "test-local",
    modelId: `model-${id}`,
    mode: "deterministic",
    capabilities: ["json"],
    requiredTools: [],
    requiredSideEffects: ["local_compute"],
    invoke: async ({ payload }) => payload,
    ...extra,
  };
}
function routing(extra: Partial<LogicalAgentModelRouting> = {}): LogicalAgentModelRouting {
  return {
    revision: "test-v1",
    adapters: [adapter("small"), adapter("reviewer")],
    defaultPolicy: policy,
    ...extra,
  };
}
const task = { id: "clean", agentId: "data_cleaning" as const, input: "evidence" };
const execute = async ({
  modelSlot,
  input,
  signal,
}: LogicalAgentExecutionContext<string, unknown>) => ({
  output: await modelSlot.invoke(input, signal),
  sideEffects: [] as const,
});

describe("role model execution receipts", () => {
  it("routes by registered role instead of trusting a role in the payload", async () => {
    const pool = new LogicalAgentPool<string, unknown>({
      modelRouting: routing({ roles: { evidence_integrity: { ...policy, primary: "reviewer" } } }),
    });
    const result = await runLogicalAgentPlan({
      pool,
      runId: "route-run",
      tasks: [
        task,
        {
          id: "review",
          agentId: "evidence_integrity",
          input: "data_cleaning",
          dependsOn: [task.id],
        },
      ],
      executor: execute,
    });
    expect(result.tasks.map((entry) => entry.modelId)).toEqual(["model-small", "model-reviewer"]);
    const receipts = result.tasks.flatMap((entry) => entry.modelCalls ?? []);
    expect(receipts.map((receipt) => receipt.correlationId)).toEqual(["route-run", "route-run"]);
    expect(new Set(receipts.map((receipt) => receipt.callId)).size).toBe(2);
    expect(
      receipts.every(
        (receipt) => receipt.outcome === "completed" && !receipt.realModelInferenceObserved,
      ),
    ).toBe(true);
  });

  it("records a failed primary and a successful fallback without leaking adapter error text", async () => {
    const pool = new LogicalAgentPool<string, unknown>({
      modelRouting: routing({
        adapters: [
          adapter("small", {
            invoke: async () => {
              throw new Error("secret-credential");
            },
          }),
          adapter("reviewer"),
        ],
        defaultPolicy: { ...policy, fallback: ["reviewer"] },
      }),
    });
    const result = await pool.submit(task, execute);
    expect(result.status).toBe("completed");
    expect(result.modelId).toBe("model-reviewer");
    expect(result.modelCalls?.map((call) => [call.attempt, call.outcome])).toEqual([
      [1, "failed"],
      [2, "completed"],
    ]);
    expect(JSON.stringify(result)).not.toContain("secret-credential");
  });

  it.each(["side-effect", "tool", "capability"])(
    "checks %s constraints before invoking and can use an eligible fallback",
    async (constraint) => {
      const invoke = vi.fn(async () => "forbidden");
      const blocked = adapter("small", {
        invoke,
        ...(constraint === "side-effect" ? { requiredSideEffects: ["provider_call"] } : {}),
        ...(constraint === "tool" ? { requiredTools: ["private-tool"] } : {}),
        ...(constraint === "capability" ? { capabilities: [] } : {}),
      });
      const pool = new LogicalAgentPool<string, unknown>({
        modelRouting: routing({
          adapters: [blocked, adapter("reviewer")],
          defaultPolicy: { ...policy, fallback: ["reviewer"] },
        }),
      });
      const result = await pool.submit(task, execute);
      expect(invoke).not.toHaveBeenCalled();
      expect(result.status).toBe("completed");
      expect(result.modelCalls?.[0]).toMatchObject({
        outcome: "rejected",
        reason: "capability_constraint",
        adapterInvoked: false,
      });
    },
  );

  it("rejects oversized input without dispatching any target", async () => {
    const invoke = vi.fn(async () => "unexpected");
    const pool = new LogicalAgentPool<string, unknown>({
      modelRouting: routing({
        adapters: [adapter("small", { invoke }), adapter("reviewer", { invoke })],
        defaultPolicy: { ...policy, maxInputBytes: 2, fallback: ["reviewer"] },
      }),
    });
    const result = await pool.submit(task, execute);
    expect(invoke).not.toHaveBeenCalled();
    expect(result.modelCalls).toHaveLength(1);
    expect(result.modelCalls?.[0]).toMatchObject({
      outcome: "rejected",
      reason: "input_constraint",
    });
  });

  it("cancels active work without launching fallback", async () => {
    const controller = new AbortController();
    const fallback = vi.fn(async () => "unexpected");
    let observedAbort = false;
    const pool = new LogicalAgentPool<string, unknown>({
      modelRouting: routing({
        adapters: [
          adapter("small", {
            invoke: async (_, signal) =>
              new Promise((_, reject) => {
                signal.addEventListener(
                  "abort",
                  () => {
                    observedAbort = true;
                    reject(new Error("cancelled"));
                  },
                  { once: true },
                );
                controller.abort();
              }),
          }),
          adapter("reviewer", { invoke: fallback }),
        ],
        defaultPolicy: { ...policy, fallback: ["reviewer"] },
      }),
    });
    const result = await pool.submit(task, async ({ modelSlot }) => ({
      output: await modelSlot.invoke(task.input, controller.signal),
      sideEffects: [],
    }));
    expect(result.modelCalls?.[0]?.outcome).toBe("aborted");
    expect(observedAbort).toBe(true);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("times out an uncooperative adapter while keeping the physical slot occupied and expiring queued fallback", async () => {
    let release: (value: string) => void = () => {};
    const fallback = vi.fn(async () => "unexpected");
    const pool = new LogicalAgentPool<string, unknown>({
      modelRouting: routing({
        adapters: [
          adapter("small", {
            invoke: async () =>
              new Promise<string>((resolve) => {
                release = resolve;
              }),
          }),
          adapter("reviewer", { invoke: fallback }),
        ],
        defaultPolicy: { ...policy, timeoutMs: 15, fallback: ["reviewer"] },
      }),
    });
    const result = await pool.submit(task, execute);
    expect(result.status).toBe("failed");
    expect(result.modelCalls?.map((call) => [call.outcome, call.adapterInvoked])).toEqual([
      ["timed_out", true],
      ["timed_out", false],
    ]);
    expect(pool.status.activeModelInvocations).toBe(1);
    expect(fallback).not.toHaveBeenCalled();
    release("late");
    await vi.waitFor(() => expect(pool.status.activeModelInvocations).toBe(0));
    expect(result.modelCalls?.[0]?.outcome).toBe("timed_out");
  });

  it("uses a cooperative timeout fallback without overlapping physical calls", async () => {
    const pool = new LogicalAgentPool<string, unknown>({
      modelRouting: routing({
        adapters: [
          adapter("small", {
            invoke: async (_, signal) =>
              new Promise((_, reject) =>
                signal.addEventListener("abort", () => reject(new Error("cancelled")), {
                  once: true,
                }),
              ),
          }),
          adapter("reviewer"),
        ],
        defaultPolicy: { ...policy, timeoutMs: 15, fallback: ["reviewer"] },
      }),
    });
    const result = await pool.submit(task, execute);
    expect(result.status).toBe("completed");
    expect(result.modelCalls?.map((call) => call.outcome)).toEqual(["timed_out", "completed"]);
    expect(pool.status.maxObservedModelConcurrency).toBe(1);
  });

  it("does not treat caller output or mismatched adapter observations as real execution", async () => {
    const pool = new LogicalAgentPool<string, unknown>({
      modelRouting: routing({
        adapters: [
          adapter("small", {
            mode: "adapter",
            invoke: async () => ({ realModelInferenceObserved: true }),
            observe: (call) => ({
              ...call,
              callId: "other-call",
              transportRequestId: "test",
              kind: "model_inference",
            }),
          }),
        ],
      }),
    });
    const result = await pool.submit(task, execute);
    expect(result.modelCalls?.[0]).toMatchObject({
      adapterInvoked: true,
      evidence: "not-observed",
      realModelInferenceObserved: false,
    });
  });

  it("accepts matching observation metadata at the adapter boundary (fixture only)", async () => {
    const observations = new Map<string, ModelCallObservation>();
    const pool = new LogicalAgentPool<string, unknown>({
      modelRouting: routing({
        adapters: [
          adapter("small", {
            mode: "adapter",
            invoke: async (call) => {
              observations.set(call.callId, {
                ...call,
                transportRequestId: "fixture-transport",
                kind: "model_inference",
              });
              return "fixture";
            },
            observe: (call) => observations.get(call.callId),
          }),
        ],
      }),
    });
    const result = await pool.submit(task, execute);
    expect(result.modelCalls?.[0]).toMatchObject({
      evidence: "adapter-attested",
      realModelInferenceObserved: true,
      providerCallObserved: false,
    });
  });

  it("preserves receipts across checkpoint resume and refuses changed routing", async () => {
    const store = createInMemoryLogicalAgentCheckpointStore<unknown>();
    const options = {
      tasks: [task],
      executor: execute,
      runId: "checkpoint-route",
      checkpointStore: store,
    };
    const first = await runLogicalAgentPlan({
      ...options,
      pool: new LogicalAgentPool<string, unknown>({ modelRouting: routing() }),
    });
    const resumed = await runLogicalAgentPlan({
      ...options,
      resume: true,
      pool: new LogicalAgentPool<string, unknown>({ modelRouting: routing() }),
    });
    expect(resumed.tasks[0]?.modelCalls).toEqual(first.tasks[0]?.modelCalls);
    await expect(
      runLogicalAgentPlan({
        ...options,
        resume: true,
        pool: new LogicalAgentPool<string, unknown>({
          modelRouting: routing({ roles: { data_cleaning: { ...policy, primary: "reviewer" } } }),
        }),
      }),
    ).rejects.toThrow("fingerprint mismatch");
  });
});
