import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempWorkspace } from "../../test-helpers/workspace.js";
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
        boundary: "local_module_learning_pipeline_plan",
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

  it("keeps external message learning on module-specific receipts instead of finance-only attach", async () => {
    const tool = createModuleLearningPipelinePlanTool();

    const result = await tool.execute("external-plan", {
      targetModule: "external_message_workflow",
      learningIntent: "Learn a readable External reply workflow from a visible reply receipt.",
    });

    expect(result.details).toEqual(
      expect.objectContaining({
        ok: true,
        targetModule: "external_message_workflow",
        moduleFamily: "agent_workflow",
        financePipelineArgs: null,
      }),
    );
    expect(result.details).toEqual(
      expect.objectContaining({
        existingToolBridge: expect.objectContaining({
          primaryTool: "external_loop_diagnose",
          bridgeStatus: "module_specific_receipt_required",
        }),
        safetyBoundaries: expect.arrayContaining([
          "no_live_visible_fixed_claim_without_real_inbound_reply",
          "no_external_channel_sender_change",
          "no_provider_config_change",
        ]),
      }),
    );
    expect(result.details).toHaveProperty(
      "claimBoundary",
      expect.stringContaining("not learned from storage alone"),
    );
  });

  it("plans advanced trader QC modules through the same evidence-gated memory chain", async () => {
    const tool = createModuleLearningPipelinePlanTool();

    const valuation = await tool.execute("valuation-qc-plan", {
      targetModule: "financial_modeling_valuation_qc",
      sourceUrlOrPath: "memory/research-sources/valuation-model-qc-note.md",
      actualReadingScope:
        "Read the DCF assumptions, comps, sensitivity, number provenance, and audit checklist sections.",
      existingArtifactPaths: ["memory/research-sources/valuation-model-qc-note.md"],
      learningIntent: "Learn a valuation-model QC workflow without target-price or trade advice.",
    });
    expect(valuation.details).toEqual(
      expect.objectContaining({
        ok: true,
        targetModule: "financial_modeling_valuation_qc",
        moduleFamily: "finance_research",
        status: "missing_evidence",
        financePipelineArgs: expect.objectContaining({
          allowedActionAuthority: "research_only",
        }),
      }),
    );
    expect(valuation.details).toEqual(
      expect.objectContaining({
        requiredInputs: expect.arrayContaining([
          "model_assumptions_sensitivity_and_audit_inputs",
          "research_artifact_qc_and_number_provenance_checklist",
        ]),
        safetyBoundaries: expect.arrayContaining([
          "no_model_math_guessing",
          "cite_every_number_or_mark_unsourced",
        ]),
      }),
    );

    for (const targetModule of [
      "thesis_catalyst_lifecycle",
      "data_provenance_quality",
      "research_artifact_qc",
    ]) {
      const result = await tool.execute(`${targetModule}-plan`, {
        targetModule,
        sourceUrlOrPath: `memory/research-sources/${targetModule}.md`,
        actualReadingScope: `Read the ${targetModule} source and evidence checklist.`,
        existingArtifactPaths: [`memory/research-sources/${targetModule}.md`],
      });
      expect(result.details).toEqual(
        expect.objectContaining({
          ok: true,
          targetModule,
          moduleFamily: "finance_research",
          boundary: "local_module_learning_pipeline_plan",
          liveTouched: false,
          providerConfigTouched: false,
          protectedMemoryTouched: false,
        }),
      );
      expect(result.details).toHaveProperty(
        "claimBoundary",
        expect.stringContaining("not learned from storage alone"),
      );
    }
  });

  it("routes data provenance module learning through structured data review targets", async () => {
    const tool = createModuleLearningPipelinePlanTool();

    const result = await tool.execute("macro-data-provenance-plan", {
      targetModule: "data_provenance_quality",
      sourceUrlOrPath: "https://fred.stlouisfed.org/series/CPIAUCSL",
      actualReadingScope:
        "Read the FRED series notes, units, frequency, timestamp, revision policy, and field-definition notes.",
      existingArtifactPaths: ["memory/research-sources/fred-cpi-series.md"],
      learningIntent:
        "Learn a macro data provenance review rule for timestamped official data without inventing current market facts.",
    });

    expect(result.details).toEqual(
      expect.objectContaining({
        ok: true,
        targetModule: "data_provenance_quality",
        requiredInputs: expect.arrayContaining([
          "source_timestamp_and_vendor",
          "currency_adjustment_and_update_frequency_policy",
        ]),
        financePipelineArgs: expect.objectContaining({
          sourceType: "official_data_source",
          expectedNextReviewTarget: "data_provenance_quality_review_input",
          allowedActionAuthority: "research_only",
        }),
        safetyBoundaries: expect.arrayContaining([
          "no_unverified_current_market_data",
          "source_timestamp_required",
        ]),
      }),
    );
  });

  it("keeps weak alternative sources in the same module-learning chain with follow-through gates", async () => {
    const tool = createModuleLearningPipelinePlanTool();

    const missingFollowthrough = await tool.execute("weak-alternative-missing", {
      targetModule: "company_fundamentals_value",
      sourceUrlOrPath: "https://example.com/viral-ai-dinner",
      actualReadingScope: "Read the article and identify the executive interaction claim.",
      existingArtifactPaths: ["memory/research-sources/viral-ai-dinner.md"],
      sourceRegistryRecordPath: "memory/finance-article-source-registry.md",
      retrievalReceiptPath: "memory/finance-learning-retrieval-receipts/weak-source.json",
      applicationValidationReceiptPath:
        "memory/finance-learning-apply-usage-receipts/weak-source.json",
      trainingOrEvalAbsorptionEvidencePath: "ops/local-brain/eval/weak-source.json",
      freshAdjacentApplicationTask:
        "Apply the weak-source rule to a fresh AI supply-chain interview without trade advice.",
      keepDownrankDiscardDecision: "keep",
      sourceEvidenceClass: "weak_alternative_source",
      sourceReliabilityGrade: "d",
      weakEvidenceLearningPolicy: "downrank_until_followthrough",
    });

    expect(missingFollowthrough.details).toEqual(
      expect.objectContaining({
        status: "missing_evidence",
        weakEvidenceGate: expect.objectContaining({
          required: true,
          satisfied: false,
          missingEvidence: expect.arrayContaining([
            "primary_source_or_transcript",
            "official_followup_or_contract_evidence",
            "fundamental_followthrough_evidence",
            "market_followthrough_window",
          ]),
        }),
        missingEvidence: expect.arrayContaining([
          "primary_source_or_transcript",
          "official_followup_or_contract_evidence",
          "fundamental_followthrough_evidence",
        ]),
      }),
    );

    const absorbed = await tool.execute("weak-alternative-ready", {
      targetModule: "company_fundamentals_value",
      sourceUrlOrPath: "https://example.com/viral-ai-dinner",
      actualReadingScope:
        "Read the original article, transcript, official company follow-up, and later filing evidence.",
      existingArtifactPaths: [
        "memory/research-sources/viral-ai-dinner.md",
        "memory/research-sources/viral-ai-dinner-followthrough.md",
      ],
      sourceRegistryRecordPath: "memory/finance-article-source-registry.md",
      retrievalReceiptPath: "memory/finance-learning-retrieval-receipts/weak-source.json",
      applicationValidationReceiptPath:
        "memory/finance-learning-apply-usage-receipts/weak-source.json",
      trainingOrEvalAbsorptionEvidencePath: "ops/local-brain/eval/weak-source.json",
      freshAdjacentApplicationTask:
        "Apply the weak-source rule to a fresh AI supply-chain interview without trade advice.",
      keepDownrankDiscardDecision: "keep",
      sourceEvidenceClass: "weak_alternative_source",
      sourceReliabilityGrade: "d",
      primarySourceOrTranscriptPath: "memory/research-sources/viral-ai-dinner-transcript.md",
      officialFollowupEvidencePath: "memory/research-sources/ai-supply-chain-official-followup.md",
      fundamentalFollowthroughEvidencePath:
        "memory/research-sources/ai-supply-chain-fundamental-followthrough.md",
      marketFollowthroughWindow: "30-180 days",
      weakEvidenceLearningPolicy: "downrank_until_followthrough",
    });

    expect(absorbed.details).toEqual(
      expect.objectContaining({
        status: "eval_absorbed",
        sourceEvidenceClass: "weak_alternative_source",
        sourceReliabilityGrade: "d",
        weakEvidenceGate: expect.objectContaining({
          required: true,
          satisfied: true,
          missingEvidence: [],
        }),
        financePipelineArgs: expect.objectContaining({
          sourceEvidenceClass: "weak_alternative_source",
          sourceReliabilityGrade: "d",
          weakEvidenceLearningPolicy: "downrank_until_followthrough",
        }),
      }),
    );
  });

  it("writes a receipt and upgrades status when evidence paths are present", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-module-learning-plan-");
    const tool = createModuleLearningPipelinePlanTool({ workspaceDir });

    try {
      const result = await tool.execute("options-receipt", {
        targetModule: "options_volatility",
        sourceUrlOrPath: "memory/research-sources/options-iv-event-note.md",
        actualReadingScope:
          "Read the IV term-structure, skew, gamma, event calendar, and liquidity sections.",
        existingArtifactPaths: ["memory/research-sources/options-iv-event-note.md"],
        sourceRegistryRecordPath: "memory/research-sources/options-iv-event-note.md",
        retrievalReceiptPath: "memory/finance-learning-retrieval-receipts/2026-05-12/r.json",
        applicationValidationReceiptPath:
          "memory/finance-learning-apply-usage-receipts/2026-05-12/a.json",
        trainingOrEvalAbsorptionEvidencePath: "ops/local-brain/eval/options-iv-event.json",
        freshAdjacentApplicationTask: "Apply to an FOMC QQQ gap-risk prompt without contracts.",
        keepDownrankDiscardDecision: "keep",
        writeReceipt: true,
      });

      expect(result.details).toEqual(
        expect.objectContaining({
          status: "eval_absorbed",
          receiptWritten: true,
          keepDownrankDiscardDecision: "keep",
          missingEvidence: [],
        }),
      );
      const receiptPath = (result.details as { receiptPath: string }).receiptPath;
      expect(receiptPath).toMatch(/^memory\/module-learning-pipeline-plan-receipts\//u);
      const receipt = JSON.parse(
        await fs.readFile(path.join(workspaceDir, receiptPath), "utf8"),
      ) as {
        targetModule: string;
        status: string;
        liveTouched: boolean;
      };
      expect(receipt).toMatchObject({
        targetModule: "options_volatility",
        status: "eval_absorbed",
        liveTouched: false,
      });
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("keeps receipt paths distinct for same-intent superseding receipts from different sources", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-module-learning-plan-");
    const tool = createModuleLearningPipelinePlanTool({ workspaceDir });

    try {
      const baseArgs = {
        targetModule: "portfolio_risk_gates",
        learningIntent:
          "Discard weak module-learning candidate after extraction gap; keep source as reference-only.",
        actualReadingScope: "Read the local source and extraction gap.",
        keepDownrankDiscardDecision: "discard",
        writeReceipt: true,
      };
      const first = await tool.execute("module-learning-pipeline-plan-cli", {
        ...baseArgs,
        sourceUrlOrPath: "memory/research-sources/first.md",
        existingArtifactPaths: ["memory/research-sources/first.md"],
        sourceRegistryRecordPath: "memory/research-sources/first.md",
        supersedesReceiptPath: "memory/module-learning-pipeline-plan-receipts/day/first.json",
      });
      const second = await tool.execute("module-learning-pipeline-plan-cli", {
        ...baseArgs,
        sourceUrlOrPath: "memory/research-sources/second.md",
        existingArtifactPaths: ["memory/research-sources/second.md"],
        sourceRegistryRecordPath: "memory/research-sources/second.md",
        supersedesReceiptPath: "memory/module-learning-pipeline-plan-receipts/day/second.json",
      });

      const firstPath = (first.details as { receiptPath: string }).receiptPath;
      const secondPath = (second.details as { receiptPath: string }).receiptPath;
      expect(firstPath).not.toEqual(secondPath);
      await expect(fs.stat(path.join(workspaceDir, firstPath))).resolves.toBeTruthy();
      await expect(fs.stat(path.join(workspaceDir, secondPath))).resolves.toBeTruthy();
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });
});
