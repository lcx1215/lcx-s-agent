import { afterEach, describe, expect, it, vi } from "vitest";
import { runFinanceResearchCli } from "../../scripts/operator/lcx-finance-research.ts";
import { runFinanceResearchRun } from "../../src/agents/finance-research-runner.ts";
import {
  LogicalAgentModelRouter,
  type ModelCallReceipt,
} from "../../src/agents/logical-agent-model-router.ts";
import type { LogicalAgentId } from "../../src/agents/logical-agent-pool.ts";
import { LCX_FINANCE_WORKFLOW_ROLE_CONTRACTS } from "../../src/shared/lcx-ontology.ts";

// Intercept transport and collection only. CLI selection, workflow policies,
// role contracts, router dependency tracking and shared budget remain real.
vi.mock("../../src/agents/finance-research-runner.ts", async (original) => {
  const actual = await original<typeof import("../../src/agents/finance-research-runner.ts")>();
  return { ...actual, runFinanceResearchRun: vi.fn(actual.runFinanceResearchRun) };
});
vi.mock("../../src/agents/configured-finance-model-adapter.ts", async (original) => {
  const actual =
    await original<typeof import("../../src/agents/configured-finance-model-adapter.ts")>();
  return {
    ...actual,
    createConfiguredFinanceModelAdapter: (
      _config: unknown,
      options: Parameters<typeof actual.createConfiguredFinanceModelAdapter>[1],
    ) => ({
      id: options!.modelRef!,
      provider: "fixture",
      modelId: options!.modelRef!,
      mode: "deterministic",
      capabilities: ["quality_harness"],
      requiredTools: [],
      requiredSideEffects: [],
      invoke: async ({ payload }: { payload: { agentId: LogicalAgentId } }) => {
        options!.callBudget!.reserve();
        return LCX_FINANCE_WORKFLOW_ROLE_CONTRACTS[payload.agentId].output === "artifact"
          ? {
              kind: "artifact",
              artifact: {
                answer: "Fixture evidence only.",
                claims: [
                  {
                    id: "c1",
                    text: "Fixture evidence only.",
                    status: "supported",
                    evidenceIds: ["e1"],
                  },
                ],
              },
            }
          : {
              kind: "review",
              review: {
                verdict: "pass",
                criticalFindings: [],
                evidenceGaps: [],
                notes: ["Fixture contract checked"],
              },
            };
      },
    }),
  };
});
const args = ["--ask", "Review supplied evidence", "--as-of", "2026-09-08T00:00:00Z"];
const config = {
  agents: {
    defaults: { model: { primary: "fixture/fast", fallbacks: ["fixture/reason", "review/check"] } },
  },
};
afterEach(() => vi.mocked(runFinanceResearchRun).mockClear());

describe("finance CLI responsibility handoff", () => {
  it("dispatches every retired research role through the existing workflow and shared budget", async () => {
    const actual = await vi.importActual<
      typeof import("../../src/agents/finance-research-runner.ts")
    >("../../src/agents/finance-research-runner.ts");
    const receipts: ModelCallReceipt[] = [];
    vi.mocked(runFinanceResearchRun).mockImplementationOnce(async (options) => {
      expect(options.allowProviderCalls).toBe(true);
      expect(options.modelRouting).toBe(options.qualityModelRouting);
      const router = new LogicalAgentModelRouter(options.modelRouting!);
      for (const [name, contract] of Object.entries(LCX_FINANCE_WORKFLOW_ROLE_CONTRACTS)) {
        const role = name as LogicalAgentId;
        await router.invoke({
          role,
          taskId: role,
          correlationId: "handoff",
          payload: {
            agentId: role,
            stage: contract.stage,
            task: "Review supplied evidence",
            evidence: [{ id: "e1" }],
          },
          capabilities: { allowedTools: [], allowedSideEffects: [], forbiddenSideEffects: [] },
          signal: new AbortController().signal,
          dispatch: async (fn) => fn(),
          record: (receipt) => receipts.push(receipt),
        });
      }
      // Ten roles include one deterministic intake: all nine inference reservations
      // share this invocation's budget, so another inference must be rejected.
      await expect(
        router.invoke({
          role: "risk_check",
          taskId: "over-budget",
          correlationId: "handoff",
          payload: { agentId: "risk_check", stage: "risk", task: "Review", evidence: [] },
          capabilities: { allowedTools: [], allowedSideEffects: [], forbiddenSideEffects: [] },
          signal: new AbortController().signal,
          dispatch: async (fn) => fn(),
          record: () => {},
        }),
      ).rejects.toThrow("call_budget_exhausted");
      return actual.runFinanceResearchRun({ input: options.input, liveFetch: false });
    });
    await runFinanceResearchCli(
      [...args, "--live", "--workflow-models", "--max-model-calls", "9"],
      { config },
    );
    expect(receipts).toHaveLength(10);
    expect(receipts.every((receipt) => receipt.outcome === "completed")).toBe(true);
    const model = (role: LogicalAgentId) =>
      receipts.find((receipt) => receipt.role === role)!.modelId;
    expect(model("data_cleaning")).toBe("deterministic-intake-v1");
    expect(model("research_draft")).toBe("fixture/reason");
    expect(model("formatting")).toBe(model("research_draft"));
    expect(model("final_precheck")).not.toBe(model("research_draft"));
  });
  it("rejects the retired local route before dispatching any source or model work", async () => {
    await expect(
      runFinanceResearchCli([...args, "--live", "--model", "local/old", "--adapter", "/missing"], {
        config,
      }),
    ).rejects.toThrow("local research/review roles retired");
    expect(runFinanceResearchRun).not.toHaveBeenCalled();
  });
});
