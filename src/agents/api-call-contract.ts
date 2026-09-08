import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { retryAsync, type RetryConfig } from "../infra/retry.js";

/** Labels only: never include credentials, URLs, headers, bodies or raw errors. */
export type ApiAuthScopeLabel = "public" | "configured_read_only" | "unspecified";
export type ApiCircuitState = "closed" | "open" | "half_open";
export type ApiCallReceipt = Readonly<{
  schemaVersion: "lcx_api_call_v1";
  callId: string;
  correlationId: string;
  provider: string;
  source: string;
  operation: string;
  startedAt: string;
  finishedAt: string;
  latencyMs: number;
  attempt: number;
  status: "succeeded" | "failed" | "timed_out" | "cancelled";
  httpStatus?: number;
  transportError?:
    | "network_error"
    | "http_error"
    | "forbidden"
    | "rate_limited"
    | "timeout"
    | "cancelled"
    | "circuit_open"
    | "source_error"
    | "budget_exhausted";
  timeoutMs: number;
  circuitState: ApiCircuitState;
  retryAfterMs?: number;
  rateLimited?: boolean;
  throttleWaitMs?: number;
  authScopeLabel: ApiAuthScopeLabel;
  quota?: { remaining?: number; limit?: number };
  cost?: { amount: number; currency: string };
  idempotencyKey?: string;
}>;

export type ApiTransportOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  correlationId?: string;
  retry?: RetryConfig;
  authScopeLabel?: ApiAuthScopeLabel;
  idempotencyKey?: string;
  circuitBreaker?: ApiCircuitBreaker;
  rateLimiter?: ApiRateLimiter;
  onReceipt?: (receipt: ApiCallReceipt) => void;
  /** Synchronous reservation immediately before each actual HTTP attempt. */
  beforeHttpDispatch?: () => void;
};

export type ApiCircuitBreaker = Readonly<{
  beforeRequest: () => ApiCircuitState;
  recordSuccess: () => void;
  recordFailure: () => void;
}>;

export function createApiCircuitBreaker(
  options: {
    failureThreshold?: number;
    resetAfterMs?: number;
  } = {},
): ApiCircuitBreaker {
  const failureThreshold = options.failureThreshold ?? 3;
  const resetAfterMs = options.resetAfterMs ?? 30_000;
  if (!Number.isSafeInteger(failureThreshold) || failureThreshold <= 0) {
    throw new Error("failureThreshold must be a positive integer");
  }
  if (!Number.isFinite(resetAfterMs) || resetAfterMs <= 0) {
    throw new Error("resetAfterMs must be positive");
  }
  let failures = 0;
  let openedAt: number | undefined;
  let halfOpen = false;
  return {
    beforeRequest: () => {
      if (openedAt === undefined) {
        return "closed";
      }
      if (Date.now() - openedAt < resetAfterMs) {
        return "open";
      }
      if (halfOpen) {
        return "open";
      }
      halfOpen = true;
      return "half_open";
    },
    recordSuccess: () => {
      failures = 0;
      openedAt = undefined;
      halfOpen = false;
    },
    recordFailure: () => {
      if (halfOpen) {
        halfOpen = false;
        openedAt = Date.now();
        return;
      }
      failures += 1;
      if (failures >= failureThreshold) {
        openedAt = Date.now();
      }
    },
  };
}
export type ApiFetchResponse = {
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  text: () => Promise<string>;
};
export type ApiFetch = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<ApiFetchResponse>;

type CallContext = ApiTransportOptions & {
  provider: string;
  source: string;
  operation: string;
};
const context = new AsyncLocalStorage<CallContext>();

export class ApiCallError extends Error {
  constructor(
    readonly kind: NonNullable<ApiCallReceipt["transportError"]>,
    readonly httpStatus?: number,
    readonly retryAfterMs?: number,
  ) {
    super(httpStatus === undefined ? `API ${kind}` : `API http status ${httpStatus}`);
    this.name = "ApiCallError";
  }
}

export type ApiRateLimiterPermit = Readonly<{
  waitMs: number;
  release: () => void;
}>;

export type ApiRateLimiter = Readonly<{
  acquire: (signal?: AbortSignal) => Promise<ApiRateLimiterPermit>;
}>;

/**
 * Bounded per-source scheduler. It intentionally slows callers down instead
 * of retrying a provider that is already protecting its public endpoint.
 */
export function createApiRateLimiter(
  options: {
    minIntervalMs?: number;
    maxConcurrent?: number;
    maxQueue?: number;
  } = {},
): ApiRateLimiter {
  const minIntervalMs = options.minIntervalMs ?? 250;
  const maxConcurrent = options.maxConcurrent ?? 1;
  const maxQueue = options.maxQueue ?? 64;
  if (!Number.isFinite(minIntervalMs) || minIntervalMs < 0) {
    throw new Error("minIntervalMs must be a non-negative number");
  }
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent <= 0) {
    throw new Error("maxConcurrent must be a positive integer");
  }
  if (!Number.isSafeInteger(maxQueue) || maxQueue <= 0) {
    throw new Error("maxQueue must be a positive integer");
  }

  type Waiter = {
    enqueuedAt: number;
    signal?: AbortSignal;
    resolve: (permit: ApiRateLimiterPermit) => void;
    reject: (error: ApiCallError) => void;
    onAbort?: () => void;
  };
  const queue: Waiter[] = [];
  let active = 0;
  let nextStartAt = 0;
  let drainTimer: ReturnType<typeof setTimeout> | undefined;

  const schedule = () => {
    if (drainTimer !== undefined || queue.length === 0 || active >= maxConcurrent) {
      return;
    }
    const waitMs = Math.max(0, nextStartAt - Date.now());
    if (waitMs > 0) {
      drainTimer = setTimeout(() => {
        drainTimer = undefined;
        drain();
      }, waitMs);
      drainTimer.unref?.();
      return;
    }
    drain();
  };

  const drain = () => {
    if (queue.length === 0 || active >= maxConcurrent) {
      return;
    }
    const now = Date.now();
    if (nextStartAt > now) {
      schedule();
      return;
    }
    const waiter = queue.shift();
    if (!waiter) {
      return;
    }
    if (waiter.signal?.aborted) {
      waiter.reject(new ApiCallError("cancelled"));
      drain();
      return;
    }
    waiter.signal?.removeEventListener("abort", waiter.onAbort!);
    active += 1;
    nextStartAt = Date.now() + minIntervalMs;
    let released = false;
    waiter.resolve({
      waitMs: Math.max(0, Date.now() - waiter.enqueuedAt),
      release: () => {
        if (released) {
          return;
        }
        released = true;
        active = Math.max(0, active - 1);
        schedule();
      },
    });
    schedule();
  };

  return Object.freeze({
    acquire: (signal?: AbortSignal) => {
      if (signal?.aborted) {
        return Promise.reject(new ApiCallError("cancelled"));
      }
      if (queue.length >= maxQueue) {
        return Promise.reject(new ApiCallError("rate_limited"));
      }
      return new Promise<ApiRateLimiterPermit>((resolve, reject) => {
        const waiter: Waiter = {
          enqueuedAt: Date.now(),
          signal,
          resolve,
          reject,
        };
        waiter.onAbort = () => {
          const index = queue.indexOf(waiter);
          if (index >= 0) {
            queue.splice(index, 1);
            reject(new ApiCallError("cancelled"));
            schedule();
          }
        };
        signal?.addEventListener("abort", waiter.onAbort, { once: true });
        queue.push(waiter);
        schedule();
      });
    },
  });
}

export type ApiSourceGovernance = Readonly<{
  rateLimiter: ApiRateLimiter;
  circuitBreaker: ApiCircuitBreaker;
}>;

export type ApiSourceGovernanceRegistry = Readonly<{
  forSource: (sourceKey: string) => ApiSourceGovernance;
}>;

/** Reusable source-scoped state for repeated, bounded live refreshes. */
export function createApiSourceGovernanceRegistry(
  options: {
    minIntervalMs?: number;
    maxConcurrent?: number;
    maxQueue?: number;
    failureThreshold?: number;
    resetAfterMs?: number;
  } = {},
): ApiSourceGovernanceRegistry {
  const states = new Map<string, ApiSourceGovernance>();
  return Object.freeze({
    forSource: (sourceKey: string) => {
      const key = sourceKey.trim();
      if (!key) {
        throw new Error("sourceKey required");
      }
      const existing = states.get(key);
      if (existing) {
        return existing;
      }
      const state = Object.freeze({
        rateLimiter: createApiRateLimiter(options),
        circuitBreaker: createApiCircuitBreaker(options),
      });
      states.set(key, state);
      return state;
    },
  });
}

export function apiSourceErrorText(error: unknown): string {
  if (error instanceof ApiCallError) {
    return error.message;
  }
  const message = error instanceof Error ? error.message : "";
  return /^\d{3}$/u.test(message) ? message : "source_error";
}

export function parseApiRetryAfter(
  value: string | null | undefined,
  now = Date.now(),
): number | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) ? Math.max(0, delay) : undefined;
}

/** Observe a bounded operation and abort the actual work before rejecting the wait. */
async function boundedCall<T>(
  options: CallContext,
  operation: (signal: AbortSignal) => Promise<T>,
  details: Partial<ApiCallReceipt> = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("timeoutMs must be a positive number");
  }
  const started = Date.now();
  const controller = new AbortController();
  let settled = false;
  const finish = (error?: unknown, failed = true) => {
    if (settled) {
      return;
    }
    settled = true;
    const kind = error instanceof ApiCallError ? error.kind : failed ? "source_error" : undefined;
    const receipt: ApiCallReceipt = {
      schemaVersion: "lcx_api_call_v1",
      callId: randomUUID(),
      correlationId: options.correlationId ?? randomUUID(),
      provider: options.provider,
      source: options.source,
      operation: options.operation,
      startedAt: new Date(started).toISOString(),
      finishedAt: new Date().toISOString(),
      latencyMs: Math.max(0, Date.now() - started),
      attempt: 1,
      timeoutMs,
      circuitState: details.circuitState ?? "closed",
      authScopeLabel:
        options.authScopeLabel === "public" || options.authScopeLabel === "configured_read_only"
          ? options.authScopeLabel
          : "unspecified",
      ...(options.idempotencyKey?.trim() ? { idempotencyKey: options.idempotencyKey.trim() } : {}),
      ...details,
      status:
        kind === "timeout"
          ? "timed_out"
          : kind === "cancelled"
            ? "cancelled"
            : failed
              ? "failed"
              : "succeeded",
      ...(kind ? { transportError: kind } : {}),
    };
    try {
      options.onReceipt?.(receipt);
    } catch {
      // Observer failure must not prevent aborting HTTP or change its outcome.
    }
  };
  let rejectAbort: (error: ApiCallError) => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const abort = (kind: "timeout" | "cancelled") => {
    const error = new ApiCallError(kind);
    controller.abort(error);
    finish(error);
    rejectAbort(error);
  };
  // A nested call preserves timeout classification while discarding arbitrary parent reasons.
  const parentAbort = () =>
    abort(
      options.signal?.reason instanceof ApiCallError && options.signal.reason.kind === "timeout"
        ? "timeout"
        : "cancelled",
    );
  const timer = setTimeout(() => abort("timeout"), timeoutMs);
  options.signal?.addEventListener("abort", parentAbort, { once: true });
  try {
    if (options.signal?.aborted) {
      parentAbort();
    }
    const result = await Promise.race([
      aborted,
      Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return operation(controller.signal);
      }),
    ]);
    finish(undefined, false);
    return result;
  } catch (error) {
    finish(error);
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", parentAbort);
  }
}

/** Compatibility bridge: existing collect(request, signal) adapters keep their API. */
export function runApiSourceCall<T>(
  options: CallContext,
  collect: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const resolved = { ...options, correlationId: options.correlationId ?? randomUUID() };
  return boundedCall(resolved, (signal) =>
    context.run({ ...resolved, signal }, () => collect(signal)),
  );
}

/** GET-only transport. Read the body within the deadline so slow bodies also abort. */
export function governApiFetch(fetchImpl: ApiFetch, options: ApiTransportOptions = {}): ApiFetch {
  return async (url, init) => {
    const inherited = context.getStore();
    const signals = [inherited?.signal, options.signal, init?.signal].filter(
      (signal): signal is AbortSignal => signal !== undefined,
    );
    const scope: CallContext = {
      provider: "http",
      source: "public-source",
      ...inherited,
      ...options,
      correlationId: options.correlationId ?? inherited?.correlationId ?? randomUUID(),
      operation: "http_get",
      signal: signals.length ? AbortSignal.any(signals) : undefined,
    };
    const circuitState = scope.circuitBreaker?.beforeRequest() ?? "closed";
    if (circuitState === "open") {
      return boundedCall(
        { ...scope, operation: "http_get", onReceipt: scope.onReceipt },
        async () => {
          throw new ApiCallError("circuit_open");
        },
        { circuitState },
      );
    }
    let lastAttemptStatus: ApiCallReceipt["status"] | undefined;
    const emitAttempt = (receipt: ApiCallReceipt) => {
      lastAttemptStatus = receipt.status;
      scope.onReceipt?.(receipt);
    };
    // One total budget covers attempts and backoff, not a fresh budget for each retry.
    const result = boundedCall(
      {
        ...scope,
        operation: "http_get_total",
        onReceipt: (receipt) => {
          // Cancellation before dispatch or during backoff has no active HTTP attempt.
          if (
            (receipt.status === "cancelled" || receipt.status === "timed_out") &&
            lastAttemptStatus !== "cancelled" &&
            lastAttemptStatus !== "timed_out"
          ) {
            scope.onReceipt?.(receipt);
          }
        },
      },
      async (signal) => {
        let attempt = 0;
        try {
          const response = await retryAsync(
            async () => {
              signal.throwIfAborted();
              const details: { -readonly [K in keyof ApiCallReceipt]?: ApiCallReceipt[K] } = {
                attempt: ++attempt,
                circuitState,
              };
              return boundedCall(
                { ...scope, signal, onReceipt: emitAttempt },
                async (attemptSignal) => {
                  let response: ApiFetchResponse;
                  let body: string;
                  let permit: ApiRateLimiterPermit | undefined;
                  try {
                    permit = await scope.rateLimiter?.acquire(attemptSignal);
                    if (permit !== undefined) {
                      details.throttleWaitMs = permit.waitMs;
                    }
                    attemptSignal.throwIfAborted();
                    scope.beforeHttpDispatch?.();
                    response = await fetchImpl(url, { ...init, signal: attemptSignal });
                    details.httpStatus = response.status;
                    details.retryAfterMs = parseApiRetryAfter(response.headers?.get("retry-after"));
                    details.rateLimited = response.status === 429;
                    body = await response.text();
                  } catch (error) {
                    attemptSignal.throwIfAborted();
                    if (error instanceof ApiCallError) {
                      throw error;
                    }
                    throw new ApiCallError("network_error");
                  } finally {
                    permit?.release();
                  }
                  if (!response.ok) {
                    throw new ApiCallError(
                      response.status === 403 ? "forbidden" : "http_error",
                      response.status,
                      details.retryAfterMs,
                    );
                  }
                  return {
                    ok: response.ok,
                    status: response.status,
                    headers: response.headers,
                    text: async () => body,
                  };
                },
                details,
              );
            },
            {
              attempts: 2,
              minDelayMs: 300,
              maxDelayMs: 30_000,
              ...scope.retry,
              jitter: 0,
              shouldRetry: (error) =>
                !signal.aborted &&
                error instanceof ApiCallError &&
                error.kind === "http_error" &&
                [408, 429, 500, 502, 503, 504].includes(error.httpStatus ?? 0) &&
                // Never shorten a server's Retry-After to the local backoff cap.
                (error.retryAfterMs === undefined ||
                  error.retryAfterMs <= (scope.retry?.maxDelayMs ?? 30_000)),
              retryAfterMs: (error) =>
                error instanceof ApiCallError ? error.retryAfterMs : undefined,
            },
          );
          scope.circuitBreaker?.recordSuccess();
          return response;
        } catch (error) {
          if (
            error instanceof ApiCallError &&
            (error.kind === "network_error" ||
              error.kind === "http_error" ||
              error.kind === "forbidden")
          ) {
            scope.circuitBreaker?.recordFailure();
          }
          throw error;
        }
      },
      { circuitState },
    );
    return result;
  };
}
