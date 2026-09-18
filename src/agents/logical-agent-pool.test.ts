import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { planFinanceBrainOrchestration } from "./finance-brain-orchestration.js";
import {
  createCanonicalStateRootLogicalAgentCheckpointStore,
  resolveLogicalAgentCheckpointPath,
} from "./logical-agent-pool-checkpoint-store.js";
import {
  buildDefaultLogicalAgentPlan,
  createInMemoryLogicalAgentCheckpointStore,
  fingerprintLogicalAgentPlan,
  LOGICAL_AGENT_DEFINITIONS,
  LOGICAL_AGENT_LOCAL_CAPABILITIES,
  LOGICAL_AGENT_SIDE_EFFECTS,
  LOGICAL_AGENT_CHECKPOINT_SCHEMA_VERSION,
  type LogicalAgentExecutionResult,
  type LogicalAgentTask,
  LogicalAgentPool,
  runLogicalAgentPlan,
} from "./logical-agent-pool.js";

describe("logical agent pool", () => {
  it("changes the plan fingerprint when the shared fact packet changes", () => {
    const plan = buildDefaultLogicalAgentPlan({ ask: "共享事实包指纹测试" });
    expect(fingerprintLogicalAgentPlan(plan, [], "final_precheck", { snapshotId: "a" })).not.toBe(
      fingerprintLogicalAgentPlan(plan, [], "final_precheck", { snapshotId: "b" }),
    );
  });

  it("passes an intent-family route through explicit context and records transferred ownership", async () => {
    const ask = "学k线图分析技术";
    const route = planFinanceBrainOrchestration({ text: ask });
    const observed: {
      sharedContext?: Readonly<Record<string, unknown>>;
      dependencyResults?: Readonly<Record<string, unknown>>;
    } = {};

    const result = await runLogicalAgentPlan({
      tasks: [
        {
          id: "intent_route",
          agentId: "data_cleaning",
          input: { ask },
        },
        {
          id: "technical_specialist",
          agentId: "research_draft",
          input: { ask },
          dependsOn: ["intent_route"],
        },
      ],
      handoffs: [
        {
          fromTaskId: "intent_route",
          toTaskId: "technical_specialist",
          contextScope: "dependency_results",
          ownership: "transferred",
          reason: "the selected route owns the next specialist decision",
        },
      ],
      sharedContext: {
        intentFamily: "finance_research",
        route: {
          primaryModules: route.primaryModules,
          supportingModules: route.supportingModules,
          requiredTools: route.requiredTools,
          boundaries: route.boundaries,
        },
      },
      executor: ({ task, sharedContext, dependencyResults }) => {
        if (task.id === "technical_specialist") {
          observed.sharedContext = sharedContext;
          observed.dependencyResults = dependencyResults;
        }
        return { output: task.id, sideEffects: [] };
      },
    });

    expect(result.status).toBe("completed");
    expect(observed.sharedContext).toMatchObject({
      intentFamily: "finance_research",
      route: {
        primaryModules: expect.arrayContaining(["technical_timing", "causal_map"]),
        supportingModules: ["finance_learning_memory"],
      },
    });
    expect(observed.dependencyResults).toEqual(
      expect.objectContaining({ intent_route: expect.objectContaining({ status: "completed" }) }),
    );
    expect(result.handoffs).toEqual([
      expect.objectContaining({
        fromTaskId: "intent_route",
        toTaskId: "technical_specialist",
        contextScope: "dependency_results",
        ownership: "transferred",
      }),
    ]);
    expect(result.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "handoff",
          taskId: "technical_specialist",
          payload: expect.objectContaining({
            fromTaskId: "intent_route",
            ownership: "transferred",
          }),
        }),
      ]),
    );
  });

  it("defines ten logical roles while binding every role to one shared local model", () => {
    expect(LOGICAL_AGENT_DEFINITIONS).toHaveLength(10);
    expect(new Set(LOGICAL_AGENT_DEFINITIONS.map((agent) => agent.modelBinding))).toEqual(
      new Set(["shared_local_model"]),
    );
    // The default grant is open: every side effect is allowed and nothing is forbidden.
    // Narrowing is opt-in per caller, so this asserts the default rather than a policy.
    expect(
      LOGICAL_AGENT_DEFINITIONS.every(
        (agent) =>
          agent.capabilities.allowedSideEffects.length === LOGICAL_AGENT_SIDE_EFFECTS.length &&
          agent.capabilities.forbiddenSideEffects.length === 0,
      ),
    ).toBe(true);
    expect(LOGICAL_AGENT_LOCAL_CAPABILITIES.allowedSideEffects).toEqual(
      expect.arrayContaining([...LOGICAL_AGENT_SIDE_EFFECTS]),
    );
    expect(LOGICAL_AGENT_LOCAL_CAPABILITIES.forbiddenSideEffects).toEqual([]);
  });

  it("runs the default DAG through one model slot in dependency order", async () => {
    const plan = buildDefaultLogicalAgentPlan({ ask: "检查一份研究请求" });
    const pool = new LogicalAgentPool({ maxConcurrency: 1 });
    const started: string[] = [];
    const result = await runLogicalAgentPlan({
      tasks: plan,
      pool,
      executor: async ({ task, dependencyResults, modelPool }) => {
        started.push(task.id);
        return {
          output: {
            agentId: task.agentId,
            dependencyCount: Object.keys(dependencyResults).length,
            modelId: modelPool.modelId,
          },
          sideEffects: [],
        };
      },
    });

    expect(result.status).toBe("completed");
    expect(result.tasks).toHaveLength(10);
    expect(result.tasks.every((task) => task.status === "completed")).toBe(true);
    expect(result.pool.maxObservedConcurrency).toBe(1);
    expect(result.pool.maxLoadedModels).toBe(1);
    expect(result.pool.modelId).toBe("Qwen/Qwen3-0.6B");
    expect(result.pool.activeRuns).toBe(0);
    expect(started).toEqual(plan.map((task) => task.id));
  });

  it("allows at most two independent local runs when explicitly configured", async () => {
    const pool = new LogicalAgentPool<{ value: number }, number>({ maxConcurrency: 2 });
    let active = 0;
    let maxActive = 0;
    const modelSlots = new Set<unknown>();
    const result = await runLogicalAgentPlan({
      pool,
      tasks: [
        { id: "a", agentId: "data_cleaning", input: { value: 1 } },
        { id: "b", agentId: "news_classification", input: { value: 2 } },
      ],
      executor: async ({ input, modelSlot }) => {
        modelSlots.add(modelSlot);
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return { output: input.value, sideEffects: [] };
      },
    });

    expect(result.status).toBe("completed");
    expect(maxActive).toBe(2);
    expect(result.pool.maxLoadedModels).toBe(1);
    expect(modelSlots.size).toBe(2);
    expect([...modelSlots].map((slot) => (slot as { modelId: string }).modelId)).toEqual([
      "Qwen/Qwen3-0.6B",
      "Qwen/Qwen3-0.6B",
    ]);
  });

  it("shares one injected model slot instead of exposing a per-task loader", async () => {
    const invocations: unknown[] = [];
    const pool = new LogicalAgentPool({
      maxConcurrency: 2,
      modelInvoker: async (request) => {
        invocations.push(request);
        return "model-output";
      },
    });

    const result = await runLogicalAgentPlan({
      pool,
      tasks: [
        { id: "a", agentId: "data_cleaning", input: { ask: "a" } },
        { id: "b", agentId: "news_classification", input: { ask: "b" } },
      ],
      executor: async ({ modelSlot, task, signal }) => ({
        output: await modelSlot.invoke(task.id, signal),
        sideEffects: [],
      }),
    });

    expect(result.status).toBe("completed");
    expect(invocations).toEqual(["a", "b"]);
  });

  it("serializes multiple model calls made by one executor", async () => {
    let active = 0;
    let maxActive = 0;
    const pool = new LogicalAgentPool({
      maxConcurrency: 1,
      modelInvoker: async (request) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return request;
      },
    });

    const result = await runLogicalAgentPlan({
      pool,
      tasks: [{ id: "fan-out", agentId: "data_cleaning", input: { ask: "x" } }],
      executor: async ({ modelSlot, signal }) => ({
        output: await Promise.all([
          modelSlot.invoke("one", signal),
          modelSlot.invoke("two", signal),
          modelSlot.invoke("three", signal),
        ]),
        sideEffects: [],
      }),
    });

    expect(result.status).toBe("completed");
    expect(maxActive).toBe(1);
    expect(result.pool.maxObservedModelConcurrency).toBe(1);
  });

  it("waits for unawaited model calls before completing a task", async () => {
    let modelSettled = false;
    const pool = new LogicalAgentPool({
      modelInvoker: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return "late-model-output";
      },
    });
    const result = await runLogicalAgentPlan({
      pool,
      tasks: [{ id: "unawaited", agentId: "data_cleaning", input: { ask: "x" } }],
      executor: ({ modelSlot, signal }) => {
        void modelSlot.invoke("late", signal).then(() => {
          modelSettled = true;
        });
        return { output: "task-output", sideEffects: [] };
      },
    });

    expect(result.status).toBe("completed");
    expect(modelSettled).toBe(true);
  });

  it("fails a task when an unawaited model call rejects", async () => {
    const pool = new LogicalAgentPool({
      modelInvoker: async () => {
        throw new Error("late model failure");
      },
    });
    const result = await runLogicalAgentPlan({
      pool,
      tasks: [{ id: "unawaited-rejection", agentId: "data_cleaning", input: { ask: "x" } }],
      executor: ({ modelSlot, signal }) => {
        void modelSlot.invoke("late", signal);
        return { output: "task-output", sideEffects: [] };
      },
    });

    expect(result.status).toBe("failed");
    expect(result.tasks[0]?.error).toBe("late model failure");
  });

  it("serializes shared model calls across concurrent task runs", async () => {
    let active = 0;
    let maxActive = 0;
    const pool = new LogicalAgentPool({
      maxConcurrency: 2,
      modelInvoker: async (request) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return request;
      },
    });
    const result = await runLogicalAgentPlan({
      pool,
      tasks: [
        { id: "first-model", agentId: "data_cleaning", input: { ask: "x" } },
        { id: "second-model", agentId: "news_classification", input: { ask: "y" } },
      ],
      executor: async ({ modelSlot, signal, task }) => ({
        output: await modelSlot.invoke(task.id, signal),
        sideEffects: [],
      }),
    });

    expect(result.status).toBe("completed");
    expect(maxActive).toBe(1);
    expect(result.pool.maxObservedModelConcurrency).toBe(1);
  });

  it("blocks descendants after a failed role without running them", async () => {
    const plan = buildDefaultLogicalAgentPlan({ ask: "失败传播测试" });
    const executed: string[] = [];
    const result = await runLogicalAgentPlan({
      tasks: plan,
      executor: ({ task }) => {
        executed.push(task.id);
        if (task.id === "data_cleaning") {
          throw new Error("input is malformed");
        }
        return { output: task.id, sideEffects: [] };
      },
    });

    expect(result.status).toBe("failed");
    expect(result.tasks.find((task) => task.taskId === "data_cleaning")?.error).toBe(
      "input is malformed",
    );
    expect(result.tasks.filter((task) => task.status === "blocked")).toHaveLength(9);
    expect(executed).toEqual(["data_cleaning"]);
  });

  it("rejects cycles before starting a model executor", async () => {
    const pool = new LogicalAgentPool();
    await expect(
      runLogicalAgentPlan({
        pool,
        tasks: [
          { id: "a", agentId: "data_cleaning", input: { ask: "x" }, dependsOn: ["b"] },
          { id: "b", agentId: "news_classification", input: { ask: "x" }, dependsOn: ["a"] },
        ],
        executor: () => ({ output: "should not run", sideEffects: [] }),
      }),
    ).rejects.toThrow("dependency cycle");
  });

  it("derives the terminal sink instead of trusting task array order", async () => {
    const result = await runLogicalAgentPlan({
      tasks: [
        { id: "terminal", agentId: "final_precheck", input: { ask: "x" }, dependsOn: ["root"] },
        { id: "root", agentId: "data_cleaning", input: { ask: "x" } },
      ],
      executor: ({ task }) => ({ output: task.id, sideEffects: [] }),
    });

    expect(result.status).toBe("completed");
    expect(result.finalTaskId).toBe("terminal");
  });

  it("keeps task identity and dependencies stable after the caller mutates its plan", async () => {
    const tasks: Array<LogicalAgentTask<{ ask: string }>> = [
      { id: "root", agentId: "data_cleaning", input: { ask: "x" } },
      { id: "terminal", agentId: "final_precheck", input: { ask: "x" }, dependsOn: ["root"] },
    ];
    const run = runLogicalAgentPlan({
      tasks,
      executor: async ({ task }) => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return { output: task.id, sideEffects: [] };
      },
    });
    tasks[0].id = "changed";
    tasks[1].id = "changed-terminal";
    tasks[1].dependsOn = ["changed"];

    const result = await run;
    expect(result.tasks.map((task) => task.taskId)).toEqual(["root", "terminal"]);
    expect(result.finalTaskId).toBe("terminal");
  });

  it("fails a task on timeout and releases the pool slot", async () => {
    const pool = new LogicalAgentPool({ taskTimeoutMs: 5 });
    const result = await runLogicalAgentPlan({
      pool,
      tasks: [{ id: "timeout", agentId: "data_cleaning", input: { ask: "x" } }],
      executor: async ({ signal }) => {
        await new Promise<never>((_, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
        return { output: "unreachable", sideEffects: [] };
      },
    });

    expect(result.status).toBe("failed");
    expect(result.tasks[0]?.error).toContain("timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(pool.status.activeRuns).toBe(0);
  });

  it("returns promptly when the parent cancels an executor that ignores AbortSignal", async () => {
    const pool = new LogicalAgentPool({ taskTimeoutMs: 1_000 });
    const parent = new AbortController();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = runLogicalAgentPlan({
      pool,
      signal: parent.signal,
      tasks: [{ id: "parent-cancel", agentId: "data_cleaning", input: { ask: "x" } }],
      executor: async () => {
        await blocked;
        return { output: "late", sideEffects: [] };
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    let guardTimer: ReturnType<typeof setTimeout> | undefined;
    const guard = new Promise<never>((_, reject) => {
      guardTimer = setTimeout(() => reject(new Error("parent cancellation did not return")), 100);
    });
    parent.abort();
    const result = await Promise.race([run, guard]);
    if (guardTimer !== undefined) {
      clearTimeout(guardTimer);
    }
    expect(result.status).toBe("failed");
    expect(result.tasks[0]?.error).toContain("cancelled");
    release();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(pool.status.activeRuns).toBe(0);
  });

  it("waits for executor termination before resolving a timed-out task", async () => {
    let terminated = false;
    const pool = new LogicalAgentPool({ taskTimeoutMs: 5 });
    const result = await runLogicalAgentPlan({
      pool,
      tasks: [{ id: "slow-timeout", agentId: "data_cleaning", input: { ask: "x" } }],
      executor: async ({ signal }) => {
        await new Promise<void>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              setTimeout(() => {
                terminated = true;
                resolve();
              }, 10);
            },
            { once: true },
          );
        });
        return { output: "late", sideEffects: [] };
      },
    });

    expect(result.status).toBe("failed");
    expect(terminated).toBe(true);
    expect(result.tasks[0]?.error).toContain("timed out");
    expect(result.pool.activeRuns).toBe(0);
  });

  it("does not reuse a slot until a timed-out executor has terminated", async () => {
    const pool = new LogicalAgentPool({ taskTimeoutMs: 5 });
    let active = 0;
    let overlapped = false;
    const first = pool.submit(
      { id: "first", agentId: "data_cleaning", input: { ask: "x" } },
      async () => {
        active += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
        return { output: "first", sideEffects: [] };
      },
    );
    const second = pool.submit(
      { id: "second", agentId: "news_classification", input: { ask: "y" } },
      async () => {
        overlapped = active > 0;
        return { output: "second", sideEffects: [] };
      },
    );

    expect((await first).status).toBe("failed");
    expect((await second).status).toBe("completed");
    expect(overlapped).toBe(false);
    expect(pool.status.activeRuns).toBe(0);
  });

  it("cancels a queued task before it starts", async () => {
    const pool = new LogicalAgentPool({ maxConcurrency: 1, taskTimeoutMs: 1_000 });
    let releaseFirst!: () => void;
    const firstFinished = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = pool.submit(
      { id: "queue-first", agentId: "data_cleaning", input: { ask: "first" } },
      async () => {
        await firstFinished;
        return { output: "first", sideEffects: [] };
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const controller = new AbortController();
    let secondStarted = false;
    const second = pool.submit(
      { id: "queue-second", agentId: "news_classification", input: { ask: "second" } },
      async () => {
        secondStarted = true;
        return { output: "second", sideEffects: [] };
      },
      {},
      {},
      "queue-second-correlation",
      controller.signal,
    );
    controller.abort();

    const secondResult = await second;
    expect(secondResult.status).toBe("failed");
    expect(secondResult.error).toContain("cancelled before start");
    expect(secondStarted).toBe(false);
    expect(pool.status.queuedRuns).toBe(0);

    releaseFirst();
    expect((await first).status).toBe("completed");
    expect(pool.status.activeRuns).toBe(0);
  });

  it("contains exceptions raised by abort listeners", async () => {
    const pool = new LogicalAgentPool({ taskTimeoutMs: 5 });
    const result = await runLogicalAgentPlan({
      pool,
      tasks: [{ id: "abort-listener", agentId: "data_cleaning", input: { ask: "x" } }],
      executor: async ({ signal }) => {
        signal.addEventListener("abort", () => {
          throw new Error("faulty cleanup");
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { output: "late", sideEffects: [] };
      },
    });

    expect(result.status).toBe("failed");
    expect(result.tasks[0]?.error).toContain("timed out");
    expect(result.tasks[0]?.error).toContain("abort listener failures: faulty cleanup");
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(pool.status.activeRuns).toBe(0);
  });

  it("preserves AbortSignal listener identity across duplicate registration and removal", async () => {
    const pool = new LogicalAgentPool({ taskTimeoutMs: 5 });
    let abortCalls = 0;
    const listener = () => {
      abortCalls += 1;
    };
    const result = await runLogicalAgentPlan({
      pool,
      tasks: [{ id: "listener-identity", agentId: "data_cleaning", input: { ask: "x" } }],
      executor: async ({ signal }) => {
        signal.addEventListener("abort", listener);
        signal.addEventListener("abort", listener);
        signal.removeEventListener("abort", listener);
        signal.addEventListener("abort", listener);
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { output: "late", sideEffects: [] };
      },
    });

    expect(result.status).toBe("failed");
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(abortCalls).toBe(1);
  });

  it("rejects timer values that Node would truncate", () => {
    expect(() => new LogicalAgentPool({ taskTimeoutMs: 2_147_483_648 })).toThrow(
      "must not exceed 2147483647ms",
    );
  });

  it("admits every declared side effect under the open default grant", async () => {
    const result = await runLogicalAgentPlan({
      tasks: [{ id: "unrestricted", agentId: "risk_check", input: { ask: "x" } }],
      executor: () =>
        ({
          output: "ok",
          sideEffects: ["trading_action", "external_message", "provider_call"],
        }) as unknown as LogicalAgentExecutionResult<string>,
    });

    expect(result.status).toBe("completed");
    expect(result.tasks[0]?.capabilityViolation).toBeUndefined();
    expect(result.tasks[0]?.sideEffects).toEqual([
      "trading_action",
      "external_message",
      "provider_call",
    ]);
  });

  it("rejects undeclared side effects at the capability boundary", async () => {
    // The default grant is open, so the boundary is only observable on a narrowed pool.
    const pool = new LogicalAgentPool<{ ask: string }, string>({
      capabilities: {
        allowedTools: [],
        allowedSideEffects: ["local_output"],
        forbiddenSideEffects: [],
      },
    });
    const result = await runLogicalAgentPlan({
      pool,
      tasks: [{ id: "unsafe", agentId: "risk_check", input: { ask: "x" } }],
      executor: () =>
        ({
          output: "unsafe",
          sideEffects: ["provider_call"],
        }) as unknown as LogicalAgentExecutionResult<string>,
    });

    expect(result.status).toBe("failed");
    expect(result.tasks[0]?.capabilityViolation).toContain("provider_call");
    expect(result.tasks[0]?.sideEffects).toEqual(["provider_call"]);
  });

  it("validates side effects against an immutable capability snapshot", async () => {
    const pool = new LogicalAgentPool<{ ask: string }, string>({
      capabilities: {
        allowedTools: [],
        allowedSideEffects: ["local_output"],
        forbiddenSideEffects: [],
      },
    });
    const result = await runLogicalAgentPlan({
      pool,
      tasks: [{ id: "mutated-capabilities", agentId: "risk_check", input: { ask: "x" } }],
      executor: ({ agent }) => {
        try {
          (agent as unknown as { capabilities: unknown }).capabilities = {
            allowedSideEffects: ["provider_call"],
          };
        } catch {
          // Frozen definitions are expected to reject mutation in strict mode.
        }
        return { output: "unsafe", sideEffects: ["provider_call"] } as const;
      },
    });

    expect(result.status).toBe("failed");
    expect(result.tasks[0]?.capabilityViolation).toContain("provider_call");
  });

  it("keeps dependency result fields immutable for downstream executors", async () => {
    const result = await runLogicalAgentPlan({
      tasks: [
        { id: "root", agentId: "data_cleaning", input: { ask: "x" } },
        {
          id: "terminal",
          agentId: "final_precheck",
          input: { ask: "x" },
          dependsOn: ["root"],
        },
      ],
      executor: ({ task, dependencyResults }) => {
        if (task.id === "terminal") {
          try {
            (dependencyResults.root as unknown as { status: string }).status = "failed";
          } catch {
            // Frozen dependency snapshots are expected to reject mutation.
          }
        }
        return { output: task.id, sideEffects: [] };
      },
    });

    expect(result.status).toBe("completed");
    expect(result.tasks.find((task) => task.taskId === "root")?.status).toBe("completed");
  });

  it("preserves special task IDs in dependency results", async () => {
    let dependencyKeys: string[] = [];
    const result = await runLogicalAgentPlan({
      tasks: [
        { id: "__proto__", agentId: "data_cleaning", input: { ask: "x" } },
        {
          id: "terminal",
          agentId: "final_precheck",
          input: { ask: "x" },
          dependsOn: ["__proto__"],
        },
      ],
      executor: ({ task, dependencyResults }) => {
        dependencyKeys = Object.keys(dependencyResults);
        return { output: task.id, sideEffects: [] };
      },
    });

    expect(result.status).toBe("completed");
    expect(dependencyKeys).toEqual(["__proto__"]);
  });

  it("contains unstringifiable thrown values in a failed receipt", async () => {
    const result = await runLogicalAgentPlan({
      tasks: [{ id: "unstringifiable", agentId: "data_cleaning", input: { ask: "x" } }],
      executor: () => {
        throw Object.create(null);
      },
    });

    expect(result.status).toBe("failed");
    expect(result.tasks[0]?.error).toContain("unstringifiable");
  });

  it("contains an Error with an unsafe message accessor", async () => {
    const result = await runLogicalAgentPlan({
      tasks: [{ id: "unsafe-error-message", agentId: "data_cleaning", input: { ask: "x" } }],
      executor: () => {
        const error = Object.create(Error.prototype) as Error;
        Object.defineProperty(error, "message", {
          configurable: true,
          get: () => {
            throw new Error("message accessor failed");
          },
        });
        throw error;
      },
    });

    expect(result.status).toBe("failed");
    expect(result.tasks[0]?.error).toContain("unstringifiable");
  });

  it("contains errors from hostile proxy objects", async () => {
    const hostile = new Proxy(Object.create(null), {
      getPrototypeOf: () => {
        throw new Error("prototype trap failed");
      },
      get: () => {
        throw new Error("string conversion trap failed");
      },
    });
    const result = await runLogicalAgentPlan({
      tasks: [{ id: "hostile-error", agentId: "data_cleaning", input: { ask: "x" } }],
      executor: () => {
        throw hostile;
      },
    });

    expect(result.status).toBe("failed");
    expect(result.tasks[0]?.error).toContain("unstringifiable");
  });

  it("enforces the measured model-invocation memory delta", async () => {
    const pool = new LogicalAgentPool({
      memoryBudgetMb: 1,
      modelInvoker: async () => Buffer.alloc(5 * 1024 * 1024),
    });
    const result = await runLogicalAgentPlan({
      pool,
      tasks: [{ id: "memory-budget", agentId: "data_cleaning", input: { ask: "x" } }],
      executor: async ({ modelSlot, signal }) => ({
        output: await modelSlot.invoke("large-output", signal),
        sideEffects: [],
      }),
    });

    expect(result.status).toBe("failed");
    expect(result.tasks[0]?.error).toContain("exceeded memory budget");
    expect(result.pool.memoryBudgetEnforcement).toBe("measured_invocation_delta");
    expect(result.pool.activeModelInvocations).toBe(0);
  });

  it("requires every executor to declare side effects", async () => {
    const result = await runLogicalAgentPlan({
      tasks: [{ id: "missing-contract", agentId: "data_cleaning", input: { ask: "x" } }],
      executor: () => ({ output: "missing" }) as unknown as LogicalAgentExecutionResult<string>,
    });

    expect(result.status).toBe("failed");
    expect(result.tasks[0]?.error).toContain("must declare sideEffects");
  });

  it("emits a trace, checkpoints completed work, and resumes only the unfinished suffix", async () => {
    const store = createInMemoryLogicalAgentCheckpointStore<string>();
    const events: string[] = [];
    let rootRuns = 0;
    let specialistRuns = 0;
    const tasks: Array<LogicalAgentTask<{ ask: string }>> = [
      { id: "root", agentId: "data_cleaning", input: { ask: "recover" } },
      {
        id: "specialist",
        agentId: "risk_check",
        input: { ask: "recover" },
        dependsOn: ["root"],
      },
      {
        id: "final",
        agentId: "final_precheck",
        input: { ask: "recover" },
        dependsOn: ["specialist"],
      },
    ];
    const executor = ({ task }: { task: LogicalAgentTask<{ ask: string }> }) => {
      if (task.id === "root") {
        rootRuns += 1;
      }
      if (task.id === "specialist") {
        specialistRuns += 1;
        if (specialistRuns === 1) {
          throw new Error("transient specialist failure");
        }
      }
      return { output: task.id, sideEffects: [] } as const;
    };

    const first = await runLogicalAgentPlan({
      runId: "recoverable-run",
      tasks,
      executor,
      checkpointStore: store,
      eventSink: (event) => events.push(event.kind),
      handoffs: [
        {
          fromTaskId: "root",
          toTaskId: "specialist",
          contextScope: "dependency_results",
          ownership: "transferred",
          reason: "risk specialist owns the next decision",
        },
      ],
    });

    expect(first.status).toBe("failed");
    expect(first.events.map((event) => event.kind)).toContain("checkpoint_saved");
    expect(first.events.map((event) => event.kind)).toContain("handoff");
    expect(store.load("recoverable-run")).toMatchObject({
      schemaVersion: LOGICAL_AGENT_CHECKPOINT_SCHEMA_VERSION,
      completedTaskIds: ["root"],
    });
    const firstCheckpoint = store.load("recoverable-run");
    expect(firstCheckpoint?.lastEventSequence).toBe(
      first.events.find((event) => event.kind === "checkpoint_saved")?.sequence,
    );

    const resumed = await runLogicalAgentPlan({
      runId: "recoverable-run",
      resume: true,
      tasks,
      executor,
      checkpointStore: store,
      eventSink: (event) => events.push(event.kind),
      handoffs: [
        {
          fromTaskId: "root",
          toTaskId: "specialist",
          contextScope: "dependency_results",
          ownership: "transferred",
          reason: "risk specialist owns the next decision",
        },
      ],
    });

    expect(resumed.status).toBe("completed");
    expect(resumed.resumed).toBe(true);
    expect(resumed.events[0]?.kind).toBe("run_resumed");
    expect(resumed.events[0]?.sequence).toBe((firstCheckpoint?.lastEventSequence ?? 0) + 1);
    expect(rootRuns).toBe(1);
    expect(specialistRuns).toBe(2);
    expect(events).toContain("run_completed");
    await expect(
      runLogicalAgentPlan({
        runId: "recoverable-run",
        resume: true,
        tasks: tasks.map((task) => ({ ...task, input: { ask: "different-plan" } })),
        executor,
        checkpointStore: store,
      }),
    ).rejects.toThrow("fingerprint mismatch");
  });

  it("persists checkpoints below the active state root and resumes from a fresh store instance", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "lcx-logical-agent-state-"));
    const firstStore = createCanonicalStateRootLogicalAgentCheckpointStore<string>({ stateDir });
    const tasks: Array<LogicalAgentTask<{ ask: string }>> = [
      { id: "root", agentId: "data_cleaning", input: { ask: "persist" } },
      { id: "final", agentId: "final_precheck", input: { ask: "persist" }, dependsOn: ["root"] },
    ];
    let rootRuns = 0;
    let finalRuns = 0;
    const executor = ({ task }: { task: LogicalAgentTask<{ ask: string }> }) => {
      if (task.id === "root") {
        rootRuns += 1;
      }
      if (task.id === "final") {
        finalRuns += 1;
        if (finalRuns === 1) {
          throw new Error("stop after durable prefix");
        }
      }
      return { output: task.id, sideEffects: [] } as const;
    };

    const first = await runLogicalAgentPlan({
      runId: "durable-restart-run",
      tasks,
      executor,
      checkpointStore: firstStore,
    });
    expect(first.status).toBe("failed");

    const checkpointPath = resolveLogicalAgentCheckpointPath("durable-restart-run", stateDir);
    expect(fs.existsSync(checkpointPath)).toBe(true);
    expect(path.dirname(checkpointPath)).toBe(
      path.join(stateDir, "agents", "logical-agent-checkpoints"),
    );
    expect(() => fs.statSync(checkpointPath)).not.toThrow();

    const restartedStore = createCanonicalStateRootLogicalAgentCheckpointStore<string>({
      stateDir,
    });
    const resumed = await runLogicalAgentPlan({
      runId: "durable-restart-run",
      resume: true,
      tasks,
      executor,
      checkpointStore: restartedStore,
    });
    expect(resumed.status).toBe("completed");
    expect(resumed.resumed).toBe(true);
    expect(rootRuns).toBe(1);
    expect(finalRuns).toBe(2);
  });

  it("runs input and output guardrails inside the shared pool boundary", async () => {
    const inputBlocked = await runLogicalAgentPlan({
      pool: new LogicalAgentPool({
        guardrails: {
          input: ({ input }) => {
            if (typeof input === "object" && input !== null && "ask" in input) {
              throw new Error("input guardrail blocked unsafe request");
            }
          },
        },
      }),
      tasks: [{ id: "input-blocked", agentId: "data_cleaning", input: { ask: "unsafe" } }],
      executor: () => ({ output: "never", sideEffects: [] }),
    });
    expect(inputBlocked.status).toBe("failed");
    expect(inputBlocked.tasks[0]?.error).toBe("input guardrail blocked unsafe request");

    const outputBlocked = await runLogicalAgentPlan({
      pool: new LogicalAgentPool({
        guardrails: {
          output: ({ output }) => {
            if (output === "unsafe-output") {
              throw new Error("output guardrail blocked unsafe result");
            }
          },
        },
      }),
      tasks: [{ id: "output-blocked", agentId: "data_cleaning", input: { ask: "safe" } }],
      executor: () => ({ output: "unsafe-output", sideEffects: [] }),
    });
    expect(outputBlocked.status).toBe("failed");
    expect(outputBlocked.tasks[0]?.error).toBe("output guardrail blocked unsafe result");
  });

  it("rejects a handoff that is not backed by a dependency edge", async () => {
    await expect(
      runLogicalAgentPlan({
        tasks: [
          { id: "root", agentId: "data_cleaning", input: { ask: "x" } },
          { id: "specialist", agentId: "risk_check", input: { ask: "x" } },
        ],
        executor: () => ({ output: "never", sideEffects: [] }),
        handoffs: [
          {
            fromTaskId: "root",
            toTaskId: "specialist",
            contextScope: "dependency_results",
            ownership: "transferred",
          },
        ],
      }),
    ).rejects.toThrow("must be a dependency");
  });
});
