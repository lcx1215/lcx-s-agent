import { createHash, randomUUID } from "node:crypto";
import {
  ApiCallError,
  apiSourceErrorText,
  createApiSourceGovernanceRegistry,
  type ApiCallReceipt,
  type ApiSourceGovernanceRegistry,
  type ApiTransportOptions,
} from "./api-call-contract.js";
import type { FinanceCommitteeEvidence } from "./finance-agent-committee.js";
import {
  createFinanceMarketCollectionRegistry,
  inspectFinanceMarketCollectionRegistry,
  runFinanceMarketCollectionRefresh,
  type FinanceMarketCollectionAdapter,
  type FinanceMarketCollectionReceipt,
  type FinanceMarketCollectionRegistryOptions,
  type FinanceMarketCollectionRequest,
} from "./finance-market-collection-registry.js";
import {
  createFinanceRealtimeSourceRegistry,
  inspectFinanceRealtimeSourceRegistry,
  runFinanceRealtimeRefresh,
  type FinanceRealtimeRefreshReceipt,
  type FinanceRealtimeSourceAdapter,
  type FinanceRealtimeSourceRegistryOptions,
  type FinanceRealtimeSourceRequest,
} from "./finance-realtime-source-registry.js";
import {
  openFinanceRunCheckpoints,
  type FinanceCheckpointOptions,
} from "./finance-run-checkpoints.js";

export const FINANCE_RESEARCH_BATCH_SCHEMA_VERSION = "lcx_finance_research_batch_v1" as const;

export type FinanceResearchBatchCollection = Omit<
  FinanceMarketCollectionRequest,
  "instrument" | "assetClass" | "asOf"
> & {
  /** Required policy: historical collections may legitimately need a longer window. */
  freshnessMaxMinutes: number;
};

export type FinanceResearchBatchTarget = Readonly<{
  id: string;
  instrument: string;
  assetClass: string;
  /** Defaults to a realtime refresh; false permits collection-only targets. */
  realtime?:
    | false
    | Partial<
        Pick<
          FinanceRealtimeSourceRequest,
          "freshnessMaxMinutes" | "crossSourceSkewMaxMinutes" | "requireOfficialReference"
        >
      >;
  collections?: readonly FinanceResearchBatchCollection[];
}>;

export type FinanceResearchBatchOptions = Readonly<{
  targets: readonly FinanceResearchBatchTarget[];
  checkpoint?: FinanceCheckpointOptions;
  asOf: string;
  useCase: string;
  correlationId?: string;
  signal?: AbortSignal;
  maxJobs?: number;
  /** Hard upper bound on worst-case source attempts reserved before dispatch. */
  maxApiCalls?: number;
  maxConcurrency?: number;
  maxSourcesPerJob?: number;
  sourceTimeoutMs?: number;
  totalTimeoutMs?: number;
  retry?: ApiTransportOptions["retry"];
  sourceGovernance?: ApiSourceGovernanceRegistry;
  realtimeAdapters?: readonly FinanceRealtimeSourceAdapter[];
  collectionAdapters?: readonly FinanceMarketCollectionAdapter[];
  realtimeRegistryOptions?: FinanceRealtimeSourceRegistryOptions;
  collectionRegistryOptions?: FinanceMarketCollectionRegistryOptions;
}>;

type PlannedJob = Readonly<{
  targetId: string;
  jobId: string;
  /** Stable request identity for receipts, not a cache or an exactly-once guarantee. */
  idempotencyKey: string;
  correlationId: string;
  freshnessMaxMinutes: number;
}> &
  (
    | { kind: "realtime"; request: FinanceRealtimeSourceRequest }
    | { kind: "collection"; request: FinanceMarketCollectionRequest }
  );

type SourceReceipt = FinanceRealtimeRefreshReceipt | FinanceMarketCollectionReceipt;
export type FinanceResearchBatchJob = PlannedJob &
  Readonly<{
    status: "ready" | "needs_review" | "blocked" | "failed" | "cancelled" | "timed_out";
    queueWaitMs: number;
    receipt?: SourceReceipt;
    apiCalls: readonly ApiCallReceipt[];
    freshnessWarnings: readonly string[];
    /** Collection conflicts only compare duplicate identities within one source. */
    conflictAssessment: "gateway" | "duplicate_source_items_only" | "not_assessed";
    conflicts: readonly string[];
    missingEvidence: readonly string[];
    error?: string;
  }>;

export type FinanceResearchBatchEvidencePacket = Readonly<{
  schemaVersion: typeof FINANCE_RESEARCH_BATCH_SCHEMA_VERSION;
  boundary: "finance_research_batch_research_only";
  decisionMode: "research_only";
  correlationId: string;
  asOf: string;
  useCase: string;
  status: "completed" | "partial" | "blocked" | "cancelled" | "timed_out";
  jobs: readonly FinanceResearchBatchJob[];
  /** Includes a coverage summary and every job's status; only ready jobs carry data. */
  committeeEvidence: readonly FinanceCommitteeEvidence[];
  checkpoint?: Readonly<{
    runId: string;
    scope: "source_nodes_only";
    reusedJobIds: readonly string[];
    uncertainJobIds: readonly string[];
  }>;
  budget: Readonly<{
    maxJobs: number;
    maxApiCalls: number;
    reservedCallBudget: number;
    requestedJobs: number;
    completedJobs: number;
    failedJobs: number;
    cancelledJobs: number;
    timedOutJobs: number;
    readyJobs: number;
    reviewJobs: number;
    blockedJobs: number;
    maxConcurrency: number;
    peakConcurrency: number;
    maxSourcesPerJob: number;
    sourceTimeoutMs: number;
    totalTimeoutMs: number;
    retryAttempts: number;
    callCount: number;
    callCountBasis: "http_get_receipts_including_rejected_dispatch";
    receiptCount: number;
    queuePolicy: "bounded_fifo_reject_oversize_before_dispatch";
    sourceGovernance: "caller_shared" | "batch_shared";
    /** Caller registries are opaque; never invent their rate/queue settings. */
    sourceGovernancePolicy: typeof DEFAULT_SOURCE_GOVERNANCE | null;
    rateLimitedCalls: number;
    circuitOpenCalls: number;
    throttleWaitMs: number;
  }>;
  notTouched: readonly string[];
}>;

const NOT_TOUCHED = [
  "provider_config",
  "external_channel_sender",
  "protected_memory",
  "trading_execution",
  "wallet_or_order_authority",
] as const;

const DEFAULT_SOURCE_GOVERNANCE = {
  minIntervalMs: 250,
  maxConcurrent: 1,
  maxQueue: 64,
  failureThreshold: 3,
  resetAfterMs: 30_000,
} as const;

function requiredText(value: string, label: string): string {
  if (!value.trim()) {
    throw new Error(`${label} required`);
  }
  return value.trim();
}

function positive(value: number, label: string, integer = false): number {
  if (!Number.isFinite(value) || value <= 0 || (integer && !Number.isSafeInteger(value))) {
    throw new Error(`${label} must be a positive ${integer ? "integer" : "number"}`);
  }
  return value;
}

function identity(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
}

function assessReceipt(receipt: SourceReceipt, job: PlannedJob) {
  if ("snapshot" in receipt || job.kind === "realtime") {
    const snapshot = (receipt as FinanceRealtimeRefreshReceipt).snapshot;
    return {
      freshnessWarnings: snapshot?.freshnessWarnings ?? [],
      conflicts: snapshot?.conflicts.map((conflict) => conflict.fieldName) ?? [],
      conflictAssessment: "gateway" as const,
    };
  }
  const freshnessWarnings: string[] = [];
  const conflicts: string[] = [];
  const seen = new Map<string, string>();
  for (const record of (receipt as FinanceMarketCollectionReceipt).records) {
    const key = JSON.stringify([record.providerName, record.collection, record.itemId]);
    const age = (Date.parse(job.request.asOf) - Date.parse(record.sourceTimestamp)) / 60_000;
    if (
      !Number.isFinite(age) ||
      age < 0 ||
      age > job.freshnessMaxMinutes ||
      !Number.isFinite(Date.parse(record.observedAt)) ||
      Date.parse(record.observedAt) > Date.parse(job.request.asOf) ||
      record.delayStatus === "manual_or_unknown" ||
      !record.sourceUrlOrArtifact?.trim()
    ) {
      freshnessWarnings.push(`stale_or_invalid_collection_provenance:${key}`);
    }
    const content = JSON.stringify(record.data);
    if (seen.has(key) && seen.get(key) !== content) {
      conflicts.push(key);
    }
    seen.set(key, content);
  }
  return {
    freshnessWarnings,
    conflicts,
    conflictAssessment: "duplicate_source_items_only" as const,
  };
}

/** Source orchestration only. This function never invokes a model or selects an answer. */
export async function runFinanceResearchBatch(
  options: FinanceResearchBatchOptions,
): Promise<FinanceResearchBatchEvidencePacket> {
  const asOf = requiredText(options.asOf, "asOf");
  if (!Number.isFinite(Date.parse(asOf))) {
    throw new Error("asOf must be an ISO timestamp");
  }
  const useCase = requiredText(options.useCase, "useCase");
  const correlationId = requiredText(options.correlationId ?? randomUUID(), "correlationId");
  const maxJobs = positive(options.maxJobs ?? 256, "maxJobs", true);
  const maxApiCalls = positive(options.maxApiCalls ?? 10_000, "maxApiCalls", true);
  const maxConcurrency = positive(options.maxConcurrency ?? 4, "maxConcurrency", true);
  const maxSourcesPerJob = positive(options.maxSourcesPerJob ?? 3, "maxSourcesPerJob", true);
  const sourceTimeoutMs = positive(options.sourceTimeoutMs ?? 15_000, "sourceTimeoutMs");
  const totalTimeoutMs = positive(options.totalTimeoutMs ?? 120_000, "totalTimeoutMs");
  const retryAttempts = positive(options.retry?.attempts ?? 1, "retry.attempts", true);
  const requestedJobs = options.targets.reduce(
    (count, target) =>
      count + (target.realtime === false ? 0 : 1) + (target.collections?.length ?? 0),
    0,
  );
  if (requestedJobs === 0 || requestedJobs > maxJobs || options.targets.length > maxJobs) {
    throw new Error(
      `batch job budget exceeded or empty: requested=${requestedJobs}, max=${maxJobs}`,
    );
  }
  const realtimeAdapters =
    options.realtimeAdapters ??
    createFinanceRealtimeSourceRegistry(options.realtimeRegistryOptions);
  const collectionAdapters =
    options.collectionAdapters ??
    createFinanceMarketCollectionRegistry(options.collectionRegistryOptions);
  const planned: PlannedJob[] = [];
  const targetIds = new Set<string>();
  for (const target of options.targets) {
    const targetId = requiredText(target.id, "target.id");
    if (targetIds.has(targetId)) {
      throw new Error(`duplicate target id: ${targetId}`);
    }
    targetIds.add(targetId);
    const common = {
      instrument: requiredText(target.instrument, "instrument"),
      assetClass: requiredText(target.assetClass, "assetClass"),
      asOf,
    };
    const requests: Array<
      Pick<PlannedJob, "kind" | "freshnessMaxMinutes"> & {
        request: FinanceRealtimeSourceRequest | FinanceMarketCollectionRequest;
      }
    > = [];
    if (target.realtime !== false) {
      const policy = target.realtime ?? {};
      const freshnessMaxMinutes = positive(policy.freshnessMaxMinutes ?? 15, "freshnessMaxMinutes");
      const request = inspectFinanceRealtimeSourceRegistry(
        {
          ...common,
          useCase,
          ...policy,
          freshnessMaxMinutes,
          crossSourceSkewMaxMinutes: positive(
            policy.crossSourceSkewMaxMinutes ?? 5,
            "crossSourceSkewMaxMinutes",
          ),
        },
        realtimeAdapters,
      ).request;
      requests.push({ kind: "realtime", request, freshnessMaxMinutes });
    }
    for (const collection of target.collections ?? []) {
      const { freshnessMaxMinutes, ...fields } = collection;
      const request = inspectFinanceMarketCollectionRegistry(
        { ...fields, ...common },
        collectionAdapters,
      ).request;
      requests.push({
        kind: "collection",
        request,
        freshnessMaxMinutes: positive(freshnessMaxMinutes, "collection.freshnessMaxMinutes"),
      });
    }
    for (const entry of requests) {
      const idempotencyKey = identity({ targetId, ...entry, maxSourcesPerJob });
      if (planned.some((job) => job.idempotencyKey === idempotencyKey)) {
        throw new Error(`duplicate job for target: ${targetId}`);
      }
      const jobId = `finance-batch:${idempotencyKey}`;
      planned.push({
        ...entry,
        targetId,
        jobId,
        idempotencyKey,
        correlationId: `${correlationId}:${idempotencyKey}`,
      } as PlannedJob);
    }
  }

  const checkpoint = options.checkpoint
    ? openFinanceRunCheckpoints(
        options.checkpoint,
        identity({
          schema: "finance_checkpoint_v1",
          execution: options.checkpoint.executionFingerprint,
          planned: planned.map(({ correlationId: _correlationId, ...job }) => job),
          maxApiCalls,
          maxConcurrency,
          totalTimeoutMs,
          maxJobs,
          maxSourcesPerJob,
          retry: options.retry ?? { attempts: 1 },
          sourceTimeoutMs,
          adapters: [...realtimeAdapters, ...collectionAdapters].map((adapter) => ({
            id: adapter.id,
            provider: adapter.providerName,
            priority: adapter.priority,
          })),
        }),
        maxApiCalls,
      )
    : undefined;
  const governance =
    options.sourceGovernance ?? createApiSourceGovernanceRegistry(DEFAULT_SOURCE_GOVERNANCE);
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  const timer = setTimeout(() => controller.abort(new ApiCallError("timeout")), totalTimeoutMs);
  const startedAt = Date.now();
  const jobs: FinanceResearchBatchJob[] = [];
  const reusedJobIds: string[] = [];
  const uncertainJobIds: string[] = [];
  let next = 0;
  let active = 0;
  let peakConcurrency = 0;
  let reservedCallBudget = checkpoint?.reserved() ?? 0;
  const abortStatus = () =>
    signal.reason instanceof ApiCallError && signal.reason.kind === "timeout"
      ? ("timed_out" as const)
      : ("cancelled" as const);
  const worker = async () => {
    while (next < planned.length) {
      const index = next++;
      const job = planned[index];
      const base = {
        ...job,
        queueWaitMs: Math.max(0, Date.now() - startedAt),
        apiCalls: [],
        freshnessWarnings: [],
        conflicts: [],
        conflictAssessment: "not_assessed" as const,
        missingEvidence: [],
      };
      if (signal.aborted) {
        jobs[index] = { ...base, status: abortStatus(), missingEvidence: ["job_not_dispatched"] };
        continue;
      }
      const supportedAdapterCount =
        job.kind === "realtime"
          ? realtimeAdapters.filter((adapter) => adapter.supports(job.request)).length
          : collectionAdapters.filter((adapter) => adapter.supports(job.request)).length;
      const worstCaseJobCalls = Math.min(maxSourcesPerJob, supportedAdapterCount) * retryAttempts;
      const reservation = checkpoint?.reserve(job.jobId, worstCaseJobCalls);
      if (reservation?.status === "completed") {
        const restored = reservation.result as FinanceResearchBatchJob;
        if (restored?.jobId !== job.jobId || restored.idempotencyKey !== job.idempotencyKey) {
          throw new Error("checkpoint job identity mismatch");
        }
        reusedJobIds.push(job.jobId);
        jobs[index] = restored;
        continue;
      }
      if (reservation?.status === "uncertain") {
        uncertainJobIds.push(job.jobId);
        jobs[index] = {
          ...base,
          status: "needs_review",
          missingEvidence: ["checkpoint_dispatch_outcome_unknown"],
        };
        continue;
      }
      if (
        reservation?.status === "budget_exhausted" ||
        (!checkpoint && reservedCallBudget + worstCaseJobCalls > maxApiCalls)
      ) {
        jobs[index] = {
          ...base,
          status: "blocked",
          missingEvidence: ["api_call_budget_exhausted"],
          error: "api_call_budget_exhausted",
        };
        continue;
      }
      reservedCallBudget = checkpoint?.reserved() ?? reservedCallBudget + worstCaseJobCalls;
      active++;
      peakConcurrency = Math.max(peakConcurrency, active);
      try {
        const transport = {
          maxSources: maxSourcesPerJob,
          timeoutMs: sourceTimeoutMs,
          signal,
          correlationId: job.correlationId,
          retry: { ...options.retry, attempts: retryAttempts },
          sourceGovernance: governance,
        };
        const receipt =
          job.kind === "realtime"
            ? await runFinanceRealtimeRefresh({
                ...transport,
                request: job.request,
                adapters: realtimeAdapters,
              })
            : await runFinanceMarketCollectionRefresh({
                ...transport,
                request: job.request,
                adapters: collectionAdapters,
              });
        const apiCalls = receipt.sourceAttempts.flatMap((attempt) => attempt.apiCalls ?? []);
        const assessment = assessReceipt(receipt, job);
        // Row freshness does not establish completeness of a requested historical window.
        // Keep this fail-closed until collection adapters expose a coverage contract.
        const coverageGaps =
          job.kind === "collection" && job.request.collection === "eod_history"
            ? ["historical_window_coverage_unverified"]
            : [];
        const requiresReview =
          coverageGaps.length > 0 ||
          assessment.freshnessWarnings.length > 0 ||
          assessment.conflicts.length > 0 ||
          receipt.sourceAttempts.some((attempt) => attempt.status === "failed");
        jobs[index] = {
          ...base,
          receipt,
          apiCalls,
          ...assessment,
          status: signal.aborted
            ? abortStatus()
            : receipt.status === "ready" && requiresReview
              ? "needs_review"
              : receipt.status,
          missingEvidence: [...receipt.missingEvidence, ...coverageGaps],
        };
      } catch (error) {
        jobs[index] = {
          ...base,
          status: signal.aborted ? abortStatus() : "failed",
          error: apiSourceErrorText(error),
          missingEvidence: ["job_result_unavailable"],
        };
      } finally {
        active--;
      }
      if (reservation?.status === "reserved") {
        checkpoint!.complete(job.jobId, reservation.token, jobs[index]);
      }
    }
  };
  try {
    const outcomes = await Promise.allSettled(
      Array.from({ length: Math.min(maxConcurrency, planned.length) }, async () => {
        try {
          await worker();
        } catch (error) {
          controller.abort(error);
          throw error;
        }
      }),
    );
    const failure = outcomes.find((outcome) => outcome.status === "rejected");
    if (failure?.status === "rejected") {
      throw failure.reason;
    }
    reservedCallBudget = checkpoint?.reserved() ?? reservedCallBudget;
  } finally {
    clearTimeout(timer);
    checkpoint?.close();
  }
  const count = (status: FinanceResearchBatchJob["status"]) =>
    jobs.filter((job) => job.status === status).length;
  const apiCalls = jobs.flatMap((job) => job.apiCalls);
  const httpCalls = apiCalls.filter((call) => call.operation === "http_get");
  const budget = {
    maxJobs,
    maxApiCalls,
    reservedCallBudget,
    requestedJobs,
    completedJobs: count("ready") + count("needs_review"),
    failedJobs: count("blocked") + count("failed"),
    cancelledJobs: count("cancelled"),
    timedOutJobs: count("timed_out"),
    readyJobs: count("ready"),
    reviewJobs: count("needs_review"),
    blockedJobs: count("blocked"),
    maxConcurrency,
    peakConcurrency,
    maxSourcesPerJob,
    sourceTimeoutMs,
    totalTimeoutMs,
    retryAttempts,
    callCount: httpCalls.length,
    callCountBasis: "http_get_receipts_including_rejected_dispatch" as const,
    receiptCount: apiCalls.length,
    queuePolicy: "bounded_fifo_reject_oversize_before_dispatch" as const,
    sourceGovernance: options.sourceGovernance
      ? ("caller_shared" as const)
      : ("batch_shared" as const),
    sourceGovernancePolicy: options.sourceGovernance ? null : DEFAULT_SOURCE_GOVERNANCE,
    rateLimitedCalls: httpCalls.filter(
      (call) => call.rateLimited || call.transportError === "rate_limited",
    ).length,
    circuitOpenCalls: httpCalls.filter((call) => call.transportError === "circuit_open").length,
    throttleWaitMs: httpCalls.reduce((sum, call) => sum + (call.throttleWaitMs ?? 0), 0),
  };
  const status = signal.aborted
    ? abortStatus()
    : budget.readyJobs === requestedJobs
      ? "completed"
      : budget.completedJobs > 0
        ? "partial"
        : "blocked";
  const committeeEvidence: FinanceCommitteeEvidence[] = [
    {
      id: `finance-batch-summary:${identity(correlationId)}`,
      source: "finance-research-batch-runner",
      timestamp: asOf,
      text: JSON.stringify({
        boundary: "finance_research_batch_research_only",
        status,
        budget,
        notTouched: NOT_TOUCHED,
      }),
    },
    ...jobs.map((job) => ({
      id: job.jobId,
      source: "finance-research-batch-runner",
      timestamp: asOf,
      text: JSON.stringify({
        targetId: job.targetId,
        request: job.request,
        status: job.status,
        usableAsCurrentEvidence: job.status === "ready",
        idempotencyKey: job.idempotencyKey,
        correlationId: job.correlationId,
        freshnessWarnings: job.freshnessWarnings,
        conflicts: job.conflicts,
        conflictAssessment: job.conflictAssessment,
        missingEvidence: job.missingEvidence,
        error: job.error,
        sourceAttempts: job.receipt?.sourceAttempts,
        requiredNextSteps: job.receipt?.requiredNextSteps,
        // Raw withheld evidence remains in jobs[].receipt for the quality reviewer.
        data: job.status === "ready" ? job.receipt : undefined,
      }),
    })),
  ];
  return {
    schemaVersion: FINANCE_RESEARCH_BATCH_SCHEMA_VERSION,
    boundary: "finance_research_batch_research_only",
    decisionMode: "research_only",
    correlationId,
    asOf,
    useCase,
    status,
    jobs,
    committeeEvidence,
    ...(options.checkpoint
      ? {
          checkpoint: {
            runId: options.checkpoint.runId,
            scope: "source_nodes_only" as const,
            reusedJobIds,
            uncertainJobIds,
          },
        }
      : {}),
    budget,
    notTouched: NOT_TOUCHED,
  };
}
