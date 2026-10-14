import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTempWorkspace } from "../../test-helpers/workspace.js";
import { createModuleLearningPipelinePlanTool } from "./module-learning-pipeline-plan-tool.js";
import {
  buildModuleLearningPipelineReview,
  createModuleLearningPipelineReviewTool,
} from "./module-learning-pipeline-review-tool.js";

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

  it.each(["skill_pattern_distillation", "agent_workflow_memory"])(
    "reviews the original %s plan using its actual non-finance boundary contract",
    async (targetModule) => {
      workspaceDir = await makeTempWorkspace("openclaw-module-boundary-");
      const sourceText = "Local test source: retain the exact source and its reading limits.";
      await fs.writeFile(path.join(workspaceDir, "source.md"), sourceText);
      await seedJson(workspaceDir, "source-registry.json", {
        sourcePath: "source.md",
        sha256: createHash("sha256").update(sourceText).digest("hex"),
        licenseScope: "test fixture only; no third-party licensing claim",
      });
      await seedJson(workspaceDir, "candidate.json", { targetModule, sourcePath: "source.md" });
      await seedJson(workspaceDir, "application.json", {
        task: "Preserve source limits on a fresh adjacent local test task",
        output: "The supplied source is a local test fixture; no upstream source verified.",
      });
      const applicationBytes = await fs.readFile(path.join(workspaceDir, "application.json"));
      await seedJson(workspaceDir, "eval.json", {
        schemaVersion: "lcx_module_learning_eval_v1",
        verdict: "passed",
        targetModule,
        sourceUrlOrPath: "source.md",
        freshAdjacentApplicationTask: "fresh local boundary-contract task",
        checks: [
          {
            id: "local-output-identity",
            passed: true,
            evidencePath: "application.json",
            sha256: createHash("sha256").update(applicationBytes).digest("hex"),
          },
        ],
      });
      const planned = await createModuleLearningPipelinePlanTool({ workspaceDir }).execute(
        "original-plan",
        {
          targetModule,
          sourceUrlOrPath: "source.md",
          actualReadingScope: "Complete local test source; no external body or script executed",
          existingArtifactPaths: ["source.md"],
          sourceRegistryRecordPath: "source-registry.json",
          retrievalReceiptPath: "candidate.json",
          applicationValidationReceiptPath: "application.json",
          trainingOrEvalAbsorptionEvidencePath: "eval.json",
          freshAdjacentApplicationTask: "fresh local boundary-contract task",
          keepDownrankDiscardDecision: "keep",
          writeReceipt: true,
        },
      );
      const plan = planned.details as Record<string, unknown>;
      expect(plan.status).toBe("application_ready");
      expect(plan.evidenceVerification).toMatchObject({
        evaluationVerified: true,
        evaluationIntegrityVerified: true,
        applicationContentAcceptance: { status: "not_observed" },
      });
      expect(plan.safetyBoundaries).not.toContain("research_only");
      const tool = createModuleLearningPipelineReviewTool({ workspaceDir });
      const reviewed = await tool.execute("original-review", { targetModule, writeReview: false });
      const proofDir = process.env.LCX_MODULE_BOUNDARY_PROOF_DIR;
      if (proofDir) {
        await fs.mkdir(proofDir, { recursive: true });
        await fs.writeFile(
          path.join(proofDir, `${targetModule}.json`),
          `${JSON.stringify({ plan, reviewed: reviewed.details, fixtureOnly: true }, null, 2)}\n`,
        );
      }
      expect(reviewed.details).toMatchObject({
        rows: [
          {
            targetModule,
            status: "application_ready",
            evaluationVerified: true,
            evaluationIntegrityVerified: true,
            applicationContentAcceptance: { status: "not_observed" },
            proofCompleteness: { safety_boundary: true },
            exactMissingProof: ["application_content_acceptance_not_observed"],
            nextProofOwner: "module_learning_pipeline_apply_validation",
            weak: true,
          },
        ],
      });
      // A declaration of research_only cannot replace the module's actual boundaries.
      const receiptPath = plan.receiptPath as string;
      const faultReadbacks: Record<string, unknown> = {};
      await seedJson(workspaceDir, receiptPath, {
        ...plan,
        status: "eval_absorbed",
        missingEvidence: [],
        contentAccepted: true,
        applicationContentAcceptance: { status: "accepted" },
      });
      faultReadbacks.legacySelfDeclaredAcceptance = (
        await tool.execute("legacy-self-declared-content", { targetModule })
      ).details;
      expect(faultReadbacks.legacySelfDeclaredAcceptance).toMatchObject({
        rows: [
          {
            declaredStatus: "eval_absorbed",
            status: "application_ready",
            evaluationIntegrityVerified: true,
            applicationContentAcceptance: { status: "not_observed" },
            exactMissingProof: ["application_content_acceptance_not_observed"],
            weak: true,
          },
        ],
      });
      for (const decision of ["downrank", "discard"]) {
        await seedJson(workspaceDir, receiptPath, {
          ...plan,
          keepDownrankDiscardDecision: decision,
        });
        expect(
          (await tool.execute("terminal-no-absorption", { targetModule })).details,
        ).toMatchObject({
          rows: [{ terminalNonAbsorbedDecision: true, exactMissingProof: [], weak: false }],
        });
      }
      await seedJson(workspaceDir, receiptPath, { ...plan, safetyBoundaries: ["research_only"] });
      faultReadbacks.wrongBoundary = (
        await tool.execute("wrong-boundary", { targetModule })
      ).details;
      expect(faultReadbacks.wrongBoundary).toMatchObject({
        rows: [{ exactMissingProof: expect.arrayContaining(["safety_boundary"]), weak: true }],
      });
      const boundaries = plan.safetyBoundaries as string[];
      for (const removed of boundaries) {
        await seedJson(workspaceDir, receiptPath, {
          ...plan,
          safetyBoundaries: boundaries.filter((boundary) => boundary !== removed),
        });
        const readback = await tool.execute("missing-module-boundary", { targetModule });
        faultReadbacks[`missingBoundary:${removed}`] = readback.details;
        expect(readback.details).toMatchObject({
          rows: [{ exactMissingProof: expect.arrayContaining(["safety_boundary"]), weak: true }],
        });
      }
      await seedJson(workspaceDir, receiptPath, plan);
      await fs.writeFile(path.join(workspaceDir, "application.json"), "changed output");
      faultReadbacks.changedEvalOutput = (
        await tool.execute("changed-eval-output", { targetModule })
      ).details;
      expect(faultReadbacks.changedEvalOutput).toMatchObject({
        rows: [{ evaluationVerified: false, weak: true }],
      });
      await fs.rm(path.join(workspaceDir, "source-registry.json"));
      faultReadbacks.missingSource = (
        await tool.execute("missing-source", { targetModule })
      ).details;
      expect(faultReadbacks.missingSource).toMatchObject({
        rows: [
          { exactMissingProof: expect.arrayContaining(["source_registry_record"]), weak: true },
        ],
      });
      if (proofDir) {
        await fs.writeFile(
          path.join(proofDir, `${targetModule}-faults.json`),
          `${JSON.stringify({ faultReadbacks, fixtureOnly: true }, null, 2)}\n`,
        );
      }
    },
  );

  it("rechecks application-ready receipts and identifies the source lost before downstream review", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-learning-application-readback-");
    const source = "memory/source.json";
    const retrieval = "memory/retrieval.json";
    const application = "memory/application.json";
    for (const file of [source, retrieval, application]) {
      await seedJson(workspaceDir, file, { fixture: true });
    }
    await seedJson(
      workspaceDir,
      "memory/module-learning-pipeline-plan-receipts/2026-05-12/ready.json",
      {
        boundary: "local_module_learning_pipeline_plan",
        targetModule: "portfolio_risk_gates",
        status: "application_ready",
        sourceRegistryRecordPath: source,
        retrievalReceiptPath: retrieval,
        applicationValidationReceiptPath: application,
      },
    );
    const tool = createModuleLearningPipelineReviewTool({ workspaceDir });
    expect((await tool.execute("initial", { writeReview: false })).details).toMatchObject({
      counts: { applicationReady: 1 },
    });
    await fs.rm(path.join(workspaceDir, source));
    const readback = await tool.execute("lost-source", { writeReview: false });
    expect(readback.details).toMatchObject({
      counts: { applicationReady: 0, missingEvidence: 1 },
      rows: [
        expect.objectContaining({
          declaredStatus: "application_ready",
          status: "missing_evidence",
          proofCompleteness: expect.objectContaining({ source_registry_record: false }),
          missingEvidence: expect.arrayContaining([`unreadable_evidence_file:${source}`]),
        }),
      ],
    });
  });

  it("keeps previous batches in the default review while allowing an explicit date", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-learning-history-");
    for (const [date, targetModule] of [
      ["2020-01-01", "portfolio_risk_gates"],
      ["2020-01-02", "technical_timing"],
    ]) {
      await seedJson(
        workspaceDir,
        `memory/module-learning-pipeline-plan-receipts/${date}/pending.json`,
        {
          boundary: "local_module_learning_pipeline_plan",
          targetModule,
          sourceUrlOrPath: `source-${targetModule}`,
          status: "application_ready",
        },
      );
    }
    const tool = createModuleLearningPipelineReviewTool({ workspaceDir });
    const all = await tool.execute("backlog", { writeReview: false });
    expect(all.details).toMatchObject({ dateKey: "all", counts: { receiptFiles: 2 } });
    const daily = await tool.execute("daily", { dateKey: "2020-01-02", writeReview: false });
    expect(daily.details).toMatchObject({ dateKey: "2020-01-02", counts: { receiptFiles: 1 } });
  });

  it("writes a daily review and flags incomplete module-learning receipts", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-module-learning-review-");
    await seedJson(
      workspaceDir,
      "memory/module-learning-pipeline-plan-receipts/2026-05-12/a.json",
      {
        boundary: "local_module_learning_pipeline_plan",
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
        moduleSpecificCapabilityRule:
          "Options learning requires IV, skew, event, liquidity, and risk-boundary evidence before reuse.",
        safetyBoundaries: ["research_only", "no_execution_authority", "no_trade_advice"],
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
        boundary: "local_module_learning_pipeline_plan",
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
      writeReview: true,
    });

    expect(result.details).toEqual(
      expect.objectContaining({
        ok: true,
        boundary: "module_learning_pipeline_review_only",
        updated: true,
        reviewPath: "memory/module-learning-pipeline-reviews/2026-05-12.json",
        counts: expect.objectContaining({
          receiptFiles: 2,
          rawReceiptFiles: 3,
          supersededReceiptFiles: 0,
          validReceipts: 2,
          invalidReceipts: 1,
          missingEvidence: 1,
          storedOnly: 1,
          retrievalReady: 0,
          applicationReady: 0,
          evalAbsorbed: 0,
          weakModuleLearning: 2,
          boundaryViolations: 0,
          structuredDataReviewTargetViolations: 0,
          exactMissingProofReceipts: 2,
        }),
        proofGapSummary: expect.objectContaining({
          module_specific_capability_rule: 1,
          capability_card_or_retrieval_receipt: 2,
          application_validation_receipt: 2,
          training_or_eval_absorption_evidence: 1,
          fresh_adjacent_application_task: 1,
          keep_downrank_or_discard_decision: 1,
          safety_boundary: 1,
        }),
        nextProofQueue: expect.arrayContaining([
          expect.objectContaining({
            targetModule: "global_index_regime",
            nextProofOwner: "module_learning_pipeline_apply_validation",
          }),
        ]),
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

  it("defaults to read-only review without writing a review file", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-module-learning-review-");
    const tool = createModuleLearningPipelineReviewTool({ workspaceDir });

    const result = await tool.execute("dry", {
      dateKey: "2026-05-12",
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

  it("treats explicit downrank or discard receipts as terminal non-absorbed evidence", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-module-learning-review-");
    await seedJson(
      workspaceDir,
      "memory/module-learning-pipeline-plan-receipts/2026-05-12/old.json",
      {
        boundary: "local_module_learning_pipeline_plan",
        targetModule: "portfolio_risk_gates",
        moduleFamily: "finance_research",
        status: "stored_only",
        sourceUrlOrPath: "memory/research-sources/weak.md",
        actualReadingScope: "Read weak source summary.",
        sourceRegistryRecordPath: "memory/research-sources/weak.md",
        missingEvidence: [
          "capability_card_or_retrieval_receipt",
          "application_validation_receipt",
          "training_or_eval_absorption_evidence",
          "fresh_adjacent_application_task",
        ],
        keepDownrankDiscardDecision: "not_decided",
        liveTouched: false,
        providerConfigTouched: false,
        protectedMemoryTouched: false,
      },
    );
    await seedJson(
      workspaceDir,
      "memory/module-learning-pipeline-plan-receipts/2026-05-12/discard.json",
      {
        boundary: "local_module_learning_pipeline_plan",
        targetModule: "portfolio_risk_gates",
        moduleFamily: "finance_research",
        status: "stored_only",
        sourceUrlOrPath: "memory/research-sources/weak.md",
        actualReadingScope: "Read weak source summary and extraction gap.",
        sourceRegistryRecordPath: "memory/research-sources/weak.md",
        moduleSpecificCapabilityRule:
          "Portfolio risk gates require weights, limits, and drawdown evidence before reuse.",
        safetyBoundaries: ["research_only", "no_execution_authority", "no_trade_advice"],
        missingEvidence: [
          "capability_card_or_retrieval_receipt",
          "application_validation_receipt",
          "training_or_eval_absorption_evidence",
          "fresh_adjacent_application_task",
        ],
        keepDownrankDiscardDecision: "discard",
        supersedesReceiptPath: "memory/module-learning-pipeline-plan-receipts/2026-05-12/old.json",
        liveTouched: false,
        providerConfigTouched: false,
        protectedMemoryTouched: false,
      },
    );
    const tool = createModuleLearningPipelineReviewTool({ workspaceDir });

    const result = await tool.execute("review", {
      dateKey: "2026-05-12",
      writeReview: false,
    });

    expect(result.details).toEqual(
      expect.objectContaining({
        counts: expect.objectContaining({
          receiptFiles: 1,
          supersededReceiptFiles: 1,
          terminalNonAbsorbed: 1,
          weakModuleLearning: 0,
          exactMissingProofReceipts: 0,
        }),
        terminalNonAbsorbedRows: [
          expect.objectContaining({
            keepDownrankDiscardDecision: "discard",
            status: "stored_only",
          }),
        ],
        nextProofQueue: [],
      }),
    );
  });

  it("keeps advanced trader QC module receipts in the same review loop", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-module-learning-review-");
    await seedJson(
      workspaceDir,
      "memory/module-learning-pipeline-plan-receipts/2026-05-12/advanced.json",
      {
        boundary: "local_module_learning_pipeline_plan",
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
        moduleSpecificCapabilityRule:
          "Data provenance learning requires timestamp, field definition, source role, and conflict review before reuse.",
        safetyBoundaries: ["research_only", "no_execution_authority", "no_trade_advice"],
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
          evalAbsorbed: 0,
          weakModuleLearning: 1,
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
        boundary: "local_module_learning_pipeline_plan",
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
        moduleSpecificCapabilityRule:
          "Data provenance learning requires timestamp, field definition, source role, and conflict review before reuse.",
        safetyBoundaries: ["research_only", "no_execution_authority", "no_trade_advice"],
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
          evalAbsorbed: 0,
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

  it("rechecks evaluation artifacts instead of trusting a previously absorbed receipt", async () => {
    workspaceDir = await makeTempWorkspace("module-review-integrity-");
    await fs.writeFile(path.join(workspaceDir, "artifact.json"), "actual output");
    const receipt = {
      boundary: "local_module_learning_pipeline_plan",
      targetModule: "options_volatility",
      status: "eval_absorbed",
      sourceUrlOrPath: "source",
      actualReadingScope: "full",
      sourceRegistryRecordPath: "artifact.json",
      retrievalReceiptPath: "artifact.json",
      applicationValidationReceiptPath: "artifact.json",
      trainingOrEvalAbsorptionEvidencePath: "eval.json",
      freshAdjacentApplicationTask: "adjacent case",
      keepDownrankDiscardDecision: "keep",
      moduleSpecificCapabilityRule: "retain provenance",
      safetyBoundaries: ["research_only"],
      missingEvidence: [],
    };
    await seedJson(
      workspaceDir,
      "memory/module-learning-pipeline-plan-receipts/2026-05-12/valid.json",
      receipt,
    );
    await seedJson(workspaceDir, "eval.json", {
      schemaVersion: "lcx_module_learning_eval_v1",
      verdict: "passed",
      targetModule: receipt.targetModule,
      sourceUrlOrPath: receipt.sourceUrlOrPath,
      freshAdjacentApplicationTask: receipt.freshAdjacentApplicationTask,
      checks: [
        {
          id: "independent-check",
          passed: true,
          evidencePath: "artifact.json",
          sha256: createHash("sha256").update("actual output").digest("hex"),
        },
      ],
    });
    const tool = createModuleLearningPipelineReviewTool({ workspaceDir });
    expect((await tool.execute("before", { writeReview: false })).details).toMatchObject({
      counts: { evalAbsorbed: 1 },
    });
    await fs.writeFile(path.join(workspaceDir, "artifact.json"), "changed output");
    expect((await tool.execute("after", { writeReview: false })).details).toMatchObject({
      counts: { evalAbsorbed: 0, applicationReady: 1 },
    });
  });

  it("reports an unreadable receipt directory instead of reporting an empty pipeline", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-module-learning-review-");
    const receiptDir = path.join(
      workspaceDir,
      "memory/module-learning-pipeline-plan-receipts/2026-05-12",
    );
    await fs.mkdir(receiptDir, { recursive: true });
    await fs.writeFile(
      path.join(receiptDir, "a.json"),
      `${JSON.stringify({ boundary: "module_learning_pipeline_plan_receipt" }, null, 2)}\n`,
      "utf8",
    );
    await fs.chmod(receiptDir, 0o000);
    let denied = false;
    try {
      await fs.readdir(receiptDir);
    } catch {
      denied = true;
    }
    if (!denied) {
      // Whether chmod denies access depends on the platform and on the user running the suite.
      await fs.chmod(receiptDir, 0o755);
      return;
    }
    try {
      const tool = createModuleLearningPipelineReviewTool({ workspaceDir });
      const result = await tool.execute("locked", {
        dateKey: "2026-05-12",
        writeReview: false,
      });
      expect(result.details).toEqual(
        expect.objectContaining({
          receiptSource: {
            directory: "memory/module-learning-pipeline-plan-receipts/2026-05-12",
            status: "unreadable",
            code: expect.any(String),
          },
        }),
      );
    } finally {
      await fs.chmod(receiptDir, 0o755);
    }
  });

  it("marks an absent receipt directory as absent, not as a pipeline that ran empty", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-module-learning-review-");
    const tool = createModuleLearningPipelineReviewTool({ workspaceDir });

    const result = await tool.execute("absent", { dateKey: "2026-05-12", writeReview: false });

    expect(result.details).toEqual(
      expect.objectContaining({
        receiptSource: {
          directory: "memory/module-learning-pipeline-plan-receipts/2026-05-12",
          status: "absent",
          code: "ENOENT",
        },
      }),
    );
  });
});

describe("module learning supersession owner selection", () => {
  const workspaceDir = "/private-offline-learning";
  const root = "memory/module-learning-pipeline-plan-receipts/2026-10-11/";
  const receipt = (name: string, values: Record<string, unknown> = {}) => ({
    ok: true as const,
    path: path.join(workspaceDir, root, name),
    receipt: {
      boundary: "local_module_learning_pipeline_plan",
      targetModule: "portfolio_risk_gates",
      sourceUrlOrPath: "source-a",
      applicationValidationReceiptPath: "application-a",
      status: "eval_absorbed",
      keepDownrankDiscardDecision: "keep",
      ...values,
    },
  });
  const review = (receipts: ReturnType<typeof receipt>[]) =>
    buildModuleLearningPipelineReview({
      workspaceDir,
      dateKey: "all",
      receiptResults: receipts,
      receiptSource: null,
      verifiedEvaluationPaths: new Set(receipts.map((entry) => entry.path)),
    });
  it("retains an explicitly downgraded current receipt instead of removing both versions", () => {
    const result = review([
      receipt("old.json"),
      receipt("new.json", {
        status: "missing_evidence",
        keepDownrankDiscardDecision: "downrank",
        supersedesReceiptPath: `${root}old.json`,
        missingEvidence: ["source_registry_record"],
      }),
    ]);
    expect(result.rows).toMatchObject([
      {
        receiptPath: `${root}new.json`,
        status: "missing_evidence",
        keepDownrankDiscardDecision: "downrank",
        missingEvidence: ["source_registry_record"],
      },
    ]);
    expect(result.supersededRows).toMatchObject([
      { receiptPath: `${root}old.json`, supersededByReceiptPath: `${root}new.json` },
    ]);
  });
  it("selects native creation order without treating higher status as freshness", () => {
    const result = review([
      receipt("2026-10-11T01-00-00-000Z__old.json"),
      receipt("2026-10-11T02-00-00-000Z__new.json", {
        status: "missing_evidence",
        keepDownrankDiscardDecision: "downrank",
      }),
    ]);
    expect(result.rows).toMatchObject([
      { keepDownrankDiscardDecision: "downrank", status: "missing_evidence" },
    ]);
  });
  it.each([
    ["source", { sourceUrlOrPath: "source-b" }, "supersession_scope_conflict"],
    ["module", { targetModule: "technical_timing" }, "supersession_scope_conflict"],
    [
      "missing",
      { supersedesReceiptPath: `${root}absent.json` },
      "supersession_predecessor_unavailable",
    ],
    ["self", { supersedesReceiptPath: `${root}new.json` }, "supersession_cycle"],
  ] as const)("rejects %s supersession without hiding the previous owner", (_name, values, gap) => {
    const result = review([
      receipt("old.json"),
      receipt("new.json", { supersedesReceiptPath: `${root}old.json`, ...values }),
    ]);
    expect(result.rows).toHaveLength(2);
    expect(result.supersededRows).toHaveLength(0);
    expect(
      result.rows.find((row) => row.receiptPath.endsWith("new.json"))?.missingEvidence,
    ).toEqual(expect.arrayContaining([expect.stringContaining(gap)]));
  });
  it("retains cyclic versions with explicit gaps instead of draining the review", () => {
    const result = review([
      receipt("old.json", { supersedesReceiptPath: `${root}new.json` }),
      receipt("new.json", { supersedesReceiptPath: `${root}old.json` }),
    ]);
    expect(result.rows).toHaveLength(2);
    expect(
      result.rows.every((row) =>
        row.supersessionIssues.some((gap) => gap.startsWith("supersession_cycle:")),
      ),
    ).toBe(true);
  });
  it("retains a descendant of an invalid predecessor with the exact chain gap", () => {
    const result = review([
      receipt("a.json", { supersedesReceiptPath: `${root}absent.json` }),
      receipt("b.json", { supersedesReceiptPath: `${root}a.json` }),
    ]);
    expect(result.rows).toHaveLength(2);
    expect(result.rows.find((row) => row.receiptPath.endsWith("b.json"))).toMatchObject({
      status: "missing_evidence",
      supersessionIssues: [`supersession_predecessor_invalid:${root}a.json`],
    });
  });
  it("rejects forked successors while retaining the predecessor and both gaps", () => {
    const result = review([
      receipt("old.json"),
      receipt("a.json", { supersedesReceiptPath: `${root}old.json` }),
      receipt("b.json", { supersedesReceiptPath: `${root}old.json` }),
    ]);
    expect(result.rows).toHaveLength(3);
    expect(result.supersededRows).toHaveLength(0);
    expect(result.rows.filter((row) => row.supersessionIssues.length)).toHaveLength(2);
  });
});
