import { createHash, randomUUID } from "node:crypto";
import type { OpenClawConfig } from "../config/config.js";
import { createConfiguredFinanceModelAdapter } from "./configured-finance-model-adapter.js";
import { ModelAdapterError, type ModelCallRequest } from "./logical-agent-model-router.js";

export const FINANCE_TRADE_DECISION_REVIEW_SCHEMA = "lcx_finance_trade_decision_review_v1" as const;

export type FinanceTradeDecisionCandidate = Readonly<{
  candidateId: string;
  instrument: string;
  side: "buy" | "sell";
  targetWeight: number;
  currentWeight: number;
  weightDelta: number;
  notional: number;
  strategySignal: "hold" | "cash";
  annualisedVol: number;
  researchClose: number;
  lastBarDate: string;
  executionQuote: Readonly<{
    referencePrice: number;
    referencePriceAt: string;
    bidPrice?: number;
    askPrice?: number;
    feed?: string;
    priceBasis?: "bid" | "ask" | "reference";
    ageMs: number;
    maxAgeMs: number;
  }>;
}>;

export type FinanceTradeDecisionReviewRequest = Readonly<{
  schemaVersion: typeof FINANCE_TRADE_DECISION_REVIEW_SCHEMA;
  venue: "alpaca:paper";
  asOf: string;
  signalAnchor: string;
  ruleIds: readonly string[];
  equity: number;
  rebalanceBand: number;
  caps: Readonly<{
    maxOrderNotional: number;
    maxInstrumentNotional: number;
    maxOrdersPerRun: number;
  }>;
  positionBookObservedAt?: string;
  reconciliation: Readonly<{
    status: string;
    historyStatus?: string;
    uncertaintyReserve?: number;
    quarantinedInstruments?: readonly string[];
  }>;
  positions: readonly Readonly<{
    instrument: string;
    quantity: number;
    marketValue: number;
  }>[];
  candidates: readonly FinanceTradeDecisionCandidate[];
}>;

export type FinanceTradeDecision = Readonly<{
  candidateId: string;
  decision: "approve" | "veto";
  rationale: string;
}>;

export type FinanceTradeDecisionReviewFailureCode =
  | "output_contract"
  | "reviewer_unavailable"
  | "output_invalid"
  | "output_truncated"
  | "provider_auth"
  | "provider_rate_limit"
  | "process_error"
  | "output_limit"
  | "runtime_timeout"
  | "call_budget_exhausted";

export type FinanceTradeDecisionReviewResult = Readonly<{
  status: "completed" | "failed";
  attempted: boolean;
  provider: string;
  modelId: string;
  latencyMs: number;
  providerCallObserved: boolean;
  adapterAttested: boolean;
  requestIdSha256?: string;
  decisions?: readonly FinanceTradeDecision[];
  failureCode?: FinanceTradeDecisionReviewFailureCode;
}>;

export type FinanceTradeDecisionReviewReceipt = Readonly<{
  status: "not_needed" | "completed" | "failed";
  candidateCount: number;
  modelCalls: number;
  candidateInputs?: readonly FinanceTradeDecisionCandidate[];
  reasonCode?: string;
  provider?: string;
  modelId?: string;
  latencyMs?: number;
  providerCallObserved?: boolean;
  adapterAttested?: boolean;
  requestIdSha256?: string;
  decisions?: readonly FinanceTradeDecision[];
  failureCode?: FinanceTradeDecisionReviewFailureCode;
}>;

export type FinanceTradeDecisionReviewer = (
  request: FinanceTradeDecisionReviewRequest,
  signal: AbortSignal,
) => Promise<FinanceTradeDecisionReviewResult>;

type ReviewerDependencies = Readonly<{
  adapterFactory?: typeof createConfiguredFinanceModelAdapter;
  now?: () => number;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Exact candidate binding prevents the model from adding, dropping, or resizing an order. */
export function parseFinanceTradeDecisionReviewOutput(
  output: unknown,
  request: FinanceTradeDecisionReviewRequest,
): readonly FinanceTradeDecision[] | undefined {
  if (!isRecord(output)) {
    return undefined;
  }
  if (
    Object.keys(output).toSorted().join(",") !== "decisions,schemaVersion" ||
    output.schemaVersion !== FINANCE_TRADE_DECISION_REVIEW_SCHEMA ||
    !Array.isArray(output.decisions)
  ) {
    return undefined;
  }
  const expectedIds = new Set(request.candidates.map((candidate) => candidate.candidateId));
  if (
    expectedIds.size !== request.candidates.length ||
    output.decisions.length !== expectedIds.size
  ) {
    return undefined;
  }
  const seen = new Set<string>();
  const decisions: FinanceTradeDecision[] = [];
  for (const value of output.decisions) {
    if (
      !isRecord(value) ||
      Object.keys(value).toSorted().join(",") !== "candidateId,decision,rationale" ||
      typeof value.candidateId !== "string" ||
      !expectedIds.has(value.candidateId) ||
      seen.has(value.candidateId) ||
      (value.decision !== "approve" && value.decision !== "veto") ||
      typeof value.rationale !== "string" ||
      value.rationale.trim().length === 0 ||
      value.rationale.length > 800
    ) {
      return undefined;
    }
    seen.add(value.candidateId);
    decisions.push({
      candidateId: value.candidateId,
      decision: value.decision,
      rationale: value.rationale.trim(),
    });
  }
  return seen.size === expectedIds.size ? Object.freeze(decisions) : undefined;
}

export function isValidFinanceTradeDecisionReviewResult(
  value: unknown,
  request: FinanceTradeDecisionReviewRequest,
): value is FinanceTradeDecisionReviewResult {
  if (
    !isRecord(value) ||
    (value.status !== "completed" && value.status !== "failed") ||
    typeof value.attempted !== "boolean" ||
    typeof value.provider !== "string" ||
    typeof value.modelId !== "string" ||
    typeof value.latencyMs !== "number" ||
    !Number.isFinite(value.latencyMs) ||
    value.latencyMs < 0 ||
    typeof value.providerCallObserved !== "boolean" ||
    typeof value.adapterAttested !== "boolean" ||
    (value.requestIdSha256 !== undefined &&
      (typeof value.requestIdSha256 !== "string" || !/^[a-f\d]{64}$/u.test(value.requestIdSha256)))
  ) {
    return false;
  }
  if (value.status === "failed") {
    const failureCodes: readonly unknown[] = [
      "output_contract",
      "reviewer_unavailable",
      "output_invalid",
      "output_truncated",
      "provider_auth",
      "provider_rate_limit",
      "process_error",
      "output_limit",
      "runtime_timeout",
      "call_budget_exhausted",
    ];
    return failureCodes.includes(value.failureCode) && value.decisions === undefined;
  }
  return (
    value.attempted &&
    value.failureCode === undefined &&
    Array.isArray(value.decisions) &&
    parseFinanceTradeDecisionReviewOutput(
      { schemaVersion: FINANCE_TRADE_DECISION_REVIEW_SCHEMA, decisions: value.decisions },
      request,
    ) !== undefined
  );
}

function reviewPrompt(payload: unknown): string {
  return [
    "You are a constrained risk reviewer for an autonomous Alpaca PAPER trading cycle.",
    "Use only the supplied decision packet. Do not use external or unstated market facts.",
    "You may only approve or veto each exact candidateId. Never add candidates or change instrument, side, weight, notional, price, order type, or timing.",
    "The researchClose is a completed-bar reference; executionQuote is a time-sensitive observed quote, not a guaranteed fill. Approval is advisory only: TypeScript will re-check quote freshness, account reconciliation, risk caps, deduplication, and the shared execution gate after your response.",
    "If evidence is incomplete, contradictory, or not sufficient to justify the proposed rebalance, veto that candidate. Return exactly one decision for every candidate and no extra fields.",
    `Return one JSON object with schemaVersion "${FINANCE_TRADE_DECISION_REVIEW_SCHEMA}" and decisions [{candidateId, decision: "approve"|"veto", rationale}].`,
    "Decision packet:",
    JSON.stringify(payload),
  ].join("\n");
}

function modelFailureCode(error: unknown): FinanceTradeDecisionReviewFailureCode {
  if (error instanceof ModelAdapterError) {
    return error.code;
  }
  return "process_error";
}

/**
 * Create one bounded, configured-provider review call. This is invoked by the resident Paper
 * scheduler only when a ready daily cycle has executable candidates; it creates no credentials,
 * configuration, local model process, or execution authority.
 */
export function createFinanceTradeDecisionReviewer(
  cfg: OpenClawConfig,
  dependencies: ReviewerDependencies = {},
): FinanceTradeDecisionReviewer {
  const factory = dependencies.adapterFactory ?? createConfiguredFinanceModelAdapter;
  const adapter = factory(cfg, {
    maxCalls: 1,
    maxTokens: 2_048,
    timeoutMs: 30_000,
    buildPrompt: reviewPrompt,
  });
  const now = dependencies.now ?? Date.now;

  return async (reviewRequest, signal) => {
    const startedAt = now();
    const call: ModelCallRequest = {
      callId: randomUUID(),
      correlationId: `finance-trade-review:${reviewRequest.asOf}`,
      taskId: `finance-trade-review:${reviewRequest.asOf.slice(0, 10)}`,
      role: "risk_check",
      attempt: 1,
      provider: adapter.provider,
      modelId: adapter.modelId,
      payload: reviewRequest,
    };
    const observed = () => {
      try {
        return adapter.observe?.({
          callId: call.callId,
          correlationId: call.correlationId,
          taskId: call.taskId,
          role: call.role,
          attempt: call.attempt,
          provider: call.provider,
          modelId: call.modelId,
        });
      } catch {
        return undefined;
      }
    };
    const latencyMs = () => Math.max(0, Math.round(now() - startedAt));

    try {
      const output = await adapter.invoke(call, signal);
      const observation = observed();
      const decisions = parseFinanceTradeDecisionReviewOutput(output, reviewRequest);
      if (!decisions) {
        return {
          status: "failed",
          attempted: true,
          provider: adapter.provider,
          modelId: adapter.modelId,
          latencyMs: latencyMs(),
          providerCallObserved: true,
          adapterAttested: observation !== undefined,
          ...(observation?.transportRequestId
            ? {
                requestIdSha256: createHash("sha256")
                  .update(observation.transportRequestId)
                  .digest("hex"),
              }
            : {}),
          failureCode: "output_contract",
        };
      }
      return {
        status: "completed",
        attempted: true,
        provider: adapter.provider,
        modelId: adapter.modelId,
        latencyMs: latencyMs(),
        providerCallObserved: true,
        adapterAttested: observation !== undefined,
        ...(observation?.transportRequestId
          ? {
              requestIdSha256: createHash("sha256")
                .update(observation.transportRequestId)
                .digest("hex"),
            }
          : {}),
        decisions,
      };
    } catch (error) {
      const observation = observed();
      const deadlineExpired =
        signal.aborted && signal.reason instanceof Error && signal.reason.name === "TimeoutError";
      return {
        status: "failed",
        attempted: true,
        provider: adapter.provider,
        modelId: adapter.modelId,
        latencyMs: latencyMs(),
        providerCallObserved: observation !== undefined,
        adapterAttested: observation !== undefined,
        ...(observation?.transportRequestId
          ? {
              requestIdSha256: createHash("sha256")
                .update(observation.transportRequestId)
                .digest("hex"),
            }
          : {}),
        failureCode: deadlineExpired ? "runtime_timeout" : modelFailureCode(error),
      };
    }
  };
}
