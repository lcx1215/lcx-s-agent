import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateFinanceRouting, type FinanceRoutingCase } from "./finance-routing-eval.js";
import { buildCentralBrainPrompt, type CentralBrain } from "./model-brain.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});
const task: FinanceRoutingCase = {
  id: "rates",
  ask: "研究宏观利率变化",
  asOf: "2026-09-22T00:00:00.000Z",
  requiredModules: ["macro_rates_inflation"],
  allowedModules: ["macro_rates_inflation"],
};
async function run(brain: CentralBrain) {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "finance-route-eval-"));
  dirs.push(workspaceDir);
  return evaluateFinanceRouting({ testCase: task, brain, workspaceDir, evidenceKind: "fixture" });
}
function brain(moduleId?: string, extras = {}): CentralBrain {
  return {
    propose: async (perception) => {
      const prompt = buildCentralBrainPrompt(perception);
      expect(prompt).not.toContain('"requiredModules"');
      expect(prompt).not.toContain('"allowedModules"');
      if (moduleId) {
        expect(prompt).toContain(`"id":"${moduleId}"`);
      }
      return {
        kind: "proposed",
        provider: "fixture",
        modelId: "fixture",
        plan: {
          note: "test",
          actions: [
            {
              ownerId: "finance_research_run",
              args: {
                ask: task.ask,
                asOf: task.asOf,
                ...(moduleId
                  ? { moduleSelection: { moduleIds: [moduleId], rationale: "catalog selection" } }
                  : {}),
                ...extras,
              },
            },
          ],
        },
      };
    },
  };
}
describe("finance routing comparison through the real Harness", () => {
  it("does not credit an explicit model selection that merely equals rule routing", async () => {
    const result = await run(brain("macro_rates_inflation"));
    expect(result.verdict).toBe("equal");
    expect(result.callerSelectedModules).toBe(true);
    expect(result.evidenceKind).toBe("fixture");
    expect(result.promotionApplied).toBe(false);
    expect(result.receipt.steps[0].status).toBe("ran_ok");
  });
  it("identifies a valid but worse catalog selection", async () => {
    const result = await run(brain("technical_timing"));
    expect(result.verdict).toBe("route_worse");
    expect(result.candidate?.missing).toContain("macro_rates_inflation");
    expect(result.candidate?.unnecessary).toContain("technical_timing");
  });
  it("keeps rule fallback distinct from autonomous module selection", async () => {
    const result = await run(brain());
    expect(result.verdict).toBe("equal");
    expect(result.callerSelectedModules).toBe(false);
  });
  it.each([{ live: true }, { ask: "different task" }])(
    "blocks task or authority changes: %j",
    async (extra) => {
      const result = await run(brain("macro_rates_inflation", extra));
      expect(result.verdict).toBe("not_assessable");
      expect(result.receipt.steps[0].status).toBe("blocked_by_gate");
      expect(result.candidate).toBeUndefined();
    },
  );
  it("records model failures without assigning a successful routing score", async () => {
    const result = await run({
      propose: async () => {
        throw new Error("model unavailable");
      },
    });
    expect(result.receipt.brainCall.outcome).toBe("failed");
    expect(result.verdict).toBe("not_assessable");
  });
});
