import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { financeSourceHeartbeatPath, resolveFinanceStateDir } from "./finance-state-dir.js";

export const FINANCE_SOURCE_HEARTBEAT_SCHEMA_VERSION = 1 as const;
export const FINANCE_SOURCE_HEARTBEAT_DEFAULT_INTERVAL_MS = 15 * 60_000;
export const FINANCE_SOURCE_HEARTBEAT_FAILURE_INTERVAL_MS = 5 * 60_000;

export type FinanceSourceHeartbeatStatus = "healthy" | "degraded" | "unhealthy" | "unknown";

export type FinanceSourceHeartbeatReason =
  | "ok"
  | "http_error"
  | "forbidden"
  | "rate_limited"
  | "budget_exhausted"
  | "network_error"
  | "timeout"
  | "cancelled"
  | "circuit_open"
  | "source_error"
  | "cache_only"
  | "no_supported_request";

export type FinanceSourceHeartbeatRecord = Readonly<{
  provider: string;
  providerName: string;
  adapterId: string;
  checkedAt: string;
  nextCheckAt: string;
  status: FinanceSourceHeartbeatStatus;
  reason: FinanceSourceHeartbeatReason;
  latencyMs: number;
  attempts: number;
  httpStatus?: number;
  networkCode?: string;
  transportError?: string;
  retryAfterMs?: number;
}>;

export type FinanceSourceHeartbeatState = Readonly<{
  schemaVersion: typeof FINANCE_SOURCE_HEARTBEAT_SCHEMA_VERSION;
  updatedAt: string;
  records: Readonly<Record<string, FinanceSourceHeartbeatRecord>>;
}>;

const EMPTY_STATE: FinanceSourceHeartbeatState = Object.freeze({
  schemaVersion: FINANCE_SOURCE_HEARTBEAT_SCHEMA_VERSION,
  updatedAt: new Date(0).toISOString(),
  records: Object.freeze({}),
});

function validStatus(value: unknown): value is FinanceSourceHeartbeatStatus {
  return ["healthy", "degraded", "unhealthy", "unknown"].includes(String(value));
}

function validReason(value: unknown): value is FinanceSourceHeartbeatReason {
  return [
    "ok",
    "http_error",
    "forbidden",
    "rate_limited",
    "budget_exhausted",
    "network_error",
    "timeout",
    "cancelled",
    "circuit_open",
    "source_error",
    "cache_only",
    "no_supported_request",
  ].includes(String(value));
}

function validRecord(value: unknown): value is FinanceSourceHeartbeatRecord {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.provider === "string" &&
    typeof record.providerName === "string" &&
    typeof record.adapterId === "string" &&
    typeof record.checkedAt === "string" &&
    Number.isFinite(Date.parse(record.checkedAt)) &&
    typeof record.nextCheckAt === "string" &&
    Number.isFinite(Date.parse(record.nextCheckAt)) &&
    validStatus(record.status) &&
    validReason(record.reason) &&
    typeof record.latencyMs === "number" &&
    Number.isFinite(record.latencyMs) &&
    record.latencyMs >= 0 &&
    typeof record.attempts === "number" &&
    Number.isSafeInteger(record.attempts) &&
    record.attempts >= 0 &&
    (record.httpStatus === undefined ||
      (typeof record.httpStatus === "number" &&
        Number.isSafeInteger(record.httpStatus) &&
        record.httpStatus >= 100 &&
        record.httpStatus <= 599)) &&
    (record.networkCode === undefined || typeof record.networkCode === "string") &&
    (record.transportError === undefined || typeof record.transportError === "string") &&
    (record.retryAfterMs === undefined ||
      (typeof record.retryAfterMs === "number" &&
        Number.isFinite(record.retryAfterMs) &&
        record.retryAfterMs >= 0))
  );
}

function parseState(value: unknown): FinanceSourceHeartbeatState | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const state = value as Record<string, unknown>;
  if (
    state.schemaVersion !== FINANCE_SOURCE_HEARTBEAT_SCHEMA_VERSION ||
    typeof state.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(state.updatedAt)) ||
    !state.records ||
    typeof state.records !== "object" ||
    Array.isArray(state.records)
  ) {
    return undefined;
  }
  const records = state.records as Record<string, unknown>;
  if (Object.keys(records).some((provider) => !provider || !validRecord(records[provider]))) {
    return undefined;
  }
  return {
    schemaVersion: FINANCE_SOURCE_HEARTBEAT_SCHEMA_VERSION,
    updatedAt: state.updatedAt,
    records: Object.freeze({ ...records }) as Readonly<
      Record<string, FinanceSourceHeartbeatRecord>
    >,
  };
}

/** Read only the durable projection. This function never performs a network call. */
export async function readFinanceSourceHeartbeat(
  options: {
    directory?: string;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<FinanceSourceHeartbeatState> {
  const directory = resolveFinanceStateDir(options).directory;
  try {
    const state = parseState(
      JSON.parse(await fs.readFile(financeSourceHeartbeatPath(directory), "utf8")),
    );
    return state ?? EMPTY_STATE;
  } catch {
    return EMPTY_STATE;
  }
}

export async function persistFinanceSourceHeartbeat(
  directory: string,
  records: Readonly<Record<string, FinanceSourceHeartbeatRecord>>,
  now: number,
): Promise<FinanceSourceHeartbeatState> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const state: FinanceSourceHeartbeatState = {
    schemaVersion: FINANCE_SOURCE_HEARTBEAT_SCHEMA_VERSION,
    updatedAt: new Date(now).toISOString(),
    records: Object.freeze({ ...records }),
  };
  const file = financeSourceHeartbeatPath(directory);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
  return state;
}
