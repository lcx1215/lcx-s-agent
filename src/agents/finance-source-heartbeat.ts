import {
  ApiCallError,
  apiSourceErrorText,
  runApiSourceCall,
  type ApiCallReceipt,
  type ApiSourceGovernanceRegistry,
} from "./api-call-contract.js";
import { resolveFinanceCredentialEnv } from "./finance-credential-env.js";
import { appendFinanceFundamentalSnapshot } from "./finance-fundamental-store.js";
import type { FetchImpl } from "./finance-live-market-source.js";
import { FINANCE_MARKET_COLLECTION_SCHEMA_VERSION } from "./finance-market-collection-registry.js";
import {
  createFinanceMarketCollectionRegistry,
  resolveFinanceMarketCollectionRegistryOptionsFromEnv,
  type FinanceMarketCollectionAdapter,
  type FinanceMarketCollectionRequest,
} from "./finance-market-collection-registry.js";
import {
  createFinanceRealtimeSourceRegistry,
  resolveFinanceRealtimeSourceRegistryOptionsFromEnv,
  type FinanceRealtimeSourceAdapter,
  type FinanceRealtimeSourceRequest,
} from "./finance-realtime-source-registry.js";
import {
  acquireFinanceSourceHeartbeatLock,
  FINANCE_SOURCE_HEARTBEAT_DEFAULT_INTERVAL_MS,
  FINANCE_SOURCE_HEARTBEAT_FAILURE_INTERVAL_MS,
  FINANCE_SOURCE_HEARTBEAT_MAX_TIMER_MS,
  FINANCE_SOURCE_HEARTBEAT_SCHEMA_VERSION,
  persistFinanceSourceHeartbeat,
  readFinanceSourceHeartbeat,
  isFinanceSourceAccessScope,
  type FinanceSourceHeartbeatReason,
  type FinanceSourceHeartbeatRecord,
  type FinanceSourceHeartbeatState,
  type FinanceSourceHeartbeatStatus,
} from "./finance-source-heartbeat-state.js";
import { withFinanceQuotaLane } from "./finance-source-quota.js";
import { financeProviderId, mapFinanceSourceLanes } from "./finance-source-scheduler.js";
import { resolveFinanceStateDir } from "./finance-state-dir.js";

export {
  FINANCE_SOURCE_HEARTBEAT_DEFAULT_INTERVAL_MS,
  FINANCE_SOURCE_HEARTBEAT_FAILURE_INTERVAL_MS,
  FINANCE_SOURCE_HEARTBEAT_MAX_TIMER_MS,
  FINANCE_SOURCE_HEARTBEAT_SCHEMA_VERSION,
  persistFinanceSourceHeartbeat,
  readFinanceSourceHeartbeat,
};
export type {
  FinanceSourceHeartbeatReason,
  FinanceSourceHeartbeatRecord,
  FinanceSourceHeartbeatState,
  FinanceSourceHeartbeatStatus,
};

export type FinanceSourceHeartbeatPlan = Readonly<{
  networkCalled: false;
  asOf: string;
  adapterId?: string;
  providerCount: number;
  candidates: readonly Readonly<{
    provider: string;
    providerName: string;
    adapterId: string;
    kind: "realtime" | "collection";
  }>[];
}>;

type Candidate = {
  id: string;
  provider: string;
  providerName: string;
  adapterId: string;
  kind: "realtime" | "collection";
  adapter: FinanceRealtimeSourceAdapter | FinanceMarketCollectionAdapter;
  request: FinanceRealtimeSourceRequest | FinanceMarketCollectionRequest;
};

type HeartbeatOptions = Readonly<{
  workspaceDir?: string;
  directory?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  asOf?: string;
  now?: () => number;
  force?: boolean;
  intervalMs?: number;
  timeoutMs?: number;
  maxSourceConcurrency?: number;
  adapterId?: string;
  sourceGovernance?: ApiSourceGovernanceRegistry;
  fetchImpl?: FetchImpl;
  realtimeAdapters?: readonly FinanceRealtimeSourceAdapter[];
  collectionAdapters?: readonly FinanceMarketCollectionAdapter[];
}>;

type ProbeResult = {
  provider: string;
  record: FinanceSourceHeartbeatRecord;
};

function realtimeRequests(asOf: string): FinanceRealtimeSourceRequest[] {
  return [
    {
      instrument: "SPY",
      assetClass: "us_equity",
      useCase: "provider_heartbeat",
      asOf,
      asOfMode: "live_now",
      freshnessMaxMinutes: 60,
    },
    {
      instrument: "BTC/USD",
      assetClass: "crypto",
      useCase: "provider_heartbeat",
      asOf,
      asOfMode: "live_now",
      freshnessMaxMinutes: 60,
    },
  ];
}

function collectionRequests(asOf: string): FinanceMarketCollectionRequest[] {
  return [
    {
      instrument: "AAPL",
      assetClass: "us_equity",
      collection: "company_profile",
      asOf,
      asOfMode: "live_now",
      limit: 1,
    },
    {
      instrument: "AAPL",
      assetClass: "us_equity",
      collection: "eod_history",
      asOf,
      asOfMode: "live_now",
      limit: 1,
    },
    {
      instrument: "AAPL",
      assetClass: "us_equity",
      collection: "news",
      asOf,
      asOfMode: "live_now",
      limit: 1,
    },
    {
      instrument: "GDP",
      assetClass: "macro",
      collection: "macro_series",
      seriesId: "GDP",
      asOf,
      asOfMode: "live_now",
      limit: 1,
    },
  ];
}

function candidateForAdapter(
  adapter: FinanceRealtimeSourceAdapter | FinanceMarketCollectionAdapter,
  kind: "realtime" | "collection",
  asOf: string,
): Candidate | undefined {
  const provider = financeProviderId(adapter.id);
  if (kind === "collection") {
    const collection = adapter as FinanceMarketCollectionAdapter;
    const samples = collection.sampleRequest
      ? [
          {
            ...collection.sampleRequest,
            asOf,
            asOfMode: "live_now" as const,
            limit: collection.sampleRequest.collection === "financial_statements" ? 3 : 1,
          },
        ]
      : collectionRequests(asOf);
    for (const request of samples) {
      try {
        if (collection.supports(request)) {
          return {
            id: collection.id,
            provider,
            providerName: collection.providerName,
            adapterId: collection.id,
            kind: "collection",
            adapter: collection,
            request,
          };
        }
      } catch {
        // A malformed representative is not evidence that the provider is down.
      }
    }
    return undefined;
  }
  const realtime = adapter as FinanceRealtimeSourceAdapter;
  const requests = realtime.sampleRequest
    ? [
        {
          ...realtime.sampleRequest,
          useCase: "provider_heartbeat",
          asOf,
          asOfMode: "live_now" as const,
          freshnessMaxMinutes: 60,
        },
      ]
    : realtimeRequests(asOf);
  for (const request of requests) {
    try {
      if (realtime.supports(request)) {
        return {
          id: realtime.id,
          provider,
          providerName: realtime.providerName,
          adapterId: realtime.id,
          kind: "realtime",
          adapter: realtime,
          request,
        };
      }
    } catch {
      // Try the next asset class representative.
    }
  }
  return undefined;
}

function selectCandidates(
  asOf: string,
  realtimeAdapters: readonly FinanceRealtimeSourceAdapter[],
  collectionAdapters: readonly FinanceMarketCollectionAdapter[],
  adapterId?: string,
  history: Readonly<Record<string, FinanceSourceHeartbeatRecord>> = {},
  checkedAt = Date.parse(asOf),
): Candidate[] {
  const requested = adapterId?.trim();
  if (
    requested &&
    ![...realtimeAdapters, ...collectionAdapters].some((adapter) => adapter.id === requested)
  ) {
    throw new Error(`unknown heartbeat adapter: ${requested}`);
  }
  const candidates = [
    ...realtimeAdapters
      .filter((adapter) => !requested || adapter.id === requested)
      .map((adapter) => candidateForAdapter(adapter, "realtime", asOf)),
    ...collectionAdapters
      .filter((adapter) => !requested || adapter.id === requested)
      .map((adapter) => candidateForAdapter(adapter, "collection", asOf)),
  ]
    .filter((candidate): candidate is Candidate => candidate !== undefined)
    .toSorted(
      (left, right) =>
        Number(Date.parse(history[left.adapterId]?.nextCheckAt ?? "1970-01-01") > checkedAt) -
          Number(Date.parse(history[right.adapterId]?.nextCheckAt ?? "1970-01-01") > checkedAt) ||
        Date.parse(history[left.adapterId]?.checkedAt ?? "1970-01-01") -
          Date.parse(history[right.adapterId]?.checkedAt ?? "1970-01-01") ||
        left.adapter.priority - right.adapter.priority ||
        left.adapterId.localeCompare(right.adapterId),
    );
  if (requested && candidates.length === 0) {
    throw new Error(`heartbeat adapter has no supported probe: ${requested}`);
  }
  const selected = new Map<string, Candidate>();
  for (const candidate of candidates) {
    if (!selected.has(candidate.provider)) {
      selected.set(candidate.provider, candidate);
    }
  }
  return [...selected.values()].toSorted((left, right) =>
    left.provider.localeCompare(right.provider),
  );
}

function latestNetworkReceipt(receipts: readonly ApiCallReceipt[]): ApiCallReceipt | undefined {
  return [...receipts]
    .filter((receipt) => receipt.operation === "http_get" || receipt.operation === "http_get_total")
    .toSorted((left, right) => Date.parse(right.finishedAt) - Date.parse(left.finishedAt))[0];
}

function resultFromReceipts(
  candidate: Candidate,
  checkedAt: number,
  intervalMs: number,
  receipts: readonly ApiCallReceipt[],
  error?: unknown,
): FinanceSourceHeartbeatRecord {
  const receipt = latestNetworkReceipt(receipts);
  const outcomeReceipt =
    receipt ??
    [...receipts]
      .filter((item) => item.operation === "provider_heartbeat")
      .toSorted((left, right) => Date.parse(right.finishedAt) - Date.parse(left.finishedAt))[0];
  const transportError = outcomeReceipt?.transportError;
  const errorKind = error instanceof ApiCallError ? error.kind : undefined;
  const kind = transportError ?? errorKind ?? (error ? "source_error" : undefined);
  const httpStatus =
    outcomeReceipt?.httpStatus ?? (error instanceof ApiCallError ? error.httpStatus : undefined);
  const networkCode =
    outcomeReceipt?.networkCode ?? (error instanceof ApiCallError ? error.networkCode : undefined);
  const status: FinanceSourceHeartbeatStatus =
    kind === "cancelled"
      ? "unknown"
      : !error && outcomeReceipt?.status === "succeeded" && receipt?.dataAccess?.kind !== "cache"
        ? "healthy"
        : kind === "budget_exhausted" ||
            kind === "forbidden" ||
            kind === "rate_limited" ||
            (httpStatus !== undefined && httpStatus >= 400 && httpStatus < 500)
          ? "degraded"
          : "unhealthy";
  const reason: FinanceSourceHeartbeatReason =
    receipt?.dataAccess?.kind === "cache"
      ? "cache_only"
      : httpStatus === 403 && (transportError === "http_error" || errorKind === "http_error")
        ? "forbidden"
        : httpStatus === 429 && (transportError === "http_error" || errorKind === "http_error")
          ? "rate_limited"
          : ((kind as FinanceSourceHeartbeatReason | undefined) ??
            (!error && outcomeReceipt?.status === "succeeded" ? "ok" : "source_error"));
  const latencyMs = Math.max(0, outcomeReceipt?.latencyMs ?? Date.now() - checkedAt);
  const baseCheckDelayMs =
    status === "healthy" ? intervalMs : FINANCE_SOURCE_HEARTBEAT_FAILURE_INTERVAL_MS;
  const retryAfterMs =
    outcomeReceipt?.retryAfterMs ??
    (error instanceof ApiCallError ? error.retryAfterMs : undefined);
  const boundedRetryAfterMs =
    typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs >= 0
      ? Math.min(retryAfterMs, FINANCE_SOURCE_HEARTBEAT_MAX_TIMER_MS)
      : 0;
  const nextCheckMs = checkedAt + Math.max(baseCheckDelayMs, boundedRetryAfterMs);
  let accessScope: FinanceSourceHeartbeatRecord["accessScope"];
  if (receipt?.dispatchedAt && [401, 402, 403].includes(httpStatus ?? 0)) {
    try {
      const fingerprint =
        candidate.kind === "collection"
          ? (candidate.adapter as FinanceMarketCollectionAdapter).accessScopeForRequest?.(
              candidate.request as FinanceMarketCollectionRequest,
            )
          : (candidate.adapter as FinanceRealtimeSourceAdapter).accessScopeForRequest?.(
              candidate.request as FinanceRealtimeSourceRequest,
            );
      const scope = { version: 1, fingerprint };
      if (isFinanceSourceAccessScope(scope)) {
        accessScope = scope;
      }
    } catch {
      // Unknown request identity must not create a durable access denial.
    }
  }
  return {
    provider: candidate.provider,
    providerName: candidate.providerName,
    adapterId: candidate.adapterId,
    checkedAt: new Date(checkedAt).toISOString(),
    nextCheckAt: new Date(nextCheckMs).toISOString(),
    status,
    reason,
    latencyMs,
    attempts: Math.max(0, ...receipts.map((item) => item.attempt)),
    ...(accessScope ? { accessScope } : {}),
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    ...(networkCode ? { networkCode } : {}),
    ...(transportError ? { transportError } : {}),
    ...(typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs >= 0
      ? { retryAfterMs }
      : {}),
  };
}

function registryOptions(env: NodeJS.ProcessEnv, fetchImpl?: FetchImpl) {
  return {
    realtime: {
      ...resolveFinanceRealtimeSourceRegistryOptionsFromEnv(env),
      fetchImpl,
    },
    collection: {
      ...resolveFinanceMarketCollectionRegistryOptionsFromEnv(env),
      fetchImpl,
    },
  };
}

/** Build a bounded inventory without dispatching any network request. */
export function planFinanceSourceHeartbeat(
  options: Pick<
    HeartbeatOptions,
    | "env"
    | "directory"
    | "workspaceDir"
    | "asOf"
    | "adapterId"
    | "fetchImpl"
    | "realtimeAdapters"
    | "collectionAdapters"
  > = {},
): FinanceSourceHeartbeatPlan {
  const env = options.env ?? process.env;
  const asOf = options.asOf ?? new Date().toISOString();
  const configured = registryOptions(
    options.env ??
      resolveFinanceCredentialEnv({
        ...env,
        LCX_FINANCE_STATE_DIR: resolveFinanceStateDir(options).directory,
      }),
    options.fetchImpl,
  );
  const realtimeAdapters =
    options.realtimeAdapters ?? createFinanceRealtimeSourceRegistry(configured.realtime);
  const collectionAdapters =
    options.collectionAdapters ?? createFinanceMarketCollectionRegistry(configured.collection);
  const candidates = selectCandidates(
    asOf,
    realtimeAdapters,
    collectionAdapters,
    options.adapterId,
  );
  return {
    networkCalled: false,
    asOf,
    ...(options.adapterId ? { adapterId: options.adapterId } : {}),
    providerCount: candidates.length,
    candidates: candidates.map(({ provider, providerName, adapterId, kind }) => ({
      provider,
      providerName,
      adapterId,
      kind,
    })),
  };
}

/**
 * Rotate at most one supported representative per provider per due interval; retain endpoint history.
 * Successful financial-statement probes also feed the existing fundamental store.
 * Callers must opt into this function for network activity; the source-health read path remains
 * strictly local and calls `readFinanceSourceHeartbeat` instead.
 */
export async function runFinanceSourceHeartbeat(options: HeartbeatOptions = {}) {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const checkedAt = now();
  const asOf = options.asOf ?? new Date(checkedAt).toISOString();
  const timeoutMs = options.timeoutMs ?? 15_000;
  const intervalMs = options.intervalMs ?? FINANCE_SOURCE_HEARTBEAT_DEFAULT_INTERVAL_MS;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > FINANCE_SOURCE_HEARTBEAT_MAX_TIMER_MS
  ) {
    throw new Error(
      `heartbeat timeoutMs must be a positive safe integer no greater than ${FINANCE_SOURCE_HEARTBEAT_MAX_TIMER_MS}`,
    );
  }
  if (
    !Number.isSafeInteger(intervalMs) ||
    intervalMs <= 0 ||
    intervalMs > FINANCE_SOURCE_HEARTBEAT_MAX_TIMER_MS
  ) {
    throw new Error(
      `heartbeat intervalMs must be a positive safe integer no greater than ${FINANCE_SOURCE_HEARTBEAT_MAX_TIMER_MS}`,
    );
  }
  const stateDir = resolveFinanceStateDir(options).directory;
  const configured = registryOptions(
    options.env ??
      resolveFinanceCredentialEnv({
        ...env,
        LCX_FINANCE_STATE_DIR: resolveFinanceStateDir(options).directory,
      }),
    options.fetchImpl,
  );
  const realtimeAdapters =
    options.realtimeAdapters ?? createFinanceRealtimeSourceRegistry(configured.realtime);
  const collectionAdapters =
    options.collectionAdapters ?? createFinanceMarketCollectionRegistry(configured.collection);
  let candidates = selectCandidates(asOf, realtimeAdapters, collectionAdapters, options.adapterId);
  const requestedConcurrency = options.maxSourceConcurrency ?? 4;
  if (
    !Number.isSafeInteger(requestedConcurrency) ||
    requestedConcurrency < 1 ||
    requestedConcurrency > 8
  ) {
    throw new Error("heartbeat maxSourceConcurrency must be an integer between 1 and 8");
  }
  const maxSourceConcurrency = Math.min(requestedConcurrency, Math.max(1, candidates.length));
  const maxLockHoldMs = Math.max(
    60_000,
    Math.ceil(candidates.length / maxSourceConcurrency) * timeoutMs + 30_000,
  );
  if (
    !Number.isSafeInteger(maxLockHoldMs) ||
    maxLockHoldMs > FINANCE_SOURCE_HEARTBEAT_MAX_TIMER_MS
  ) {
    throw new Error("heartbeat maximum probe duration exceeds the supported timer bound");
  }
  const releaseLock = await acquireFinanceSourceHeartbeatLock(stateDir, maxLockHoldMs);
  try {
    const previous = await readFinanceSourceHeartbeat({ directory: stateDir });
    const endpointRecords: Record<string, FinanceSourceHeartbeatRecord> = {
      ...Object.fromEntries(
        Object.values(previous.records).map((record) => [record.adapterId, record]),
      ),
      ...previous.endpointRecords,
    };
    candidates = selectCandidates(
      asOf,
      realtimeAdapters,
      collectionAdapters,
      options.adapterId,
      endpointRecords,
      checkedAt,
    );
    const collectionWrites: {
      adapterId: string;
      status: "stored" | "failed" | "empty";
      snapshotId?: string;
      recordCount: number;
    }[] = [];
    const due = candidates.filter((candidate) => {
      if (options.force) {
        return true;
      }
      const previousRecord = previous.records[candidate.provider];
      if (!previousRecord) {
        return true;
      }
      if (previousRecord.reason === "rate_limited") {
        return Date.parse(previousRecord.nextCheckAt) <= checkedAt;
      }
      if (previousRecord.adapterId !== candidate.adapterId) {
        return (
          Date.parse(previousRecord.checkedAt) + intervalMs <= checkedAt &&
          Date.parse(endpointRecords[candidate.adapterId]?.nextCheckAt ?? "1970-01-01") <= checkedAt
        );
      }
      return Date.parse(previousRecord.nextCheckAt) <= checkedAt;
    });
    const skippedProviders = candidates
      .filter((candidate) => !due.includes(candidate))
      .map((candidate) => candidate.provider);
    const results = await mapFinanceSourceLanes(
      due,
      async (candidate): Promise<ProbeResult> => {
        const receipts: ApiCallReceipt[] = [];
        try {
          if (options.signal?.aborted) {
            throw new ApiCallError("cancelled");
          }
          await withFinanceQuotaLane("diagnostics", async () => {
            const governance = options.sourceGovernance?.forSource(candidate.adapterId);
            await runApiSourceCall(
              {
                provider: candidate.provider,
                source: candidate.adapterId,
                operation: "provider_heartbeat",
                timeoutMs,
                ...(options.signal ? { signal: options.signal } : {}),
                retry: { attempts: 1 },
                cacheMaxAgeMs: 0,
                authScopeLabel: "configured_read_only",
                ...(governance
                  ? {
                      rateLimiter: governance.rateLimiter,
                      circuitBreaker: governance.circuitBreaker,
                    }
                  : {}),
                onReceipt: (receipt) => receipts.push(receipt),
              },
              (signal) =>
                candidate.kind === "realtime"
                  ? (candidate.adapter as FinanceRealtimeSourceAdapter)
                      .collect(candidate.request as FinanceRealtimeSourceRequest, signal)
                      .then(() => undefined)
                  : (candidate.adapter as FinanceMarketCollectionAdapter)
                      .collect(candidate.request as FinanceMarketCollectionRequest, signal)
                      .then((records) => {
                        const request = candidate.request as FinanceMarketCollectionRequest;
                        if (request.collection !== "financial_statements") {
                          return;
                        }
                        if (!records.length) {
                          collectionWrites.push({
                            adapterId: candidate.adapterId,
                            status: "empty",
                            recordCount: 0,
                          });
                          return;
                        }
                        try {
                          const snapshotId = appendFinanceFundamentalSnapshot({
                            directory: stateDir,
                            sourceId: candidate.adapterId,
                            capturedAt: new Date(now()).toISOString(),
                            receipt: {
                              schemaVersion: FINANCE_MARKET_COLLECTION_SCHEMA_VERSION,
                              refreshId: `heartbeat:${candidate.adapterId}:${asOf}`,
                              boundary: "finance_market_collection_research_only",
                              request,
                              status: "needs_review",
                              records,
                              sourceAttempts: [],
                              selectedSourceIds: [candidate.adapterId],
                              missingEvidence: ["heartbeat_collection_not_research_assessment"],
                              requiredNextSteps: [],
                              adaptersCalled: true,
                              notTouched: ["trading"],
                            },
                          });
                          collectionWrites.push({
                            adapterId: candidate.adapterId,
                            status: "stored",
                            snapshotId,
                            recordCount: records.length,
                          });
                        } catch {
                          collectionWrites.push({
                            adapterId: candidate.adapterId,
                            status: "failed",
                            recordCount: records.length,
                          });
                        }
                      }),
            );
          });
          return {
            provider: candidate.provider,
            record: resultFromReceipts(candidate, checkedAt, intervalMs, receipts),
          };
        } catch (error) {
          return {
            provider: candidate.provider,
            record: resultFromReceipts(candidate, checkedAt, intervalMs, receipts, error),
          };
        }
      },
      maxSourceConcurrency,
    );
    const records: Record<string, FinanceSourceHeartbeatRecord> = { ...previous.records };
    for (const result of results) {
      const prior = endpointRecords[result.record.adapterId];
      const failures =
        result.record.status === "healthy"
          ? 0
          : Math.min(13, (prior?.status === "healthy" ? 0 : (prior?.consecutiveFailures ?? 0)) + 1);
      // Keep provider Retry-After and quota reset authoritative; repeated failures
      // must not consume the same diagnostic budget every five minutes forever.
      const delay =
        result.record.reason === "forbidden" ||
        [401, 402, 403].includes(result.record.httpStatus ?? 0)
          ? 6 * 60 * 60_000
          : Math.min(
              60 * 60_000,
              FINANCE_SOURCE_HEARTBEAT_FAILURE_INTERVAL_MS * 2 ** Math.max(0, failures - 1),
            );
      records[result.provider] = {
        ...result.record,
        consecutiveFailures: failures,
        ...(collectionWrites.find((write) => write.adapterId === result.record.adapterId)
          ? {
              collectionWrite: collectionWrites.find(
                (write) => write.adapterId === result.record.adapterId,
              ),
            }
          : {}),
        nextCheckAt:
          failures === 0
            ? result.record.nextCheckAt
            : new Date(
                Math.max(Date.parse(result.record.nextCheckAt), checkedAt + delay),
              ).toISOString(),
      };
      endpointRecords[result.record.adapterId] = records[result.provider];
    }
    const state = await persistFinanceSourceHeartbeat(
      stateDir,
      records,
      checkedAt,
      endpointRecords,
    );
    return {
      schemaVersion: FINANCE_SOURCE_HEARTBEAT_SCHEMA_VERSION,
      networkCalled: due.length > 0,
      asOf,
      ...(options.adapterId ? { adapterId: options.adapterId } : {}),
      state,
      collectionWrites,
      endpointCoverage: {
        checkedEndpointCount: Object.keys(endpointRecords).length,
        scope: "registered_representative_requests_only" as const,
      },
      checkedProviders: due.map((candidate) => candidate.provider),
      skippedProviders,
      providerCount: candidates.length,
      healthyCount: due.filter((candidate) => records[candidate.provider]?.status === "healthy")
        .length,
      degradedCount: due.filter((candidate) => records[candidate.provider]?.status === "degraded")
        .length,
      unhealthyCount: due.filter((candidate) => records[candidate.provider]?.status === "unhealthy")
        .length,
      unknownCount: due.filter((candidate) => records[candidate.provider]?.status === "unknown")
        .length,
    };
  } finally {
    await releaseLock();
  }
}

export function heartbeatErrorText(error: unknown): string {
  return apiSourceErrorText(error);
}
