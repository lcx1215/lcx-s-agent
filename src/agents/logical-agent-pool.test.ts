import { describe, expect, it } from "vitest";
import {
  buildDefaultLogicalAgentPlan,
  LOGICAL_AGENT_DEFINITIONS,
  type LogicalAgentExecutionResult,
  type LogicalAgentTask,
  LogicalAgentPool,
  runLogicalAgentPlan,
} from "./logical-agent-pool.js";

describe("logical agent pool", () => {
  it("defines ten logical roles while binding every role to one shared local model", () => {
    expect(LOGICAL_AGENT_DEFINITIONS).toHaveLength(10);
    expect(new Set(LOGICAL_AGENT_DEFINITIONS.map((agent) => agent.modelBinding))).toEqual(
      new Set(["shared_local_model"]),
    );
    expect(
      LOGICAL_AGENT_DEFINITIONS.every(
        (agent) =>
          agent.capabilities.allowedSideEffects.length === 3 &&
          agent.capabilities.forbiddenSideEffects.includes("provider_call") &&
          agent.capabilities.forbiddenSideEffects.includes("external_message"),
      ),
    ).toBe(true);
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
    expect(modelSlots.size).toBe(1);
    expect([...modelSlots][0]).toMatchObject({ modelId: "Qwen/Qwen3-0.6B", maxLoadedModels: 1 });
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
      executor: async ({ modelSlot, task }) => ({
        output: await modelSlot.invoke(task.id, new AbortController().signal),
        sideEffects: [],
      }),
    });

    expect(result.status).toBe("completed");
    expect(invocations).toEqual(["a", "b"]);
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
    expect(pool.status.activeRuns).toBe(0);
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

  it("rejects timer values that Node would truncate", () => {
    expect(() => new LogicalAgentPool({ taskTimeoutMs: 2_147_483_648 })).toThrow(
      "must not exceed 2147483647ms",
    );
  });

  it("rejects undeclared side effects at the capability boundary", async () => {
    const result = await runLogicalAgentPlan({
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
    const result = await runLogicalAgentPlan({
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

  it("requires every executor to declare side effects", async () => {
    const result = await runLogicalAgentPlan({
      tasks: [{ id: "missing-contract", agentId: "data_cleaning", input: { ask: "x" } }],
      executor: () => ({ output: "missing" }) as unknown as LogicalAgentExecutionResult<string>,
    });

    expect(result.status).toBe("failed");
    expect(result.tasks[0]?.error).toContain("must declare sideEffects");
  });
});
