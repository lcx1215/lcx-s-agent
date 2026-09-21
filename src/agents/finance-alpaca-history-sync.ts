import { createAlpacaSafetyReadTransport } from "./finance-alpaca-safety-transport.js";
import { caseflowFingerprint } from "./finance-caseflow.js";
import {
  appendFinanceBrokerHistory,
  readFinanceBrokerHistoryRecords,
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
  const streams: Array<{
    stream: string;
    complete: boolean;
    pages: number;
    appended: number;
    reason?: string;
  }> = [];
  for (const stream of ["orders", "activities"] as const) {
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
          url.searchParams.set("nested", "false");
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
        const payload = raw as Record<string, unknown>[];
        const saved = await appendFinanceBrokerHistory(options.directory, {
          kind: "broker_history",
          accountId: options.accountId,
          venue: "alpaca:paper",
          query: `${stream}:${options.after}:${options.until}`,
          cursor,
          payload,
        });
        pages++;
        if (saved.appended) {
          appended++;
        }
        if (payload.length < (stream === "orders" ? 500 : 100)) {
          complete = true;
          break;
        }
        const last = payload.at(-1)!;
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
      reason = error instanceof Error ? error.message : "history sync failed";
    }
    streams.push({ stream, complete, pages, appended, ...(reason ? { reason } : {}) });
  }
  const receipt = {
    accountId: options.accountId,
    venue: "alpaca:paper",
    after: options.after,
    until: options.until,
    status: streams.every((item) => item.complete) ? "raw_history_synced" : "incomplete",
    streams,
    positionsReconciled: false,
    executionReceiptsCreated: 0,
  } as const;
  await appendFinanceBrokerHistory(options.directory, {
    kind: "broker_history",
    accountId: options.accountId,
    venue: "alpaca:paper",
    query: `sync_receipt:${options.after}:${options.until}`,
    cursor: "",
    payload: [
      { ...receipt, streams: receipt.streams.map(({ appended: _appended, ...stream }) => stream) },
    ],
  });
  return receipt;
}

/** Explicit account selection; raw observations are not a broker position snapshot. */
export async function readFinanceBrokerHistory(directory: string, accountId: string) {
  if (!accountId.trim()) {
    throw new Error("history account required");
  }
  const read = await readFinanceBrokerHistoryRecords(directory, accountId, "alpaca:paper");
  const records = read.records;
  const facts = new Map<string, { stream: string; fact: Record<string, unknown> }>();
  for (const record of records) {
    if (record.body.kind !== "broker_history") {
      continue;
    }
    const stream = record.body.query.split(":", 1)[0];
    for (const fact of record.body.payload) {
      facts.set(`${stream}:${caseflowFingerprint(fact)}`, { stream, fact });
    }
  }
  return {
    accountId,
    venue: "alpaca:paper",
    pageCount: records.length,
    facts: [...facts.values()],
    headRef: read.headRef,
    historyStatus: records.length ? "raw_observations_only" : "missing",
    positionsReconciled: false,
    feesInterpreted: false,
  } as const;
}
