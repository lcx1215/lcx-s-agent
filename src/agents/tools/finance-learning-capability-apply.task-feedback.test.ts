import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { planFinanceBrainOrchestration } from "../finance-brain-orchestration.js";
import { caseflowFingerprint } from "../finance-caseflow.js";
import { executeFinanceModuleComposition } from "../finance-module-execution.js";
import type { FinanceResearchBatchEvidencePacket } from "../finance-research-batch-runner.js";
import { createFinanceLearningCapabilityApplyTool } from "./finance-learning-capability-apply-tool.js";
import { createFinanceLearningCapabilityAttachTool } from "./finance-learning-capability-attach-tool.js";
import { createFinanceLearningPipelineOrchestratorTool } from "./finance-learning-pipeline-orchestrator-tool.js";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
const sourcePath =
  "memory/research-sources/2026-04-27-academic_preprint-arxiv-frontier-finance-paper-sample-frontier-finance-paper-sample-filter-gate.md";
const query =
  "frontier finance paper factor research risk gate design sample out-of-sample benchmark";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
async function workspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "senior-task-consumption-"));
  roots.push(root);
  // Use the real attachment/inspection/apply owners with a labelled local test source.
  await fs.mkdir(path.dirname(path.join(root, sourcePath)), { recursive: true });
  await fs.writeFile(
    path.join(root, sourcePath),
    [
      "Sample risk review method. Test source, not public-paper performance evidence.",
      "Required Data Sources: evaluation setup, data/sample period, benchmark or ablation results",
      "Risk and Failure Modes: Method complexity can hide weak economics; empirical claims may fail out of sample.",
      "Overfitting or Spurious Risk: Confounders include data snooping and benchmark cherry-picking; independent transfer limits remain explicit.",
      "Implementation Requirements: Record cost effects, benchmark comparison, out-of-sample or transfer limits and the next correction action.",
    ].join("\n"),
  );
  const attached = await createFinanceLearningCapabilityAttachTool({ workspaceDir: root }).execute(
    "seed-review-source",
    {
      articlePath: sourcePath,
      title: "Sample risk review source",
      sourceType: "wechat_public_account_article",
      collectionMethod: "public_wechat_capture",
      authorSourceName: "Example test source",
      publishDate: "2025-01-01",
      extractionSummary:
        "A bounded research validation method that examines economics, benchmark comparison and independent evaluation before reuse.",
      rawNotes:
        "Local test source of a sample and cost validation method, with explicit limits and no trading authority.",
      capabilityCandidates: [
        {
          capabilityName: "Frontier sample risk review",
          capabilityType: "research_framework",
          relatedFinanceDomains: ["causal_map", "portfolio_risk_gates"],
          capabilityTags: ["factor_research", "causal_mapping", "risk_gate_design"],
          evidenceCategories: [
            "backtest_or_empirical_evidence",
            "causal_chain_evidence",
            "portfolio_risk_evidence",
            "implementation_evidence",
          ],
          evidenceSummary:
            "Evaluate method task outputs and record the actual economic and independent sample evidence gaps.",
          methodSummary:
            "Review weak economics, benchmark calibration and out-of-sample transfer limits before extrapolating a research task.",
          requiredDataSources: [
            "evaluation setup",
            "data/sample period",
            "benchmark or ablation results",
          ],
          causalOrMechanisticClaim:
            "Upstream task observations -> economic and calibration validation mechanism -> downstream method reuse assessment, supported by the actual measured task evidence.",
          evidenceLevel: "case_study",
          implementationRequirements:
            "Record cost effects, benchmark comparison, out-of-sample or transfer limits and the next correction action.",
          riskAndFailureModes:
            "Method complexity can hide weak economics; empirical claims may fail out of sample.",
          overfittingOrSpuriousRisk:
            "Confounders include data snooping and benchmark cherry-picking; independent transfer limits remain explicit.",
          complianceOrCollectionNotes: "Local test fixture only; no provider or order authority.",
          suggestedAttachmentPoint: "finance_framework_domain:causal_map",
          allowedActionAuthority: "research_only",
        },
      ],
    },
  );
  expect((attached.details as { ok: boolean }).ok).toBe(true);
  await fs.writeFile(
    path.join(root, "policy.json"),
    JSON.stringify({
      frozenAt: "2025-01-01T00:00:00.000Z",
      assumedRoundTripCostFraction: 0.001,
      estimator: {
        minObservations: 2,
        priorWins: 1,
        priorLosses: 1,
        kellyFraction: 0.25,
        maxAllocationFraction: 0.5,
        maxLossBudgetFraction: 0.01,
        uncertaintyPenalty: 1.96,
      },
    }),
  );
  const tool = createFinanceLearningCapabilityApplyTool({ workspaceDir: root });
  return { root, tool };
}
async function replay(root: string, name: string, returns = [0.002, -0.003, 0.001]) {
  const body = {
    schemaVersion: "lcx_finance_intraday_paper_v1",
    executionAuthority: "none",
    trades: returns.map((grossReturn, i) => ({
      instrument: "SPY",
      entryAt: `2026-01-0${i + 1}T14:30:00.000Z`,
      exitAt: `2026-01-0${i + 1}T15:30:00.000Z`,
      grossReturn,
      costFraction: 0.001,
    })),
  };
  await fs.writeFile(
    path.join(root, name),
    JSON.stringify({ receipt: { ...body, receiptRef: caseflowFingerprint(body) } }),
  );
  return {
    taskId: "sample-review-task",
    replayPath: name,
    policyPath: "policy.json",
    additionalCostFraction: 0.002,
  };
}
function details(result: { details: unknown }) {
  return result.details as {
    ok: boolean;
    applicationMode: string;
    usageReceiptPath: string;
    answerSkeleton: { summary: string; nextAction: string; requiredNextChecks: string[] };
    nextTaskReceiptSource: { path: string; sha256: string; taskId: string };
    consumedTaskReceipt: { path: string; sha256: string };
    taskApplication: {
      source: { path: string; sha256: string };
      assessmentInputs: { meanNetReturn: number };
      assessment: { nextAction: string };
      algorithmFromSource: boolean;
    };
  };
}

describe("original Senior source application, result and follow-up consumer", () => {
  it("passes the actual task from the original intake caller to the same apply/evaluation owner", async () => {
    const { root } = await workspace();
    const task = await replay(root, "intake-task-replay.json");
    const sourceBody = [
      "# Frontier sample risk review",
      "",
      "Source: Local test method notebook",
      "Publish Date: 2025-01-01",
      "Extraction Summary: This article extracts a bounded finance research validation method with explicit economic, mechanism, benchmark and independent sample evidence limits.",
      "Capability Name: Frontier sample risk review",
      "Capability Type: research_framework",
      "Related Finance Domains: causal_map, portfolio_risk_gates",
      "Capability Tags: factor_research, causal_mapping, risk_gate_design",
      "Method Summary: Review costs, benchmark calibration and independent sample transfer before extrapolation.",
      "Required Data Sources: evaluation setup, data/sample period, benchmark or ablation results",
      "Causal Claim: Upstream task observations -> economic and calibration validation mechanism -> downstream method reuse assessment, supported by measured task evidence.",
      "Evidence Categories: backtest_or_empirical_evidence, causal_chain_evidence, portfolio_risk_evidence, implementation_evidence",
      "Evidence Summary: Task results provide bounded economic and calibration evidence, with independent sample gaps explicit.",
      "Evidence Level: case_study",
      "Implementation Requirements: Record cost effects, benchmark comparison, out-of-sample or transfer limits and the next correction action.",
      "Risk and Failure Modes: Method complexity can hide weak economics; empirical claims may fail out of sample.",
      "Overfitting or Spurious Risk: Confounders include data snooping and benchmark cherry-picking; independent transfer limits remain explicit.",
      "Compliance or Collection Notes: Local synthetic test fixture only, with no provider or order authority.",
      "Suggested Attachment Point: finance_framework_domain:causal_map",
      "Allowed Action Authority: research_only",
    ].join("\n");
    const result = await createFinanceLearningPipelineOrchestratorTool({
      workspaceDir: root,
    }).execute("original-intake-task", {
      sourceName: "Senior bounded review test source",
      sourceType: "manual_article_source",
      pastedText: sourceBody,
      title: "Frontier sample risk review",
      publishDate: "2025-01-01",
      retrievalNotes:
        "Operator-supplied local test source. No remote calls or execution authority.",
      allowedActionAuthority: "research_only",
      learningIntent: query,
      applicationValidationQuery: query,
      maxAppliedCapabilities: 1,
      financialTask: task,
    });
    const value = result.details as {
      ok: boolean;
      applicationValidation: {
        applicationMode: string;
        taskApplication: { taskId: string };
        answerSkeleton: { nextAction: string };
      };
    };
    expect(value.ok, JSON.stringify(result.details).slice(0, 1800)).toBe(true);
    expect(value.applicationValidation.applicationMode).toBe("source_bound_financial_task_review");
    expect(value.applicationValidation.taskApplication.taskId).toBe(task.taskId);
    expect(value.applicationValidation.answerSkeleton.nextAction).toBe(
      "revise_cost_or_mechanism_hypothesis",
    );
  });

  it("executes a source-bound task and changes the next original apply's research action from its actual results", async () => {
    const { root, tool } = await workspace();
    const financialTask = await replay(root, "loss-replay.json");
    const first = details(
      await tool.execute("source-task", {
        queryText: query,
        sourceArticlePath: sourcePath,
        financialTask,
      }),
    );
    expect(first.ok).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(4096);
    expect(first.applicationMode).toBe("source_bound_financial_task_review");
    expect(first.taskApplication.source.path).toBe(sourcePath);
    expect(first.taskApplication.algorithmFromSource).toBe(false);
    expect(first.taskApplication.assessmentInputs.meanNetReturn).toBeCloseTo(-0.003, 10);
    const next = details(
      await tool.execute("original-next-apply", {
        queryText: query,
        sourceArticlePath: sourcePath,
        priorTaskReceiptSource: first.nextTaskReceiptSource,
      }),
    );
    expect(Buffer.byteLength(JSON.stringify(next))).toBeLessThanOrEqual(4096);
    expect(next.consumedTaskReceipt).toEqual({
      path: first.nextTaskReceiptSource.path,
      sha256: first.nextTaskReceiptSource.sha256,
    });
    expect(next.answerSkeleton.nextAction).toBe("revise_cost_or_mechanism_hypothesis");
    expect(next.answerSkeleton.summary).toContain("nonpositive average net return");
    expect(next.answerSkeleton.requiredNextChecks).toContain("review_declared_costs_and_mechanism");
    const improved = details(
      await tool.execute("changed-real-task-results", {
        queryText: query,
        sourceArticlePath: sourcePath,
        financialTask: await replay(root, "different-replay.json", [0.02, -0.003, 0.03]),
      }),
    );
    const changedConsumer = details(
      await tool.execute("changed-result-consumer", {
        queryText: query,
        sourceArticlePath: sourcePath,
        priorTaskReceiptSource: improved.nextTaskReceiptSource,
      }),
    );
    expect(changedConsumer.answerSkeleton.nextAction).not.toBe(next.answerSkeleton.nextAction);
    expect(changedConsumer.answerSkeleton.summary).not.toBe(next.answerSkeleton.summary);
    expect(changedConsumer.answerSkeleton.requiredNextChecks).not.toContain(
      "review_declared_costs_and_mechanism",
    );
  });
  it.each([
    "source_changed",
    "receipt_hash_conflict",
    "evidence_changed",
    "forged_result_with_valid_hash",
    "wrong_task",
  ])("refuses %s rather than consume it as valid feedback", async (kind) => {
    const { root, tool } = await workspace();
    const financialTask = await replay(root, "replay.json");
    const first = details(
      await tool.execute("original-task", {
        queryText: query,
        sourceArticlePath: sourcePath,
        financialTask,
      }),
    );
    const prior = { ...first.nextTaskReceiptSource };
    if (kind === "source_changed") {
      await fs.appendFile(path.join(root, sourcePath), "\nchanged current source\n");
    }
    if (kind === "receipt_hash_conflict") {
      prior.sha256 = "a".repeat(64);
    }
    if (kind === "evidence_changed") {
      await fs.appendFile(path.join(root, "replay.json"), " ");
    }
    if (kind === "wrong_task") {
      prior.taskId = "different-task";
    }
    if (kind === "forged_result_with_valid_hash") {
      const filename = path.join(root, prior.path);
      const receipt = JSON.parse(await fs.readFile(filename, "utf8"));
      Object.assign(receipt.taskApplication.assessmentInputs, {
        meanNetReturn: 0.9,
        brierScore: 0.2,
        halfBaseline: 0.25,
        scoredPredictions: 2,
        selectedTrades: 1,
        costErasedWinners: 0,
      });
      receipt.taskApplication.assessment = {
        nextAction: "validate_on_independent_sample",
        conclusion:
          "The supplied task may support further research; independent selection-process validation remains missing.",
        corrections: ["independent_selection_process_validation_missing"],
      };
      const text = JSON.stringify(receipt);
      await fs.writeFile(filename, text);
      prior.sha256 = hash(text);
    }
    await expect(
      tool.execute("bad-consumer", {
        queryText: query,
        sourceArticlePath: sourcePath,
        priorTaskReceiptSource: prior,
      }),
    ).rejects.toThrow();
  });
  it("retains guidance-only compatibility and refuses an unbound actual task", async () => {
    const { root, tool } = await workspace();
    const original = details(await tool.execute("old-guidance", { queryText: query }));
    expect(original.applicationMode).toBe("reuse_guidance_bounded_research_answer");
    await expect(
      tool.execute("unbound-task", {
        queryText: query,
        financialTask: await replay(root, "replay.json"),
      }),
    ).rejects.toThrow("financial_task_requires_exact_source");
  });
});

describe("original finance learning module task-feedback handoff", () => {
  it.each([false, true])(
    "consumes a pinned result or rejects its hash conflict (%s)",
    async (conflict) => {
      const { root, tool } = await workspace();
      const task = await replay(root, "module-loss-task.json");
      const first = details(
        await tool.execute("module-original-producer", {
          queryText: query,
          sourceArticlePath: sourcePath,
          financialTask: task,
        }),
      );
      const asOf = new Date().toISOString();
      const batch: FinanceResearchBatchEvidencePacket = {
        schemaVersion: "lcx_finance_research_batch_v1",
        boundary: "finance_research_batch_research_only",
        decisionMode: "research_only",
        correlationId: "original-learning-module-task",
        asOf,
        useCase: "finance_research_run",
        status: "blocked",
        jobs: [],
        committeeEvidence: [],
        budget: {} as FinanceResearchBatchEvidencePacket["budget"],
        notTouched: [],
      };
      const result = await executeFinanceModuleComposition({
        ask: query,
        asOf,
        batch,
        workspaceDir: root,
        plan: planFinanceBrainOrchestration({
          text: query,
          moduleSelection: {
            moduleIds: ["finance_learning_memory"],
            rationale: "consume the existing task result",
          },
        }),
        domainProducerInputs: {
          finance_learning_memory: {
            sourceArticlePath: sourcePath,
            priorTaskReceiptSource: {
              ...first.nextTaskReceiptSource,
              ...(conflict ? { sha256: "0".repeat(64) } : {}),
            },
          },
        },
      });
      const node = result.receipt.nodes.find((node) => node.moduleId === "finance_learning_memory");
      if (conflict) {
        expect(node?.status).not.toBe("succeeded");
        expect(node?.toolCalls[0].error).toContain("prior_task_receipt_hash_conflict");
      } else {
        expect(node?.status).toBe("succeeded");
        const evidence = result.evidence.find((e) => node?.outputEvidenceIds.includes(e.id));
        expect(evidence).toBeDefined();
        const output = JSON.parse(evidence!.text).toolOutput;
        expect(output.answerSkeleton.nextAction).toBe("revise_cost_or_mechanism_hypothesis");
        expect(output.consumedTaskReceipt.sha256).toBe(first.nextTaskReceiptSource.sha256);
        expect(output.taskApplication.taskId).toBe(task.taskId);
      }
    },
  );
});

describe("normal selected-method result feedback consumption", () => {
  it.each([false, true])(
    "uses validated prior results or preserves an optional validation gap (%s)",
    async (corrupt) => {
      const { root, tool } = await workspace();
      const first = details(
        await tool.execute("default-feedback-producer", {
          queryText: query,
          sourceArticlePath: sourcePath,
          financialTask: await replay(root, "default-feedback.json"),
        }),
      );
      if (corrupt) {
        const file = path.join(root, first.nextTaskReceiptSource.path);
        const body = JSON.parse(await fs.readFile(file, "utf8"));
        body.taskApplication.assessment.nextAction = "pretend_profitable";
        await fs.writeFile(file, JSON.stringify(body));
      }
      const raw = (
        await tool.execute("normal-module-query", { queryText: query, maxCandidates: 1 })
      ).details as Record<string, unknown>;
      if (corrupt) {
        expect(raw.ok).toBe(true);
        expect(raw.applicationMode).toBe("reuse_guidance_bounded_research_answer");
        expect(raw.priorTaskFeedbackGap).toContain("validation_failed");
        expect(raw.taskApplication).toBeUndefined();
      } else {
        const value = raw as unknown as ReturnType<typeof details>;
        expect(raw.applicationMode).toBe("prior_method_task_feedback_context");
        expect(raw.taskResultScope).toBe("historical_task_not_current_market_or_trade");
        expect(value.answerSkeleton.nextAction).toBe("revise_cost_or_mechanism_hypothesis");
        expect(value.answerSkeleton.summary).toContain("not a current market/trade assessment");
        expect(value.consumedTaskReceipt.sha256).toBe(first.nextTaskReceiptSource.sha256);
        expect(Buffer.byteLength(JSON.stringify(raw))).toBeLessThanOrEqual(4096);
      }
    },
  );
});
