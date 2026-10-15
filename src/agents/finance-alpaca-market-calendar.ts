import { createAlpacaSafetyReadTransport } from "./finance-alpaca-safety-transport.js";
import { caseflowFingerprint } from "./finance-caseflow.js";
import { resolveFinanceCredentialEnv } from "./finance-credential-env.js";
import { financeUsEquityLocalTimeInstant } from "./finance-cycle-schedule.js";
import type { FinanceUncachedFetch } from "./finance-write-transport.js";

export const FINANCE_ALPACA_MARKET_CALENDAR_URL =
  "https://paper-api.alpaca.markets/v2/calendar" as const;
export const FINANCE_ALPACA_MARKET_CALENDAR_SOURCE = "alpaca_paper_market_calendar" as const;

export type FinanceAlpacaMarketSession = Readonly<{
  date: string;
  openAt: string;
  closeAt: string;
  openMinute: number;
  closeMinute: number;
  observedAt: string;
  calendarRef: string;
  sourceUrlOrArtifact: string;
}>;

export function financeAlpacaMarketSessionIssue(
  value: unknown,
  options: Readonly<{ asOf?: string; maxObservedAgeMs?: number }> = {},
): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "market session is not an object";
  }
  const session = value as Partial<FinanceAlpacaMarketSession>;
  if (
    typeof session.date !== "string" ||
    !validDate(session.date) ||
    typeof session.openAt !== "string" ||
    typeof session.closeAt !== "string" ||
    !Number.isSafeInteger(session.openMinute) ||
    !Number.isSafeInteger(session.closeMinute) ||
    typeof session.observedAt !== "string" ||
    typeof session.calendarRef !== "string" ||
    !/^[a-f0-9]{64}$/u.test(session.calendarRef) ||
    typeof session.sourceUrlOrArtifact !== "string"
  ) {
    return "market session fields are malformed";
  }
  const expectedOpenAt = financeUsEquityLocalTimeInstant(session.date, session.openMinute!);
  const expectedCloseAt = financeUsEquityLocalTimeInstant(session.date, session.closeMinute!);
  if (
    session.openMinute !== 570 ||
    session.closeMinute! <= session.openMinute ||
    session.closeMinute! > 960 ||
    expectedOpenAt !== session.openAt ||
    expectedCloseAt !== session.closeAt
  ) {
    return "market session does not describe a supported US equity schedule";
  }
  const observedAtMs = Date.parse(session.observedAt);
  if (
    !Number.isFinite(observedAtMs) ||
    new Date(observedAtMs).toISOString() !== session.observedAt
  ) {
    return "market session observation time is invalid";
  }
  let source: URL;
  try {
    source = new URL(session.sourceUrlOrArtifact);
  } catch {
    return "market session source URL is invalid";
  }
  const start = source.searchParams.get("start");
  const end = source.searchParams.get("end");
  const queryKeys = [...source.searchParams.keys()].toSorted();
  if (
    source.href !== session.sourceUrlOrArtifact ||
    source.protocol !== "https:" ||
    source.origin !== "https://paper-api.alpaca.markets" ||
    source.pathname !== "/v2/calendar" ||
    source.searchParams.get("date_type") !== "TRADING" ||
    queryKeys.join(",") !== "date_type,end,start" ||
    !start ||
    !end ||
    !validDate(start) ||
    !validDate(end) ||
    start > end ||
    session.date < start ||
    session.date > end
  ) {
    return "market session source does not bind an Alpaca Paper calendar range";
  }
  const expectedRef = caseflowFingerprint({
    source: FINANCE_ALPACA_MARKET_CALENDAR_SOURCE,
    sourceUrlOrArtifact: session.sourceUrlOrArtifact,
    date: session.date,
    openAt: session.openAt,
    closeAt: session.closeAt,
  });
  if (session.calendarRef !== expectedRef) {
    return "market session fingerprint does not match its schedule";
  }
  if (options.asOf !== undefined) {
    const asOfMs = Date.parse(options.asOf);
    if (!Number.isFinite(asOfMs) || asOfMs < observedAtMs) {
      return "market session observation is from the future or the decision time is invalid";
    }
    if (options.maxObservedAgeMs !== undefined) {
      if (
        !Number.isSafeInteger(options.maxObservedAgeMs) ||
        options.maxObservedAgeMs < 0 ||
        asOfMs - observedAtMs > options.maxObservedAgeMs
      ) {
        return "market session observation is stale";
      }
    }
  }
  return null;
}

export type FinanceAlpacaMarketSessionResolver = (
  date: string,
  signal?: AbortSignal,
) => Promise<FinanceAlpacaMarketSession | null>;

type CalendarRow = Readonly<{ date?: unknown; open?: unknown; close?: unknown }>;

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    return false;
  }
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

function marketMinute(value: unknown): number {
  if (typeof value !== "string") {
    throw new Error("Alpaca market calendar time must be text");
  }
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/iu.exec(value.trim());
  if (!match || (match[3] !== undefined && match[3] !== "00")) {
    throw new Error("Alpaca market calendar time is malformed or has sub-minute precision");
  }
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const meridiem = match[4]?.toUpperCase();
  if (minute > 59) {
    throw new Error("Alpaca market calendar minute is outside the clock range");
  }
  if (meridiem) {
    if (hour < 1 || hour > 12) {
      throw new Error("Alpaca market calendar hour is outside the 12-hour range");
    }
    hour %= 12;
    if (meridiem === "PM") {
      hour += 12;
    }
  } else if (hour > 23) {
    throw new Error("Alpaca market calendar hour is outside the 24-hour range");
  }
  return hour * 60 + minute;
}

function parseSession(
  row: CalendarRow,
  observedAt: string,
  sourceUrlOrArtifact: string,
): FinanceAlpacaMarketSession {
  if (typeof row.date !== "string" || !validDate(row.date)) {
    throw new Error("Alpaca market calendar date is invalid");
  }
  const openMinute = marketMinute(row.open);
  const closeMinute = marketMinute(row.close);
  if (openMinute !== 570 || closeMinute <= openMinute || closeMinute > 960) {
    throw new Error("Alpaca market calendar returned unsupported US equity hours");
  }
  const openAt = financeUsEquityLocalTimeInstant(row.date, openMinute);
  const closeAt = financeUsEquityLocalTimeInstant(row.date, closeMinute);
  if (!openAt || !closeAt || Date.parse(openAt) >= Date.parse(closeAt)) {
    throw new Error("Alpaca market calendar could not be bound to Eastern time");
  }
  const calendarRef = caseflowFingerprint({
    source: FINANCE_ALPACA_MARKET_CALENDAR_SOURCE,
    sourceUrlOrArtifact,
    date: row.date,
    openAt,
    closeAt,
  });
  return Object.freeze({
    date: row.date,
    openAt,
    closeAt,
    openMinute,
    closeMinute,
    observedAt,
    calendarRef,
    sourceUrlOrArtifact,
  });
}

function credentials(directory?: string) {
  const env = resolveFinanceCredentialEnv({
    ...process.env,
    ...(directory ? { LCX_FINANCE_STATE_DIR: directory } : {}),
  });
  const apiKeyId = env.ALPACA_API_KEY_ID?.trim() ?? "";
  const apiSecretKey = env.ALPACA_API_SECRET_KEY?.trim() ?? "";
  if (!apiKeyId.startsWith("PK") || !apiSecretKey) {
    throw new Error("Alpaca market calendar requires configured Paper credentials");
  }
  return { apiKeyId, apiSecretKey };
}

export async function readFinanceAlpacaMarketCalendar(options: {
  startDate: string;
  endDate: string;
  directory?: string;
  signal?: AbortSignal;
  read?: FinanceUncachedFetch;
  credentials?: { apiKeyId: string; apiSecretKey: string };
  now?: () => Date;
}): Promise<readonly FinanceAlpacaMarketSession[]> {
  if (
    !validDate(options.startDate) ||
    !validDate(options.endDate) ||
    options.startDate > options.endDate ||
    Date.parse(`${options.endDate}T00:00:00.000Z`) -
      Date.parse(`${options.startDate}T00:00:00.000Z`) >
      5 * 366 * 86_400_000
  ) {
    throw new Error("Alpaca market calendar requires a valid range of at most five years");
  }
  const credential = options.credentials ?? credentials(options.directory);
  const read = options.read ?? createAlpacaSafetyReadTransport();
  const signal = options.signal ?? AbortSignal.timeout(20_000);
  const url = new URL(FINANCE_ALPACA_MARKET_CALENDAR_URL);
  url.searchParams.set("start", options.startDate);
  url.searchParams.set("end", options.endDate);
  url.searchParams.set("date_type", "TRADING");
  const response = await read(url.toString(), {
    headers: {
      "APCA-API-KEY-ID": credential.apiKeyId,
      "APCA-API-SECRET-KEY": credential.apiSecretKey,
      accept: "application/json",
    },
    signal,
  });
  if (response.status !== 200) {
    throw new Error(`Alpaca market calendar returned HTTP ${response.status}`);
  }
  const payload: unknown = JSON.parse(response.body);
  if (!Array.isArray(payload) || payload.length > 5 * 366) {
    throw new Error("Alpaca market calendar response is malformed or too large");
  }
  const observedAtDate = (options.now ?? (() => new Date()))();
  if (!Number.isFinite(observedAtDate.getTime())) {
    throw new Error("Alpaca market calendar observation time is invalid");
  }
  const observedAt = observedAtDate.toISOString();
  const sourceUrlOrArtifact = url.toString();
  const sessions = payload.map((row) =>
    parseSession(row as CalendarRow, observedAt, sourceUrlOrArtifact),
  );
  const dates = sessions.map((session) => session.date);
  if (
    new Set(dates).size !== dates.length ||
    dates.some((date) => date < options.startDate || date > options.endDate)
  ) {
    throw new Error("Alpaca market calendar returned duplicate or out-of-range dates");
  }
  return Object.freeze(sessions.toSorted((left, right) => left.date.localeCompare(right.date)));
}

export function createFinanceAlpacaMarketSessionResolver(
  options: {
    directory?: string;
    read?: FinanceUncachedFetch;
    credentials?: { apiKeyId: string; apiSecretKey: string };
    now?: () => Date;
    cacheTtlMs?: number;
  } = {},
): FinanceAlpacaMarketSessionResolver {
  const cache = new Map<
    string,
    { expiresAt: number; session: FinanceAlpacaMarketSession | null }
  >();
  const cacheTtlMs = options.cacheTtlMs ?? 60_000;
  if (!Number.isSafeInteger(cacheTtlMs) || cacheTtlMs < 1_000 || cacheTtlMs > 300_000) {
    throw new Error("Alpaca market calendar cache TTL must be between 1s and 5m");
  }
  return async (date, signal) => {
    const now = (options.now ?? (() => new Date()))();
    const cached = cache.get(date);
    if (cached && cached.expiresAt > now.getTime()) {
      return cached.session;
    }
    const sessions = await readFinanceAlpacaMarketCalendar({
      startDate: date,
      endDate: date,
      ...(options.directory ? { directory: options.directory } : {}),
      ...(options.read ? { read: options.read } : {}),
      ...(options.credentials ? { credentials: options.credentials } : {}),
      ...(signal ? { signal } : {}),
      now: () => now,
    });
    const session = sessions.find((row) => row.date === date) ?? null;
    cache.set(date, { expiresAt: now.getTime() + cacheTtlMs, session });
    return session;
  };
}
