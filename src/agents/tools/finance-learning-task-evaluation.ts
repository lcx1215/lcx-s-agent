import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import { z } from "zod";
import { caseflowFingerprint } from "../finance-caseflow.js";
import { FinanceTradeEconomicsPolicySchema } from "../finance-trade-economics.js";
import { createQuantMathTool } from "./quant-math-tool.js";

export const FinanceLearningTaskSchema = Type.Object({
  taskId: Type.String({ minLength: 1, maxLength: 120 }),
  replayPath: Type.String(),
  policyPath: Type.String(),
  additionalCostFraction: Type.Number({ minimum: 0 }),
});
export const FinanceLearningPriorTaskSchema = Type.Object({
  path: Type.String(),
  sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  taskId: Type.String({ minLength: 1, maxLength: 120 }),
});
const Task = z
  .object({
    taskId: z.string().min(1).max(120),
    replayPath: z.string().min(1),
    policyPath: z.string().min(1),
    additionalCostFraction: z.number().finite().nonnegative(),
  })
  .strict();
const Prior = z
  .object({
    path: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    taskId: z.string().min(1).max(120),
  })
  .strict();
const FileRef = z
  .object({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/u) })
  .strict();
const AssessmentInput = z
  .object({
    meanNetReturn: z.number().finite().nullable(),
    brierScore: z.number().finite().nullable(),
    halfBaseline: z.number().finite().nullable(),
    scoredPredictions: z.number().int().nonnegative(),
    selectedTrades: z.number().int().nonnegative(),
    costErasedWinners: z.number().int().nonnegative(),
  })
  .strict();
const Application = z
  .object({
    schemaVersion: z.literal("lcx_finance_learning_task_application_v1"),
    taskId: z.string().min(1).max(120),
    additionalCostFraction: z.number().finite().nonnegative(),
    source: FileRef,
    replay: FileRef,
    policy: FileRef,
    guidanceSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    sourceMethod: z.literal("retained_sample_and_risk_review_guidance"),
    sourceChecksUsed: z.array(z.string()).min(1),
    methodOwner: z.literal("quant_math.trade_economics_eval"),
    nativeReceiptRef: z.string().regex(/^[a-f0-9]{64}$/u),
    datasetRef: z.string().regex(/^[a-f0-9]{64}$/u),
    policyRef: z.string().regex(/^[a-f0-9]{64}$/u),
    assessmentInputs: AssessmentInput,
    assessment: z
      .object({ nextAction: z.string(), conclusion: z.string(), corrections: z.array(z.string()) })
      .strict(),
    sourceTruth: z.literal("not_independently_verified"),
    algorithmFromSource: z.literal(false),
    executionAuthority: z.literal("none"),
  })
  .strict();
export type FinanceLearningTaskApplication = z.infer<typeof Application>;
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Exact workspace files only; no remote reads, protected-state writes or result aliases. */
async function readFile(workspace: string, name: string) {
  const root = await fs.realpath(workspace);
  const filename = await fs.realpath(path.resolve(root, name));
  if (!filename.startsWith(root + path.sep)) {
    throw new Error("task_evidence_outside_workspace");
  }
  if ((await fs.stat(filename)).size > 1_048_576) {
    throw new Error("task_evidence_too_large");
  }
  const bytes = await fs.readFile(filename);
  if (bytes.length > 1_048_576) {
    throw new Error("task_evidence_too_large");
  }
  return {
    path: path.relative(root, filename).split(path.sep).join("/"),
    sha256: hash(bytes),
    text: bytes.toString("utf8"),
  };
}
function assess(input: z.infer<typeof AssessmentInput>) {
  const negative = input.meanNetReturn !== null && input.meanNetReturn <= 0;
  const unscored = input.scoredPredictions === 0;
  const calibrationWeak =
    input.brierScore !== null &&
    input.halfBaseline !== null &&
    input.brierScore > input.halfBaseline;
  const nextAction = negative
    ? "revise_cost_or_mechanism_hypothesis"
    : unscored
      ? "collect_closed_observations"
      : calibrationWeak
        ? "review_prediction_calibration"
        : "validate_on_independent_sample";
  return {
    nextAction,
    conclusion: negative
      ? "The supplied task has nonpositive average net return; revisit the cost/mechanism hypothesis before treating it as performance evidence."
      : unscored
        ? "The task has no scored predictions; gather closed observations before calibration claims."
        : calibrationWeak
          ? "Prediction calibration is weaker than the half-probability baseline; review it before extrapolating."
          : "The supplied task may support further research; independent selection-process validation remains missing.",
    corrections: [
      ...(negative ? ["review_declared_costs_and_mechanism"] : []),
      ...(calibrationWeak ? ["review_calibration_without_fitting_this_sample"] : []),
      ...(input.costErasedWinners > 0 ? ["review_turnover_fees_and_slippage"] : []),
      ...(input.selectedTrades === 0
        ? ["zero_selected_trades_is_abstention_not_profitability"]
        : []),
      "independent_selection_process_validation_missing",
    ],
  };
}

export async function evaluateFinanceLearningTask(params: {
  workspaceDir: string;
  candidate: Record<string, unknown>;
  task?: unknown;
  prior?: unknown;
}) {
  const sourcePath = z.string().min(1).parse(params.candidate.sourceArticlePath);
  const tags = z.array(z.string()).parse(params.candidate.capabilityTags);
  const guidance = z
    .object({
      riskChecks: z.array(z.string()).min(1),
      implementationCheck: z.string().min(1),
      requiredInputs: z.array(z.string()).min(1),
    })
    .passthrough()
    .parse(params.candidate.reuseGuidance);
  if (!tags.includes("risk_gate_design")) {
    throw new Error("source_has_no_supported_sample_risk_review_method");
  }
  const sourceFile = await readFile(params.workspaceDir, sourcePath);
  const source = { path: sourceFile.path, sha256: sourceFile.sha256 };
  // Risk review is the retained method; the native estimator is not attributed to the paper.
  const sourceChecksUsed = [...guidance.riskChecks, guidance.implementationCheck];
  const normalizeText = (text: string) => text.replace(/\s+/gu, " ").trim();
  if (
    sourceChecksUsed.some((check) => !normalizeText(sourceFile.text).includes(normalizeText(check)))
  ) {
    throw new Error("source_card_guidance_not_present_in_current_source");
  }
  const ruleText = sourceChecksUsed.join(" ");
  // This bounded adapter supports the retained economic/sample/benchmark review,
  // not arbitrary source prose or an implementation of a paper's alpha algorithm.
  if (
    !/out.of.sample|transfer limits/iu.test(ruleText) ||
    !/economic|cost|fee|slippage/iu.test(ruleText) ||
    !guidance.requiredInputs.some((input) => /benchmark/iu.test(input))
  ) {
    throw new Error("source_review_rules_not_supported_by_native_task_evaluator");
  }
  const guidanceSha256 = createHash("sha256").update(JSON.stringify(guidance)).digest("hex");
  let previous: FinanceLearningTaskApplication | undefined;
  let consumedReceipt: z.infer<typeof FileRef> | undefined;
  if (params.prior !== undefined) {
    const prior = Prior.parse(params.prior);
    if (!prior.path.startsWith("memory/finance-learning-apply-usage-receipts/")) {
      throw new Error("prior_task_not_original_usage_receipt");
    }
    const file = await readFile(params.workspaceDir, prior.path);
    if (file.sha256 !== prior.sha256) {
      throw new Error("prior_task_receipt_hash_conflict");
    }
    const receipt = z
      .object({
        boundary: z.literal("finance_learning_capability_apply_usage_receipt"),
        ok: z.literal(true),
        taskApplication: Application,
      })
      .passthrough()
      .parse(JSON.parse(file.text));
    previous = receipt.taskApplication;
    if (
      previous.taskId !== prior.taskId ||
      previous.source.path !== source.path ||
      previous.source.sha256 !== source.sha256 ||
      previous.guidanceSha256 !== guidanceSha256
    ) {
      throw new Error("prior_task_source_or_task_scope_conflict");
    }
    for (const ref of [previous.replay, previous.policy]) {
      if ((await readFile(params.workspaceDir, ref.path)).sha256 !== ref.sha256) {
        throw new Error("prior_task_evidence_hash_conflict");
      }
    }
    const verified = await evaluateFinanceLearningTask({
      workspaceDir: params.workspaceDir,
      candidate: params.candidate,
      task: {
        taskId: previous.taskId,
        replayPath: previous.replay.path,
        policyPath: previous.policy.path,
        additionalCostFraction: previous.additionalCostFraction,
      },
    });
    if (JSON.stringify(verified.application) !== JSON.stringify(previous)) {
      throw new Error("prior_task_assessment_conflict");
    }
    consumedReceipt = { path: file.path, sha256: file.sha256 };
  }
  let application = previous;
  if (params.task !== undefined) {
    const task = Task.parse(params.task);
    if (previous && previous.taskId !== task.taskId) {
      throw new Error("followup_task_scope_conflict");
    }
    const replayFile = await readFile(params.workspaceDir, task.replayPath);
    const policyFile = await readFile(params.workspaceDir, task.policyPath);
    const raw = z
      .object({ receipt: z.record(z.string(), z.unknown()) })
      .passthrough()
      .parse(JSON.parse(replayFile.text));
    const { receiptRef, ...body } = raw.receipt;
    if (receiptRef !== caseflowFingerprint(body)) {
      throw new Error("original_replay_receipt_hash_conflict");
    }
    const replay = z
      .object({
        schemaVersion: z.literal("lcx_finance_intraday_paper_v1"),
        executionAuthority: z.literal("none"),
        trades: z.array(
          z.object({
            instrument: z.string(),
            entryAt: z.string(),
            exitAt: z.string(),
            grossReturn: z.number(),
            costFraction: z.number(),
          }),
        ),
      })
      .passthrough()
      .parse(body);
    if (
      replay.trades.some(
        (trade) =>
          !Number.isFinite(Date.parse(trade.exitAt)) || Date.parse(trade.exitAt) > Date.now(),
      )
    ) {
      throw new Error("financial_task_has_no_closed_actual_outcome");
    }
    const policy = z
      .object({
        frozenAt: z.string().datetime({ offset: true }),
        estimator: FinanceTradeEconomicsPolicySchema,
        assumedRoundTripCostFraction: z.number().finite().nonnegative(),
      })
      .passthrough()
      .parse(JSON.parse(policyFile.text));
    if (Date.parse(policy.frozenAt) > Date.now()) {
      throw new Error("task_policy_frozen_in_future");
    }
    const native = await createQuantMathTool().execute("finance-learning-task-evaluation", {
      action: "trade_economics_eval",
      observations: replay.trades.map((t) => ({
        id: `${t.instrument}:${t.entryAt}`,
        entryAt: t.entryAt,
        exitAt: t.exitAt,
        grossReturn: t.grossReturn,
        costFraction: t.costFraction,
      })),
      policy: policy.estimator,
      assumedRoundTripCostFraction: policy.assumedRoundTripCostFraction,
      additionalCostFraction: task.additionalCostFraction,
    });
    const result = z
      .object({
        datasetRef: z.string(),
        policyRef: z.string(),
        brierScore: z.number().nullable(),
        constantHalfBrier: z.number().nullable(),
        scoredPredictions: z.number(),
        sizedTrades: z.number(),
        netEconomics: z.object({
          allOpportunities: z.object({ meanNetReturn: z.number().nullable() }),
          grossWinnersLostAfterCosts: z.number(),
        }),
      })
      .passthrough()
      .parse(native.details);
    const assessmentInputs = AssessmentInput.parse({
      meanNetReturn: result.netEconomics.allOpportunities.meanNetReturn,
      brierScore: result.brierScore,
      halfBaseline: result.constantHalfBrier,
      scoredPredictions: result.scoredPredictions,
      selectedTrades: result.sizedTrades,
      costErasedWinners: result.netEconomics.grossWinnersLostAfterCosts,
    });
    application = Application.parse({
      schemaVersion: "lcx_finance_learning_task_application_v1",
      taskId: task.taskId,
      additionalCostFraction: task.additionalCostFraction,
      guidanceSha256,
      source,
      replay: { path: replayFile.path, sha256: replayFile.sha256 },
      policy: { path: policyFile.path, sha256: policyFile.sha256 },
      sourceMethod: "retained_sample_and_risk_review_guidance",
      sourceChecksUsed,
      methodOwner: "quant_math.trade_economics_eval",
      nativeReceiptRef: receiptRef,
      datasetRef: result.datasetRef,
      policyRef: result.policyRef,
      assessmentInputs,
      assessment: assess(assessmentInputs),
      sourceTruth: "not_independently_verified",
      algorithmFromSource: false,
      executionAuthority: "none",
    });
  }
  if (!application) {
    throw new Error("financial_task_or_prior_receipt_required");
  }
  return { application, consumedReceipt, previousAssessment: previous?.assessment ?? null };
}

// Reuse the exact validators at the original research producer handoff.
export { Task as FinanceLearningTaskValidator, Prior as FinanceLearningPriorTaskValidator };
