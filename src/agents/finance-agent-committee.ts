import type { FinanceAsOfMode } from "./finance-data-gateway.js";
import type { FinanceDecisionMode } from "./finance-decision-policy.js";
import { modelRoutingTaskTimeoutMs } from "./logical-agent-model-router.js";
import {
  buildDefaultLogicalAgentPlan,
  LogicalAgentPool,
  runLogicalAgentPlan,
  type LogicalAgentExecutor,
  type LogicalAgentModelInvoker,
  type LogicalAgentModelRouting,
  type LogicalAgentPlanResult,
  type LogicalAgentRequest,
  type LogicalAgentSharedContext,
} from "./logical-agent-pool.js";

export const FINANCE_COMMITTEE_CONTEXT_SCHEMA = "lcx_finance_committee_context_v1" as const;

export type FinanceCommitteeEvidence = Readonly<{
  id: string;
  text: string;
  source: string;
  timestamp: string;
}>;

export type FinanceCommitteeInput = Readonly<{
  ask: string;
  asOf: string;
  asOfMode?: FinanceAsOfMode;
  decisionMode?: FinanceDecisionMode;
  evidence: readonly FinanceCommitteeEvidence[];
  userConstraints?: Readonly<Record<string, unknown>>;
}>;

export type FinanceCommitteeSharedContext = LogicalAgentSharedContext &
  Readonly<{
    schemaVersion: typeof FINANCE_COMMITTEE_CONTEXT_SCHEMA;
    ask: string;
    asOf: string;
    asOfMode?: FinanceAsOfMode;
    decisionMode: FinanceDecisionMode;
    evidence: readonly FinanceCommitteeEvidence[];
    userConstraints: Readonly<Record<string, unknown>>;
    instruction: string;
  }>;

export type FinanceCommitteeCoverage = Readonly<{
  commonContext: "present" | "missing";
  completedRoleCount: number;
  totalRoleCount: number;
  independentReviewCount: number;
  requiredLanes: readonly string[];
  /** Every known lane that did not complete, required or not. Reported in full. */
  missingLanes: readonly string[];
  /** The subset of `missingLanes` that actually withholds the candidate verdict. */
  missingRequiredLanes: readonly string[];
  equivalenceStatus: "not_ready" | "committee_candidate";
  equivalenceClaim: "not_claimed";
}>;

/** Every lane the committee knows about. Reported whether or not it is required. */
const COMMITTEE_LANES = [
  "evidence_integrity",
  "financial_extraction",
  "portfolio_exposure",
  "risk_check",
  "research_draft",
  "adversarial_challenge",
  "final_precheck",
] as const;

/**
 * Lanes that must complete before the committee will call itself a candidate.
 *
 * `adversarial_challenge` is deliberately not among them. It is still a lane the plan schedules,
 * it still runs when scheduled, and `missingLanes` still reports it when it does not — so
 * skipping the adversarial round stays visible rather than hidden. What changed is that skipping
 * it no longer withholds the candidate verdict. A challenge performed to satisfy a gate is not a
 * review; it is a formality, and a formality produces no finding.
 *
 * The verdict is correspondingly narrower: `committee_candidate` now means "every required lane
 * completed", not "every lane completed". `missingLanes` is what tells the two apart.
 */
const REQUIRED_LANES = [
  "evidence_integrity",
  "financial_extraction",
  "portfolio_exposure",
  "risk_check",
  "research_draft",
  "final_precheck",
] as const;

function requiredText(value: string, label: string): string {
  const text = value.trim();
  if (!text) {
    throw new Error(`${label} required`);
  }
  return text;
}

function assertIsoTimestamp(value: string, label: string): string {
  const text = requiredText(value, label);
  if (!Number.isFinite(Date.parse(text))) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return text;
}

function cloneRecord(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  try {
    return Object.freeze(structuredClone(value));
  } catch {
    throw new Error("finance committee userConstraints must be structured-cloneable");
  }
}

export function buildFinanceCommitteeContext(
  input: FinanceCommitteeInput,
): FinanceCommitteeSharedContext {
  const ask = requiredText(input.ask, "ask");
  const asOf = assertIsoTimestamp(input.asOf, "asOf");
  if (input.evidence.length === 0) {
    throw new Error("finance committee requires at least one evidence item");
  }
  const ids = new Set<string>();
  const evidence = input.evidence.map((item, index) => {
    const id = requiredText(item.id, `evidence[${index}].id`);
    if (ids.has(id)) {
      throw new Error(`duplicate finance committee evidence id: ${id}`);
    }
    ids.add(id);
    return Object.freeze({
      id,
      text: requiredText(item.text, `evidence[${index}].text`),
      source: requiredText(item.source, `evidence[${index}].source`),
      timestamp: assertIsoTimestamp(item.timestamp, `evidence[${index}].timestamp`),
    });
  });
  return Object.freeze({
    schemaVersion: FINANCE_COMMITTEE_CONTEXT_SCHEMA,
    ask,
    asOf,
    ...(input.asOfMode === undefined ? {} : { asOfMode: input.asOfMode }),
    decisionMode: input.decisionMode ?? "research_only",
    evidence: Object.freeze(evidence),
    userConstraints: cloneRecord(input.userConstraints ?? {}),
    instruction:
      "Every role must use this same fact packet. Role disagreement is evidence to review, not permission to invent a second fact set.",
  });
}

export function buildFinanceCommitteePlan(
  input: FinanceCommitteeInput,
): ReturnType<typeof buildDefaultLogicalAgentPlan> {
  const context = buildFinanceCommitteeContext(input);
  const request: LogicalAgentRequest = {
    ask: context.ask,
    evidence: context.evidence.map(
      (item) => `[${item.id}] ${item.text} (source=${item.source}; timestamp=${item.timestamp})`,
    ),
    metadata: {
      financeDecisionMode: context.decisionMode,
      financeCommitteeContext: context.schemaVersion,
    },
  };
  return buildDefaultLogicalAgentPlan(request);
}

export function evaluateFinanceCommitteeCoverage<TResult>(
  result: LogicalAgentPlanResult<TResult>,
): FinanceCommitteeCoverage {
  const completed = new Set(
    result.tasks.filter((task) => task.status === "completed").map((task) => task.agentId),
  );
  const missingLanes = COMMITTEE_LANES.filter((lane) => !completed.has(lane));
  const missingRequiredLanes = REQUIRED_LANES.filter((lane) => !completed.has(lane));
  const independentReviewCount = (
    ["evidence_integrity", "adversarial_challenge", "final_precheck"] as const
  ).filter((lane) => completed.has(lane)).length;
  return Object.freeze({
    commonContext: "present",
    completedRoleCount: completed.size,
    totalRoleCount: new Set(result.tasks.map((task) => task.agentId)).size,
    independentReviewCount,
    requiredLanes: REQUIRED_LANES,
    missingLanes: Object.freeze(missingLanes),
    missingRequiredLanes: Object.freeze(missingRequiredLanes),
    // Only a missing *required* lane withholds the verdict. A missing advisory lane is reported
    // through `missingLanes` and left to the reader to weigh.
    equivalenceStatus: missingRequiredLanes.length === 0 ? "committee_candidate" : "not_ready",
    equivalenceClaim: "not_claimed",
  });
}

export async function runFinanceCommittee<TResult>(params: {
  allowProviderCalls?: boolean;
  signal?: AbortSignal;
  input: FinanceCommitteeInput;
  executor: LogicalAgentExecutor<LogicalAgentRequest, TResult>;
  pool?: LogicalAgentPool<LogicalAgentRequest, TResult>;
  /** Optional role router for the canonical finance committee owner path. */
  modelRouting?: LogicalAgentModelRouting;
  /** Compatibility injection for deterministic/local adapters without a router. */
  modelInvoker?: LogicalAgentModelInvoker;
  runId?: string;
}): Promise<{
  execution: LogicalAgentPlanResult<TResult>;
  context: FinanceCommitteeSharedContext;
  coverage: FinanceCommitteeCoverage;
}> {
  const context = buildFinanceCommitteeContext(params.input);
  const request: LogicalAgentRequest = {
    ask: context.ask,
    evidence: context.evidence.map(
      (item) => `[${item.id}] ${item.text} (source=${item.source}; timestamp=${item.timestamp})`,
    ),
    metadata: {
      financeDecisionMode: context.decisionMode,
      financeCommitteeContext: context.schemaVersion,
    },
  };
  const pool =
    params.pool ??
    new LogicalAgentPool<LogicalAgentRequest, TResult>({
      modelId: params.modelRouting?.adapters[0]?.modelId,
      taskTimeoutMs: params.modelRouting
        ? modelRoutingTaskTimeoutMs(params.modelRouting)
        : undefined,
      allowProviderCalls: params.allowProviderCalls,
      ...(params.modelRouting === undefined ? {} : { modelRouting: params.modelRouting }),
      ...(params.modelInvoker === undefined ? {} : { modelInvoker: params.modelInvoker }),
    });
  const execution = await runLogicalAgentPlan({
    signal: params.signal,
    tasks: buildDefaultLogicalAgentPlan(request),
    executor: params.executor,
    pool,
    ...(params.runId === undefined ? {} : { runId: params.runId }),
    finalTaskId: "final_precheck",
    sharedContext: context,
  });
  return Object.freeze({
    execution,
    context,
    coverage: evaluateFinanceCommitteeCoverage(execution),
  });
}
