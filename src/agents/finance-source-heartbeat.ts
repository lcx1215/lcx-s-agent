import {
  ApiCallError,
  apiSourceErrorText,
  runApiSourceCall,
  type ApiCallReceipt,
  type ApiSourceGovernanceRegistry,
} from "./api-call-contract.js";
import type { FetchImpl } from "./finance-live-market-source.js";
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
            limit: 1,
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
): Candidate[] {
  const candidates = [
    ...realtimeAdapters.map((adapter) => candidateForAdapter(adapter, "realtime", asOf)),
    ...collectionAdapters.map((adapter) => candidateForAdapter(adapter, "collection", asOf)),
  ]
    .filter((candidate): candidate is Candidate => candidate !== undefined)
    .toSorted(
      (left, right) =>
        left.adapter.priority - right.adapter.priority ||
        left.adapterId.localeCompare(right.adapterId),
    );
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
    "env" | "asOf" | "fetchImpl" | "realtimeAdapters" | "collectionAdapters"
  > = {},
): FinanceSourceHeartbeatPlan {
  const env = options.env ?? process.env;
  const asOf = options.asOf ?? new Date().toISOString();
  const configured = registryOptions(env, options.fetchImpl);
  const candidates = selectCandidates(
    asOf,
    options.realtimeAdapters ?? createFinanceRealtimeSourceRegistry(configured.realtime),
    options.collectionAdapters ?? createFinanceMarketCollectionRegistry(configured.collection),
  );
  return {
    networkCalled: false,
    asOf,
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
 * Probe at most one cheap representative per provider and persist only a redacted liveness record.
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
  const configured = registryOptions(env, options.fetchImpl);
  const candidates = selectCandidates(
    asOf,
    options.realtimeAdapters ?? createFinanceRealtimeSourceRegistry(configured.realtime),
    options.collectionAdapters ?? createFinanceMarketCollectionRegistry(configured.collection),
  );
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
    const due = candidates.filter((candidate) => {
      if (options.force) {
        return true;
      }
      const previousRecord = previous.records[candidate.provider];
      return !previousRecord || Date.parse(previousRecord.nextCheckAt) <= checkedAt;
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
                      .then(() => undefined),
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
      const prior = previous.records[result.provider];
      const failures =
        result.record.status === "healthy"
          ? 0
          : Math.min(13, (prior?.status === "healthy" ? 0 : (prior?.consecutiveFailures ?? 0)) + 1);
      // Keep provider Retry-After and quota reset authoritative; repeated failures
      // must not consume the same diagnostic budget every five minutes forever.
      const delay =
        result.record.reason === "forbidden"
          ? 6 * 60 * 60_000
          : Math.min(
              60 * 60_000,
              FINANCE_SOURCE_HEARTBEAT_FAILURE_INTERVAL_MS * 2 ** Math.max(0, failures - 1),
            );
      records[result.provider] = {
        ...result.record,
        consecutiveFailures: failures,
        nextCheckAt:
          failures === 0
            ? result.record.nextCheckAt
            : new Date(
                Math.max(Date.parse(result.record.nextCheckAt), checkedAt + delay),
              ).toISOString(),
      };
    }
    const state = await persistFinanceSourceHeartbeat(stateDir, records, checkedAt);
    return {
      schemaVersion: FINANCE_SOURCE_HEARTBEAT_SCHEMA_VERSION,
      networkCalled: due.length > 0,
      asOf,
      state,
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
