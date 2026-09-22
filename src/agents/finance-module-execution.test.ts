import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  FINANCE_BRAIN_MODULES,
  planFinanceBrainOrchestration,
} from "./finance-brain-orchestration.js";
import {
  executeFinanceModuleComposition,
  financeModuleExecutionRegistryIds,
} from "./finance-module-execution.js";
import type { FinanceResearchBatchEvidencePacket } from "./finance-research-batch-runner.js";

function emptyBatch(): FinanceResearchBatchEvidencePacket {
  return {
    schemaVersion: "lcx_finance_research_batch_v1",
    boundary: "finance_research_batch_research_only",
    decisionMode: "research_only",
    correlationId: "module-test",
    asOf: "2026-09-11T00:00:00.000Z",
    useCase: "finance_research_run",
    status: "blocked",
    jobs: [],
    committeeEvidence: [],
    budget: {} as FinanceResearchBatchEvidencePacket["budget"],
    notTouched: [],
  };
}

describe("finance module execution", () => {
  it("keeps the executor registry aligned with every registered finance module", () => {
    expect(financeModuleExecutionRegistryIds()).toEqual(FINANCE_BRAIN_MODULES.map(({ id }) => id));
  });

  it("records every composed node even when no evidence is available", async () => {
    const moduleIds = FINANCE_BRAIN_MODULES.map(({ id }) => id);
    const plan = planFinanceBrainOrchestration({
      text: "全量金融模块研究",
      highStakesConclusion: true,
      moduleSelection: { moduleIds, rationale: "bounded all-module coverage test" },
    });
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-module-execution-"));
    try {
      const result = await executeFinanceModuleComposition({
        ask: "全量金融模块研究",
        asOf: "2026-09-11T00:00:00.000Z",
        plan,
        batch: emptyBatch(),
        workspaceDir,
      });
      expect(result.receipt.compositionNodeIds).toHaveLength(moduleIds.length);
      expect(result.receipt.nodes.map((node) => node.moduleId).toSorted()).toEqual(
        moduleIds.toSorted(),
      );
      expect(result.receipt.nodes).toHaveLength(moduleIds.length);
      for (const node of result.receipt.nodes) {
        const definition = FINANCE_BRAIN_MODULES.find((module) => module.id === node.moduleId);
        expect(node.requiredToolNames).toEqual(definition?.requiredTools);
      }
      expect(result.receipt.moduleToolsDispatched).toBe(false);
      expect(result.evidence).toHaveLength(0);
      expect(
        result.receipt.nodes.every(
          (node) => node.status === "blocked_missing_evidence" || node.status === "failed",
        ),
      ).toBe(true);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("dispatches quant_math from ready historical levels and preserves the evidence link", async () => {
    const plan = planFinanceBrainOrchestration({
      text: "执行模块取消测试",
      highStakesConclusion: true,
      moduleSelection: {
        moduleIds: ["quant_math", "finance_learning_memory", "causal_map"],
        rationale: "bounded quant execution test",
        composition: {
          nodes: [
            { id: "learning", moduleId: "finance_learning_memory", dependsOn: [] },
            { id: "math", moduleId: "quant_math", dependsOn: [] },
            { id: "causal", moduleId: "causal_map", dependsOn: [] },
          ],
          maxReplans: 0,
        },
      },
    });
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-module-quant-"));
    try {
      const batch = {
        ...emptyBatch(),
        status: "completed",
        jobs: [
          {
            jobId: "eod:spy",
            status: "ready",
            request: { collection: "eod_history", instrument: "SPY", assetClass: "us_equity" },
            receipt: {
              records: [{ data: { close: 100 } }, { data: { close: 95 } }, { data: { close: 97 } }],
            },
          },
        ],
      } as unknown as FinanceResearchBatchEvidencePacket;
      const result = await executeFinanceModuleComposition({
        ask: "执行模块取消测试",
        asOf: "2026-09-11T00:00:00.000Z",
        plan,
        batch,
        workspaceDir,
      });
      const quant = result.receipt.nodes.find((node) => node.moduleId === "quant_math");
      expect(quant?.status).toBe("succeeded");
      expect(quant?.toolCalls[0]?.toolName).toBe("quant_math");
      expect(quant?.outputEvidenceIds).toEqual(["finance-module:math"]);
      expect(result.evidence.map((entry) => entry.id)).toContain("finance-module:math");
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("preserves cancellation in every node receipt", async () => {
    const plan = planFinanceBrainOrchestration({
      text: "执行模块取消测试",
      highStakesConclusion: true,
      moduleSelection: {
        moduleIds: ["quant_math", "finance_learning_memory", "causal_map"],
        rationale: "bounded cancellation test",
        composition: {
          nodes: [
            { id: "learning", moduleId: "finance_learning_memory", dependsOn: [] },
            { id: "math", moduleId: "quant_math", dependsOn: [] },
            { id: "causal", moduleId: "causal_map", dependsOn: [] },
          ],
        },
      },
    });
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-module-cancel-"));
    const controller = new AbortController();
    controller.abort(new Error("test cancellation"));
    try {
      const result = await executeFinanceModuleComposition({
        ask: "执行模块取消测试",
        asOf: "2026-09-11T00:00:00.000Z",
        plan,
        batch: emptyBatch(),
        workspaceDir,
        signal: controller.signal,
      });
      expect(result.receipt.moduleToolsDispatched).toBe(false);
      expect(result.receipt.nodes.every((node) => node.status === "cancelled")).toBe(true);
      expect(result.receipt.nodes.every((node) => node.toolCalls.length === 0)).toBe(true);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });
});
