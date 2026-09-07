import { describe, expect, it } from "vitest";
import { buildFinanceCommitteeContext, runFinanceCommittee } from "./finance-agent-committee.js";
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
});
