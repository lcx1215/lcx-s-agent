import { existsSync } from "node:fs";
import type { FinanceCommitteeEvidence } from "./finance-agent-committee.js";
import {
  FINANCE_BRAIN_MODULES,
  type FinanceBrainModuleId,
  type FinanceBrainOrchestrationPlan,
} from "./finance-brain-orchestration.js";
import { buildFinanceActiveStrategyResearchEvidence } from "./finance-night-review-context.js";
import type {
  FinanceResearchBatchEvidencePacket,
  FinanceResearchBatchJob,
} from "./finance-research-batch-runner.js";
import { summarizeFinancePriceHistory } from "./finance-research-evidence.js";
import { financeBarLedgerPath } from "./finance-state-dir.js";
import type { AnyAgentTool } from "./tools/common.js";
import { createFinanceFrameworkCoreInspectTool } from "./tools/finance-framework-core-inspect-tool.js";
import { createFinanceFrameworkDomainProducerTools } from "./tools/finance-framework-domain-producer-tools.js";
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

export type FinanceModuleReplanFeedback = Readonly<{
  status:
    | "not_requested"
    | "completed"
    | "replan_soft"
    | "blocked_hard"
    | "soft_replan_budget_exhausted";
  hardNodeIds: readonly string[];
  softNodeIds: readonly string[];
  hardFailures: readonly string[];
  softFailures: readonly string[];
  remainingSoftReplans: number;
  nextAction: "none" | "revise_soft_modules" | "stop";
}>;

export type FinanceModuleExecutionReceipt = Readonly<{
  schemaVersion: typeof FINANCE_MODULE_EXECUTION_SCHEMA_VERSION;
  boundary: "finance_module_execution_research_only";
  requested: boolean;
  allNodesSucceeded: boolean;
  /** Mandatory lanes only; optional failures remain visible in nodes and feedback. */
  requiredNodesSucceeded?: boolean;
  /** Set by the research runner from mandatory-node success and evidence inclusion. */
  requiredEvidenceReady?: boolean;
  moduleToolsDispatched: boolean;
  compositionNodeIds: readonly string[];
  outputEvidenceIds: readonly string[];
  nodes: readonly FinanceModuleExecutionNode[];
  replanFeedback: FinanceModuleReplanFeedback;
  notTouched: readonly string[];
}>;

const NOT_TOUCHED = Object.freeze([
  "provider_config",
  "external_channel_sender",
  "trading_execution",
  "wallet_or_order_authority",
] as const);

export function deriveFinanceModuleReplanFeedback(
  composition: FinanceBrainOrchestrationPlan["composition"],
  nodes: readonly FinanceModuleExecutionNode[],
  requested: boolean,
): FinanceModuleReplanFeedback {
  const hardNodeIds = composition.control.hardNodeIds;
  const softNodeIds = composition.control.softNodeIds;
  if (!requested) {
    return Object.freeze({
      status: "not_requested",
      hardNodeIds,
      softNodeIds,
      hardFailures: Object.freeze([]),
      softFailures: Object.freeze([]),
      remainingSoftReplans: composition.control.maxSoftReplans,
      nextAction: "none",
    });
  }
  const statusById = new Map(nodes.map((node) => [node.nodeId, node.status]));
  const failed = (nodeId: string) => statusById.get(nodeId) !== "succeeded";
  const hardFailures = hardNodeIds.filter(failed);
  const softFailures = softNodeIds.filter(failed);
  if (hardFailures.length > 0) {
    return Object.freeze({
      status: "blocked_hard",
      hardNodeIds,
      softNodeIds,
      hardFailures: Object.freeze(hardFailures),
      softFailures: Object.freeze(softFailures),
      remainingSoftReplans: 0,
      nextAction: "stop",
    });
  }
  if (softFailures.length > 0) {
    const remainingSoftReplans = composition.control.maxSoftReplans;
    return Object.freeze({
      status: remainingSoftReplans > 0 ? "replan_soft" : "soft_replan_budget_exhausted",
      hardNodeIds,
      softNodeIds,
      hardFailures: Object.freeze([]),
      softFailures: Object.freeze(softFailures),
      remainingSoftReplans,
      nextAction: remainingSoftReplans > 0 ? "revise_soft_modules" : "stop",
    });
  }
  return Object.freeze({
    status: "completed",
    hardNodeIds,
    softNodeIds,
    hardFailures: Object.freeze([]),
    softFailures: Object.freeze([]),
    remainingSoftReplans: composition.control.maxSoftReplans,
    nextAction: "none",
  });
}

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

type QuantHistory = Readonly<{
  levels: readonly number[];
  instrument: string;
  fromDate: string;
  toDate: string;
  evidenceId: string;
  identity?: readonly string[];
  basis: "stored_close_history_not_adjusted_total_return";
}>;

function validDate(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/u.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  );
}

function recordsForJobs(
  batch: FinanceResearchBatchEvidencePacket,
  asOf: string,
  ask: string,
): Readonly<{
  jobs: readonly FinanceResearchBatchJob[];
  inputEvidenceIds: readonly string[];
  quantHistories: readonly QuantHistory[];
  quantHistoryIssues: readonly string[];
  hasEodHistory: boolean;
  summary: string;
}> {
  const jobs = batch.jobs.filter((job) => job.status === "ready" && job.receipt !== undefined);
  const visibleEvidenceIds = new Set(batch.committeeEvidence.map((item) => item.id));
  // Raw job IDs remain in the batch receipt. Modules cite the instrument summary
  // actually supplied to the committee, which binds those source receipts.
  const inputEvidenceIds = [
    ...new Set(
      jobs
        .map((job) => `finance-model:${encodeURIComponent(job.request.instrument)}`)
        .filter((id) => visibleEvidenceIds.has(id)),
    ),
  ];
  const collections = new Map<string, number>();
  const eodJobs: FinanceResearchBatchJob[] = [];
  for (const job of jobs) {
    if (!job.receipt || !("records" in job.receipt) || !("collection" in job.request)) {
      continue;
    }
    collections.set(
      job.request.collection,
      (collections.get(job.request.collection) ?? 0) + job.receipt.records.length,
    );
    if (job.request.collection === "eod_history") {
      eodJobs.push(job);
    }
  }
  const mentionedInstruments = new Set(
    [...new Set(eodJobs.map((job) => job.request.instrument))].filter((instrument) =>
      new RegExp(
        `(^|[^A-Z0-9])${instrument.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?=$|[^A-Z0-9])`,
        "iu",
      ).test(ask),
    ),
  );
  const requestedJobs =
    mentionedInstruments.size > 0
      ? eodJobs.filter((job) => mentionedInstruments.has(job.request.instrument))
      : eodJobs;
  const jobsByInstrument = new Map<string, FinanceResearchBatchJob[]>();
  for (const job of requestedJobs) {
    const group = jobsByInstrument.get(job.request.instrument) ?? [];
    group.push(job);
    jobsByInstrument.set(job.request.instrument, group);
  }
  const quantHistories: QuantHistory[] = [];
  const quantHistoryIssues: string[] = [];
  for (const [instrument, instrumentJobs] of jobsByInstrument) {
    const records = instrumentJobs.flatMap((job) =>
      job.receipt && "records" in job.receipt ? job.receipt.records : [],
    );
    const history = summarizeFinancePriceHistory(records, asOf, { asOfMode: batch.asOfMode });
    const evidenceId = `finance-model:${encodeURIComponent(instrument)}`;
    if (history.summaries.length === 0) {
      quantHistoryIssues.push(`ready_eod_history_with_at_least_two_positive_levels:${instrument}`);
    }
    const summarizedInvalidIdentities = new Set<string>();
    for (const summary of history.summaries) {
      const identity = JSON.stringify(summary.identity);
      if (summary.invalid > 0) {
        summarizedInvalidIdentities.add(identity);
        quantHistoryIssues.push(`valid_dated_positive_eod_closes:${instrument}:${identity}`);
      }
      if (summary.conflicts > 0) {
        quantHistoryIssues.push(`conflict_free_eod_close_history:${instrument}:${identity}`);
      }
      if (summary.orderedCloses.length < 2) {
        quantHistoryIssues.push(`at_least_two_valid_eod_closes:${instrument}:${identity}`);
      }
      if (!visibleEvidenceIds.has(evidenceId)) {
        quantHistoryIssues.push(`citeable_source_history_evidence_packet:${instrument}`);
      }
      if (
        summary.invalid === 0 &&
        summary.conflicts === 0 &&
        summary.orderedCloses.length >= 2 &&
        visibleEvidenceIds.has(evidenceId)
      ) {
        quantHistories.push(
          Object.freeze({
            levels: Object.freeze(summary.orderedCloses.map((row) => row.close)),
            instrument,
            fromDate: summary.from,
            toDate: summary.to,
            evidenceId,
            identity: Object.freeze([...summary.identity]),
            basis: "stored_close_history_not_adjusted_total_return",
          }),
        );
      }
    }
    for (const invalidSeries of history.invalidSeries) {
      const identity = JSON.stringify(invalidSeries.identity);
      if (!summarizedInvalidIdentities.has(identity)) {
        quantHistoryIssues.push(`valid_dated_positive_eod_closes:${instrument}:${identity}`);
      }
    }
  }
  return {
    jobs,
    inputEvidenceIds: Object.freeze(inputEvidenceIds),
    quantHistories: Object.freeze(quantHistories),
    quantHistoryIssues: Object.freeze(quantHistoryIssues),
    hasEodHistory: eodJobs.length > 0,
    summary: [...collections.entries()]
      .map(([collection, count]) => `${collection}=${count}`)
      .join(", "),
  };
}

/** Accept bounded controller closes; hydrate the model-facing monthly projection from its ledger. */
async function controllerCloseHistories(
  evidence: readonly FinanceCommitteeEvidence[],
  asOf: string,
  ask: string,
  financeStateDir?: string,
): Promise<
  Readonly<{
    histories: readonly QuantHistory[];
    issues: readonly string[];
    hasControllerHistory: boolean;
  }>
> {
  const visible = evidence.filter(
    (item) =>
      item.source === "finance-bar-ledger" &&
      item.id.startsWith("finance-controller:eod:") &&
      Number.isFinite(Date.parse(item.timestamp)) &&
      Date.parse(item.timestamp) <= Date.parse(asOf),
  );
  const historiesByInstrument = new Map<string, QuantHistory[]>();
  const issues: string[] = [];
  const instrumentLabel = (record: Record<string, unknown>) =>
    typeof record.instrument === "string" ? record.instrument : "unknown";
  const monthlyItems: Array<{ item: FinanceCommitteeEvidence; record: Record<string, unknown> }> =
    [];
  const resolvedItems: FinanceCommitteeEvidence[] = [];
  for (const item of visible) {
    try {
      const value: unknown = JSON.parse(item.text);
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("invalid controller close projection");
      }
      const record = value as Record<string, unknown>;
      if (Array.isArray(record.monthlyCloseObservations)) {
        monthlyItems.push({ item, record });
      } else {
        resolvedItems.push(item);
      }
    } catch {
      resolvedItems.push(item);
    }
  }
  if (monthlyItems.length > 0) {
    if (!financeStateDir || !existsSync(financeBarLedgerPath(financeStateDir))) {
      for (const { record } of monthlyItems) {
        issues.push(`controller_bar_ledger_unavailable:${instrumentLabel(record)}`);
      }
      return {
        histories: Object.freeze([]),
        issues: Object.freeze(issues),
        hasControllerHistory: true,
      };
    }
    const instruments = monthlyItems.map(({ record }) => record.instrument);
    if (
      instruments.some((instrument) => typeof instrument !== "string") ||
      new Set(instruments).size !== instruments.length
    ) {
      for (const { record } of monthlyItems) {
        issues.push(`valid_controller_close_history:${instrumentLabel(record)}`);
      }
      return {
        histories: Object.freeze([]),
        issues: Object.freeze(issues),
        hasControllerHistory: true,
      };
    }
    const projectionAsOf = monthlyItems.map(({ item }) => item.timestamp);
    if (new Set(projectionAsOf).size !== 1) {
      for (const { record } of monthlyItems) {
        issues.push(`controller_history_snapshot_mismatch:${instrumentLabel(record)}`);
      }
      return {
        histories: Object.freeze([]),
        issues: Object.freeze(issues),
        hasControllerHistory: true,
      };
    }
    try {
      const scopeEvidence = evidence.find(
        (item) =>
          item.source === "finance-strategy-rule-ledger" &&
          (item.id === "finance-controller:active-strategies" ||
            item.id.startsWith("finance-night:rules:")) &&
          Date.parse(item.timestamp) === Date.parse(projectionAsOf[0]),
      );
      let strategyIds: string[] | undefined;
      if (scopeEvidence) {
        const activeRules = asRecord(JSON.parse(scopeEvidence.text)).activeRules;
        if (!Array.isArray(activeRules)) {
          throw new Error("invalid controller history strategy scope");
        }
        strategyIds = activeRules.map((rule: unknown) => {
          const ruleId = asRecord(rule).ruleId;
          if (typeof ruleId !== "string") {
            throw new Error("invalid controller history strategy id");
          }
          return ruleId;
        });
      }
      const dailyEvidence = await buildFinanceActiveStrategyResearchEvidence({
        directory: financeStateDir,
        asOf: projectionAsOf[0],
        ...(strategyIds === undefined ? {} : { strategyIds }),
        instrumentIds: instruments as string[],
        historyFormat: "daily_calculation",
      });
      const dailyById = new Map(
        dailyEvidence
          .filter(
            (item) =>
              item.id.startsWith("finance-controller:eod:") && item.source === "finance-bar-ledger",
          )
          .map((item) => [item.id, item]),
      );
      for (const { item, record } of monthlyItems) {
        const instrument = record.instrument;
        const daily = dailyById.get(item.id);
        let projection: Record<string, unknown> | undefined;
        try {
          projection = daily ? (JSON.parse(daily.text) as Record<string, unknown>) : undefined;
        } catch {
          projection = undefined;
        }
        const sameSnapshot =
          projection &&
          projection.instrument === instrument &&
          projection.headRef === record.headRef &&
          projection.fromDate === record.fromDate &&
          projection.toDate === record.toDate &&
          projection.windowBarCount === record.windowBarCount &&
          projection.rawBarCount === record.rawBarCount &&
          projection.collapsedRepeatedCloses === record.collapsedRepeatedCloses &&
          projection.suppliedBarCount === record.suppliedBarCount &&
          projection.omittedByLimit === record.omittedByLimit &&
          JSON.stringify(projection.divergentDates) === JSON.stringify(record.divergentDates) &&
          JSON.stringify(projection.monthlyCloseObservations) ===
            JSON.stringify(record.monthlyCloseObservations) &&
          Array.isArray(record.divergentDates) &&
          record.divergentDates.length === 0 &&
          Array.isArray(projection.closes) &&
          projection.closes.length === record.suppliedBarCount;
        if (!sameSnapshot) {
          issues.push(`controller_history_snapshot_mismatch:${String(instrument)}`);
          continue;
        }
        resolvedItems.push({ ...item, text: JSON.stringify(projection) });
      }
    } catch {
      for (const { record } of monthlyItems) {
        issues.push(`controller_history_snapshot_mismatch:${instrumentLabel(record)}`);
      }
    }
  }
  for (const item of resolvedItems) {
    let instrument = item.id.slice("finance-controller:eod:".length);
    try {
      const value: unknown = JSON.parse(item.text);
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("invalid controller close projection");
      }
      const record = value as Record<string, unknown>;
      if (typeof record.instrument === "string") {
        instrument = record.instrument;
      }
      if (
        typeof record.instrument !== "string" ||
        item.id !== `finance-controller:eod:${record.instrument}` ||
        !Array.isArray(record.divergentDates) ||
        record.divergentDates.length > 0 ||
        !Array.isArray(record.closes) ||
        record.closes.length < 2 ||
        record.closes.length > 400 ||
        record.suppliedBarCount !== record.closes.length ||
        typeof record.fromDate !== "string" ||
        typeof record.toDate !== "string"
      ) {
        throw new Error("invalid controller close projection");
      }
      let previous = "";
      let firstDate = "";
      const levels: number[] = [];
      for (const row of record.closes) {
        if (
          !Array.isArray(row) ||
          row.length !== 2 ||
          typeof row[0] !== "string" ||
          !validDate(row[0]) ||
          row[0] <= previous ||
          row[0] < record.fromDate ||
          row[0] > record.toDate ||
          Date.parse(row[0]) >= Date.parse(asOf) ||
          typeof row[1] !== "number" ||
          !Number.isFinite(row[1]) ||
          row[1] <= 0
        ) {
          throw new Error("invalid controller close projection");
        }
        firstDate ||= row[0];
        previous = row[0];
        levels.push(row[1]);
      }
      const group = historiesByInstrument.get(instrument) ?? [];
      group.push({
        levels,
        evidenceId: item.id,
        instrument,
        fromDate: firstDate,
        toDate: previous,
        basis: "stored_close_history_not_adjusted_total_return",
      });
      historiesByInstrument.set(instrument, group);
    } catch {
      issues.push(`valid_controller_close_history:${instrument}`);
    }
  }
  const mentionedInstruments = new Set(
    [...historiesByInstrument.keys()].filter((instrument) =>
      new RegExp(
        `(^|[^A-Z0-9])${instrument.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?=$|[^A-Z0-9])`,
        "iu",
      ).test(ask),
    ),
  );
  const requestedInstruments =
    mentionedInstruments.size > 0 ? mentionedInstruments : new Set(historiesByInstrument.keys());
  const histories: QuantHistory[] = [];
  for (const instrument of requestedInstruments) {
    const group = historiesByInstrument.get(instrument) ?? [];
    if (group.length !== 1) {
      issues.push(`unambiguous_controller_history:${instrument}`);
      continue;
    }
    histories.push(group[0]);
  }
  return {
    histories: Object.freeze(histories),
    issues: Object.freeze(issues),
    hasControllerHistory: visible.length > 0,
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

// Put the substantive result before repeated call metadata: downstream prompts
// deliberately clip each evidence item. This is model analysis, not new source proof.
function frameworkAnalysis(details: ToolDetails): ToolDetails | undefined {
  const entry = asRecord(asRecord(details.inspect).entry);
  if (typeof entry.evidenceSummary !== "string") {
    return undefined;
  }
  const excerpt = (value: unknown, limit: number) =>
    typeof value === "string"
      ? value.length <= limit
        ? value
        : `${value.slice(0, limit)}…`
      : null;
  return {
    basis: "module_analysis_not_independent_source_verification",
    confidence: entry.confidenceOrConviction,
    evidenceSummary: excerpt(entry.evidenceSummary, 180),
    riskGateNotes: excerpt(entry.riskGateNotes, 160),
    invalidation: excerpt(entry.whatChangesMyMind, 140),
    keyCausalChain: excerpt(entry.keyCausalChain, 180),
    sourceArtifacts: entry.sourceArtifacts,
    allowedActionAuthority: "research_only",
  };
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
      researchOnly: true,
      analysis: frameworkAnalysis(details),
      toolOutput: details,
      nodeId: node.nodeId,
      moduleId: node.moduleId,
      status: node.status,
      inputEvidenceIds: node.inputEvidenceIds,
      toolCalls: node.toolCalls,
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
    replanFeedback: deriveFinanceModuleReplanFeedback(plan.composition, [], false),
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
    /** Explicit controller-owned finance state root used only for bounded fallback hydration. */
    financeStateDir?: string;
    controllerEvidence?: readonly FinanceCommitteeEvidence[];
    /** Structured, source-backed model output for an explicitly selected domain producer. */
    domainProducerInputs?: Readonly<
      Partial<Record<FinanceBrainModuleId, Readonly<Record<string, unknown>>>>
    >;
    signal?: AbortSignal;
  }>,
): Promise<
  Readonly<{
    receipt: FinanceModuleExecutionReceipt;
    evidence: readonly FinanceCommitteeEvidence[];
  }>
> {
  const batchSource = recordsForJobs(params.batch, params.asOf, params.ask);
  const controllerSource =
    params.plan.composition.nodes.some((node) => node.moduleId === "quant_math") &&
    !batchSource.hasEodHistory
      ? await controllerCloseHistories(
          params.controllerEvidence ?? [],
          params.asOf,
          params.ask,
          params.financeStateDir,
        )
      : undefined;
  const source = controllerSource
    ? {
        ...batchSource,
        quantHistories: controllerSource.histories,
        quantHistoryIssues: controllerSource.issues,
        hasEodHistory: controllerSource.hasControllerHistory,
      }
    : batchSource;
  const quantTool = createQuantMathTool();
  const learningTool = createFinanceLearningCapabilityApplyTool({
    workspaceDir: params.workspaceDir,
  });
  const inspectTool = createFinanceFrameworkCoreInspectTool({
    workspaceDir: params.workspaceDir,
  });
  const domainProducerTools = new Map(
    createFinanceFrameworkDomainProducerTools({ workspaceDir: params.workspaceDir }).map((tool) => [
      tool.name,
      tool,
    ]),
  );
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
    const producerSources = params.domainProducerInputs?.[moduleId]?.sourceArtifacts;
    const inputEvidenceIds = Object.freeze([
      ...new Set([
        ...(moduleId === "quant_math"
          ? source.quantHistories.map((history) => history.evidenceId)
          : source.inputEvidenceIds),
        ...(moduleId !== "quant_math" && Array.isArray(producerSources)
          ? producerSources.filter((id): id is string => typeof id === "string")
          : []),
      ]),
    ]);
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
        if (source.quantHistoryIssues.length > 0) {
          missingEvidence.push(...source.quantHistoryIssues);
        } else if (source.quantHistories.length === 0) {
          missingEvidence.push("ready_eod_history_with_at_least_two_positive_levels");
        } else {
          const results: Array<{ details: ToolDetails; historySource: QuantHistory }> = [];
          for (const quantHistory of source.quantHistories) {
            const result = await callTool(
              quantTool,
              toolName,
              { action: "max_drawdown", series: [...quantHistory.levels], seriesMode: "levels" },
              [quantHistory.evidenceId],
              params.signal,
            );
            toolCalls.push(result.call);
            results.push({ details: result.details ?? {}, historySource: quantHistory });
          }
          const failedCall = toolCalls.find((call) => call.status !== "succeeded");
          status = failedCall ? statusFromToolCall(failedCall.status, "failed") : "succeeded";
          details =
            results.length === 1
              ? {
                  ...results[0].details,
                  historySource: {
                    instrument: results[0].historySource.instrument,
                    evidenceId: results[0].historySource.evidenceId,
                    fromDate: results[0].historySource.fromDate,
                    toDate: results[0].historySource.toDate,
                    identity: results[0].historySource.identity,
                    basis: results[0].historySource.basis,
                  },
                }
              : {
                  instrumentResults: results.map(({ details: resultDetails, historySource }) => ({
                    ...resultDetails,
                    historySource: {
                      instrument: historySource.instrument,
                      evidenceId: historySource.evidenceId,
                      fromDate: historySource.fromDate,
                      toDate: historySource.toDate,
                      identity: historySource.identity,
                      basis: historySource.basis,
                    },
                  })),
                };
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
        const producerName = moduleRequiredToolNames.find((name) => name.endsWith("_producer"));
        const producerTool = producerName ? domainProducerTools.get(producerName) : undefined;
        const producerInput = params.domainProducerInputs?.[moduleId];
        if (producerName && producerTool && producerInput) {
          const produced = await callTool(
            producerTool,
            producerName,
            { ...producerInput },
            inputEvidenceIds,
            params.signal,
          );
          toolCalls.push(produced.call);
          if (produced.call.status !== "succeeded") {
            status = statusFromToolCall(produced.call.status);
            details = { producer: produced.details ?? {} };
          }
        } else if (producerName) {
          missingEvidence.push(`domain_producer_input:${producerName}`);
        }
        const producerSucceeded =
          !producerName ||
          toolCalls.some((call) => call.toolName === producerName && call.status === "succeeded");
        if (producerSucceeded && toolCalls.every((call) => call.status === "succeeded")) {
          const inspected = await callTool(
            inspectTool,
            toolName,
            { domain: moduleId },
            inputEvidenceIds,
            params.signal,
          );
          toolCalls.push(inspected.call);
          details = {
            ...(details.producer ? details : {}),
            inspect: inspected.details ?? {},
          };
          status = statusFromToolCall(inspected.call.status);
        }
        if (producerName && !producerInput) {
          status = "blocked_missing_evidence";
        }
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
  const feedback = deriveFinanceModuleReplanFeedback(params.plan.composition, nodes, true);
  return {
    receipt: Object.freeze({
      schemaVersion: FINANCE_MODULE_EXECUTION_SCHEMA_VERSION,
      boundary: "finance_module_execution_research_only",
      requested: true,
      allNodesSucceeded,
      requiredNodesSucceeded:
        !params.signal?.aborted &&
        feedback.hardNodeIds.length > 0 &&
        feedback.hardFailures.length === 0,
      moduleToolsDispatched: allNodesSucceeded && outputEvidenceIds.length === nodes.length,
      compositionNodeIds: Object.freeze([...params.plan.composition.topologicalOrder]),
      outputEvidenceIds: Object.freeze(outputEvidenceIds),
      nodes: Object.freeze(nodes),
      replanFeedback: feedback,
      notTouched: NOT_TOUCHED,
    }),
    evidence: Object.freeze(evidence),
  };
}

export function financeModuleExecutionRegistryIds(): readonly FinanceBrainModuleId[] {
  return Object.freeze(FINANCE_BRAIN_MODULES.map((module) => module.id));
}
