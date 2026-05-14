import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTempWorkspace } from "../../test-helpers/workspace.js";
import { createModuleLearningPipelineReviewTool } from "./module-learning-pipeline-review-tool.js";

async function seedJson(workspaceDir: string, relativePath: string, payload: unknown) {
  const absolutePath = path.join(workspaceDir, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function readJson(workspaceDir: string, relativePath: string) {
  return JSON.parse(await fs.readFile(path.join(workspaceDir, relativePath), "utf8")) as Record<
    string,
    unknown
  >;
}

describe("module learning pipeline review tool", () => {
  let workspaceDir: string | undefined;

  afterEach(async () => {
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      workspaceDir = undefined;
    }
  });

  it("writes a daily review and flags incomplete module-learning receipts", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-module-learning-review-");
    await seedJson(
      workspaceDir,
      "memory/module-learning-pipeline-plan-receipts/2026-05-12/a.json",
      {
        boundary: "dev_module_learning_pipeline_plan",
        targetModule: "options_volatility",
        moduleFamily: "finance_research",
        status: "eval_absorbed",
        learningIntent: "Learn options IV event risk.",
        sourceUrlOrPath: "memory/research-sources/options.md",
        actualReadingScope: "Read IV, skew, gamma, event, and liquidity sections.",
        sourceRegistryRecordPath: "memory/research-sources/options.md",
        retrievalReceiptPath: "memory/finance-learning-retrieval-receipts/2026-05-12/r.json",
        applicationValidationReceiptPath:
          "memory/finance-learning-apply-usage-receipts/2026-05-12/a.json",
        trainingOrEvalAbsorptionEvidencePath: "ops/local-brain/eval/options.json",
        freshAdjacentApplicationTask: "Apply to a fresh FOMC gap-risk prompt.",
        keepDownrankDiscardDecision: "keep",
        missingEvidence: [],
        liveTouched: false,
        providerConfigTouched: false,
        protectedMemoryTouched: false,
      },
    );
    await seedJson(
      workspaceDir,
      "memory/module-learning-pipeline-plan-receipts/2026-05-12/b.json",
      {
        boundary: "dev_module_learning_pipeline_plan",
        targetModule: "global_index_regime",
        moduleFamily: "finance_research",
        status: "stored_only",
        learningIntent: "Learn index methodology from a local note.",
        sourceUrlOrPath: "memory/research-sources/index.md",
        actualReadingScope: "Read methodology section only.",
        sourceRegistryRecordPath: "memory/research-sources/index.md",
        missingEvidence: ["capability_card_or_retrieval_receipt", "application_validation_receipt"],
        liveTouched: false,
        providerConfigTouched: false,
        protectedMemoryTouched: false,
      },
    );
    await seedJson(
      workspaceDir,
      "memory/module-learning-pipeline-plan-receipts/2026-05-12/c.json",
      {
        boundary: "language_routing_candidate",
      },
    );
    const tool = createModuleLearningPipelineReviewTool({ workspaceDir });

    const result = await tool.execute("review", {
      dateKey: "2026-05-12",
    });

    expect(result.details).toEqual(
      expect.objectContaining({
        ok: true,
        boundary: "module_learning_pipeline_review_only",
        updated: true,
        reviewPath: "memory/module-learning-pipeline-reviews/2026-05-12.json",
        counts: {
          receiptFiles: 2,
          rawReceiptFiles: 3,
          supersededReceiptFiles: 0,
          validReceipts: 2,
          invalidReceipts: 1,
          missingEvidence: 0,
          storedOnly: 1,
          retrievalReady: 0,
          applicationReady: 0,
          evalAbsorbed: 1,
          weakModuleLearning: 1,
          boundaryViolations: 0,
          structuredDataReviewTargetViolations: 0,
        },
        weakModuleLearning: expect.arrayContaining([
          expect.objectContaining({
            targetModule: "global_index_regime",
            status: "stored_only",
            failedReason: "capability_card_or_retrieval_receipt",
          }),
        ]),
        separationContract: expect.objectContaining({
          languageCorpusUntouched: true,
          protectedMemoryUntouched: true,
          liveTouched: false,
          providerConfigTouched: false,
          noExecutionAuthority: true,
        }),
      }),
    );
    const review = await readJson(
      workspaceDir,
      "memory/module-learning-pipeline-reviews/2026-05-12.json",
    );
    expect(review).toEqual(
      expect.objectContaining({
        boundary: "module_learning_pipeline_review",
      }),
    );
  });

  it("supports dry-run review without writing a review file", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-module-learning-review-");
    const tool = createModuleLearningPipelineReviewTool({ workspaceDir });

    const result = await tool.execute("dry", {
      dateKey: "2026-05-12",
      writeReview: false,
    });

    expect(result.details).toEqual(
      expect.objectContaining({
        ok: true,
        updated: false,
        reviewPath: undefined,
        counts: expect.objectContaining({
          receiptFiles: 0,
          validReceipts: 0,
          weakModuleLearning: 0,
        }),
      }),
    );
    await expect(
      fs.stat(path.join(workspaceDir, "memory/module-learning-pipeline-reviews/2026-05-12.json")),
    ).rejects.toThrow();
  });

  it("keeps advanced trader QC module receipts in the same review loop", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-module-learning-review-");
    await seedJson(
      workspaceDir,
      "memory/module-learning-pipeline-plan-receipts/2026-05-12/advanced.json",
      {
        boundary: "dev_module_learning_pipeline_plan",
        targetModule: "data_provenance_quality",
        moduleFamily: "finance_research",
        status: "eval_absorbed",
        learningIntent: "Learn source provenance and field-quality gates.",
        sourceUrlOrPath: "memory/research-sources/data.md",
        actualReadingScope: "Read timestamp, vendor, field definition, and conflict sections.",
        sourceRegistryRecordPath: "memory/research-sources/data.md",
        retrievalReceiptPath: "memory/finance-learning-retrieval-receipts/2026-05-12/data.json",
        applicationValidationReceiptPath:
          "memory/finance-learning-apply-usage-receipts/2026-05-12/data.json",
        trainingOrEvalAbsorptionEvidencePath: "ops/local-brain/eval/data.json",
        freshAdjacentApplicationTask:
          "Apply data provenance learning to a fresh conflicting macro data ask.",
        keepDownrankDiscardDecision: "keep",
        missingEvidence: [],
        financePipelineArgs: {
          sourceType: "official_data_source",
          expectedNextReviewTarget: "data_provenance_quality_review_input",
        },
        liveTouched: false,
        providerConfigTouched: false,
        protectedMemoryTouched: false,
      },
    );
    const tool = createModuleLearningPipelineReviewTool({ workspaceDir });

    const result = await tool.execute("review", {
      dateKey: "2026-05-12",
      targetModule: "data_provenance_quality",
      writeReview: false,
    });

    expect(result.details).toEqual(
      expect.objectContaining({
        ok: true,
        boundary: "module_learning_pipeline_review_only",
        updated: false,
        counts: expect.objectContaining({
          validReceipts: 1,
          evalAbsorbed: 1,
          weakModuleLearning: 0,
          boundaryViolations: 0,
          structuredDataReviewTargetViolations: 0,
        }),
        separationContract: expect.objectContaining({
          languageCorpusUntouched: true,
          protectedMemoryUntouched: true,
          liveTouched: false,
          providerConfigTouched: false,
        }),
      }),
    );
  });

  it("flags data provenance receipts that skip the structured data review target", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-module-learning-review-");
    await seedJson(
      workspaceDir,
      "memory/module-learning-pipeline-plan-receipts/2026-05-12/bad-data.json",
      {
        boundary: "dev_module_learning_pipeline_plan",
        targetModule: "data_provenance_quality",
        moduleFamily: "finance_research",
        status: "eval_absorbed",
        learningIntent: "Learn source provenance but accidentally use article extraction.",
        sourceUrlOrPath: "memory/research-sources/data.md",
        actualReadingScope: "Read timestamp, vendor, and field definition sections.",
        sourceRegistryRecordPath: "memory/research-sources/data.md",
        retrievalReceiptPath: "memory/finance-learning-retrieval-receipts/2026-05-12/data.json",
        applicationValidationReceiptPath:
          "memory/finance-learning-apply-usage-receipts/2026-05-12/data.json",
        trainingOrEvalAbsorptionEvidencePath: "ops/local-brain/eval/data.json",
        freshAdjacentApplicationTask: "Apply to a fresh conflicting macro data ask.",
        keepDownrankDiscardDecision: "keep",
        missingEvidence: [],
        financePipelineArgs: {
          sourceType: "manual_article_source",
          expectedNextReviewTarget: "finance_article_extract_capability_input",
        },
        liveTouched: false,
        providerConfigTouched: false,
        protectedMemoryTouched: false,
      },
    );
    const tool = createModuleLearningPipelineReviewTool({ workspaceDir });

    const result = await tool.execute("review", {
      dateKey: "2026-05-12",
      targetModule: "data_provenance_quality",
      writeReview: false,
    });

    expect(result.details).toEqual(
      expect.objectContaining({
        ok: true,
        counts: expect.objectContaining({
          validReceipts: 1,
          evalAbsorbed: 1,
          weakModuleLearning: 1,
          structuredDataReviewTargetViolations: 1,
        }),
        weakModuleLearning: [
          expect.objectContaining({
            targetModule: "data_provenance_quality",
            failedReason: "data_provenance_receipt_missing_structured_review_target",
          }),
        ],
      }),
    );
  });
});
