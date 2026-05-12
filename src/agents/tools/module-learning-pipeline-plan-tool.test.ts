import { describe, expect, it } from "vitest";
import { createModuleLearningPipelinePlanTool } from "./module-learning-pipeline-plan-tool.js";

describe("module learning pipeline plan tool", () => {
  it("plans an options module learning run through the existing finance pipeline", async () => {
    const tool = createModuleLearningPipelinePlanTool();

    const result = await tool.execute("options-plan", {
      targetModule: "options_volatility",
      sourceUrlOrPath: "memory/research-sources/options-iv-event-note.md",
      actualReadingScope:
        "Read the IV term-structure, skew, gamma, event calendar, and liquidity sections.",
      existingArtifactPaths: ["memory/research-sources/options-iv-event-note.md"],
      learningIntent: "Learn an options IV event-risk research framework without trade advice.",
    });

    expect(result.details).toEqual(
      expect.objectContaining({
        ok: true,
        boundary: "dev_read_only_module_learning_plan",
        targetModule: "options_volatility",
        moduleFamily: "finance_research",
        status: "missing_evidence",
        liveTouched: false,
        providerConfigTouched: false,
        protectedMemoryTouched: false,
      }),
    );
    expect(result.details).toEqual(
      expect.objectContaining({
        existingToolBridge: expect.objectContaining({
          primaryTool: "finance_learning_pipeline_orchestrator",
          bridgeStatus: "direct_finance_pipeline",
          closestExistingFinanceDomains: expect.arrayContaining([
            "options_volatility",
            "event_driven",
            "portfolio_risk_gates",
          ]),
        }),
        financePipelineArgs: expect.objectContaining({
          sourceType: "manual_article_source",
          allowedActionAuthority: "research_only",
          learningIntent: "Learn an options IV event-risk research framework without trade advice.",
        }),
      }),
    );
    expect(result.details).toHaveProperty(
      "moduleSpecificCapabilityRule",
      expect.stringContaining("IV/skew/gamma"),
    );
    expect(result.details).toHaveProperty(
      "missingEvidence",
      expect.arrayContaining([
        "source_registry_record",
        "capability_card_or_retrieval_receipt",
        "application_validation_receipt",
        "training_or_eval_absorption_evidence",
      ]),
    );
  });

  it("keeps Lark/Feishu learning on module-specific receipts instead of finance-only attach", async () => {
    const tool = createModuleLearningPipelinePlanTool();

    const result = await tool.execute("lark-plan", {
      targetModule: "lark_feishu_workflow",
      learningIntent: "Learn a readable Lark reply workflow from a visible reply receipt.",
    });

    expect(result.details).toEqual(
      expect.objectContaining({
        ok: true,
        targetModule: "lark_feishu_workflow",
        moduleFamily: "agent_workflow",
        financePipelineArgs: null,
      }),
    );
    expect(result.details).toEqual(
      expect.objectContaining({
        existingToolBridge: expect.objectContaining({
          primaryTool: "lark_loop_diagnose",
          bridgeStatus: "module_specific_receipt_required",
        }),
        safetyBoundaries: expect.arrayContaining([
          "no_live_visible_fixed_claim_without_real_inbound_reply",
          "no_live_sender_change",
          "no_provider_config_change",
        ]),
      }),
    );
    expect(result.details).toHaveProperty(
      "claimBoundary",
      expect.stringContaining("not learned from storage alone"),
    );
  });
});
