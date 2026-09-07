import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { retryAsync, type RetryConfig } from "../infra/retry.js";

/** Labels only: never include credentials, URLs, headers, bodies or raw errors. */
export type ApiAuthScopeLabel = "public" | "configured_read_only" | "unspecified";
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
  transportError?: "network_error" | "http_error" | "timeout" | "cancelled" | "source_error";
  timeoutMs: number;
  retryAfterMs?: number;
  rateLimited?: boolean;
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
  onReceipt?: (receipt: ApiCallReceipt) => void;
};
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
      authScopeLabel:
        options.authScopeLabel === "public" || options.authScopeLabel === "configured_read_only"
          ? options.authScopeLabel
          : "unspecified",
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
    let lastAttemptStatus: ApiCallReceipt["status"] | undefined;
    const emitAttempt = (receipt: ApiCallReceipt) => {
      lastAttemptStatus = receipt.status;
      scope.onReceipt?.(receipt);
    };
    // One total budget covers attempts and backoff, not a fresh budget for each retry.
    return boundedCall(
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
        return retryAsync(
          async () => {
            signal.throwIfAborted();
            const details: { -readonly [K in keyof ApiCallReceipt]?: ApiCallReceipt[K] } = {
              attempt: ++attempt,
            };
            return boundedCall(
              { ...scope, signal, onReceipt: emitAttempt },
              async (attemptSignal) => {
                let response: ApiFetchResponse;
                let body: string;
                try {
                  response = await fetchImpl(url, { ...init, signal: attemptSignal });
                  details.httpStatus = response.status;
                  details.retryAfterMs = parseApiRetryAfter(response.headers?.get("retry-after"));
                  details.rateLimited = response.status === 429;
                  body = await response.text();
                } catch {
                  attemptSignal.throwIfAborted();
                  throw new ApiCallError("network_error");
                }
                if (!response.ok) {
                  throw new ApiCallError("http_error", response.status, details.retryAfterMs);
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
      },
    );
  };
}
