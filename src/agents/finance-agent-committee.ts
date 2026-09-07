import type { FinanceDecisionMode } from "./finance-decision-policy.js";
import {
  buildDefaultLogicalAgentPlan,
  runLogicalAgentPlan,
  type LogicalAgentExecutor,
  type LogicalAgentPlanResult,
  type LogicalAgentPool,
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
  decisionMode?: FinanceDecisionMode;
  evidence: readonly FinanceCommitteeEvidence[];
  userConstraints?: Readonly<Record<string, unknown>>;
}>;

export type FinanceCommitteeSharedContext = LogicalAgentSharedContext &
  Readonly<{
    schemaVersion: typeof FINANCE_COMMITTEE_CONTEXT_SCHEMA;
    ask: string;
    asOf: string;
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
  missingLanes: readonly string[];
  equivalenceStatus: "not_ready" | "committee_candidate";
  equivalenceClaim: "not_claimed";
}>;

const REQUIRED_LANES = [
  "evidence_integrity",
  "financial_extraction",
  "portfolio_exposure",
  "risk_check",
  "research_draft",
  "adversarial_challenge",
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
  const missingLanes = REQUIRED_LANES.filter((lane) => !completed.has(lane));
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
    equivalenceStatus: missingLanes.length === 0 ? "committee_candidate" : "not_ready",
    equivalenceClaim: "not_claimed",
  });
}

export async function runFinanceCommittee<TResult>(params: {
  input: FinanceCommitteeInput;
  executor: LogicalAgentExecutor<LogicalAgentRequest, TResult>;
  pool?: LogicalAgentPool<LogicalAgentRequest, TResult>;
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
  const execution = await runLogicalAgentPlan({
    tasks: buildDefaultLogicalAgentPlan(request),
    executor: params.executor,
    ...(params.pool === undefined ? {} : { pool: params.pool }),
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
