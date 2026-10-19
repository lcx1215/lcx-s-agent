import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { requireNodeSqlite } from "../memory/sqlite.js";
import { resolveProcessScopedMap } from "../shared/process-scoped-map.js";
import { isAlpacaTradeExecutionType } from "./finance-alpaca-activity-contract.js";
import { createAlpacaSafetyReadTransport } from "./finance-alpaca-safety-transport.js";
import { caseflowFingerprint } from "./finance-caseflow.js";
import { financeHistoryInstant } from "./finance-history-sync-coverage.js";
import {
  appendFinanceBrokerHistory,
  reduceFinanceBrokerHistoryRecords,
} from "./finance-position-ledger.js";
import type { FinanceUncachedFetch } from "./finance-write-transport.js";

export type AlpacaHistoryOptions = {
  directory: string;
  accountId: string;
  after: string;
  until: string;
  credentials: { keyId: string; secretKey: string };
  read?: FinanceUncachedFetch;
  signal?: AbortSignal;
  maxPages?: number;
};

const activeSyncs = resolveProcessScopedMap<true>(Symbol.for("lcx.alpacaHistoryActiveSyncs"));
const host = "https://paper-api.alpaca.markets";
function instant(value: string) {
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error("history window requires explicit timezone");
  }
  return Date.parse(value);
}

/** Raw facts only: no inferred fees, fill completion, holdings, or reconciliation authority. */
export async function syncAlpacaPaperHistory(options: AlpacaHistoryOptions) {
  const after = instant(options.after);
  const until = instant(options.until);
  if (after >= until || until > Date.now() || !options.accountId.trim()) {
    throw new Error("invalid history account/window");
  }
  const maxPages = options.maxPages ?? 100;
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 1000) {
    throw new Error("invalid history page budget");
  }
  options.signal?.throwIfAborted();
  await fs.mkdir(options.directory, { recursive: true, mode: 0o700 });
  const lockKey = path.join(await fs.realpath(options.directory), "alpaca-history-sync");
  // Reject local overlap consistently across module copies and directory aliases.
  if (activeSyncs.has(lockKey)) {
    throw new Error("history sync already in progress");
  }
  activeSyncs.set(lockKey, true);
  try {
    // A dedicated SQLite write transaction supplies the cross-process OS lock.
    // It survives suspension without age-based eviction and releases automatically on exit.
    const { DatabaseSync } = requireNodeSqlite();
    const lock = new DatabaseSync(`${lockKey}.sqlite`);
    try {
      lock.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE;");
      return await syncAlpacaPaperHistoryOnTurn(options, after, maxPages);
    } finally {
      lock.close();
    }
  } finally {
    activeSyncs.delete(lockKey);
  }
}

async function syncAlpacaPaperHistoryOnTurn(
  options: AlpacaHistoryOptions,
  after: number,
  maxPages: number,
) {
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(120_000)])
    : AbortSignal.timeout(120_000);
  const read = options.read ?? createAlpacaSafetyReadTransport();
  const get = async (url: string): Promise<unknown> => {
    signal.throwIfAborted();
    const response = await read(url, {
      headers: {
        "APCA-API-KEY-ID": options.credentials.keyId,
        "APCA-API-SECRET-KEY": options.credentials.secretKey,
      },
      signal,
    });
    signal.throwIfAborted();
    if (response.status !== 200) {
      throw new Error(`history GET status ${response.status}`);
    }
    return JSON.parse(response.body);
  };
  const account = await get(`${host}/v2/account`);
  if (
    !account ||
    typeof account !== "object" ||
    !("id" in account) ||
    account.id !== options.accountId
  ) {
    throw new Error("history account identity mismatch");
  }
  const createdAt = "created_at" in account ? account.created_at : undefined;
  const inception = financeHistoryInstant(createdAt);
  const accountCreatedAt = Number.isFinite(inception) ? new Date(inception).toISOString() : null;
  // Invalidate the old completion before this attempt can persist any new pages.
  // An opaque attempt identity also prevents append deduplication from hiding retries.
  const syncId = randomUUID();
  const appendSyncReceipt = (payload: Record<string, unknown>) =>
    appendFinanceBrokerHistory(
      options.directory,
      {
        kind: "broker_history",
        accountId: options.accountId,
        venue: "alpaca:paper",
        query: `sync_receipt:${options.after}:${options.until}`,
        cursor: "",
        payload: [{ ...payload, syncId, accountCreatedAt }],
      },
      { signal },
    );
  await appendSyncReceipt({
    accountId: options.accountId,
    venue: "alpaca:paper",
    after: options.after,
    until: options.until,
    status: "incomplete",
    streams: [],
    positionsReconciled: false,
    executionReceiptsCreated: 0,
  });
  const streams: Array<{
    stream: string;
    complete: boolean;
    pages: number;
    appended: number;
    reason?: string;
  }> = [];
  for (const stream of ["orders", "activities"] as const) {
    signal.throwIfAborted();
    let cursor = "";
    let pages = 0;
    let appended = 0;
    let complete = false;
    let reason: string | undefined;
    const cursors = new Set<string>();
    try {
      for (; pages < maxPages; ) {
        const url = new URL(`${host}/v2/${stream === "orders" ? "orders" : "account/activities"}`);
        url.searchParams.set("after", stream === "orders" && cursor ? cursor : options.after);
        url.searchParams.set("until", options.until);
        url.searchParams.set("direction", "asc");
        if (stream === "orders") {
          url.searchParams.set("status", "all");
          url.searchParams.set("limit", "500");
          url.searchParams.set("nested", "true");
        } else {
          url.searchParams.set("page_size", "100");
          if (cursor) {
            url.searchParams.set("page_token", cursor);
          }
        }
        const raw = await get(url.toString());
        if (
          !Array.isArray(raw) ||
          raw.some((row) => !row || typeof row !== "object" || Array.isArray(row))
        ) {
          throw new Error("unsupported history page schema");
        }
        const roots = raw as Record<string, unknown>[];
        const payload = [...roots];
        // Retain the broker's parent/leg relationship and each raw child observation.
        // Pagination still belongs to the endpoint's root rows, never the flattened legs.
        if (stream === "orders") {
          for (let index = 0; index < payload.length; index++) {
            const legs: unknown = payload[index].legs;
            if (legs === undefined || legs === null) {
              continue;
            }
            if (
              !Array.isArray(legs) ||
              legs.some((leg) => !leg || typeof leg !== "object" || Array.isArray(leg)) ||
              payload.length + legs.length > 5_000
            ) {
              throw new Error("unsupported nested order schema");
            }
            payload.push(...(legs as Record<string, unknown>[]));
          }
        }
        for (const [index, row] of payload.entries()) {
          if (typeof row.id !== "string" || !row.id.trim()) {
            throw new Error("history row identity unavailable");
          }
          if (stream === "orders") {
            // Held child orders need not yet have a submission timestamp.
            if (index < roots.length && typeof row.submitted_at !== "string") {
              throw new Error("order timestamp unavailable");
            }
            if (typeof row.submitted_at === "string") {
              instant(row.submitted_at);
            }
          } else {
            if (typeof row.activity_type !== "string" || !row.activity_type.trim()) {
              throw new Error("activity type unavailable");
            }
            if (row.activity_type === "FILL" && !isAlpacaTradeExecutionType(row.type)) {
              throw new Error("trade execution type unavailable");
            }
            if (typeof row.transaction_time === "string") {
              instant(row.transaction_time);
            } else if (
              row.activity_type !== "FILL" &&
              typeof row.date === "string" &&
              /^\d{4}-\d{2}-\d{2}$/.test(row.date) &&
              Number.isFinite(Date.parse(row.date)) &&
              new Date(row.date).toISOString().slice(0, 10) === row.date
            ) {
              // Non-trade activities may carry only a native business date; do not invent time.
            } else {
              throw new Error("activity native time/date unavailable");
            }
          }
        }

        signal.throwIfAborted();
        const saved = await appendFinanceBrokerHistory(
          options.directory,
          {
            kind: "broker_history",
            accountId: options.accountId,
            venue: "alpaca:paper",
            query: `${stream}:${options.after}:${options.until}`,
            cursor,
            payload,
          },
          { signal },
        );
        pages++;
        if (saved.appended) {
          appended++;
        }
        if (roots.length < (stream === "orders" ? 500 : 100)) {
          complete = true;
          break;
        }
        const last = roots.at(-1)!;
        if (stream === "activities") {
          if (typeof last.id !== "string" || !last.id) {
            throw new Error("activity cursor unavailable");
          }
          cursor = last.id;
        } else {
          if (typeof last.submitted_at !== "string") {
            throw new Error("order timestamp cursor unavailable");
          }
          // Overlap the boundary; never skip other orders sharing the final timestamp.
          cursor = new Date(instant(last.submitted_at) - 1).toISOString();
          if (Date.parse(cursor) < after) {
            throw new Error("order cursor cannot advance");
          }
        }
        if (cursors.has(cursor)) {
          throw new Error("history pagination cannot advance; incomplete");
        }
        cursors.add(cursor);
      }
      if (!complete) {
        reason = "page budget exhausted; incomplete";
      }
    } catch (error) {
      // Cancellation is terminal; retain acknowledged transport cleanup errors.
      if (signal.aborted) {
        throw error;
      }
      reason = error instanceof Error ? error.message : "history sync failed";
    }
    streams.push({ stream, complete, pages, appended, ...(reason ? { reason } : {}) });
  }
  const receipt = {
    syncId,
    accountId: options.accountId,
    venue: "alpaca:paper",
    after: options.after,
    until: options.until,
    status: streams.every((item) => item.complete) ? "raw_history_synced" : "incomplete",
    streams,
    positionsReconciled: false,
    executionReceiptsCreated: 0,
  } as const;
  signal.throwIfAborted();
  await appendSyncReceipt({
    ...receipt,
    streams: receipt.streams.map(({ appended: _appended, ...stream }) => stream),
  });
  return receipt;
}

/** Explicit account selection; raw observations are not a broker position snapshot. */
export async function readFinanceBrokerHistory(
  directory: string,
  accountId: string,
  options: { streams?: readonly string[]; signal?: AbortSignal } = {},
) {
  if (!accountId.trim()) {
    throw new Error("history account required");
  }
  const selectedStreams = options.streams ? new Set(options.streams) : undefined;
  const syncState: { latestReceipt: Record<string, unknown> | null } = { latestReceipt: null };
  const latestTimes = new Map<string, number>();
  const factCounts = new Map<string, number>();
  const read = await reduceFinanceBrokerHistoryRecords(
    directory,
    accountId,
    "alpaca:paper",
    new Map<string, { stream: string; fact: Record<string, unknown> }>(),
    (facts, record) => {
      if (record.body.kind !== "broker_history") {
        return facts;
      }
      const stream = record.body.query.split(":", 1)[0];
      if (stream === "sync_receipt") {
        // Verified record order, independent of stream filters and fact deduplication.
        syncState.latestReceipt = record.body.payload.length === 1 ? record.body.payload[0] : null;
      }
      for (const fact of record.body.payload) {
        // Preserve raw revisions in the ledger, but expose one observation per
        // broker identity to research. Orders and activities have separate IDs.
        const nativeId = typeof fact.id === "string" ? fact.id.trim() : "";
        const key =
          (stream === "orders" || stream === "activities") && nativeId
            ? `${stream}:id:${nativeId}`
            : `${stream}:content:${caseflowFingerprint(fact)}`;
        const previousTime = latestTimes.get(key);
        const nextTime = Date.parse(typeof fact.updated_at === "string" ? fact.updated_at : "");
        if (
          previousTime !== undefined &&
          Number.isFinite(previousTime) &&
          (!Number.isFinite(nextTime) || nextTime < previousTime)
        ) {
          continue;
        }
        if (!latestTimes.has(key)) {
          factCounts.set(stream, (factCounts.get(stream) ?? 0) + 1);
        }
        latestTimes.set(key, nextTime);
        if (selectedStreams && !selectedStreams.has(stream)) {
          continue;
        }
        // Reinsertion keeps recently observed identities at the end for bounded
        // history consumers. A stale broker revision must not displace a newer one.
        facts.delete(key);
        facts.set(key, { stream, fact });
      }
      return facts;
    },
    { signal: options.signal },
  );
  return {
    directory,
    accountId,
    venue: "alpaca:paper",
    pageCount: read.recordCount,
    facts: [...read.value.values()],
    latestSyncReceipt: syncState.latestReceipt,
    totalFactCount: latestTimes.size,
    observationCount: latestTimes.size - (factCounts.get("sync_receipt") ?? 0),
    omittedFactCount: latestTimes.size - read.value.size,
    streamScope: selectedStreams ? [...selectedStreams] : null,
    headRef: read.headRef,
    historyStatus: read.recordCount ? "raw_observations_only" : "missing",
    positionsReconciled: false,
    feesInterpreted: false,
  } as const;
}

/** Controller-owned recurring seam: account identity and history start come from the broker. */
export async function syncConfiguredAlpacaPaperHistory(options: {
  directory: string;
  env?: NodeJS.ProcessEnv;
  read?: FinanceUncachedFetch;
  now?: () => Date;
  signal?: AbortSignal;
}) {
  const { resolveFinanceCredentialEnv } = await import("./finance-credential-env.js");
  const env = resolveFinanceCredentialEnv({
    ...(options.env ?? process.env),
    LCX_FINANCE_STATE_DIR: options.directory,
  });
  const keyId = env.ALPACA_API_KEY_ID;
  const secretKey = env.ALPACA_API_SECRET_KEY;
  if (!keyId || !secretKey) {
    throw new Error("history credentials unavailable");
  }
  const until = (options.now?.() ?? new Date()).toISOString();
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(120_000)])
    : AbortSignal.timeout(120_000);
  const read = options.read ?? createAlpacaSafetyReadTransport();
  const response = await read(`${host}/v2/account`, {
    headers: { "APCA-API-KEY-ID": keyId, "APCA-API-SECRET-KEY": secretKey },
    signal,
  });
  if (response.status !== 200) {
    throw new Error("history account discovery failed");
  }
  const account: unknown = JSON.parse(response.body);
  if (
    !account ||
    typeof account !== "object" ||
    !("id" in account) ||
    typeof account.id !== "string" ||
    !("created_at" in account) ||
    typeof account.created_at !== "string"
  ) {
    throw new Error("history account id/created_at unavailable");
  }
  const { syncFinanceBrokerReconciliation } = await import("./finance-broker-reconciliation.js");
  const reconciliation = await syncFinanceBrokerReconciliation({
    directory: options.directory,
    accountId: account.id,
    after: account.created_at,
    until,
    credentials: { keyId, secretKey },
    read,
    signal,
  });
  const { historySync, ...accountReconciliation } = reconciliation;
  return { ...historySync, accountReconciliation };
}
