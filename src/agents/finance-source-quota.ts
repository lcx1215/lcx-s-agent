import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { withFileLock } from "../infra/file-lock.js";
import {
  ApiCallError,
  currentApiCallContext,
  parseApiRetryAfter,
  type ApiFetch,
} from "./api-call-contract.js";
import {
  classifyFinanceQuotaBody,
  financeLaneAllowance,
  financeQuotaDayWindow,
  FINANCE_QUOTA_DEFAULT_LANE,
  FINANCE_QUOTA_LANES,
  FINANCE_QUOTA_LANE_SHARES,
  FINANCE_SOURCE_QUOTA_POLICIES,
  isFinanceQuotaLane,
  type FinanceQuotaLane,
  type FinanceQuotaPolicy,
} from "./finance-source-quota-policy.js";
import {
  financeQuotaProbesDir,
  financeQuotaStateDir,
  resolveFinanceStateDir,
} from "./finance-state-dir.js";

/** `lane`/`source` are absent on pre-attribution files; they are never required to read a book. */
type QuotaEvent = {
  at: number;
  weight: number;
  reservationId?: string;
  lane?: FinanceQuotaLane;
  source?: string;
  fromReserve?: boolean;
};
type QuotaState = {
  schemaVersion: 1;
  events: QuotaEvent[];
  nextStartAt: number;
  blockedUntil: number;
  importedProbeFiles?: string[];
  tokens?: number;
  tokenUpdatedAt?: number;
  serverBudget?: { remaining: number; resetAt: number; observedAt: number };
};
const serial = new Map<string, Promise<void>>();
const minute = 60_000;
const day = 86_400_000;

const laneContext = new AsyncLocalStorage<FinanceQuotaLane>();

/**
 * Declare which purpose the calls inside `operation` serve.
 *
 * This is the "record it where you use it" half of quota allocation: the adapter that spends a
 * credit names the budget it spends from, so a diagnostics sweep can be capped without capping
 * production, and a spent credit can be attributed afterwards. Anything not wrapped is treated
 * as `production` -- the loop's own work is the default, not an escape hatch.
 */
export function withFinanceQuotaLane<T>(lane: FinanceQuotaLane, operation: () => Promise<T>) {
  return laneContext.run(lane, operation);
}

/** Window cutoffs are shared by the per-window accounting and the per-lane accounting. */
function windowCutoff(window: { durationMs: number; alignment?: "utc_day" }, time: number) {
  return window.alignment === "utc_day" ? Math.floor(time / day) * day : time - window.durationMs;
}

function spendByLane(events: readonly QuotaEvent[], cutoff: number): Record<string, number> {
  const spend: Record<string, number> = {};
  for (const event of events) {
    if (event.at < cutoff) {
      continue;
    }
    const lane = event.lane ?? FINANCE_QUOTA_DEFAULT_LANE;
    spend[lane] = (spend[lane] ?? 0) + event.weight;
  }
  return spend;
}

async function exclusive<T>(file: string, operation: () => Promise<T>): Promise<T> {
  const previous = serial.get(file) ?? Promise.resolve();
  let release!: () => void;
  const done = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = previous.then(() => done);
  serial.set(file, pending);
  await previous;
  try {
    return await withFileLock(
      file,
      { retries: { retries: 40, factor: 1, minTimeout: 25, maxTimeout: 25 }, stale: 30_000 },
      operation,
    );
  } finally {
    release();
    if (serial.get(file) === pending) {
      serial.delete(file);
    }
  }
}

function retention(policy: FinanceQuotaPolicy): number {
  return Math.max(minute, ...policy.windows.map((window) => window.durationMs));
}

/** A window limits credits, not necessarily HTTP requests. Unknown expensive routes fail closed. */
function requestWeight(policy: FinanceQuotaPolicy, url: URL): number {
  if (policy.id === "twelve_data") {
    if (
      !["/quote", "/time_series", "/sma", "/ema", "/rsi", "/macd", "/bbands", "/atr"].includes(
        url.pathname,
      )
    ) {
      throw new ApiCallError("budget_exhausted");
    }
    return Math.max(1, (url.searchParams.get("symbol") ?? "").split(",").length);
  }
  if (policy.id === "binance") {
    if (url.pathname === "/api/v3/ticker/price") {
      return url.searchParams.has("symbol") ? 2 : 4;
    }
    if (url.pathname === "/api/v3/klines") {
      return 2;
    }
    if (url.pathname === "/api/v3/exchangeInfo") {
      return 20;
    }
    throw new ApiCallError("budget_exhausted");
  }
  return 1;
}

/** Shared local-process and cross-process quota state; no credentials or request URLs are stored. */
/**
 * A policy is configuration, and a degenerate one used to surface as a hang rather than as an error.
 *
 * Measured: `tokenBucket.refillPerSecond: 0` made the wait `Infinity` — a bucket that never refills
 * can never admit a call it has already spent, so the guard waited forever (Node clamps the timer and
 * the loop keeps asking). A non-finite `minIntervalMs`, window `durationMs` or window `limit` turned
 * the pacing arithmetic into `NaN` instead. And `windows: []` with no token bucket admitted every
 * call: the guard ran, applied no constraint, and reported success eight times out of eight.
 *
 * `retention()` above already treats an empty `windows` as a case needing its own fallback
 * (`Math.max(minute, ...)`), so "no windows" is not a supported way to declare "no limits" — and
 * neither is a bucket that cannot refill. Validate once at construction so the failure is a readable
 * configuration error instead of an unbounded wait at call time.
 */
function assertUsablePolicy(policy: FinanceQuotaPolicy): void {
  const unusable = (what: string) => new Error(`quota policy ${policy.id} is unusable: ${what}`);
  if (!Number.isFinite(policy.minIntervalMs) || policy.minIntervalMs < 0) {
    throw unusable("minIntervalMs must be a non-negative number");
  }
  for (const window of policy.windows) {
    if (!Number.isFinite(window.durationMs) || window.durationMs <= 0) {
      throw unusable("window.durationMs must be a positive number");
    }
    if (!Number.isFinite(window.limit) || window.limit < 0) {
      throw unusable("window.limit must be a non-negative number");
    }
  }
  if (policy.tokenBucket) {
    if (!Number.isFinite(policy.tokenBucket.capacity) || policy.tokenBucket.capacity < 0) {
      throw unusable("tokenBucket.capacity must be a non-negative number");
    }
    if (
      !Number.isFinite(policy.tokenBucket.refillPerSecond) ||
      policy.tokenBucket.refillPerSecond <= 0
    ) {
      throw unusable("tokenBucket.refillPerSecond must be a positive number");
    }
  }
  // Deliberately NOT required: a window or a bucket. A policy with `windows: []` is a supported
  // declaration -- "governed by the venue cooldown, not by a window" -- and the Bybit cooldown test
  // relies on it. An earlier version of this check demanded one and broke that case, which is why the
  // tests are the judge here rather than my reading of the shape.
}

export function createFinanceQuotaGuard(
  options: {
    stateDir?: string;
    policies?: readonly FinanceQuotaPolicy[];
    now?: () => number;
  } = {},
) {
  const stateDir = options.stateDir ?? resolveFinanceStateDir().directory;
  const policies = options.policies ?? FINANCE_SOURCE_QUOTA_POLICIES;
  for (const policy of policies) {
    assertUsablePolicy(policy);
  }
  const now = options.now ?? Date.now;
  const directory = financeQuotaStateDir(stateDir);

  async function read(file: string, policy: FinanceQuotaPolicy): Promise<QuotaState> {
    let state: QuotaState = {
      schemaVersion: 1,
      events: [],
      nextStartAt: 0,
      blockedUntil: 0,
      importedProbeFiles: [],
    };
    try {
      const data = JSON.parse(await fs.readFile(file, "utf8")) as QuotaState;
      if (
        data.schemaVersion !== 1 ||
        !Array.isArray(data.events) ||
        data.events.some(
          (event) =>
            !Number.isFinite(event.at) || !Number.isFinite(event.weight) || event.weight <= 0,
        ) ||
        data.events.some(
          (event) =>
            (event.lane !== undefined && !isFinanceQuotaLane(event.lane)) ||
            (event.source !== undefined && typeof event.source !== "string") ||
            (event.fromReserve !== undefined && typeof event.fromReserve !== "boolean"),
        ) ||
        !Number.isFinite(data.nextStartAt) ||
        !Number.isFinite(data.blockedUntil) ||
        (data.importedProbeFiles !== undefined &&
          (!Array.isArray(data.importedProbeFiles) ||
            data.importedProbeFiles.some((name) => typeof name !== "string"))) ||
        (data.tokens !== undefined && (!Number.isFinite(data.tokens) || data.tokens < 0)) ||
        (data.tokenUpdatedAt !== undefined && !Number.isFinite(data.tokenUpdatedAt)) ||
        (data.serverBudget !== undefined &&
          (!Number.isFinite(data.serverBudget.remaining) ||
            data.serverBudget.remaining < 0 ||
            !Number.isFinite(data.serverBudget.resetAt) ||
            !Number.isFinite(data.serverBudget.observedAt)))
      ) {
        throw new Error("invalid quota state");
      }
      state = data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new ApiCallError("budget_exhausted");
      }
    }
    // Bring this session's real measurements into the budget instead of resetting usage at rollout.
    const probeDir = financeQuotaProbesDir(stateDir);
    const names = await fs.readdir(probeDir).catch(() => [] as string[]);
    const seen = new Set<string>();
    state.importedProbeFiles ??= [];
    for (const name of names.filter(
      (name) =>
        name.endsWith(`-${policy.provider}.json`) && !state.importedProbeFiles?.includes(name),
    )) {
      let probe;
      try {
        probe = JSON.parse(await fs.readFile(path.join(probeDir, name), "utf8"));
      } catch {
        continue;
      }
      if (
        probe.schemaVersion !== "lcx_finance_quota_probe_v1" ||
        probe.provider !== policy.provider ||
        !Array.isArray(probe.observations)
      ) {
        continue;
      }
      state.importedProbeFiles.push(name);
      // DOC and static title downloads have separate hosts and limits.
      if (
        (policy.id === "gdelt_titles" && probe.adapterId !== "gdelt_public_news_titles") ||
        (policy.id === "gdelt_doc" && probe.adapterId === "gdelt_public_news_titles") ||
        (policy.id === "fred_public" && probe.adapterId !== "fred_public_index_history") ||
        (policy.id === "fred" && probe.adapterId === "fred_public_index_history")
      ) {
        continue;
      }
      for (const observation of probe.observations) {
        if (!Array.isArray(observation?.calls)) {
          continue;
        }
        for (const call of observation.calls) {
          const at = Date.parse(call?.startedAt);
          if (
            call?.operation !== "http_get" ||
            typeof call.callId !== "string" ||
            seen.has(call.callId) ||
            !Number.isFinite(at) ||
            at > now() ||
            at <= now() - retention(policy)
          ) {
            continue;
          }
          seen.add(call.callId);
          // Probe files are written by the limit probe, which is measurement rather than the
          // loop's own work. Importing them as unlabelled would bill them to `production` and
          // then cap production for a sweep's spending.
          state.events.push({
            at,
            weight: policy.id === "binance" ? 2 : 1,
            lane: "diagnostics",
            source: typeof probe.adapterId === "string" ? probe.adapterId : undefined,
          });
          if (call.rateLimited || observation.bodyRateLimited) {
            const cooldown = policy.id === "alpha_vantage" ? day : minute;
            state.blockedUntil = Math.max(state.blockedUntil, at + (call.retryAfterMs ?? cooldown));
          }
        }
      }
    }
    state.events.sort((left, right) => left.at - right.at);
    return state;
  }

  async function mutate<T>(
    policy: FinanceQuotaPolicy,
    operation: (state: QuotaState) => T,
    signal?: AbortSignal,
  ): Promise<T> {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const file = path.join(await fs.realpath(directory), `${policy.id}.json`);
    return exclusive(file, async () => {
      signal?.throwIfAborted();
      const state = await read(file, policy);
      state.events = state.events.filter((event) => event.at > now() - retention(policy));
      const result = operation(state);
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
        await fs.rename(temporary, file);
      } finally {
        await fs.rm(temporary, { force: true });
      }
      return result;
    });
  }

  async function reserve(
    policy: FinanceQuotaPolicy,
    weight: number,
    signal?: AbortSignal,
  ): Promise<() => Promise<void>> {
    const reservationId = randomUUID();
    let reservedAt = 0;
    let serverResetAt: number | undefined;
    for (;;) {
      signal?.throwIfAborted();
      let usedReserve = false;
      const waitMs = await mutate(
        policy,
        (state) => {
          const time = now();
          const lane = laneContext.getStore() ?? FINANCE_QUOTA_DEFAULT_LANE;
          if (state.blockedUntil > time) {
            throw new ApiCallError("budget_exhausted", undefined, state.blockedUntil - time);
          }
          let wait = Math.max(0, state.nextStartAt - time);
          if (
            state.serverBudget &&
            state.serverBudget.resetAt > time &&
            state.serverBudget.remaining < weight
          ) {
            throw new ApiCallError(
              "budget_exhausted",
              undefined,
              state.serverBudget.resetAt - time,
            );
          }
          for (const window of policy.windows) {
            const cutoff =
              window.alignment === "utc_day"
                ? Math.floor(time / day) * day
                : time - window.durationMs;
            const events = state.events.filter((event) => event.at >= cutoff);
            const used = events.reduce((sum, event) => sum + event.weight, 0);
            if (weight > window.limit) {
              throw new ApiCallError("budget_exhausted");
            }
            if (used + weight > window.limit) {
              let remaining = used;
              let resetAt = cutoff + window.durationMs;
              for (const event of events) {
                remaining -= event.weight;
                resetAt =
                  window.alignment === "utc_day" ? cutoff + day : event.at + window.durationMs + 1;
                if (remaining + weight <= window.limit) {
                  break;
                }
              }
              if (window.durationMs >= day) {
                throw new ApiCallError("budget_exhausted", undefined, resetAt - time);
              }
              wait = Math.max(wait, resetAt - time);
            }
          }
          // Per-lane allocation. Only providers whose budget actually runs out (a day-scale
          // window) are split; minute-scale windows pace throughput and have nothing to divide.
          const dayWindow = financeQuotaDayWindow(policy);
          if (dayWindow) {
            const cutoff = windowCutoff(dayWindow, time);
            const inDay = state.events.filter((event) => event.at >= cutoff);
            const spend = spendByLane(state.events, cutoff);
            const allowance = financeLaneAllowance({
              dayLimit: dayWindow.limit,
              lane,
              usedByLane: spend,
            });
            const usedByThisLane = spend[lane] ?? 0;
            if (!allowance.uncontended && usedByThisLane + weight > allowance.own) {
              const reserveUsed = inDay
                .filter((event) => event.fromReserve === true)
                .reduce((sum, event) => sum + event.weight, 0);
              // Marginal need, not cumulative: `reserveUsed` already counts everything this
              // lane previously borrowed, so adding the cumulative overspend to it would
              // charge each borrowed credit twice and cut the reserve in half.
              const need =
                Math.max(0, usedByThisLane + weight - allowance.own) -
                Math.max(0, usedByThisLane - allowance.own);
              if (reserveUsed + need > allowance.reserve) {
                const refusal = new ApiCallError(
                  "budget_exhausted",
                  undefined,
                  Math.max(1, cutoff + dayWindow.durationMs - time),
                );
                // Name the lane and the numbers. "budget_exhausted" on its own reads as
                // "this source is out of credits", which is a different claim than
                // "your sweep spent the diagnostics share" -- and the first one gets
                // believed, silently, all the way down the pipeline.
                refusal.message =
                  `API budget_exhausted: lane "${lane}" has spent ${usedByThisLane}/${allowance.own}` +
                  ` of ${policy.id}'s day budget and the shared reserve is spent` +
                  ` (${reserveUsed}/${allowance.reserve} used, other lanes active)`;
                throw refusal;
              }
              usedReserve = need > 0;
            }
          }
          if (policy.tokenBucket) {
            const { capacity, refillPerSecond } = policy.tokenBucket;
            const tokens = Math.min(
              capacity,
              (state.tokens ?? capacity) +
                (Math.max(0, time - (state.tokenUpdatedAt ?? time)) * refillPerSecond) / 1_000,
            );
            state.tokens = tokens;
            state.tokenUpdatedAt = time;
            if (tokens < weight) {
              wait = Math.max(wait, Math.ceil(((weight - tokens) * 1_000) / refillPerSecond));
            }
          }
          if (wait > 0) {
            return wait;
          }
          if (state.serverBudget && state.serverBudget.resetAt > time) {
            state.serverBudget.remaining -= weight;
            serverResetAt = state.serverBudget.resetAt;
          }
          reservedAt = time;
          state.events.push({
            at: time,
            weight,
            reservationId,
            lane,
            source: currentApiCallContext().source,
            ...(usedReserve ? { fromReserve: true } : {}),
          });
          state.nextStartAt = time + policy.minIntervalMs;
          if (state.tokens !== undefined) {
            state.tokens -= weight;
          }
          return 0;
        },
        signal,
      );
      if (!waitMs) {
        return async () => {
          await mutate(policy, (state) => {
            if (!state.events.some((event) => event.reservationId === reservationId)) {
              return;
            }
            state.events = state.events.filter((event) => event.reservationId !== reservationId);
            if (state.nextStartAt === reservedAt + policy.minIntervalMs) {
              state.nextStartAt = Math.max(
                0,
                ...state.events.map((event) => event.at + policy.minIntervalMs),
              );
            }
            if (state.tokens !== undefined && policy.tokenBucket) {
              state.tokens = Math.min(policy.tokenBucket.capacity, state.tokens + weight);
            }
            if (state.serverBudget && state.serverBudget.resetAt === serverResetAt) {
              state.serverBudget.remaining += weight;
            }
          });
        };
      }
      await delay(waitMs, undefined, { signal });
    }
  }

  function wrap(fetch: ApiFetch) {
    const prepare: NonNullable<ApiFetch["prepare"]> = async (url, init) => {
      const parsed = new URL(url);
      const policy = policies.find((candidate) => candidate.hosts.includes(parsed.hostname));
      if (!policy) {
        return fetch;
      }
      const release = await reserve(policy, requestWeight(policy, parsed), init?.signal);
      let dispatched = false;
      const cancelPreparation = async () => {
        if (!dispatched) {
          await release();
        }
      };
      const dispatch: ApiFetch = async () => {
        if (init?.signal?.aborted) {
          await cancelPreparation();
          init.signal.throwIfAborted();
        }
        dispatched = true;
        const response = await fetch(url, init);
        const observedAt = now();
        const retryAfterMs = parseApiRetryAfter(response.headers?.get("retry-after"), observedAt);
        const rawRemaining =
          response.headers?.get("x-ratelimit-remaining") ??
          response.headers?.get("api-credits-left");
        const remaining =
          rawRemaining?.trim() && /^\d+$/u.test(rawRemaining) ? Number(rawRemaining) : undefined;
        const rawReset = response.headers?.get("x-ratelimit-reset");
        const resetAt =
          rawReset?.trim() && /^\d+$/u.test(rawReset)
            ? Number(rawReset) * 1_000
            : policy.id === "twelve_data"
              ? (Math.floor(observedAt / minute) + 1) * minute
              : undefined;
        const rateCooldown =
          retryAfterMs ??
          (policy.tokenBucket ? Math.ceil(1_000 / policy.tokenBucket.refillPerSecond) + 1 : minute);
        await mutate(policy, (state) => {
          if (response.status === 429) {
            state.blockedUntil = Math.max(state.blockedUntil, observedAt + rateCooldown);
          }
          if (policy.id === "bybit" && response.status === 403) {
            state.blockedUntil = Math.max(state.blockedUntil, observedAt + 10 * minute);
          }
          if (policy.id === "binance" && response.status === 418) {
            state.blockedUntil = Math.max(
              state.blockedUntil,
              observedAt + (retryAfterMs ?? 2 * minute),
            );
          }
          if (remaining !== undefined && policy.tokenBucket) {
            state.tokens = Math.min(state.tokens ?? remaining, remaining);
            state.tokenUpdatedAt = observedAt;
          }
          if (!policy.tokenBucket && remaining !== undefined && resetAt && resetAt > observedAt) {
            const previous = state.serverBudget;
            state.serverBudget = {
              remaining:
                previous?.resetAt === resetAt ? Math.min(previous.remaining, remaining) : remaining,
              resetAt,
              observedAt,
            };
          }
          if (!policy.tokenBucket && remaining === 0 && resetAt && resetAt > observedAt) {
            state.blockedUntil = Math.max(state.blockedUntil, resetAt + 1);
          }
        });
        return {
          ...response,
          text: async () => {
            const body = await response.text();
            const bodyLimit = classifyFinanceQuotaBody(body);
            if (bodyLimit) {
              const cooldown =
                bodyLimit === "daily" ? day : bodyLimit === "monthly" ? 31 * day : rateCooldown;
              await mutate(policy, (state) => {
                state.blockedUntil = Math.max(state.blockedUntil, now() + cooldown);
              });
              if (response.ok) {
                throw new ApiCallError("rate_limited", response.status, cooldown);
              }
            }
            return body;
          },
        };
      };
      return Object.assign(dispatch, { cancelPreparation });
    };
    const wrapped: ApiFetch = async (url, init) => (await prepare(url, init))(url, init);
    return Object.assign(wrapped, { prepare });
  }
  async function inspect() {
    return Promise.all(
      policies.map(async (policy) => {
        const base = {
          id: policy.id,
          provider: policy.provider,
          basis: policy.basis,
          documentation: policy.documentation,
          minIntervalMs: policy.minIntervalMs,
          tokenBucket: policy.tokenBucket,
          accountingScope: "shared_local_state_not_other_devices_or_clients" as const,
        };
        try {
          const state = await read(path.join(directory, `${policy.id}.json`), policy);
          const time = now();
          const windows = policy.windows.map((window) => {
            const cutoff =
              window.alignment === "utc_day"
                ? Math.floor(time / day) * day
                : time - window.durationMs;
            const used = state.events
              .filter((event) => event.at >= cutoff)
              .reduce((sum, event) => sum + event.weight, 0);
            let nextAvailableAt = time;
            if (used >= window.limit) {
              let remaining = used;
              for (const event of state.events
                .filter((event) => event.at >= cutoff)
                .toSorted((a, b) => a.at - b.at)) {
                remaining -= event.weight;
                nextAvailableAt =
                  window.alignment === "utc_day" ? cutoff + day : event.at + window.durationMs + 1;
                if (remaining < window.limit) {
                  break;
                }
              }
            }
            return {
              ...window,
              nextAvailableAt: new Date(nextAvailableAt).toISOString(),
              locallyCountedUsage: used,
              localRemaining: Math.max(0, window.limit - used),
            };
          });
          const dayWindow = financeQuotaDayWindow(policy);
          const lanes = (() => {
            if (!dayWindow) {
              return [];
            }
            const cutoff = windowCutoff(dayWindow, time);
            const inDay = state.events.filter((event) => event.at >= cutoff);
            const spend = spendByLane(state.events, cutoff);
            const totalUsed = inDay.reduce((sum, event) => sum + event.weight, 0);
            const reserveUsed = inDay
              .filter((event) => event.fromReserve === true)
              .reduce((sum, event) => sum + event.weight, 0);
            return FINANCE_QUOTA_LANES.map((lane) => {
              const allowance = financeLaneAllowance({
                dayLimit: dayWindow.limit,
                lane,
                usedByLane: spend,
              });
              const used = spend[lane] ?? 0;
              return {
                lane,
                used,
                share: FINANCE_QUOTA_LANE_SHARES[lane],
                own: allowance.own,
                reserveAvailable: Math.max(0, allowance.reserve - reserveUsed),
                uncontended: allowance.uncontended,
                remaining: allowance.uncontended
                  ? Math.max(0, dayWindow.limit - totalUsed)
                  : Math.max(0, allowance.own - used) +
                    Math.max(0, allowance.reserve - reserveUsed),
              };
            });
          })();
          const availableTokens = policy.tokenBucket
            ? Math.min(
                policy.tokenBucket.capacity,
                (state.tokens ?? policy.tokenBucket.capacity) +
                  (Math.max(0, time - (state.tokenUpdatedAt ?? time)) *
                    policy.tokenBucket.refillPerSecond) /
                    1_000,
              )
            : undefined;
          const nextAllowed = Math.max(
            time,
            state.blockedUntil,
            state.nextStartAt,
            ...windows.map((window) => Date.parse(window.nextAvailableAt)),
            state.serverBudget && state.serverBudget.remaining < 1
              ? state.serverBudget.resetAt
              : time,
            policy.tokenBucket && availableTokens !== undefined && availableTokens < 1
              ? time +
                  Math.ceil(((1 - availableTokens) * 1_000) / policy.tokenBucket.refillPerSecond)
              : time,
          );
          return {
            ...base,
            availableTokens,
            nextAllowedAt: new Date(nextAllowed).toISOString(),
            nextAllowedBasis: "one_credit_local_estimate_recheck_at_dispatch" as const,
            state:
              state.blockedUntil > time
                ? "cooldown"
                : windows.some((window) => window.localRemaining === 0) ||
                    (state.serverBudget &&
                      state.serverBudget.resetAt > time &&
                      state.serverBudget.remaining < 1)
                  ? "quota_exhausted"
                  : nextAllowed > time
                    ? "waiting"
                    : "within_local_budget",
            blockedUntil:
              state.blockedUntil > time ? new Date(state.blockedUntil).toISOString() : undefined,
            serverBudget:
              state.serverBudget && state.serverBudget.resetAt > time
                ? state.serverBudget
                : undefined,
            windows,
            lanes,
          };
        } catch {
          return { ...base, state: "quota_state_unreadable", windows: [], lanes: [] };
        }
      }),
    );
  }
  return { wrap, inspect };
}

/** Created lazily so a fresh process uses its current configured state directory. */
export function governFinanceQuota(fetch: ApiFetch): ApiFetch {
  const wrapped: ApiFetch = async (url, init) => createFinanceQuotaGuard().wrap(fetch)(url, init);
  wrapped.prepare = async (url, init) => createFinanceQuotaGuard().wrap(fetch).prepare(url, init);
  return wrapped;
}
