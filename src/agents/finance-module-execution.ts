import type { FinanceCommitteeEvidence } from "./finance-agent-committee.js";
import {
  FINANCE_BRAIN_MODULES,
  type FinanceBrainModuleId,
  type FinanceBrainOrchestrationPlan,
} from "./finance-brain-orchestration.js";
import type {
  FinanceResearchBatchEvidencePacket,
  FinanceResearchBatchJob,
} from "./finance-research-batch-runner.js";
import type { AnyAgentTool } from "./tools/common.js";
import { createFinanceFrameworkCoreInspectTool } from "./tools/finance-framework-core-inspect-tool.js";
import { createFinanceLearningCapabilityApplyTool } from "./tools/finance-learning-capability-apply-tool.js";
import { createQuantMathTool } from "./tools/quant-math-tool.js";

export const FINANCE_MODULE_EXECUTION_SCHEMA_VERSION = "lcx_finance_module_execution_v1" as const;

export type FinanceModuleExecutionNodeStatus =
  | "succeeded"
  | "blocked_missing_evidence"
  | "failed"
  | "cancelled";

export type FinanceModuleExecutionToolCall = Readonly<{
  toolName: string;
  status: "succeeded" | "blocked" | "failed" | "cancelled";
  inputEvidenceIds: readonly string[];
  outputSummary?: string;
  error?: string;
}>;

export type FinanceModuleExecutionNode = Readonly<{
  nodeId: string;
  moduleId: FinanceBrainModuleId;
  requiredToolNames: readonly string[];
  dependsOn: readonly string[];
  status: FinanceModuleExecutionNodeStatus;
  inputEvidenceIds: readonly string[];
  outputEvidenceIds: readonly string[];
  toolCalls: readonly FinanceModuleExecutionToolCall[];
  missingEvidence: readonly string[];
  error?: string;
}>;

export type FinanceModuleExecutionReceipt = Readonly<{
  schemaVersion: typeof FINANCE_MODULE_EXECUTION_SCHEMA_VERSION;
  boundary: "finance_module_execution_research_only";
  requested: boolean;
  allNodesSucceeded: boolean;
  moduleToolsDispatched: boolean;
  compositionNodeIds: readonly string[];
  outputEvidenceIds: readonly string[];
  nodes: readonly FinanceModuleExecutionNode[];
  notTouched: readonly string[];
}>;

const NOT_TOUCHED = Object.freeze([
  "provider_config",
  "external_channel_sender",
  "trading_execution",
  "wallet_or_order_authority",
] as const);

const FRAMEWORK_INSPECT_DOMAINS = new Set<string>([
  "macro_rates_inflation",
  "etf_regime",
  "options_volatility",
  "company_fundamentals_value",
  "commodities_oil_gold",
  "fx_dollar",
  "credit_liquidity",
  "event_driven",
  "portfolio_risk_gates",
  "causal_map",
] as const);

type ToolDetails = Record<string, unknown>;

function asRecord(value: unknown): ToolDetails {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as ToolDetails) : {};
}

function compact(value: unknown, maxLength = 2_000): string {
  try {
    const serialized = JSON.stringify(value);
    return serialized.length <= maxLength ? serialized : `${serialized.slice(0, maxLength)}…`;
  } catch {
    return "[unserializable tool output]";
  }
}

function recordsForJobs(batch: FinanceResearchBatchEvidencePacket): Readonly<{
  jobs: readonly FinanceResearchBatchJob[];
  inputEvidenceIds: readonly string[];
  levels: readonly number[];
  summary: string;
}> {
  const jobs = batch.jobs.filter((job) => job.status === "ready" && job.receipt !== undefined);
  const inputEvidenceIds = jobs.map((job) => job.jobId);
  const levels: number[] = [];
  const collections = new Map<string, number>();
  let selectedHistory: FinanceResearchBatchJob | undefined;
  for (const job of jobs) {
    if (!("records" in job.receipt!)) {
      continue;
    }
    const records = job.receipt.records;
    if (!("collection" in job.request)) {
      continue;
    }
    collections.set(
      job.request.collection,
      (collections.get(job.request.collection) ?? 0) + records.length,
    );
    if (job.request.collection !== "eod_history") {
      continue;
    }
    if (
      selectedHistory === undefined ||
      ("records" in selectedHistory.receipt! &&
        records.length > selectedHistory.receipt.records.length)
    ) {
      selectedHistory = job;
    }
  }
  if (selectedHistory?.receipt && "records" in selectedHistory.receipt) {
    for (const record of selectedHistory.receipt.records) {
      const value = record.data.close ?? record.data.c ?? record.data.price;
      if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        levels.push(value);
      } else if (typeof value === "string" && Number.isFinite(Number(value)) && Number(value) > 0) {
        levels.push(Number(value));
      }
    }
  }
  return {
    jobs,
    inputEvidenceIds: Object.freeze(inputEvidenceIds),
    levels: Object.freeze(levels),
    summary: [...collections.entries()]
      .map(([collection, count]) => `${collection}=${count}`)
      .join(", "),
  };
}

function toolResultDetails(result: unknown): ToolDetails {
  return asRecord(
    result && typeof result === "object" && "details" in result ? result.details : result,
  );
}

async function callTool(
  tool: AnyAgentTool,
  toolName: string,
  args: Record<string, unknown>,
  inputEvidenceIds: readonly string[],
  signal?: AbortSignal,
): Promise<{
  call: FinanceModuleExecutionToolCall;
  details?: ToolDetails;
}> {
  try {
    signal?.throwIfAborted();
    if (!tool.execute) {
      return {
        call: {
          toolName,
          status: "failed",
          inputEvidenceIds,
          error: "tool_has_no_execute_handler",
        },
      };
    }
    const result = await tool.execute(`finance-module:${toolName}`, args, signal);
    const details = toolResultDetails(result);
    const ok = details.ok !== false;
    return {
      call: {
        toolName,
        status: ok ? "succeeded" : "blocked",
        inputEvidenceIds,
        outputSummary: compact(details),
        ...(ok
          ? {}
          : { error: typeof details.reason === "string" ? details.reason : "tool_blocked" }),
      },
      details,
    };
  } catch (error) {
    if (signal?.aborted) {
      return {
        call: {
          toolName,
          status: "cancelled",
          inputEvidenceIds,
          error: "module_execution_cancelled",
        },
      };
    }
    return {
      call: {
        toolName,
        status: "failed",
        inputEvidenceIds,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function selectedToolName(moduleId: FinanceBrainModuleId): string {
  if (moduleId === "quant_math") {
    return "quant_math";
  }
  if (moduleId === "finance_learning_memory") {
    return "finance_learning_capability_apply";
  }
  if (FRAMEWORK_INSPECT_DOMAINS.has(moduleId)) {
    return "finance_framework_core_inspect";
  }
  return "finance_learning_capability_apply";
}

function requiredToolNames(moduleId: FinanceBrainModuleId): readonly string[] {
  const definition = FINANCE_BRAIN_MODULES.find((module) => module.id === moduleId);
  return definition?.requiredTools ?? [];
}

function statusFromToolCall(
  status: FinanceModuleExecutionToolCall["status"],
  blockedStatus: FinanceModuleExecutionNodeStatus = "blocked_missing_evidence",
): FinanceModuleExecutionNodeStatus {
  if (status === "succeeded") {
    return "succeeded";
  }
  if (status === "cancelled") {
    return "cancelled";
  }
  if (status === "failed") {
    return "failed";
  }
  return blockedStatus;
}

function moduleQuery(moduleId: FinanceBrainModuleId, ask: string): string {
  return `Finance module ${moduleId}. Apply retained guidance to this bounded research question: ${ask}. Use only supplied fresh evidence and state missing inputs; research-only.`;
}

function outputEvidence(
  node: FinanceModuleExecutionNode,
  details: ToolDetails,
  timestamp: string,
): FinanceCommitteeEvidence {
  const id = `finance-module:${node.nodeId}`;
  return {
    id,
    source: "finance-module-execution",
    timestamp,
    text: JSON.stringify({
      nodeId: node.nodeId,
      moduleId: node.moduleId,
      status: node.status,
      inputEvidenceIds: node.inputEvidenceIds,
      toolCalls: node.toolCalls,
      toolOutput: details,
      researchOnly: true,
    }),
  };
}

export function createUnrequestedFinanceModuleExecutionReceipt(
  plan: FinanceBrainOrchestrationPlan,
): FinanceModuleExecutionReceipt {
  return Object.freeze({
    schemaVersion: FINANCE_MODULE_EXECUTION_SCHEMA_VERSION,
    boundary: "finance_module_execution_research_only",
    requested: false,
    allNodesSucceeded: false,
    moduleToolsDispatched: false,
    compositionNodeIds: Object.freeze([...plan.composition.topologicalOrder]),
    outputEvidenceIds: Object.freeze([]),
    nodes: Object.freeze([]),
    notTouched: NOT_TOUCHED,
  });
}

export async function executeFinanceModuleComposition(
  params: Readonly<{
    ask: string;
    asOf: string;
    plan: FinanceBrainOrchestrationPlan;
    batch: FinanceResearchBatchEvidencePacket;
    workspaceDir: string;
    signal?: AbortSignal;
  }>,
): Promise<
  Readonly<{
    receipt: FinanceModuleExecutionReceipt;
    evidence: readonly FinanceCommitteeEvidence[];
  }>
> {
  const source = recordsForJobs(params.batch);
  const quantTool = createQuantMathTool();
  const learningTool = createFinanceLearningCapabilityApplyTool({
    workspaceDir: params.workspaceDir,
  });
  const inspectTool = createFinanceFrameworkCoreInspectTool({
    workspaceDir: params.workspaceDir,
  });
  const nodes: FinanceModuleExecutionNode[] = [];
  const evidence: FinanceCommitteeEvidence[] = [];
  const nodeStatusById = new Map<string, FinanceModuleExecutionNodeStatus>();
  const compositionNodesById = new Map(
    params.plan.composition.nodes.map((node) => [node.id, node]),
  );

  for (const compositionNodeId of params.plan.composition.topologicalOrder) {
    const compositionNode = compositionNodesById.get(compositionNodeId);
    if (!compositionNode) {
      continue;
    }
    const moduleId = compositionNode.moduleId;
    const moduleRequiredToolNames = requiredToolNames(moduleId);
    const inputEvidenceIds = source.inputEvidenceIds;
    const missingEvidence: string[] = [];
    const toolCalls: FinanceModuleExecutionToolCall[] = [];
    let details: ToolDetails = {};
    let status: FinanceModuleExecutionNodeStatus = "blocked_missing_evidence";

    const failedDependencies = compositionNode.dependsOn.filter(
      (dependency) => nodeStatusById.get(dependency) !== "succeeded",
    );
    if (failedDependencies.length > 0) {
      const node: FinanceModuleExecutionNode = {
        nodeId: compositionNode.id,
        moduleId: compositionNode.moduleId,
        requiredToolNames: moduleRequiredToolNames,
        dependsOn: compositionNode.dependsOn,
        status: "blocked_missing_evidence",
        inputEvidenceIds,
        outputEvidenceIds: Object.freeze([]),
        toolCalls: Object.freeze([]),
        missingEvidence: Object.freeze(
          failedDependencies.map(
            (dependency) =>
              `dependency_not_succeeded:${dependency}:${nodeStatusById.get(dependency) ?? "missing"}`,
          ),
        ),
      };
      nodes.push(node);
      nodeStatusById.set(compositionNode.id, node.status);
      continue;
    }

    try {
      params.signal?.throwIfAborted();
      const toolName = selectedToolName(moduleId);
      if (moduleId === "quant_math") {
        if (source.levels.length < 2) {
          missingEvidence.push("ready_eod_history_with_at_least_two_positive_levels");
        } else {
          const result = await callTool(
            quantTool,
            toolName,
            { action: "max_drawdown", series: [...source.levels], seriesMode: "levels" },
            inputEvidenceIds,
            params.signal,
          );
          toolCalls.push(result.call);
          details = result.details ?? {};
          status = statusFromToolCall(result.call.status, "failed");
        }
      } else if (moduleId === "finance_learning_memory") {
        const result = await callTool(
          learningTool,
          toolName,
          {
            queryText: moduleQuery(moduleId, params.ask),
            maxCandidates: 3,
            writeUsageReceipt: true,
          },
          inputEvidenceIds,
          params.signal,
        );
        toolCalls.push(result.call);
        details = result.details ?? {};
        status = statusFromToolCall(result.call.status);
        if (status !== "succeeded") {
          missingEvidence.push("retrievable_finance_capability_card");
        }
      } else if (FRAMEWORK_INSPECT_DOMAINS.has(moduleId)) {
        const result = await callTool(
          inspectTool,
          toolName,
          { domain: moduleId },
          inputEvidenceIds,
          params.signal,
        );
        toolCalls.push(result.call);
        details = result.details ?? {};
        status = statusFromToolCall(result.call.status);
        if (status !== "succeeded") {
          missingEvidence.push(`durable_framework_core_entry:${moduleId}`);
          missingEvidence.push("domain_producer_model_output_for_new_entry");
        }
      } else {
        const result = await callTool(
          learningTool,
          toolName,
          {
            queryText: moduleQuery(moduleId, params.ask),
            maxCandidates: 3,
            writeUsageReceipt: true,
          },
          inputEvidenceIds,
          params.signal,
        );
        toolCalls.push(result.call);
        details = result.details ?? {};
        status = result.call.status === "succeeded" ? "succeeded" : "blocked_missing_evidence";
        if (status !== "succeeded") {
          missingEvidence.push("retrievable_finance_capability_card");
        }
      }
    } catch (error) {
      if (params.signal?.aborted) {
        status = "cancelled";
        missingEvidence.push("module_execution_cancelled");
      } else {
        status = "failed";
      }
      const node: FinanceModuleExecutionNode = {
        nodeId: compositionNode.id,
        moduleId,
        requiredToolNames: moduleRequiredToolNames,
        dependsOn: compositionNode.dependsOn,
        status,
        inputEvidenceIds,
        outputEvidenceIds: Object.freeze([]),
        toolCalls: Object.freeze(toolCalls),
        missingEvidence: Object.freeze(missingEvidence),
        error: error instanceof Error ? error.message : String(error),
      };
      nodes.push(node);
      nodeStatusById.set(compositionNode.id, node.status);
      continue;
    }

    const provisional: FinanceModuleExecutionNode = {
      nodeId: compositionNode.id,
      moduleId,
      requiredToolNames: moduleRequiredToolNames,
      dependsOn: compositionNode.dependsOn,
      status,
      inputEvidenceIds,
      outputEvidenceIds: Object.freeze(
        status === "succeeded" ? [`finance-module:${compositionNode.id}`] : [],
      ),
      toolCalls: Object.freeze(toolCalls),
      missingEvidence: Object.freeze(missingEvidence),
    };
    if (status === "succeeded") {
      evidence.push(outputEvidence(provisional, details, params.asOf));
    }
    nodes.push(provisional);
    nodeStatusById.set(compositionNode.id, provisional.status);
  }

  const allNodesSucceeded =
    nodes.length > 0 &&
    nodes.length === params.plan.composition.topologicalOrder.length &&
    nodes.every((node) => node.status === "succeeded");
  const outputEvidenceIds = evidence.map((entry) => entry.id);
  return {
    receipt: Object.freeze({
      schemaVersion: FINANCE_MODULE_EXECUTION_SCHEMA_VERSION,
      boundary: "finance_module_execution_research_only",
      requested: true,
      allNodesSucceeded,
      moduleToolsDispatched: allNodesSucceeded && outputEvidenceIds.length === nodes.length,
      compositionNodeIds: Object.freeze([...params.plan.composition.topologicalOrder]),
      outputEvidenceIds: Object.freeze(outputEvidenceIds),
      nodes: Object.freeze(nodes),
      notTouched: NOT_TOUCHED,
    }),
    evidence: Object.freeze(evidence),
  };
}

export function financeModuleExecutionRegistryIds(): readonly FinanceBrainModuleId[] {
  return Object.freeze(FINANCE_BRAIN_MODULES.map((module) => module.id));
}
