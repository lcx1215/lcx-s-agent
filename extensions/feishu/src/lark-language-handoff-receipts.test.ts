import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTempWorkspace } from "../../../src/test-helpers/workspace.js";
import {
  renderLarkAnswerComposerNotice,
  renderLarkFinanceBrainOrchestrationNotice,
  writeLarkLanguageHandoffReceipt,
} from "./lark-language-handoff-receipts.js";

describe("lark language handoff receipts", () => {
  let workspaceDir: string | undefined;

  afterEach(async () => {
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      workspaceDir = undefined;
    }
  });

  it("writes a language-only handoff receipt with backend proof requirements", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-lark-handoff-receipt-");

    const result = await writeLarkLanguageHandoffReceipt({
      workspaceDir,
      generatedAt: "2026-04-30T12:00:00.000Z",
      agentId: "main",
      targetSurface: "learning_command",
      effectiveSurface: "learning_command",
      chatId: "oc-control",
      sessionKey: "session-1",
      messageId: "om_123",
      userMessage: "看看 GitHub 热榜项目哪些功能能加进来，我们内部有没有雏形",
      handoff: {
        family: "learning_external_source",
        source: "api",
        confidence: 0.91,
        targetSurface: "learning_command",
        deterministicSurface: "learning_command",
        workOrder: {
          schemaVersion: 1,
          family: "learning_external_source",
          targetSurface: "learning_command",
          objective: "inspect an external source before learning",
          source: "api_planner_audited",
          plannerFamily: "learning_external_source",
          requiredModules: ["source_grounding"],
          backendTool: "github_project_capability_intake",
          evidenceRequired: ["source URL or local path"],
          safetyBoundaries: ["research_only"],
          outputContract: ["failedReason if source missing"],
          validation: {
            apiFamilyAccepted: true,
            familyContractMatched: true,
            deterministicSurface: "learning_command",
            notes: ["no_local_semantic_live_decomposition"],
          },
        },
        backendToolContract: {
          toolName: "github_project_capability_intake",
          learningIntent: "看看 GitHub 热榜项目哪些功能能加进来，我们内部有没有雏形",
          sourceRequirement: "repo_url_or_readme_summary_required",
          expectedProof: ["capabilityFamily", "existingEmbryos", "adoptionDecision"],
        },
        notice: "handoff",
      },
    });

    expect(result.relativePath).toBe(
      "memory/lark-language-handoff-receipts/2026-04-30/om_123.json",
    );
    expect(result.artifact).toMatchObject({
      boundary: "language_handoff_only",
      noFinanceLearningArtifact: true,
      noExecutionApproval: true,
      noLiveProbeProof: true,
      handoff: {
        family: "learning_external_source",
        source: "api",
        backendToolContract: {
          toolName: "github_project_capability_intake",
        },
        workOrder: {
          family: "learning_external_source",
          source: "api_planner_audited",
          validation: {
            familyContractMatched: true,
          },
        },
        expectedProof: ["capabilityFamily", "existingEmbryos", "adoptionDecision"],
        missingBeforeExecution: ["repo URL, README/docs summary, or selected feature summary"],
      },
    });

    const written = await fs.readFile(path.join(workspaceDir, result.relativePath), "utf8");
    expect(written).toContain('"boundary": "language_handoff_only"');
    expect(written).toContain('"github_project_capability_intake"');
    expect(written).not.toContain("financeBrainOrchestration");
  });

  it("adds a finance brain orchestration plan for finance learning handoffs", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-lark-finance-handoff-receipt-");

    const result = await writeLarkLanguageHandoffReceipt({
      workspaceDir,
      generatedAt: "2026-05-02T12:00:00.000Z",
      agentId: "main",
      targetSurface: "learning_command",
      effectiveSurface: "learning_command",
      chatId: "oc-control",
      sessionKey: "session-2",
      messageId: "om_finance_123",
      userMessage:
        "学习一套 ETF 因子择时和持仓风险控制方法，结合利率、基本面、技术择时、回撤数学和因果证伪，最后给 application_ready。",
      handoff: {
        family: "market_capability_learning_intake",
        source: "api",
        confidence: 0.94,
        targetSurface: "learning_command",
        deterministicSurface: "learning_command",
        backendToolContract: {
          toolName: "finance_learning_pipeline_orchestrator",
          learningIntent:
            "学习一套 ETF 因子择时和持仓风险控制方法，结合利率、基本面、技术择时、回撤数学和因果证伪，最后给 application_ready。",
          sourceRequirement: "safe_local_or_manual_source_required",
          expectedProof: ["retrievalReceiptPath", "retrievalReviewPath"],
        },
        notice: "handoff",
      },
    });

    expect(result.artifact.financeBrainOrchestration).toMatchObject({
      primaryModules: expect.arrayContaining([
        "macro_rates_inflation",
        "etf_regime",
        "company_fundamentals_value",
        "technical_timing",
        "portfolio_risk_gates",
        "quant_math",
        "causal_map",
      ]),
      supportingModules: ["finance_learning_memory"],
      requiredTools: expect.arrayContaining([
        "finance_learning_capability_apply",
        "finance_framework_core_inspect",
        "quant_math",
        "review_tier",
        "review_panel",
      ]),
      boundaries: expect.arrayContaining([
        "research_only",
        "no_execution_authority",
        "no_model_math_guessing",
      ]),
    });

    const written = await fs.readFile(path.join(workspaceDir, result.relativePath), "utf8");
    expect(written).toContain('"financeBrainOrchestration"');
    expect(written).toContain('"quant_math"');
    expect(written).toContain('"no_execution_authority"');
  });

  it("adds finance brain orchestration for technical market math handoffs", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-lark-technical-math-handoff-receipt-");

    const result = await writeLarkLanguageHandoffReceipt({
      workspaceDir,
      generatedAt: "2026-05-02T21:24:32.499Z",
      agentId: "main",
      targetSurface: "technical_daily",
      effectiveSurface: "technical_daily",
      chatId: "oc-control",
      sessionKey: "session-technical",
      messageId: "om_nasdaq_math",
      userMessage: "用你的数学知识分析下最近一个月的纳斯达克指数",
      handoff: {
        family: "technical_timing",
        source: "api",
        confidence: 0.72,
        targetSurface: "technical_daily",
        deterministicSurface: "technical_daily",
        notice: "handoff",
      },
    });

    expect(result.artifact.financeBrainOrchestration).toMatchObject({
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
    const notice = renderLarkFinanceBrainOrchestrationNotice(
      result.artifact.financeBrainOrchestration,
    );
    expect(notice).toContain("Finance brain orchestration contract");
    expect(notice).toContain("primaryModules=etf_regime,quant_math,causal_map");
    expect(notice).toContain("requiredTools=");
    expect(notice).toContain("do not replace quant_math with model guesses");
  });

  it("renders an answer composer contract that keeps backend labels out of the visible lead", () => {
    const notice = renderLarkAnswerComposerNotice({
      schemaVersion: 1,
      family: "position_risk_adjustment",
      targetSurface: "technical_daily",
      objective: "Answer a TLT position-risk question with research-only boundaries.",
      source: "api_planner_audited",
      plannerFamily: "market_capability_learning_intake",
      requiredModules: ["macro_rates_inflation", "etf_regime", "quant_math"],
      evidenceRequired: ["explicit missing-data list", "risk boundary"],
      safetyBoundaries: ["research_only", "no_execution_authority"],
      outputContract: ["concise judgment", "failedReason when live rates are missing"],
      validation: {
        apiFamilyAccepted: false,
        familyContractMatched: true,
        deterministicSurface: "technical_daily",
        notes: ["no_local_semantic_live_decomposition"],
      },
    });

    expect(notice).toContain("Lark answer composer contract");
    expect(notice).toContain("answer the user's real question first in plain language");
    expect(notice).toContain("do not lead with family, route, modules, receipts");
    expect(notice).toContain("concise judgment");
    expect(notice).toContain("failedReason");
  });

  it("does not add finance orchestration for non-finance handoff wording", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-lark-nonfinance-handoff-receipt-");

    const result = await writeLarkLanguageHandoffReceipt({
      workspaceDir,
      generatedAt: "2026-05-02T12:30:00.000Z",
      agentId: "main",
      targetSurface: "control_room",
      effectiveSurface: "control_room",
      chatId: "oc-control",
      sessionKey: "session-3",
      messageId: "om_nonfinance_123",
      userMessage: "帮我整理 marketing meeting 和 security risk 待办。",
      handoff: {
        family: "control_room_aggregate",
        source: "api",
        confidence: 0.88,
        targetSurface: "control_room",
        deterministicSurface: "control_room",
        notice: "handoff",
      },
    });

    expect(result.artifact.financeBrainOrchestration).toBeUndefined();
  });
});
