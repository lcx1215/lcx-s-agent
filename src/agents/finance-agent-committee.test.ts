import { describe, expect, it } from "vitest";
import { buildFinanceCommitteeContext, runFinanceCommittee } from "./finance-agent-committee.js";
import type { LogicalAgentModelAdapter } from "./logical-agent-model-router.js";
import { LogicalAgentPool } from "./logical-agent-pool.js";

const input = {
  ask: "分析一个有时间戳证据的组合风险候选方案",
  asOf: "2026-09-07T10:00:00+08:00",
  decisionMode: "conditional_trade_candidate" as const,
  evidence: [
    {
      id: "e1",
      text: "公开材料中的风险事实",
      source: "test-source",
      timestamp: "2026-09-07T09:00:00+08:00",
    },
  ],
  userConstraints: { horizon: "quarter", maxDrawdown: "bounded" },
};

describe("finance agent committee", () => {
  it("builds one immutable fact packet shared by every role", () => {
    const context = buildFinanceCommitteeContext(input);
    expect(context.schemaVersion).toBe("lcx_finance_committee_context_v1");
    expect(context.decisionMode).toBe("conditional_trade_candidate");
    expect(context.evidence[0]).toEqual(input.evidence[0]);
    expect(() => {
      (context.userConstraints as Record<string, unknown>).horizon = "changed";
    }).toThrow();
  });

  it("runs the existing role DAG with shared context and does not claim monolith equivalence", async () => {
    const observedContexts: unknown[] = [];
    const result = await runFinanceCommittee({
      input,
      pool: new LogicalAgentPool({ maxConcurrency: 2 }),
      executor: ({ task, sharedContext, dependencyResults }) => {
        observedContexts.push(sharedContext);
        return {
          output: {
            agentId: task.agentId,
            dependencyCount: Object.keys(dependencyResults).length,
          },
          sideEffects: [],
        };
      },
      runId: "finance-committee-test",
    });

    expect(result.execution.status).toBe("completed");
    expect(result.coverage.equivalenceStatus).toBe("committee_candidate");
    expect(result.coverage.equivalenceClaim).toBe("not_claimed");
    expect(result.coverage.missingLanes).toEqual([]);
    expect(observedContexts).toHaveLength(10);
    expect(
      observedContexts.every(
        (context) =>
          (context as { schemaVersion: string }).schemaVersion ===
          "lcx_finance_committee_context_v1",
      ),
    ).toBe(true);
  });

  it("routes the production committee owner through an injected role policy", async () => {
    const adapter: LogicalAgentModelAdapter = {
      id: "committee-test-adapter",
      provider: "local-fixture",
      modelId: "committee-fixture-v1",
      mode: "deterministic",
      capabilities: ["json"],
      requiredTools: [],
      requiredSideEffects: ["local_compute"],
      invoke: async ({ payload }) => payload,
    };
    const result = await runFinanceCommittee({
      input,
      modelRouting: {
        revision: "committee-test-v1",
        adapters: [adapter],
        defaultPolicy: {
          primary: adapter.id,
          requiredCapabilities: ["json"],
          maxInputBytes: 64_000,
          timeoutMs: 1_000,
        },
      },
      executor: async ({ modelSlot, signal, task }) => ({
        output: await modelSlot.invoke({ taskId: task.id }, signal),
        sideEffects: [],
      }),
      runId: "finance-committee-routed",
    });

    expect(result.execution.status).toBe("completed");
    expect(result.execution.tasks).toHaveLength(10);
    expect(
      result.execution.tasks.every(
        (task) =>
          task.modelCalls?.length === 1 &&
          task.modelCalls[0]?.adapterId === adapter.id &&
          task.modelCalls[0]?.evidence === "not-observed",
      ),
    ).toBe(true);
  });
});
