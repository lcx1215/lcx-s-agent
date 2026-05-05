import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { languageBrainLoopSmokeCommand } from "./capabilities.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const runtime = createTestRuntime();

describe("languageBrainLoopSmokeCommand", () => {
  beforeEach(() => {
    runtime.log.mockClear();
    runtime.error.mockClear();
    runtime.exit.mockClear();
  });

  it("runs the local language-brain-analysis-memory loop and writes a receipt", async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-loop-smoke-test-"));
    await languageBrainLoopSmokeCommand({ workspaceDir, json: true }, runtime);

    expect(runtime.log).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(runtime.log.mock.calls[0]?.[0])) as {
      ok: boolean;
      workspaceDir: string;
      language: { family: string; backendTool: string };
      orchestration: {
        primaryModules: string[];
        supportingModules: string[];
        requiredTools: string[];
        reviewTools: string[];
        boundaries: string[];
      };
      brain: { candidateCount: number; synthesisMode: string };
      analysis: { eventReviewStatus: string; noActionBoundary: boolean };
      math: {
        localTool: string;
        checks: string[];
        rollingBetaWindows: number;
        noModelMathGuessing: boolean;
      };
      visibleReply: {
        text: string;
        startsWithPlainSummary: boolean;
        hidesInternalLabels: boolean;
        includesResearchBoundary: boolean;
        includesProofPath: boolean;
      };
      adjacentApplication: {
        userAsk: string;
        text: string;
        primaryModules: string[];
        supportingModules: string[];
        requiredTools: string[];
        boundaries: string[];
        reviewTools: string[];
        missingFreshInputs: string[];
        blocksNumericGuessingWithoutInputs: boolean;
        startsWithPlainSummary: boolean;
        hidesInternalLabels: boolean;
        includesResearchBoundary: boolean;
      };
      review: {
        tier: string;
        reviewers: string[];
        tokenPolicy: string;
        reasons: string[];
      };
      reviewPanel: {
        status: string;
        tier: string;
        providerCallsMade: boolean;
        reviewerTasks: unknown[];
        receiptPath: string;
        localArbitration: {
          status: string;
          providerCallsMade: boolean;
          reviewerFindings: unknown[];
        };
      };
      memory: { loopReceiptPath: string };
      protectedMemoryUntouched: boolean;
      languageCorpusUntouched: boolean;
      noRemoteFetchOccurred: boolean;
      noExecutionAuthority: boolean;
    };

    expect(payload.ok).toBe(true);
    expect(payload.workspaceDir).toBe(workspaceDir);
    expect(payload.language.family).toBe("market_capability_learning_intake");
    expect(payload.language.backendTool).toBe("finance_learning_pipeline_orchestrator");
    expect(payload.orchestration.primaryModules).toEqual(
      expect.arrayContaining([
        "etf_regime",
        "technical_timing",
        "portfolio_risk_gates",
        "quant_math",
        "event_driven",
        "causal_map",
      ]),
    );
    expect(payload.orchestration.supportingModules).toContain("finance_learning_memory");
    expect(payload.orchestration.requiredTools).toEqual(
      expect.arrayContaining([
        "finance_framework_core_inspect",
        "finance_learning_capability_apply",
        "quant_math",
        "review_tier",
        "review_panel",
      ]),
    );
    expect(payload.orchestration.reviewTools).toEqual(["review_tier", "review_panel"]);
    expect(payload.orchestration.boundaries).toEqual(
      expect.arrayContaining(["research_only", "no_execution_authority", "no_model_math_guessing"]),
    );
    expect(payload.brain.candidateCount).toBe(6);
    expect(payload.brain.synthesisMode).toBe("multi_capability_synthesis");
    expect(payload.analysis.eventReviewStatus).toBe("research_review_ready");
    expect(payload.analysis.noActionBoundary).toBe(true);
    expect(payload.math.localTool).toBe("quant_math");
    expect(payload.math.checks).toEqual([
      "risk_budget_deviation",
      "rolling_beta",
      "drawdown_duration",
      "calmar_ratio",
    ]);
    expect(payload.math.rollingBetaWindows).toBe(4);
    expect(payload.math.noModelMathGuessing).toBe(true);
    expect(payload.visibleReply.startsWithPlainSummary).toBe(true);
    expect(payload.visibleReply.hidesInternalLabels).toBe(true);
    expect(payload.visibleReply.includesResearchBoundary).toBe(true);
    expect(payload.visibleReply.includesProofPath).toBe(true);
    expect(payload.visibleReply.text).toMatch(/^当前判断：/u);
    expect(payload.visibleReply.text).toContain("research-only");
    expect(payload.visibleReply.text).not.toContain("primaryModules");
    expect(payload.visibleReply.text).not.toContain("backendTool");
    expect(payload.visibleReply.text).not.toContain("{");
    expect(payload.adjacentApplication.userAsk).toContain("QQQ");
    expect(payload.adjacentApplication.text).toMatch(/^当前判断：/u);
    expect(payload.adjacentApplication.text).toContain("缺失输入：");
    expect(payload.adjacentApplication.text).toContain("不能靠模型补数字");
    expect(payload.adjacentApplication.text).not.toContain("primaryModules");
    expect(payload.adjacentApplication.text).not.toContain("backendTool");
    expect(payload.adjacentApplication.text).not.toContain("{");
    expect(payload.adjacentApplication.primaryModules).toEqual(
      expect.arrayContaining([
        "macro_rates_inflation",
        "credit_liquidity",
        "fx_dollar",
        "etf_regime",
        "company_fundamentals_value",
        "portfolio_risk_gates",
        "quant_math",
        "causal_map",
      ]),
    );
    expect(payload.adjacentApplication.supportingModules).toContain("finance_learning_memory");
    expect(payload.adjacentApplication.requiredTools).toEqual(
      expect.arrayContaining([
        "finance_learning_capability_apply",
        "finance_framework_macro_rates_inflation_producer",
        "finance_framework_credit_liquidity_producer",
        "finance_framework_fx_dollar_producer",
        "finance_framework_company_fundamentals_value_producer",
        "quant_math",
        "review_panel",
      ]),
    );
    expect(payload.adjacentApplication.boundaries).toEqual(
      expect.arrayContaining(["research_only", "no_execution_authority", "no_model_math_guessing"]),
    );
    expect(payload.adjacentApplication.reviewTools).toEqual(["review_tier", "review_panel"]);
    expect(payload.adjacentApplication.missingFreshInputs).toEqual(
      expect.arrayContaining([
        "current_rates_and_inflation_inputs",
        "current_credit_and_liquidity_inputs",
        "current_usd_liquidity_or_dxy_inputs",
        "qqq_tlt_nvda_current_prices_and_trend_inputs",
        "nvda_latest_fundamental_and_ai_capex_inputs",
        "position_weights_and_return_series",
        "portfolio_risk_limits",
      ]),
    );
    expect(payload.adjacentApplication.blocksNumericGuessingWithoutInputs).toBe(true);
    expect(payload.adjacentApplication.startsWithPlainSummary).toBe(true);
    expect(payload.adjacentApplication.hidesInternalLabels).toBe(true);
    expect(payload.adjacentApplication.includesResearchBoundary).toBe(true);
    expect(payload.review.tier).toBe("three_model_review");
    expect(payload.review.reviewers).toEqual([
      "logic_and_expression",
      "risk_and_countercase",
      "math_and_evidence_consistency",
    ]);
    expect(payload.review.tokenPolicy).toBe("use_three_model_panel");
    expect(payload.review.reasons).toContain("has_quant_math_results");
    expect(payload.review.reasons).toContain("operator_requested_strict_review");
    expect(payload.reviewPanel.status).toBe("three_model_panel_arbitrated");
    expect(payload.reviewPanel.tier).toBe("three_model_review");
    expect(payload.reviewPanel.providerCallsMade).toBe(false);
    expect(payload.reviewPanel.reviewerTasks).toHaveLength(3);
    expect(payload.reviewPanel.localArbitration).toMatchObject({
      status: "passed",
      providerCallsMade: false,
    });
    expect(payload.reviewPanel.localArbitration.reviewerFindings).toHaveLength(3);
    expect(payload.reviewPanel.receiptPath).toMatch(
      /^memory\/review-panel-receipts\/\d{4}-\d{2}-\d{2}\//u,
    );
    expect(payload.protectedMemoryUntouched).toBe(true);
    expect(payload.languageCorpusUntouched).toBe(true);
    expect(payload.noRemoteFetchOccurred).toBe(true);
    expect(payload.noExecutionAuthority).toBe(true);
    expect(fs.existsSync(path.join(workspaceDir, payload.memory.loopReceiptPath))).toBe(true);
  });
});
