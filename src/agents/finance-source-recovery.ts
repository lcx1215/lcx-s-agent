import { createHash } from "node:crypto";
import { z } from "zod";
import {
  FINANCE_MARKET_COLLECTION_KINDS,
  resolveFinanceMarketCollectionRegistryOptionsFromEnv,
} from "./finance-market-collection-registry.js";
import { resolveFinanceRealtimeSourceRegistryOptionsFromEnv } from "./finance-realtime-source-registry.js";
import {
  runFinanceResearchBatch,
  type FinanceResearchBatchOptions,
  type FinanceResearchBatchTarget,
} from "./finance-research-batch-runner.js";

const timestamp = z
  .string()
  .refine((value) => Number.isFinite(Date.parse(value)), "invalid timestamp");
const sourceJob = z.object({
  jobId: z.string().min(1),
  targetId: z.string().min(1),
  parentJobId: z.string().optional(),
  latestAttemptJobId: z.string().optional(),
  kind: z.enum(["realtime", "collection"]),
  sourceAdapterIds: z.array(z.string().min(1)).optional(),
  status: z.enum(["ready", "needs_review", "blocked", "failed", "cancelled", "timed_out"]),
  freshnessMaxMinutes: z.number().positive(),
  request: z.object({
    instrument: z.string().min(1),
    assetClass: z.string().min(1),
    collection: z.enum(FINANCE_MARKET_COLLECTION_KINDS).optional(),
    seriesId: z.string().optional(),
    fromDate: z.string().optional(),
    toDate: z.string().optional(),
    limit: z.number().int().positive().optional(),
    crossSourceSkewMaxMinutes: z.number().positive().optional(),
    requireOfficialReference: z.boolean().optional(),
  }),
  apiCalls: z.array(
    z.object({
      status: z.string(),
      httpStatus: z.number().optional(),
      transportError: z.string().optional(),
      networkCode: z.string().optional(),
      finishedAt: timestamp,
      retryAfterMs: z.number().nonnegative().optional(),
    }),
  ),
  missingEvidence: z.array(z.string()),
  freshnessWarnings: z.array(z.string()),
  conflicts: z.array(z.string()),
});
const sourceBatch = z.object({
  schemaVersion: z.literal("lcx_finance_research_batch_v1"),
  boundary: z.literal("finance_research_batch_research_only"),
  correlationId: z.string().min(1),
  asOf: timestamp,
  jobs: z.array(sourceJob),
});
const recoveryState = z.object({
  schemaVersion: z.literal("lcx_finance_recovery_state_v1"),
  boundary: z.literal("source_recovery_scheduling_only"),
  originalCorrelationId: z.string().min(1),
  originalAsOf: timestamp,
  jobs: z.array(sourceJob),
});
type RecoveryJob = z.infer<typeof sourceJob>;
export type FinanceSourceRecoveryAction =
  | "preserve"
  | "retry"
  | "wait"
  | "resolve_access"
  | "review_evidence"
  | "reconcile_dispatch";

function classify(job: RecoveryJob, nowMs: number) {
  const result = (action: FinanceSourceRecoveryAction, reason: string, retryAt?: string) => ({
    action,
    reason,
    ...(retryAt ? { retryAt } : {}),
  });
  if (job.status === "ready") {
    return result("preserve", "already_ready");
  }
  if (job.missingEvidence.includes("checkpoint_dispatch_outcome_unknown")) {
    return result("reconcile_dispatch", "dispatch_outcome_unknown");
  }
  const failed = job.apiCalls.filter((call) => call.status !== "succeeded");
  if (
    failed.some(
      (call) =>
        call.httpStatus === 401 || call.httpStatus === 403 || call.transportError === "forbidden",
    )
  ) {
    return result("resolve_access", "access_denied");
  }
  if (job.conflicts.length || job.freshnessWarnings.length || job.status === "needs_review") {
    return result("review_evidence", "evidence_quality_requires_review");
  }
  // Successful transports with a missing cross-check/history window need different
  // evidence, not another identical call. A mixed failure stays reviewable too.
  if (job.apiCalls.some((call) => call.status === "succeeded")) {
    return result("review_evidence", "transport_succeeded_but_evidence_incomplete");
  }
  const delays = failed.filter(
    (call) =>
      (call.retryAfterMs ?? 0) > 0 ||
      call.httpStatus === 429 ||
      call.transportError === "rate_limited" ||
      call.transportError === "circuit_open",
  );
  const retryAtMs = Math.max(
    0,
    ...delays.map((call) => Date.parse(call.finishedAt) + (call.retryAfterMs ?? 60_000)),
  );
  if (retryAtMs > nowMs) {
    return result("wait", "source_cooldown", new Date(retryAtMs).toISOString());
  }
  const recoverable =
    failed.length > 0 &&
    failed.every(
      (call) =>
        ["budget_exhausted", "timeout", "rate_limited", "circuit_open"].includes(
          call.transportError ?? "",
        ) ||
        (call.transportError === "network_error" &&
          [
            "ECONNRESET",
            "UND_ERR_SOCKET",
            "EAI_AGAIN",
            "ETIMEDOUT",
            "UND_ERR_CONNECT_TIMEOUT",
            "UND_ERR_HEADERS_TIMEOUT",
            "UND_ERR_BODY_TIMEOUT",
          ].includes(call.networkCode ?? "")) ||
        call.httpStatus === 408 ||
        call.httpStatus === 429 ||
        (call.httpStatus !== undefined && call.httpStatus >= 500 && call.httpStatus <= 599),
    );
  if (
    recoverable ||
    (!failed.length &&
      (job.missingEvidence.includes("api_call_budget_exhausted") ||
        job.missingEvidence.includes("job_not_dispatched")))
  ) {
    return result("retry", "recoverable_transport_or_unspent_job");
  }
  return result("review_evidence", "unclassified_failure_requires_inspection");
}

/** Accept an original batch or the containing research receipt, never model text. */
export function buildFinanceSourceRecoveryPlan(input: unknown, asOf: string) {
  const nowMs = Date.parse(timestamp.parse(asOf));
  const state =
    input && typeof input === "object" && "recoveryState" in input
      ? recoveryState.parse(input.recoveryState)
      : undefined;
  const wrapped = z.object({ batch: z.unknown() }).safeParse(input);
  const batch = state
    ? {
        correlationId: state.originalCorrelationId,
        asOf: state.originalAsOf,
        jobs: state.jobs,
      }
    : sourceBatch.parse(wrapped.success ? wrapped.data.batch : input);
  if (nowMs < Date.parse(batch.asOf)) {
    throw new Error("recovery time cannot precede source batch");
  }
  if (new Set(batch.jobs.map((job) => job.jobId)).size !== batch.jobs.length) {
    throw new Error("duplicate recovery job identity");
  }
  const entries = batch.jobs.map((job) => ({
    parentJobId: job.jobId,
    targetId: job.targetId,
    sourceAdapterIds: job.sourceAdapterIds ?? [],
    originalStatus: job.status,
    ...classify(job, nowMs),
  }));
  const targets = batch.jobs.flatMap((job, index): FinanceResearchBatchTarget[] => {
    if (entries[index].action !== "retry") {
      return [];
    }
    const { instrument, assetClass, collection, seriesId, fromDate, toDate, limit, ...realtime } =
      job.request;
    if (job.kind === "collection" && !collection) {
      throw new Error("collection recovery requires its original collection type");
    }
    return [
      {
        id: job.jobId,
        instrument,
        assetClass,
        ...(job.sourceAdapterIds ? { sourceAdapterIds: job.sourceAdapterIds } : {}),
        realtime:
          job.kind === "realtime"
            ? { ...realtime, freshnessMaxMinutes: job.freshnessMaxMinutes }
            : false,
        ...(job.kind === "collection"
          ? {
              collections: [
                {
                  collection: collection!,
                  seriesId,
                  fromDate,
                  toDate,
                  limit,
                  freshnessMaxMinutes: job.freshnessMaxMinutes,
                },
              ],
            }
          : {}),
      },
    ];
  });
  return {
    schemaVersion: "lcx_finance_source_recovery_v1" as const,
    boundary: "finance_source_recovery_research_only" as const,
    parentCorrelationId: batch.correlationId,
    parentAsOf: batch.asOf,
    parentFingerprint: createHash("sha256").update(JSON.stringify(batch)).digest("hex"),
    asOf,
    entries,
    targets,
    recoveryState: {
      schemaVersion: "lcx_finance_recovery_state_v1" as const,
      boundary: "source_recovery_scheduling_only" as const,
      originalCorrelationId: batch.correlationId,
      originalAsOf: batch.asOf,
      jobs: batch.jobs,
    },
    counts: Object.fromEntries(
      (
        [
          "preserve",
          "retry",
          "wait",
          "resolve_access",
          "review_evidence",
          "reconcile_dispatch",
        ] as const
      ).map((action) => [action, entries.filter((entry) => entry.action === action).length]),
    ),
    executionAuthority: "none" as const,
  };
}

/** A new bounded batch, linked to its parent. Never rewrites or adopts old evidence. */
export async function runFinanceSourceRecovery(
  input: unknown,
  options: {
    asOf: string;
    live: boolean;
    maxJobs: number;
    sourceAdapterIds?: readonly string[];
    batchOptions?: Omit<
      FinanceResearchBatchOptions,
      "targets" | "asOf" | "useCase" | "checkpoint" | "maxJobs"
    >;
  },
) {
  if (!Number.isSafeInteger(options.maxJobs) || options.maxJobs < 1) {
    throw new Error("recovery maxJobs must be a positive integer");
  }
  const plan = buildFinanceSourceRecoveryPlan(input, options.asOf);
  const selectedSources = options.sourceAdapterIds;
  if (selectedSources && (!selectedSources.length || selectedSources.some((id) => !id.trim()))) {
    throw new Error("recovery source selection must contain nonempty IDs");
  }
  const eligible = plan.targets.flatMap((target): FinanceResearchBatchTarget[] => {
    if (!selectedSources) {
      return [target];
    }
    const sourceAdapterIds =
      target.sourceAdapterIds?.filter((id) => selectedSources.includes(id)) ?? [];
    return sourceAdapterIds.length ? [{ ...target, sourceAdapterIds }] : [];
  });
  const eligibleIds = new Set(eligible.map((target) => target.id));
  const selected = eligible.slice(0, options.maxJobs);
  const batch =
    options.live && selected.length
      ? await runFinanceResearchBatch({
          ...options.batchOptions,
          realtimeRegistryOptions: {
            ...resolveFinanceRealtimeSourceRegistryOptionsFromEnv(),
            includeYahooPublicSource: true,
            ...options.batchOptions?.realtimeRegistryOptions,
          },
          collectionRegistryOptions: {
            ...resolveFinanceMarketCollectionRegistryOptionsFromEnv(),
            includeYahooPublicSources: true,
            ...options.batchOptions?.collectionRegistryOptions,
          },
          targets: selected,
          asOf: options.asOf,
          useCase: "finance_source_recovery",
          maxJobs: options.maxJobs,
        })
      : undefined;
  const updatedJobs = plan.recoveryState.jobs.flatMap((original): RecoveryJob[] => {
    const attempt = batch?.jobs.find((job) => job.targetId === original.jobId);
    if (!attempt) {
      return [original];
    }
    const retried = selected.find((target) => target.id === original.jobId)!;
    const remainingSources = original.sourceAdapterIds?.filter(
      (id) => !retried.sourceAdapterIds?.includes(id),
    );
    const observed = {
      ...sourceJob.parse(attempt),
      parentJobId: original.parentJobId ?? original.jobId,
      latestAttemptJobId: attempt.jobId,
      targetId: original.targetId,
    };
    // A selected adapter's success cannot clear unselected failures in the same job.
    return remainingSources?.length
      ? [{ ...original, sourceAdapterIds: remainingSources }, observed]
      : [{ ...observed, jobId: original.jobId }];
  });
  return {
    ...plan,
    recoveryState: { ...plan.recoveryState, jobs: updatedJobs },
    status: !options.live
      ? ("planned" as const)
      : batch
        ? ("executed" as const)
        : ("no_retryable_jobs" as const),
    selectedParentJobIds: selected.map((target) => target.id),
    deferredParentJobIds: eligible.slice(options.maxJobs).map((target) => target.id),
    excludedParentJobIds: plan.targets
      .filter((target) => !eligibleIds.has(target.id))
      .map((target) => target.id),
    ...(batch ? { batch } : {}),
    adopted: false as const,
    originalEvidenceRewritten: false as const,
  };
}
