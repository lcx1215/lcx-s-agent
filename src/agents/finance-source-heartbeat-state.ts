import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { financeSourceHeartbeatPath, resolveFinanceStateDir } from "./finance-state-dir.js";
import { acquireSessionWriteLock } from "./session-write-lock.js";

export const FINANCE_SOURCE_HEARTBEAT_SCHEMA_VERSION = 1 as const;
export const FINANCE_SOURCE_HEARTBEAT_DEFAULT_INTERVAL_MS = 15 * 60_000;
export const FINANCE_SOURCE_HEARTBEAT_FAILURE_INTERVAL_MS = 5 * 60_000;
export const FINANCE_SOURCE_HEARTBEAT_MAX_TIMER_MS = 2_147_483_647;

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
  consecutiveFailures?: number;
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
    (record.consecutiveFailures === undefined ||
      (Number.isSafeInteger(record.consecutiveFailures) &&
        Number(record.consecutiveFailures) >= 0)) &&
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
  const filename = financeSourceHeartbeatPath(directory);
  let raw: string;
  try {
    raw = await fs.readFile(filename, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return EMPTY_STATE;
    }
    throw new Error("finance source heartbeat state is unreadable; refusing provider probes", {
      cause: error,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("finance source heartbeat state is invalid JSON; refusing provider probes");
  }
  const state = parseState(parsed);
  if (!state) {
    throw new Error(
      "finance source heartbeat state has an invalid schema; refusing provider probes",
    );
  }
  return state;
}

/** Serialize probe scheduling and state replacement across the scheduler and standalone CLI. */
export async function acquireFinanceSourceHeartbeatLock(
  directory: string,
  maxHoldMs: number,
): Promise<() => Promise<void>> {
  const lock = await acquireSessionWriteLock({
    sessionFile: financeSourceHeartbeatPath(directory),
    // This is non-critical diagnostics. A contending cycle skips rather than delaying a
    // scheduled paper run for the full provider probe window.
    timeoutMs: 1_000,
    staleMs: maxHoldMs + 60_000,
    maxHoldMs,
    allowReentrant: false,
  });
  return lock.release;
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
