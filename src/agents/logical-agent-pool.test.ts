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
    const result = await runLogicalAgentPlan({
      pool,
      tasks: [
        { id: "a", agentId: "data_cleaning", input: { value: 1 } },
        { id: "b", agentId: "news_classification", input: { value: 2 } },
      ],
      executor: async ({ input }) => {
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
      executor: async () => {
        await new Promise<never>(() => undefined);
        return { output: "unreachable", sideEffects: [] };
      },
    });

    expect(result.status).toBe("failed");
    expect(result.tasks[0]?.error).toContain("timed out");
    expect(pool.status.activeRuns).toBe(0);
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

  it("requires every executor to declare side effects", async () => {
    const result = await runLogicalAgentPlan({
      tasks: [{ id: "missing-contract", agentId: "data_cleaning", input: { ask: "x" } }],
      executor: () => ({ output: "missing" }) as unknown as LogicalAgentExecutionResult<string>,
    });

    expect(result.status).toBe("failed");
    expect(result.tasks[0]?.error).toContain("must declare sideEffects");
  });
});
