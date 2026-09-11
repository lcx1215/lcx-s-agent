import { createHash } from "node:crypto";
import { ApiCallError, type ApiFetch, type ApiFetchResponse } from "./api-call-contract.js";
import { FINANCE_SOURCE_QUOTA_POLICIES } from "./finance-source-quota-policy.js";

type Entry = { body: string; fetchedAt: number; expiresAt: number; bytes: number };

/** Cache lifetimes are reuse policies, not provider limits or source freshness guarantees. */
export function financeResponseLifetime(url: string): number {
  const parsed = new URL(url);
  if (!FINANCE_SOURCE_QUOTA_POLICIES.some((policy) => policy.hosts.includes(parsed.hostname))) {
    return 0;
  }
  if (/company_tickers|exchangeInfo|companyfacts|submissions|\/profile/u.test(parsed.pathname)) {
    return 15 * 60_000;
  }
  if (/news|rss|\/doc\//iu.test(parsed.pathname)) {
    return 60_000;
  }
  if (
    /fred|bls|treasury/u.test(parsed.hostname) ||
    /history|candles|klines|time_series/iu.test(parsed.pathname) ||
    /TIME_SERIES/u.test(parsed.searchParams.get("function") ?? "")
  ) {
    return 60_000;
  }
  return 5_000;
}

function cacheable(body: string): boolean {
  if (!body.trim() || /^\s*(?:<!doctype html|<html)/iu.test(body)) {
    return false;
  }
  if (/^\s*[{[]/u.test(body)) {
    try {
      const value: unknown = JSON.parse(body);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const record = value as Record<string, unknown>;
        if (
          ["error", "Error Message", "Information", "Note"].some((key) =>
            Array.isArray(record[key]) ? record[key].length > 0 : Boolean(record[key]),
          )
        ) {
          return false;
        }
        if (record.status === "error" || (record.retCode !== undefined && record.retCode !== 0)) {
          return false;
        }
        if (record.chart && typeof record.chart === "object" && "error" in record.chart) {
          return !record.chart.error;
        }
      }
    } catch {
      return false;
    }
  }
  return true;
}

async function waitForRead(pending: Promise<void>, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  let abort: () => void = () => {};
  try {
    await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        abort = () => reject(new ApiCallError("cancelled"));
        signal?.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

/** Bounded process-local reuse across adapters. No response bodies or credentials go to disk. */
export function createFinanceResponseCache(
  options: { maxBytes?: number; maxEntries?: number; now?: () => number } = {},
) {
  const maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
  const maxEntries = options.maxEntries ?? 256;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0 ||
    !Number.isSafeInteger(maxEntries) ||
    maxEntries <= 0
  ) {
    throw new Error("cache bounds must be positive integers");
  }
  const now = options.now ?? Date.now;
  const entries = new Map<string, Entry>();
  const pending = new Map<string, Promise<void>>();
  let bytes = 0;
  let hits = 0;
  let misses = 0;
  let joined = 0;
  const remove = (key: string) => {
    bytes -= entries.get(key)?.bytes ?? 0;
    entries.delete(key);
  };
  function wrap(fetch: ApiFetch, namespace = "text"): ApiFetch {
    const requestKey = (url: string, headers?: Record<string, string>) =>
      createHash("sha256")
        .update(
          JSON.stringify([
            namespace,
            url,
            Object.entries(headers ?? {}).toSorted(([a], [b]) => a.localeCompare(b)),
          ]),
        )
        .digest("hex");
    const hasCachedResponse: NonNullable<ApiFetch["hasCachedResponse"]> = (url, init) => {
      const cached = entries.get(requestKey(url, init?.headers));
      const age = cached ? now() - cached.fetchedAt : Infinity;
      return (
        cached !== undefined &&
        now() < cached.expiresAt &&
        age >= 0 &&
        age < Math.min(financeResponseLifetime(url), init?.cacheMaxAgeMs ?? Infinity)
      );
    };
    const prepare: NonNullable<ApiFetch["prepare"]> = async (url, init) => {
      const maxAge = init?.cacheMaxAgeMs;
      if (maxAge !== undefined && (!Number.isFinite(maxAge) || maxAge < 0)) {
        throw new ApiCallError("source_error");
      }
      const lifetime = Math.min(financeResponseLifetime(url), maxAge ?? Infinity);
      if (lifetime === 0) {
        return fetch.prepare ? fetch.prepare(url, init) : fetch;
      }
      // Include credentials in the hash to isolate accounts, but retain neither URLs nor headers.
      const key = requestKey(url, init?.headers);
      while (pending.has(key)) {
        joined++;
        await waitForRead(pending.get(key)!, init?.signal);
      }
      init?.signal?.throwIfAborted();
      const cached = entries.get(key);
      const age = cached ? now() - cached.fetchedAt : Infinity;
      if (cached && now() < cached.expiresAt && age >= 0 && age < lifetime) {
        hits++;
        entries.delete(key);
        entries.set(key, cached);
        const read: ApiFetch = async () => ({
          ok: true,
          status: 200,
          text: async () => cached.body,
          dataAccess: {
            kind: "cache",
            fetchedAt: new Date(cached.fetchedAt).toISOString(),
            ageMs: age,
          },
        });
        return Object.assign(read, { skipsHttpDispatch: true });
      }
      if (cached) {
        remove(key);
      }
      misses++;
      let release!: () => void;
      pending.set(
        key,
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      );
      let released = false;
      const unlock = () => {
        if (!released) {
          released = true;
          pending.delete(key);
          release();
        }
      };
      let dispatch: ApiFetch;
      try {
        dispatch = fetch.prepare ? await fetch.prepare(url, init) : fetch;
      } catch (error) {
        unlock();
        throw error;
      }
      let started = false;
      const cancelPreparation = async () => {
        if (!started) {
          try {
            await dispatch.cancelPreparation?.();
          } finally {
            unlock();
          }
        }
      };
      const send: ApiFetch = async () => {
        if (init?.signal?.aborted) {
          await cancelPreparation();
          init.signal.throwIfAborted();
        }
        started = true;
        try {
          const response = await dispatch(url, init);
          const body = await response.text();
          init?.signal?.throwIfAborted();
          const fetchedAt = now();
          const size = Buffer.byteLength(body);
          const cacheControl = response.headers?.get("cache-control") ?? "";
          const maxAgeMatch = /(?:^|,)\s*max-age="?(\d+)/iu.exec(cacheControl);
          const responseAge = Number(response.headers?.get("age") ?? 0);
          const serverLifetime = maxAgeMatch
            ? Math.max(
                0,
                Number(maxAgeMatch[1]) * 1_000 -
                  (Number.isFinite(responseAge) ? responseAge * 1_000 : 0),
              )
            : lifetime;
          const expiresAt = fetchedAt + Math.min(lifetime, serverLifetime);
          if (
            response.ok &&
            response.status === 200 &&
            size <= maxBytes &&
            expiresAt > fetchedAt &&
            response.headers?.get("vary") !== "*" &&
            !/no-store|no-cache/iu.test(cacheControl) &&
            cacheable(body)
          ) {
            while (entries.size >= maxEntries || bytes + size > maxBytes) {
              remove(entries.keys().next().value!);
            }
            entries.set(key, { body, fetchedAt, expiresAt, bytes: size });
            bytes += size;
          }
          return {
            ...response,
            text: async () => body,
            dataAccess: { kind: "network", fetchedAt: new Date(fetchedAt).toISOString(), ageMs: 0 },
          } satisfies ApiFetchResponse;
        } finally {
          unlock();
        }
      };
      return Object.assign(send, { cancelPreparation });
    };
    return Object.assign<ApiFetch, Pick<ApiFetch, "prepare" | "hasCachedResponse">>(
      async (url, init) => (await prepare(url, init))(url, init),
      { prepare, hasCachedResponse },
    );
  }
  return {
    wrap,
    inspect: () => ({
      scope: "process_local" as const,
      entries: entries.size,
      bytes,
      maxBytes,
      maxEntries,
      hits,
      misses,
      joined,
      inFlight: pending.size,
    }),
  };
}

export const financeResponseCache = createFinanceResponseCache();
