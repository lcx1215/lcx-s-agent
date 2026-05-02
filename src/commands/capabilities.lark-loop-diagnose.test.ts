import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { larkLoopDiagnoseCommand } from "./capabilities.js";
import { readReceiptStats } from "./capabilities/lark-loop-diagnose.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const runtime = createTestRuntime();

describe("larkLoopDiagnoseCommand", () => {
  beforeEach(() => {
    runtime.log.mockClear();
    runtime.error.mockClear();
    runtime.exit.mockClear();
  });

  it("reports the local loop as ready and live receipts as the remaining blocker", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-lark-diagnose-test-"));
    await larkLoopDiagnoseCommand({ workspaceDir: workspace, json: true }, runtime);

    expect(runtime.log).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(runtime.log.mock.calls[0]?.[0])) as {
      ok: boolean;
      gatewayAgentModelParamSchema: { ok: boolean; error: string | null };
      localLoop: {
        ok: boolean;
        backendTool: string;
        analysisStatus: string;
        orchestration: { primaryModules: string[]; requiredTools: string[]; boundaries: string[] };
      };
      liveHandoffReceipts: {
        count: number;
        workspaceDir: string;
        financeOrchestrationCount: number;
        latestFinanceOrchestration: unknown;
        latestReceiptFinanceReplay: unknown;
        workspaces: Array<{
          count: number;
          workspaceDir: string;
          financeOrchestrationCount: number;
        }>;
      };
      nextBlocker: string;
    };
    expect(payload.ok).toBe(false);
    expect(payload.gatewayAgentModelParamSchema).toEqual({ ok: true, error: null });
    expect(payload.localLoop.ok).toBe(true);
    expect(payload.localLoop.backendTool).toBe("finance_learning_pipeline_orchestrator");
    expect(payload.localLoop.analysisStatus).toBe("research_review_ready");
    expect(payload.localLoop.orchestration.primaryModules).toEqual(
      expect.arrayContaining(["etf_regime", "portfolio_risk_gates", "quant_math", "causal_map"]),
    );
    expect(payload.localLoop.orchestration.requiredTools).toEqual(
      expect.arrayContaining(["finance_framework_core_inspect", "quant_math", "review_panel"]),
    );
    expect(payload.localLoop.orchestration.boundaries).toContain("no_execution_authority");
    expect(payload.liveHandoffReceipts.count).toBe(0);
    expect(payload.liveHandoffReceipts.financeOrchestrationCount).toBe(0);
    expect(payload.liveHandoffReceipts.latestFinanceOrchestration).toBeNull();
    expect(payload.liveHandoffReceipts.latestReceiptFinanceReplay).toBeNull();
    expect(payload.liveHandoffReceipts.workspaceDir).toBe(workspace);
    expect(payload.liveHandoffReceipts.workspaces).toEqual([
      expect.objectContaining({ count: 0, financeOrchestrationCount: 0, workspaceDir: workspace }),
    ]);
    expect(payload.nextBlocker).toBe("no_live_lark_user_inbound_handoff_receipt_yet");
  });

  it("aggregates receipts across inspected agent workspaces", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-lark-diagnose-receipts-"));
    const receiptDir = path.join(
      workspace,
      "memory",
      "lark-language-handoff-receipts",
      "2026-05-02",
    );
    await fs.promises.mkdir(receiptDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(receiptDir, "om_live.json"),
      JSON.stringify({
        generatedAt: "2026-05-02T12:00:00.000Z",
        boundary: "language_handoff_only",
        userMessage: "学习 ETF 因子择时、持仓风险控制、回撤数学和因果证伪。",
        handoff: {
          family: "market_capability_learning_intake",
          source: "api",
        },
        financeBrainOrchestration: {
          primaryModules: ["etf_regime", "portfolio_risk_gates", "quant_math", "causal_map"],
          supportingModules: ["finance_learning_memory"],
          requiredTools: [
            "finance_learning_capability_apply",
            "finance_framework_core_inspect",
            "quant_math",
            "review_tier",
            "review_panel",
          ],
          reviewTools: ["review_tier", "review_panel"],
          boundaries: ["research_only", "no_execution_authority", "no_model_math_guessing"],
        },
      }),
      "utf8",
    );

    const stats = await readReceiptStats({ workspaceDir: workspace });

    expect(stats).toMatchObject({
      workspaceDir: workspace,
      count: 1,
      latestPath: "memory/lark-language-handoff-receipts/2026-05-02/om_live.json",
      latestGeneratedAt: "2026-05-02T12:00:00.000Z",
      financeOrchestrationCount: 1,
      latestFinanceOrchestration: {
        receiptPath: "memory/lark-language-handoff-receipts/2026-05-02/om_live.json",
        generatedAt: "2026-05-02T12:00:00.000Z",
        family: "market_capability_learning_intake",
        source: "api",
        primaryModules: ["etf_regime", "portfolio_risk_gates", "quant_math", "causal_map"],
        supportingModules: ["finance_learning_memory"],
        requiredTools: [
          "finance_learning_capability_apply",
          "finance_framework_core_inspect",
          "quant_math",
          "review_tier",
          "review_panel",
        ],
        reviewTools: ["review_tier", "review_panel"],
        boundaries: ["research_only", "no_execution_authority", "no_model_math_guessing"],
      },
      latestReceiptFinanceReplay: {
        receiptPath: "memory/lark-language-handoff-receipts/2026-05-02/om_live.json",
        generatedAt: "2026-05-02T12:00:00.000Z",
        family: "market_capability_learning_intake",
        source: "api",
        primaryModules: expect.arrayContaining([
          "etf_regime",
          "portfolio_risk_gates",
          "quant_math",
          "causal_map",
        ]),
        supportingModules: ["finance_learning_memory"],
        requiredTools: expect.arrayContaining([
          "finance_framework_core_inspect",
          "quant_math",
          "review_tier",
          "review_panel",
        ]),
        reviewTools: ["review_tier", "review_panel"],
        boundaries: expect.arrayContaining(["research_only", "no_execution_authority"]),
      },
      workspaces: [
        expect.objectContaining({
          count: 1,
          financeOrchestrationCount: 1,
          workspaceDir: workspace,
        }),
      ],
    });
  });

  it("replays finance orchestration for the latest receipt when old live receipt lacks it", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-lark-diagnose-replay-"));
    const receiptDir = path.join(
      workspace,
      "memory",
      "lark-language-handoff-receipts",
      "2026-05-02",
    );
    await fs.promises.mkdir(receiptDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(receiptDir, "om_nasdaq_math.json"),
      JSON.stringify({
        generatedAt: "2026-05-02T21:24:32.499Z",
        boundary: "language_handoff_only",
        userMessage: "用你的数学知识分析下最近一个月的纳斯达克指数",
        handoff: {
          family: "technical_timing",
          source: "api",
        },
      }),
      "utf8",
    );

    const stats = await readReceiptStats({ workspaceDir: workspace });

    expect(stats.financeOrchestrationCount).toBe(0);
    expect(stats.latestFinanceOrchestration).toBeNull();
    expect(stats.latestReceiptFinanceReplay).toMatchObject({
      receiptPath: "memory/lark-language-handoff-receipts/2026-05-02/om_nasdaq_math.json",
      generatedAt: "2026-05-02T21:24:32.499Z",
      family: "technical_timing",
      source: "api",
      primaryModules: expect.arrayContaining(["etf_regime", "quant_math", "causal_map"]),
      supportingModules: ["finance_learning_memory"],
      requiredTools: expect.arrayContaining([
        "finance_framework_core_inspect",
        "finance_framework_etf_regime_producer",
        "quant_math",
        "review_tier",
        "review_panel",
      ]),
      boundaries: expect.arrayContaining(["research_only", "no_model_math_guessing"]),
    });
  });
});
