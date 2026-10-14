import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { createFinanceLearningCapabilityApplyTool } from "../../src/agents/tools/finance-learning-capability-apply-tool.js";
import { createFinanceLearningPipelineOrchestratorTool } from "../../src/agents/tools/finance-learning-pipeline-orchestrator-tool.js";
import { createModuleLearningPipelinePlanTool } from "../../src/agents/tools/module-learning-pipeline-plan-tool.js";
import { createModuleLearningPipelineReviewTool } from "../../src/agents/tools/module-learning-pipeline-review-tool.js";

const executeFile = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "../..");
export type LearningRecord = Record<string, unknown>;
export function record(value: unknown): LearningRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected original owner record");
  }
  return value as LearningRecord;
}
export function text(value: unknown): string {
  if (typeof value !== "string" || !value) {
    throw new Error("Expected original owner string");
  }
  return value;
}
export async function saveLearningJson(workspace: string, file: string, value: unknown) {
  await fs.mkdir(path.dirname(path.join(workspace, file)), { recursive: true });
  await fs.writeFile(path.join(workspace, file), `${JSON.stringify(value, null, 2)}\n`);
  return file;
}
export async function learningHash(workspace: string, file: string) {
  return createHash("sha256")
    .update(await fs.readFile(path.join(workspace, file)))
    .digest("hex");
}
export async function learningGate(workspace: string) {
  const result = await executeFile(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/operator/lcx-module-learning-absorption-gate.ts",
      "--workspace",
      workspace,
      "--guard-log",
      path.join(workspace, "guard.jsonl"),
      "--json",
    ],
    { cwd: repoRoot, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
  );
  return record(JSON.parse(result.stdout));
}
export async function seedNativeLearning(workspace: string) {
  const sourceFile = "memory/input/source.md";
  await fs.mkdir(path.dirname(path.join(workspace, sourceFile)), { recursive: true });
  await fs.copyFile(
    path.join(repoRoot, "test/fixtures/finance-learning-pipeline/valid-etf-risk-sizing-article.md"),
    path.join(workspace, sourceFile),
  );
  const query = "Research-only ETF risk sizing portfolio risk gates and position exposure review";
  const intake = record(
    (
      await createFinanceLearningPipelineOrchestratorTool({ workspaceDir: workspace }).execute(
        "native-source-intake",
        {
          sourceName: "Offline original risk method",
          sourceType: "manual_article_source",
          localFilePath: sourceFile,
          title: "ETF risk sizing review",
          retrievalNotes: "Bounded local source and actual source content; no remote fetch.",
          allowedActionAuthority: "research_only",
          learningIntent: query,
          targetModule: "portfolio_risk_gates",
          actualReadingScope: "Entire local structured method fixture; external claims unverified",
          applicationValidationQuery: query,
        },
      )
    ).details,
  );
  const candidate = record(intake.moduleLearningPlanCandidate);
  const applicationPath = text(candidate.applicationValidationReceiptPath);
  const source = text(candidate.sourceUrlOrPath);
  const task =
    "Apply original retained sizing method to a fresh offline exposure question without execution authority";
  const apply = record(
    (
      await createFinanceLearningCapabilityApplyTool({ workspaceDir: workspace }).execute(
        "fresh-native-application",
        { queryText: query, writeUsageReceipt: true },
      )
    ).details,
  );
  const freshApplicationPath = text(apply.usageReceiptPath);
  const evaluationPath = await saveLearningJson(workspace, "evidence/application-eval.json", {
    schemaVersion: "lcx_module_learning_eval_v1",
    verdict: "passed",
    targetModule: "portfolio_risk_gates",
    sourceUrlOrPath: source,
    freshAdjacentApplicationTask: task,
    checks: [
      {
        id: "original-application-research-boundary",
        passed:
          apply.ok === true && apply.boundary === "finance_learning_capability_apply_read_only",
        evidencePath: freshApplicationPath,
        sha256: await learningHash(workspace, freshApplicationPath),
      },
      {
        id: "original-source-content",
        passed: true,
        evidencePath: source,
        sha256: await learningHash(workspace, source),
      },
    ],
    boundary:
      "Local deterministic application check; no trainer, model learning or promotion claim",
  });
  const planArgs = {
    ...candidate,
    trainingOrEvalAbsorptionEvidencePath: evaluationPath,
    freshAdjacentApplicationTask: task,
    keepDownrankDiscardDecision: "keep",
    writeReceipt: true,
    receiptDateKey: "2026-10-11",
  };
  const plan = record(
    (
      await createModuleLearningPipelinePlanTool({ workspaceDir: workspace }).execute(
        "native-module-plan",
        planArgs,
      )
    ).details,
  );
  const review = record(
    (
      await createModuleLearningPipelineReviewTool({ workspaceDir: workspace }).execute(
        "native-module-review",
        { targetModule: "portfolio_risk_gates", writeReview: true },
      )
    ).details,
  );
  await fs.writeFile(
    path.join(workspace, "guard.jsonl"),
    `${JSON.stringify({ at: "2026-10-11T00:00:00.000Z", event: "step_ok", name: "stable_hardened_eval", result: { summary: { passed: 1, total: 1, passRate: 1, promotionReady: true, failedCaseIds: [], parseErrorCaseIds: [], parseRecoveredCaseIds: [] } } })}\n`,
  );
  return {
    sourceFile,
    source,
    intake,
    candidate,
    applicationPath,
    freshApplicationPath,
    apply,
    evaluationPath,
    planArgs,
    plan,
    review,
    query,
  };
}

export type NativeLearningObservation = {
  owner: string;
  id: string;
  parentId: string | null;
  toolCallId: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  scope: { runId: string; workspaceId: string };
};

export async function probeContinuousNativeLearning(params: {
  workspace: string;
  directory: string;
  runId: string;
  observations: NativeLearningObservation[];
  fault?: "source_hash_conflict" | "missing_retrieval" | "eval_timeout";
}) {
  const { auditWorkflowHandoffs } = await import("../../scripts/operator/lcx-flow-graph.js");
  const { createFinanceLearningCapabilityInspectTool } =
    await import("../../src/agents/tools/finance-learning-capability-inspect-tool.js");
  const scope = {
    runId: params.runId,
    workspaceId: createHash("sha256").update(path.resolve(params.workspace)).digest("hex"),
  };
  await fs.mkdir(params.directory, { recursive: true });
  const seeded = await seedNativeLearning(params.workspace);
  const frozenSourceSha256 = await learningHash(params.workspace, seeded.source);
  const retrievalPath = text(seeded.candidate.retrievalReceiptPath);
  const originalFiles = [
    seeded.sourceFile,
    seeded.source,
    "memory/local-memory/finance-learning-capability-candidates.md",
    retrievalPath,
    seeded.applicationPath,
    seeded.freshApplicationPath,
    seeded.evaluationPath,
    text(seeded.plan.receiptPath),
    text(seeded.review.reviewPath),
  ];
  const preserved: Array<{ relativePath: string; path: string; sha256: string }> = [];
  const preserve = async (relativePath: string, tag = "before-feedback") => {
    const file = path.join(params.directory, "native-bytes", tag, relativePath);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.copyFile(path.join(params.workspace, relativePath), file);
    preserved.push({
      relativePath,
      path: file,
      sha256: createHash("sha256")
        .update(await fs.readFile(file))
        .digest("hex"),
    });
  };
  for (const file of originalFiles) {
    await preserve(file);
  }
  const originalRetrieval = record(
    JSON.parse(await fs.readFile(path.join(params.workspace, retrievalPath), "utf8")),
  );
  if (params.fault === "source_hash_conflict") {
    await fs.appendFile(
      path.join(params.workspace, seeded.source),
      "\nSource changed after local evaluation.\n",
    );
  }
  if (params.fault === "missing_retrieval") {
    await fs.rm(path.join(params.workspace, retrievalPath));
  }
  if (params.fault === "eval_timeout") {
    await fs.appendFile(
      path.join(params.workspace, "guard.jsonl"),
      `${JSON.stringify({ at: "2026-10-11T01:00:00.000Z", event: "step_timeout", name: "stable_hardened_eval", result: { timeoutReason: "offline_evaluator_receipt_substitute", timeoutMs: 100 } })}\n`,
    );
  }
  const nextPlan = record(
    (
      await createModuleLearningPipelinePlanTool({ workspaceDir: params.workspace }).execute(
        "continuous-original-downrank",
        {
          ...seeded.planArgs,
          keepDownrankDiscardDecision: "downrank",
          supersedesReceiptPath: seeded.plan.receiptPath,
        },
      )
    ).details,
  );
  const review = record(
    (
      await createModuleLearningPipelineReviewTool({ workspaceDir: params.workspace }).execute(
        "continuous-original-review",
        { writeReview: true },
      )
    ).details,
  );
  const inspection = record(
    (
      await createFinanceLearningCapabilityInspectTool({ workspaceDir: params.workspace }).execute(
        "continuous-original-feedback-inspection",
        { queryText: seeded.query },
      )
    ).details,
  );
  const nextApply = record(
    (
      await createFinanceLearningCapabilityApplyTool({ workspaceDir: params.workspace }).execute(
        "continuous-original-next-application",
        { queryText: seeded.query, writeUsageReceipt: true },
      )
    ).details,
  );
  const gateExecution = await executeFile(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/operator/lcx-module-learning-absorption-gate.ts",
      "--workspace",
      params.workspace,
      "--guard-log",
      path.join(params.workspace, "guard.jsonl"),
      "--source",
      seeded.source,
      "--target-module",
      "portfolio_risk_gates",
      "--host-run-id",
      params.runId,
      "--receipt-sha256",
      await learningHash(params.workspace, text(nextPlan.receiptPath)),
      "--source-sha256",
      frozenSourceSha256,
      "--json",
    ],
    { cwd: repoRoot, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
  );
  const gate = record(JSON.parse(gateExecution.stdout));
  for (const file of [
    text(nextPlan.receiptPath),
    text(review.reviewPath),
    text(nextApply.usageReceiptPath),
    "guard.jsonl",
    seeded.source,
  ]) {
    await preserve(file, "after-feedback");
  }
  const find = (owner: string, toolCallId?: string) => {
    const call = params.observations.find(
      (entry) => entry.owner === owner && (!toolCallId || entry.toolCallId === toolCallId),
    );
    if (!call) {
      throw new Error(`Original invocation missing:${owner}:${toolCallId}`);
    }
    return call;
  };
  const workbench = find("finance-research-source-workbench-tool");
  const extraction = find("finance-article-extract-capability-input-tool");
  const attachment = find("finance-learning-capability-attach-tool");
  const primaryApplication = params.observations.find(
    (call) =>
      call.owner === "finance-learning-capability-apply-tool" &&
      call.toolCallId.endsWith(":application-validation"),
  );
  if (!primaryApplication) {
    throw new Error("Original pipeline application invocation missing");
  }
  const primaryInspection = params.observations.find(
    (call) =>
      call.owner === "finance-learning-capability-inspect-tool" &&
      call.parentId === primaryApplication.id,
  );
  if (!primaryInspection) {
    throw new Error("Original apply child inspection readback missing");
  }
  const feedbackInspection = find(
    "finance-learning-capability-inspect-tool",
    "continuous-original-feedback-inspection",
  );
  const evaluation = find("module-learning-pipeline-plan-tool", "continuous-original-downrank");
  const reviewObservation = find(
    "module-learning-pipeline-review-tool",
    "continuous-original-review",
  );
  const files: Record<string, string> = {};
  const save = async (name: string, value: unknown) => {
    const file = path.join(params.directory, `${name}.json`);
    await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
    files[name] = file;
    return file;
  };
  await save("source-intake", workbench);
  await save("source-extraction", extraction);
  await save("card-lifecycle", {
    scope,
    attachment,
    primaryInspection,
    effective: feedbackInspection,
  });
  await save("application", {
    scope,
    application: primaryApplication,
    inspection: primaryInspection,
  });
  await save("retrieval", { scope, pipelineReturn: seeded.intake, receipt: originalRetrieval });
  await save("local-evaluation", evaluation);
  await save("review", reviewObservation);
  await save("gate", gate);
  await save("native-invocations", { scope, observations: params.observations });
  await save("outcome", {
    scope,
    fault: params.fault ?? null,
    review,
    inspection,
    nextApply,
    preserved,
    boundary:
      "Host observes original invocation arguments and returns in one private run. Deterministic evaluator and timeout receipt are substitutes; no model training, natural adoption or process cancellation claim.",
  });
  const ref = async (name: string, pointer: string) => ({
    path: files[name],
    pointer,
    sha256: createHash("sha256")
      .update(await fs.readFile(files[name]))
      .digest("hex"),
  });
  const node = async (
    nodeId: import("../../scripts/operator/lcx-flow-graph.js").WorkflowHandoffEvidence["nodes"][number]["nodeId"],
    name: string,
    output: string,
    inputs: Array<[typeof nodeId, string]> = [],
  ): Promise<
    import("../../scripts/operator/lcx-flow-graph.js").WorkflowHandoffEvidence["nodes"][number]
  > => ({
    nodeId,
    scope: await ref(name, "/scope"),
    output: await ref(name, output),
    inputs: await Promise.all(
      inputs.map(async ([from, pointer]) => ({ from, value: await ref(name, pointer) })),
    ),
  });
  const card = await node("capability_card", "card-lifecycle", "/effective/output/candidates/0", [
    ["actual_reading_scope", "/attachment/input"],
    [
      "module_learning_review",
      "/effective/output/candidates/0/moduleLearningReview/receipts/0/receiptSha256",
    ],
  ]);
  card.outputs = [
    {
      to: "apply_validation",
      value: await ref("card-lifecycle", "/primaryInspection/output/artifactPath"),
    },
    {
      to: "retrieval_receipt",
      value: await ref("card-lifecycle", "/effective/output/artifactPath"),
    },
  ];
  const reviewNode = await node("module_learning_review", "review", "/output/rows/0", [
    ["local_brain_eval_absorption", "/output/rows/0/declaredStatus"],
  ]);
  reviewNode.outputs = [
    {
      to: "keep_downrank_discard",
      value: await ref("review", "/output/rows/0/keepDownrankDiscardDecision"),
    },
    {
      to: "module_learning_absorption_gate",
      value: await ref("review", "/output/rows/0/receiptSha256"),
    },
    { to: "capability_card", value: await ref("review", "/output/rows/0/receiptSha256") },
  ];
  const gateNode = {
    nodeId: "module_learning_absorption_gate" as const,
    scope: await ref("gate", "/consumedReview/hostScope"),
    output: await ref("gate", "/gateDecision"),
    inputs: [
      {
        from: "module_learning_review" as const,
        value: await ref("gate", "/consumedReview/selectedReceipts/0/receiptSha256"),
      },
      {
        from: "keep_downrank_discard" as const,
        value: await ref("gate", "/consumedReview/selectedReceipts/0/keepDownrankDiscardDecision"),
      },
    ],
    block: {
      filter: "per_receipt_absorption_evidence_required" as const,
      status: await ref("gate", "/gateDecision"),
      reason: await ref("gate", "/blockers/0"),
    },
  };
  const evidence: import("../../scripts/operator/lcx-flow-graph.js").WorkflowHandoffEvidence = {
    scenarioId: "module_learning_internalization_waterflow",
    environment: "offline_fixture",
    nodes: [
      await node("source_intake", "source-intake", "/output/artifactPath"),
      await node("source_registry", "source-extraction", "/output/articlePath", [
        ["source_intake", "/input/articlePath"],
      ]),
      await node("actual_reading_scope", "source-extraction", "/output/attachPayload", [
        ["source_registry", "/input/articlePath"],
      ]),
      card,
      await node("apply_validation", "application", "/application/output/usageReceiptPath", [
        ["capability_card", "/inspection/output/artifactPath"],
      ]),
      await node(
        "retrieval_receipt",
        "retrieval",
        "/pipelineReturn/retrievalFirstLearning/retrievalReceiptPath",
        [
          ["capability_card", "/receipt/postAttachCapabilityRetrieval/artifactPath"],
          ["apply_validation", "/receipt/applicationValidation/usageReceiptPath"],
        ],
      ),
      await node("local_brain_eval_absorption", "local-evaluation", "/output/status", [
        ["retrieval_receipt", "/input/retrievalReceiptPath"],
        ["apply_validation", "/input/applicationValidationReceiptPath"],
      ]),
      reviewNode,
      await node(
        "keep_downrank_discard",
        "review",
        "/output/terminalNonAbsorbedRows/0/keepDownrankDiscardDecision",
        [
          [
            "module_learning_review",
            "/output/terminalNonAbsorbedRows/0/keepDownrankDiscardDecision",
          ],
        ],
      ),
      gateNode,
    ],
  };
  await save("handoff-input", [evidence]);
  const audit = (await auditWorkflowHandoffs([evidence])).find(
    (row) => row.scenarioId === evidence.scenarioId,
  );
  await save("handoff-audit", audit);
  return { evidence, audit, nextApply, gate, preserved };
}
