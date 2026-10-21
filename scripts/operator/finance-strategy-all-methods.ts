#!/usr/bin/env node

/**
 * Build one auditable receipt for the complete 12-method strategy surface.
 *
 * The market calculations live in the existing benchmark and research
 * runners. This operator joins their real-data receipts, checks that every
 * catalog method has an actual result or an explicit evidence gate, and keeps
 * blocked methods blocked. It never turns a diagnostic into a trade signal.
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  FINANCE_STRATEGY_METHODS,
  STRATEGY_METHOD_IDS,
  type StrategyMethodId,
} from "../../src/agents/finance-strategy-method-catalog.ts";
import { buildStressVariants } from "./finance-strategy-method-benchmark.ts";

type JsonObject = Record<string, unknown>;
type SourcePeriod = Readonly<{ fromDate: string; toDate: string }>;
type MethodReceipt = Readonly<{
  method: StrategyMethodId;
  name: string;
  evidenceType: "real_market_backtest" | "real_market_diagnostic" | "real_market_contract";
  sourceWindow: string;
  sourceArtifacts: readonly string[];
  sourceKinds: readonly string[];
  sourceReceiptsReady: boolean;
  sourceStage: string;
  assessment: "research_only";
  gateStatus: string;
  checksPass: boolean;
  result: JsonObject;
  claims: Readonly<{
    profit: "not_claimed";
    modelLearning: "not_claimed";
    execution: "none";
  }>;
}>;

type AllMethodsReceipt = Readonly<{
  schemaVersion: "lcx_finance_strategy_all_methods_v2";
  status: "completed";
  boundary: "research_only_no_execution";
  runAt: string;
  methodCount: number;
  methods: readonly MethodReceipt[];
  checks: Readonly<{
    completeCatalog: boolean;
    everyMethodHasEvidence: boolean;
    everyMethodHasSourceReceipt: boolean;
    everyMethodHasExplicitGate: boolean;
    noProfitClaim: true;
    noModelLearningClaim: true;
    executionAuthority: "none";
  }>;
}>;

type AllMethodsReceiptOptions = Readonly<{
  inputRoot?: string;
  researchRoot?: string;
}>;

type CliOptions = Readonly<
  AllMethodsReceiptOptions & {
    out?: string;
  }
>;

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "../..");
const CONFIGURED_RESEARCH_ROOT = process.env.LCX_TRADER_STRATEGY_RESEARCH_ROOT?.trim()
  ? path.resolve(process.env.LCX_TRADER_STRATEGY_RESEARCH_ROOT)
  : undefined;

function asObject(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonObject;
}

async function readJson(filePath: string): Promise<JsonObject> {
  try {
    return asObject(JSON.parse(await fs.readFile(filePath, "utf8")), filePath);
  } catch (error: unknown) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw new Error(
        `required strategy input is missing: ${filePath}; provide a generated receipt`,
        { cause: error },
      );
    }
    throw error;
  }
}

function requiredObject(value: unknown, label: string): JsonObject {
  return asObject(value, label);
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requiredFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
}

function requiredPeriodMetrics(value: unknown, label: string): JsonObject[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value.map((entry, index) => {
    const period = requiredObject(entry, `${label}[${index}]`);
    return {
      window: requiredText(period.window, `${label}[${index}].window`),
      metric: requiredObject(period.metric, `${label}[${index}].metric`),
    };
  });
}

function sourceGroupReady(receipts: JsonObject, period?: SourcePeriod): boolean {
  const rows = Object.entries(receipts);
  return (
    rows.length > 0 && rows.every(([key, receipt]) => sourceReceiptReady(key, receipt, period))
  );
}

const SOURCE_RECEIPT_TIMESTAMP_KEYS = [
  "finished_at",
  "finishedAt",
  "observed_at",
  "observedAt",
  "source_timestamp",
  "sourceTimestamp",
  "retrieved_at",
  "retrievedAt",
  "quote_timestamp",
  "updated_at",
  "updatedAt",
  "timestamp",
] as const;

const SOURCE_RECEIPT_REQUEST_KEYS = [
  "instrument",
  "symbol",
  "ticker",
  "series_id",
  "seriesId",
  "query",
  "window",
  "from",
  "to",
  "start",
  "end",
] as const;

const SOURCE_RECEIPT_STATUS_KEYS = [
  "status",
  "evidence_status",
  "body_status",
  "provider_status",
  "data_status",
] as const;

const SOURCE_RECEIPT_ERROR_KEYS = [
  "error",
  "error_code",
  "error_message",
  "provider_error",
  "body_error",
  "transport_error",
] as const;

function nonEmptyReceiptText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function nestedReceiptObject(receipt: JsonObject): JsonObject | undefined {
  for (const key of ["request", "request_context", "requestContext", "params"] as const) {
    const value = receipt[key];
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return value as JsonObject;
    }
  }
  return undefined;
}

function receiptRequestValues(receipt: JsonObject): string[] {
  const request = nestedReceiptObject(receipt);
  return [...SOURCE_RECEIPT_REQUEST_KEYS]
    .flatMap((key) => [receipt[key], request?.[key]])
    .map((value) =>
      typeof value === "number" && Number.isFinite(value)
        ? String(value)
        : nonEmptyReceiptText(value),
    )
    .filter((value): value is string => value !== undefined);
}

function receiptDay(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    return undefined;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
    ? value
    : undefined;
}

function sourcePeriod(value: unknown): SourcePeriod | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const row = value as JsonObject;
  const fromDate = receiptDay(row.fromDate ?? row.from ?? row.start);
  const toDate = receiptDay(row.toDate ?? row.to ?? row.end);
  return fromDate && toDate && fromDate <= toDate ? { fromDate, toDate } : undefined;
}

function sourceRequestCovers(receipt: JsonObject, expected: SourcePeriod): boolean {
  const expectedPeriod = sourcePeriod(expected);
  const request = nestedReceiptObject(receipt) ?? receipt;
  const window = nonEmptyReceiptText(request.window)?.split("..");
  const actual =
    sourcePeriod(request) ??
    (window?.length === 2 ? sourcePeriod({ from: window[0], to: window[1] }) : undefined);
  return Boolean(
    expectedPeriod &&
    actual &&
    actual.fromDate <= expectedPeriod.fromDate &&
    actual.toDate >= expectedPeriod.toDate,
  );
}

function localBenchmarkSourcesReady(benchmarkData: JsonObject): boolean {
  const period = sourcePeriod(benchmarkData);
  const symbols = benchmarkData.symbols;
  const receipts = benchmarkData.sourceReceipts;
  const observations = benchmarkData.alignedObservations;
  const asOf = typeof benchmarkData.asOf === "string" ? Date.parse(benchmarkData.asOf) : NaN;
  if (
    !period ||
    !Array.isArray(symbols) ||
    symbols.length === 0 ||
    symbols.some((symbol) => typeof symbol !== "string" || !symbol.trim()) ||
    new Set(symbols).size !== symbols.length ||
    !Array.isArray(receipts) ||
    receipts.length !== symbols.length ||
    typeof observations !== "number" ||
    !Number.isInteger(observations) ||
    observations < 2 ||
    !Number.isFinite(asOf)
  ) {
    return false;
  }
  const seen = new Set<string>();
  return receipts.every((value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }
    const receipt = value as JsonObject;
    const symbol = receipt.symbol;
    const first =
      typeof receipt.firstSourceTimestamp === "string"
        ? Date.parse(receipt.firstSourceTimestamp)
        : NaN;
    const last =
      typeof receipt.lastSourceTimestamp === "string"
        ? Date.parse(receipt.lastSourceTimestamp)
        : NaN;
    if (
      typeof symbol !== "string" ||
      !symbols.includes(symbol) ||
      seen.has(symbol) ||
      receipt.status !== "ready" ||
      typeof receipt.recordCount !== "number" ||
      !Number.isInteger(receipt.recordCount) ||
      receipt.recordCount < observations ||
      !Number.isFinite(first) ||
      !Number.isFinite(last) ||
      first > last ||
      last > asOf ||
      new Date(first).toISOString().slice(0, 10) > period.fromDate ||
      new Date(last).toISOString().slice(0, 10) < period.toDate ||
      !Array.isArray(receipt.chunks) ||
      receipt.chunks.length === 0
    ) {
      return false;
    }
    seen.add(symbol);
    const chunks: SourcePeriod[] = [];
    let chunkRecordCount = 0;
    for (const value of receipt.chunks) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
      }
      const chunk = value as JsonObject;
      const window = sourcePeriod(chunk);
      if (
        !window ||
        chunk.status !== "ready" ||
        typeof chunk.recordCount !== "number" ||
        !Number.isInteger(chunk.recordCount) ||
        chunk.recordCount < 0
      ) {
        return false;
      }
      chunkRecordCount += chunk.recordCount;
      chunks.push(window);
    }
    if (chunkRecordCount < receipt.recordCount) {
      return false;
    }
    // Requests include warmup and arrive newest first. Check their union, not array order.
    chunks.sort((a, b) => a.fromDate.localeCompare(b.fromDate));
    let coveredThrough = Date.parse(period.fromDate) - 86_400_000;
    for (const chunk of chunks) {
      const start = Date.parse(chunk.fromDate);
      if (start > coveredThrough + 86_400_000) {
        break;
      }
      coveredThrough = Math.max(coveredThrough, Date.parse(chunk.toDate));
    }
    return coveredThrough >= Date.parse(period.toDate);
  });
}

function cboeSourceReady(receipt: JsonObject, result: JsonObject, raw?: Uint8Array): boolean {
  if (
    !raw ||
    typeof receipt.raw_sha256 !== "string" ||
    createHash("sha256").update(raw).digest("hex") !== receipt.raw_sha256
  ) {
    return false;
  }
  let snapshot: JsonObject;
  try {
    snapshot = asObject(JSON.parse(Buffer.from(raw).toString("utf8")), "Cboe snapshot");
  } catch {
    return false;
  }
  const symbol = nonEmptyReceiptText(snapshot.symbol);
  const timestamp = nonEmptyReceiptText(snapshot.timestamp);
  const data = snapshot.data;
  const clock = timestamp && /^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2}):(\d{2})$/u.exec(timestamp);
  const validQuoteTime =
    clock &&
    receiptDay(clock[1]) &&
    Number(clock[2]) < 24 &&
    Number(clock[3]) < 60 &&
    Number(clock[4]) < 60;
  if (
    !symbol ||
    !validQuoteTime ||
    result.quote_timestamp !== timestamp ||
    receipt.observed_as_of !== timestamp ||
    receipt.source_url !==
      `https://cdn.cboe.com/api/global/delayed_quotes/options/${symbol}.json` ||
    !sourceReceiptReady("cboe", {
      ...receipt,
      finished_at: receipt.fetched_at,
      request: { symbol },
    }) ||
    !data ||
    typeof data !== "object" ||
    Array.isArray(data)
  ) {
    return false;
  }
  const chain = data as JsonObject;
  if (
    chain.symbol !== symbol ||
    typeof chain.current_price !== "number" ||
    !Number.isFinite(chain.current_price) ||
    chain.current_price <= 0 ||
    result.spot !== chain.current_price ||
    !Array.isArray(chain.options)
  ) {
    return false;
  }
  const contracts = new Map<string, JsonObject>();
  for (const value of chain.options) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const option = value as JsonObject;
      if (typeof option.option === "string") {
        if (contracts.has(option.option)) {
          return false;
        }
        contracts.set(option.option, option);
      }
    }
  }
  const quote = (code: unknown, expiry: unknown, strike: unknown, side: "C" | "P") => {
    if (
      typeof code !== "string" ||
      !receiptDay(expiry) ||
      typeof strike !== "number" ||
      !Number.isFinite(strike) ||
      strike <= 0
    ) {
      return undefined;
    }
    const suffix = code.slice(symbol.length);
    const match = /^(\d{6})([CP])(\d{8})$/u.exec(suffix);
    if (
      !code.startsWith(symbol) ||
      !match ||
      match[1] !== String(expiry).slice(2).replaceAll("-", "") ||
      match[2] !== side ||
      Number(match[3]) / 1000 !== strike
    ) {
      return undefined;
    }
    const option = contracts.get(code);
    return option &&
      typeof option.bid === "number" &&
      Number.isFinite(option.bid) &&
      option.bid >= 0 &&
      typeof option.ask === "number" &&
      Number.isFinite(option.ask) &&
      option.ask >= option.bid
      ? option
      : undefined;
  };
  if (result.module === "M10") {
    if (!result.put || typeof result.put !== "object" || Array.isArray(result.put)) {
      return false;
    }
    const put = result.put as JsonObject;
    const option = quote(put.contract, put.expiry, put.strike, "P");
    return Boolean(
      option &&
      typeof option.iv === "number" &&
      Number.isFinite(option.iv) &&
      option.iv > 0 &&
      typeof option.bid === "number" &&
      option.bid > 0 &&
      put.bid === option.bid &&
      put.ask === option.ask &&
      put.iv === option.iv,
    );
  }
  if (result.module === "M11") {
    if (
      !result.contract_pair ||
      typeof result.contract_pair !== "object" ||
      Array.isArray(result.contract_pair)
    ) {
      return false;
    }
    const pair = result.contract_pair as JsonObject;
    const call = quote(pair.call, pair.expiry, pair.strike, "C");
    const put = quote(pair.put, pair.expiry, pair.strike, "P");
    return Boolean(call && put);
  }
  return false;
}

async function readCboeSnapshot(researchRoot: string): Promise<Uint8Array | undefined> {
  try {
    return await fs.readFile(
      path.join(researchRoot, "experiments/real_market/raw/cboe_spy_options.json"),
    );
  } catch {
    return undefined;
  }
}

type NativeSourceBytes = Readonly<Record<string, Uint8Array | undefined>>;
type NativeEvidence = Readonly<{
  strategy: NativeSourceBytes;
  real: NativeSourceBytes;
  events: NativeSourceBytes;
}>;
type SourceRequirement = Readonly<{
  symbol: string;
  period: SourcePeriod;
  endpoints?: boolean;
  nextClose?: boolean;
  previousClose?: boolean;
}>;

function verifiedSourceObject(
  receipt: JsonObject,
  raw: Uint8Array | undefined,
): JsonObject | undefined {
  if (
    !raw ||
    typeof receipt.raw_sha256 !== "string" ||
    createHash("sha256").update(raw).digest("hex") !== receipt.raw_sha256
  ) {
    return undefined;
  }
  try {
    return asObject(JSON.parse(Buffer.from(raw).toString("utf8")), "source body");
  } catch {
    return undefined;
  }
}

function sourceSymbols(value: unknown): string[] | undefined {
  return Array.isArray(value) &&
    value.length > 0 &&
    value.every((symbol) => typeof symbol === "string" && /^[A-Z^][A-Z0-9.^-]{0,19}$/u.test(symbol))
    ? [...new Set(value as string[])]
    : undefined;
}

function historicalRequirements(
  method: string,
  result: JsonObject,
  manifest: JsonObject,
): SourceRequirement[] | undefined {
  if (method === "M09") {
    if (!Array.isArray(result.events) || result.events.length === 0) {
      return undefined;
    }
    const required: SourceRequirement[] = [];
    for (const value of result.events) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return undefined;
      }
      const event = value as JsonObject;
      const period = sourcePeriod({ from: event.entry_date, to: event.exit_date });
      const announcement = receiptDay(event.announcement_date);
      const effective = receiptDay(event.effective_date);
      const symbols = sourceSymbols(event.tickers);
      if (
        !period ||
        !announcement ||
        !effective ||
        !symbols ||
        announcement >= period.fromDate ||
        period.toDate >= effective
      ) {
        return undefined;
      }
      required.push(
        ...[...new Set([...symbols, "SPY"])].map((symbol) => ({ symbol, period, endpoints: true })),
      );
    }
    return required;
  }
  let period = sourcePeriod(result.sample);
  if (method === "M04" && period) {
    period = { ...period, fromDate: `${period.fromDate.slice(0, 7)}-01` };
  }
  let symbols: string[] | undefined;
  if (method === "M02") {
    symbols = sourceSymbols(result.universe);
  } else if (method === "M03") {
    symbols = ["SPY", "^TNX"];
  } else if (method === "M04") {
    symbols = sourceSymbols([
      result.target,
      ...(Array.isArray(result.factor_proxies) ? result.factor_proxies : []),
    ]);
    if (!sourceSymbols(result.factor_proxies)) {
      return undefined;
    }
  } else if (method === "M08") {
    symbols = ["HYG", "SPY", "LQD"];
  } else if (["M05", "M06", "M07"].includes(method)) {
    if (!Array.isArray(result.results) || result.results.length === 0) {
      return undefined;
    }
    const all: string[] = [];
    for (const value of result.results) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return undefined;
      }
      const row = value as JsonObject;
      const rowSymbols = sourceSymbols(method === "M07" ? [row.cef, row.nav_proxy] : row.universe);
      if (!rowSymbols) {
        return undefined;
      }
      all.push(...rowSymbols);
    }
    symbols = [...new Set(all)];
    if (method === "M07") {
      period = sourcePeriod({ start: manifest.start, end: manifest.end_requested });
    }
  }
  return period && symbols
    ? symbols.map((symbol) => ({
        symbol,
        period,
        nextClose: method === "M03" && symbol === "SPY",
        previousClose: ["M04", "M08"].includes(method) || (method === "M03" && symbol === "^TNX"),
      }))
    : undefined;
}

function historicalSourcesReady(
  method: string,
  result: JsonObject,
  receipts: JsonObject,
  raw: NativeSourceBytes | undefined,
  manifest: JsonObject = {},
): boolean {
  const required = historicalRequirements(method, result, manifest);
  if (!required || !raw) {
    return false;
  }
  const parsed = new Map<string, { receipt: JsonObject; days: Set<string> }>();
  for (const expected of required) {
    let source = parsed.get(expected.symbol);
    if (!source) {
      const value = receipts[expected.symbol];
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
      }
      const receipt = value as JsonObject;
      const body = verifiedSourceObject(receipt, raw[expected.symbol]);
      if (!body || receipt.symbol !== expected.symbol) {
        return false;
      }
      let url: URL;
      let pathname: string;
      try {
        url = new URL(String(receipt.source_url));
        pathname = decodeURIComponent(url.pathname);
      } catch {
        return false;
      }
      if (
        url.origin !== "https://query1.finance.yahoo.com" ||
        pathname !== `/v8/finance/chart/${expected.symbol}` ||
        url.searchParams.get("interval") !== "1d" ||
        !["period1", "period2"].every(
          (key) =>
            url.searchParams.getAll(key).length === 1 &&
            /^\d+$/u.test(url.searchParams.get(key) ?? ""),
        )
      ) {
        return false;
      }
      const from = Number(url.searchParams.get("period1")) * 1000;
      const to = Number(url.searchParams.get("period2")) * 1000;
      if (
        !Number.isFinite(from) ||
        !Number.isFinite(to) ||
        from >= to ||
        !Number.isFinite(new Date(from).getTime()) ||
        !Number.isFinite(new Date(to).getTime())
      ) {
        return false;
      }
      const chart = body.chart;
      if (!chart || typeof chart !== "object" || Array.isArray(chart)) {
        return false;
      }
      const rows = chart as JsonObject;
      if (rows.error != null || !Array.isArray(rows.result) || rows.result.length !== 1) {
        return false;
      }
      const row = rows.result[0] as JsonObject | undefined;
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        return false;
      }
      const meta = row.meta as JsonObject | undefined;
      const indicators = row.indicators as JsonObject | undefined;
      const quote = Array.isArray(indicators?.quote)
        ? (indicators.quote[0] as JsonObject | undefined)
        : undefined;
      const adjusted = Array.isArray(indicators?.adjclose)
        ? (indicators.adjclose[0] as JsonObject | undefined)
        : undefined;
      const closes = quote?.close;
      const adjustedCloses = adjusted?.adjclose ?? closes;
      if (
        meta?.symbol !== expected.symbol ||
        !Array.isArray(row.timestamp) ||
        !Array.isArray(closes) ||
        !Array.isArray(adjustedCloses) ||
        closes.length !== row.timestamp.length ||
        adjustedCloses.length !== row.timestamp.length
      ) {
        return false;
      }
      const days = new Set<string>();
      for (let i = 0; i < row.timestamp.length; i++) {
        const time = row.timestamp[i];
        const close = closes[i];
        const adjclose = adjustedCloses[i];
        if (
          typeof time === "number" &&
          Number.isFinite(time) &&
          Number.isFinite(new Date(time * 1000).getTime()) &&
          typeof close === "number" &&
          Number.isFinite(close) &&
          close > 0 &&
          typeof adjclose === "number" &&
          Number.isFinite(adjclose) &&
          adjclose > 0
        ) {
          days.add(new Date(time * 1000).toISOString().slice(0, 10));
        }
      }
      const ordered = [...days].toSorted();
      if (
        !ordered.length ||
        receipt.observed_as_of !== ordered.at(-1) ||
        Date.parse(String(receipt.fetched_at)) < Date.parse(ordered.at(-1) ?? "")
      ) {
        return false;
      }
      const request = {
        symbol: expected.symbol,
        fromDate: new Date(from).toISOString().slice(0, 10),
        toDate: new Date(to - 1).toISOString().slice(0, 10),
      };
      if (
        !sourceReceiptReady(expected.symbol, {
          ...receipt,
          finished_at: receipt.fetched_at,
          request,
        })
      ) {
        return false;
      }
      source = { receipt: { ...receipt, finished_at: receipt.fetched_at, request }, days };
      parsed.set(expected.symbol, source);
    }
    if (
      !sourceReceiptReady(expected.symbol, source.receipt, expected.period) ||
      [...source.days].filter(
        (day) => day >= expected.period.fromDate && day <= expected.period.toDate,
      ).length < (expected.endpoints ? 1 : 2) ||
      (method === "M04"
        ? String(source.receipt.observed_as_of).slice(0, 7) < expected.period.toDate.slice(0, 7)
        : String(source.receipt.observed_as_of) < expected.period.toDate) ||
      (expected.endpoints &&
        (!source.days.has(expected.period.fromDate) || !source.days.has(expected.period.toDate))) ||
      (expected.previousClose && ![...source.days].some((day) => day < expected.period.fromDate)) ||
      (expected.nextClose && ![...source.days].some((day) => day > expected.period.toDate))
    ) {
      return false;
    }
  }
  if (["M03", "M04", "M08"].includes(method)) {
    const sample = result.sample as JsonObject;
    const observations = method === "M04" ? sample.monthly_observations : sample.observations;
    if (typeof observations !== "number" || !Number.isInteger(observations) || observations < 2) {
      return false;
    }
    const first = required[0];
    if (!first) {
      return false;
    }
    let actualCount: number;
    if (method === "M04") {
      // The producer resamples each series independently before joining months.
      const months = required.map(
        ({ symbol, period }) =>
          new Set(
            [...(parsed.get(symbol)?.days ?? [])]
              .map((day) => day.slice(0, 7))
              .filter(
                (month) =>
                  month >= period.fromDate.slice(0, 7) && month <= period.toDate.slice(0, 7),
              ),
          ),
      );
      actualCount = [...(months[0] ?? [])].filter((month) =>
        months.every((set) => set.has(month)),
      ).length;
    } else {
      actualCount = [...(parsed.get(first.symbol)?.days ?? [])].filter(
        (day) =>
          day >= first.period.fromDate &&
          day <= first.period.toDate &&
          required.every(({ symbol }) => parsed.get(symbol)?.days.has(day)),
      ).length;
    }
    if (actualCount < observations) {
      return false;
    }
  }
  return true;
}

function officialEventSourcesReady(
  events: unknown,
  receipts: JsonObject,
  raw: NativeSourceBytes | undefined,
): boolean {
  if (!Array.isArray(events) || events.length === 0 || !raw) {
    return false;
  }
  const seen = new Set<string>();
  for (const value of events) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }
    const event = value as JsonObject;
    const id = nonEmptyReceiptText(event.event_id);
    const date = receiptDay(event.announcement_date);
    const effective = receiptDay(event.effective_date);
    if (
      !id ||
      !/^[A-Za-z0-9_-]{1,64}$/u.test(id) ||
      seen.has(id) ||
      !date ||
      !effective ||
      date >= effective
    ) {
      return false;
    }
    seen.add(id);
    const receipt = receipts[id];
    const embedded = event.source_receipt;
    if (
      !receipt ||
      typeof receipt !== "object" ||
      Array.isArray(receipt) ||
      !embedded ||
      typeof embedded !== "object" ||
      Array.isArray(embedded)
    ) {
      return false;
    }
    const source = receipt as JsonObject;
    const retained = embedded as JsonObject;
    const bytes = raw[id];
    const normalize = (value: unknown) => {
      try {
        const url = new URL(String(value));
        return url.origin === "https://press.spglobal.com" && !url.search && !url.hash
          ? url.origin + decodeURIComponent(url.pathname)
          : undefined;
      } catch {
        return undefined;
      }
    };
    const url = normalize(event.source_url);
    if (
      !url ||
      !new URL(url).pathname.startsWith(`/${date}-`) ||
      normalize(source.source_url) !== url ||
      normalize(retained.source_url) !== url ||
      !bytes ||
      source.raw_sha256 !== createHash("sha256").update(bytes).digest("hex") ||
      retained.raw_sha256 !== source.raw_sha256 ||
      source.bytes !== bytes.byteLength ||
      retained.bytes !== source.bytes ||
      ![source, retained].every(
        (receipt) =>
          sourceReceiptReady("event", {
            ...receipt,
            finished_at: receipt.fetched_at,
            request: { query: url },
          }) && Date.parse(String(receipt.fetched_at)) >= Date.parse(date),
      )
    ) {
      return false;
    }
    const html = Buffer.from(bytes).toString("utf8");
    const canonical =
      /<link\b(?=[^>]*\brel=["']canonical["'])[^>]*\bhref=["']([^"']+)["'][^>]*>/iu.exec(html)?.[1];
    if (normalize(canonical) !== url || !html.includes(`<!-- ITEMDATE: ${date} `)) {
      return false;
    }
  }
  return true;
}

async function readNativeEvidence(
  researchRoot: string,
  strategy: JsonObject,
  real: JsonObject,
): Promise<NativeEvidence> {
  const read = async (file: string) => {
    try {
      return await fs.readFile(file);
    } catch {
      return undefined;
    }
  };
  const group = async (receipts: unknown, directory: string, prefix: string, suffix: string) => {
    if (!receipts || typeof receipts !== "object" || Array.isArray(receipts)) {
      return {};
    }
    const entries = await Promise.all(
      Object.keys(receipts).map(
        async (key) =>
          [
            key,
            /^[A-Za-z0-9^_-][A-Za-z0-9.^_-]{0,63}$/u.test(key)
              ? await read(path.join(directory, `${prefix}${key}${suffix}`))
              : undefined,
          ] as const,
      ),
    );
    return Object.fromEntries(entries);
  };
  const sources = real.sources as JsonObject | undefined;
  const [strategyBytes, realBytes, events] = await Promise.all([
    group(strategy.source_receipts, path.join(researchRoot, "experiments/raw"), "", ".json"),
    group(
      sources?.yahoo_symbols,
      path.join(researchRoot, "experiments/real_market/raw"),
      "yahoo_",
      ".json",
    ),
    group(
      sources?.event_sources,
      path.join(researchRoot, "experiments/real_market/raw"),
      "event_",
      ".html",
    ),
  ]);
  return { strategy: strategyBytes, real: realBytes, events };
}

function sourceGroupReadyForResult(receipts: JsonObject, result: JsonObject): boolean {
  const period = sourcePeriod(result.sample);
  return period !== undefined && sourceGroupReady(receipts, period);
}

function sourceReceiptReady(key: string, value: unknown, period?: SourcePeriod): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const receipt = value as JsonObject;
  const httpStatus = receipt.http_status ?? receipt.httpStatus;
  if (String(httpStatus).trim() !== "200") {
    return false;
  }
  const timestamp = SOURCE_RECEIPT_TIMESTAMP_KEYS.map((timestampKey) => receipt[timestampKey]).find(
    (candidate) => nonEmptyReceiptText(candidate) !== undefined,
  );
  if (typeof timestamp !== "string" || !Number.isFinite(Date.parse(timestamp))) {
    return false;
  }
  for (const statusKey of SOURCE_RECEIPT_STATUS_KEYS) {
    const statusValue = receipt[statusKey];
    if (statusValue === undefined || statusValue === null || statusValue === "") {
      continue;
    }
    const status = nonEmptyReceiptText(statusValue);
    if (
      !status ||
      !["ok", "ready", "success", "succeeded", "completed", "200"].includes(status.toLowerCase())
    ) {
      return false;
    }
  }
  if (
    SOURCE_RECEIPT_ERROR_KEYS.some((errorKey) => {
      const error = receipt[errorKey];
      return (
        error !== undefined &&
        error !== null &&
        error !== false &&
        (typeof error !== "string" || error.trim().length > 0)
      );
    })
  ) {
    return false;
  }
  const requestValues = receiptRequestValues(receipt);
  if (requestValues.length === 0) {
    return false;
  }
  if (
    period &&
    (!sourceRequestCovers(receipt, period) || Date.parse(timestamp) < Date.parse(period.toDate))
  ) {
    return false;
  }
  const expectedInstrument = /^[A-Z][A-Z0-9.-]{1,9}$/u.test(key) ? key.toUpperCase() : undefined;
  return (
    expectedInstrument === undefined ||
    requestValues.some((item) => item.toUpperCase() === expectedInstrument)
  );
}

function artifactLabel(filePath: string, researchRoot?: string): string {
  if (researchRoot) {
    const relativeToResearch = path.relative(path.resolve(researchRoot), path.resolve(filePath));
    if (
      relativeToResearch === "" ||
      (!relativeToResearch.startsWith("..") && !path.isAbsolute(relativeToResearch))
    ) {
      return `external-research/${relativeToResearch}`;
    }
  }
  return path.relative(REPO_ROOT, filePath) || filePath;
}

function methodName(method: StrategyMethodId): string {
  return FINANCE_STRATEGY_METHODS.find((item) => item.id === method)?.name ?? method;
}

function sourceWindow(value: unknown, fallback: string): string {
  const sample = typeof value === "object" && value !== null ? (value as JsonObject).sample : null;
  if (typeof sample === "object" && sample !== null) {
    const start = (sample as JsonObject).start;
    const end = (sample as JsonObject).end;
    if (typeof start === "string" && typeof end === "string") {
      return `${start}..${end}`;
    }
  }
  return fallback;
}

function checkBooleans(value: unknown, label: string): boolean {
  const checks = requiredObject(value, label);
  const entries = Object.entries(checks);
  if (entries.length === 0 || entries.some(([, item]) => typeof item !== "boolean")) {
    throw new Error(`${label} must contain only boolean checks`);
  }
  return entries.every(([, item]) => item === true);
}

function methodReceipt(
  method: StrategyMethodId,
  evidenceType: MethodReceipt["evidenceType"],
  sourceWindowValue: string,
  sourceArtifacts: readonly string[],
  sourceKinds: readonly string[],
  sourceStage: string,
  sourceReceiptsReady: boolean,
  checksPass: boolean,
  gateStatus: string,
  result: JsonObject,
): MethodReceipt {
  if (!gateStatus) {
    throw new Error(`${method} must have an explicit gate status`);
  }
  return Object.freeze({
    method,
    name: methodName(method),
    evidenceType,
    sourceWindow: sourceWindowValue,
    sourceArtifacts: Object.freeze([...sourceArtifacts]),
    sourceKinds: Object.freeze([...sourceKinds]),
    sourceReceiptsReady,
    sourceStage,
    assessment: "research_only",
    gateStatus,
    checksPass,
    result,
    claims: Object.freeze({
      profit: "not_claimed",
      modelLearning: "not_claimed",
      execution: "none",
    }),
  });
}

function getMediumRows(value: unknown, label: string): JsonObject[] {
  const root = requiredObject(value, label);
  const rows = root.results;
  if (!Array.isArray(rows)) {
    throw new Error(`${label}.results must be an array`);
  }
  return rows
    .filter(
      (row): row is JsonObject => typeof row === "object" && row !== null && !Array.isArray(row),
    )
    .filter(
      (row) => requiredObject(row.cost_assumption, `${label}.cost_assumption`).label === "medium",
    );
}

function buildMethods(
  benchmark: JsonObject,
  stress: JsonObject,
  strategyManifest: JsonObject,
  m02: JsonObject,
  m05: JsonObject,
  m06: JsonObject,
  m07: JsonObject,
  realSummary: JsonObject,
  realResults: Readonly<Record<string, JsonObject>>,
  researchRoot: string = CONFIGURED_RESEARCH_ROOT ?? REPO_ROOT,
  inputRoot: string = REPO_ROOT,
  cboeSnapshot?: Uint8Array,
  nativeEvidence?: NativeEvidence,
): readonly MethodReceipt[] {
  const benchmarkChecks = requiredObject(benchmark.checks, "benchmark.checks");
  const benchmarkPortfolio = requiredObject(benchmark.portfolio, "benchmark.portfolio");
  const benchmarkData = requiredObject(benchmark.data, "benchmark.data");
  const stressMatrix = requiredObject(stress.stressMatrix, "stress.stressMatrix");
  const stressSummary = requiredObject(stressMatrix.summary, "stress summary");
  if (!Array.isArray(stressMatrix.variants)) {
    throw new Error("stress.stressMatrix.variants must be an array of evaluated sensitivity cells");
  }
  const m02StressVariants = stressMatrix.variants.map((value, index) => {
    const row = requiredObject(value, `stress.stressMatrix.variants[${index}]`);
    const lookback = requiredFiniteNumber(row.lookback, `M02 variant ${index} lookback`);
    const costBps = requiredFiniteNumber(row.costBps, `M02 variant ${index} costBps`);
    const breadth = requiredFiniteNumber(row.breadth, `M02 variant ${index} breadth`);
    return {
      variantKind: "parameter_sensitivity_cell_not_search_candidate",
      variantKey: `lookback=${lookback};costBps=${costBps};breadth=${breadth}`,
      lookback,
      costBps,
      breadth,
      baseline: requiredObject(row.baseline, `M02 variant ${index} baseline`),
      enriched: requiredObject(row.enriched, `M02 variant ${index} enriched`),
      baselinePeriods: requiredPeriodMetrics(
        row.baselinePeriods,
        `M02 variant ${index} baselinePeriods`,
      ),
      enrichedPeriods: requiredPeriodMetrics(
        row.enrichedPeriods,
        `M02 variant ${index} enrichedPeriods`,
      ),
      cagrDeltaPp: requiredFiniteNumber(row.cagrDeltaPp, `M02 variant ${index} cagrDeltaPp`),
      maxDrawdownDeltaPp: requiredFiniteNumber(
        row.maxDrawdownDeltaPp,
        `M02 variant ${index} maxDrawdownDeltaPp`,
      ),
      totalReturnDeltaPp: requiredFiniteNumber(
        row.totalReturnDeltaPp,
        `M02 variant ${index} totalReturnDeltaPp`,
      ),
    };
  });
  const m02StressVariantKeys = new Set(m02StressVariants.map((variant) => variant.variantKey));
  const expectedM02StressVariantKeys = new Set(
    buildStressVariants().map(
      ({ lookback, costBps, breadth }) =>
        `lookback=${lookback};costBps=${costBps};breadth=${breadth}`,
    ),
  );
  const m02StressVariantRowsComplete =
    m02StressVariants.length === expectedM02StressVariantKeys.size &&
    m02StressVariantKeys.size === expectedM02StressVariantKeys.size &&
    [...expectedM02StressVariantKeys].every((key) => m02StressVariantKeys.has(key));
  const strategyManifestReceipts = requiredObject(
    strategyManifest.source_receipts,
    "strategy manifest source_receipts",
  );
  const strategySourcesReady = (method: string, result: JsonObject) =>
    historicalSourcesReady(
      method,
      result,
      strategyManifestReceipts,
      nativeEvidence?.strategy,
      strategyManifest,
    );
  const localSourcesReady = localBenchmarkSourcesReady(benchmarkData);
  const realSources = requiredObject(realSummary.sources, "real_market_summary.sources");
  const realYahooSources = requiredObject(
    realSources.yahoo_symbols,
    "real_market_summary.sources.yahoo_symbols",
  );
  const realYahooReady = (method: string, result: JsonObject) =>
    historicalSourcesReady(method, result, realYahooSources, nativeEvidence?.real);
  const cboeSource = requiredObject(realSources.cboe, "real_market_summary.sources.cboe");
  const cboeReady = (result: JsonObject) => cboeSourceReady(cboeSource, result, cboeSnapshot);
  const eventSources = requiredObject(
    realSources.event_sources,
    "real_market_summary.sources.event_sources",
  );
  const eventSourcesReady = officialEventSourcesReady(
    realResults.M09?.events,
    eventSources,
    nativeEvidence?.events,
  );
  const realSummaryTests = realSummary.tests;
  if (!Array.isArray(realSummaryTests)) {
    throw new Error("real_market_summary.tests must be an array");
  }

  const artifact = (filePath: string) => artifactLabel(filePath, researchRoot);
  const localBenchmark = artifact(path.join(inputRoot, "benchmark-20260910.json"));
  const localStress = artifact(path.join(inputRoot, "stress-matrix-12us-20260910.json"));
  const external = (name: string) => path.join(researchRoot, name);

  const m02Portfolio = requiredObject(
    benchmarkPortfolio.trend_breadth_gate,
    "benchmark trend_breadth_gate",
  );
  const m02Base = requiredObject(benchmarkPortfolio.buy_hold, "benchmark buy_hold");
  const m02Stress = {
    variantCount: stressSummary.variantCount,
    cagrOutperformanceCount: stressSummary.cagrOutperformanceCount,
    drawdownImprovementCount: stressSummary.drawdownImprovementCount,
    bothCagrAndDrawdownCount: stressSummary.bothCagrAndDrawdownCount,
    medianCagrDeltaPp: stressSummary.medianCagrDeltaPp,
    variantRowsComplete: m02StressVariantRowsComplete,
    variants: m02StressVariants,
  };

  const m05Medium = getMediumRows(m05, "m05_results");
  const m06Medium = getMediumRows(m06, "m06_results");
  const m07Rows = m07.results;
  if (!Array.isArray(m07Rows)) {
    throw new Error("m07_diagnostic.results must be an array");
  }
  const real = (method: string) => requiredObject(realResults[method], `real_market/${method}`);
  const realTest = (method: string) => {
    const row = realSummaryTests.find(
      (item) => typeof item === "object" && item !== null && (item as JsonObject).module === method,
    );
    return row ? requiredObject(row, `real_market_summary.tests.${method}`) : undefined;
  };
  const realGate = (method: string) =>
    requiredText(
      realTest(method)?.gate_status ?? real(method).gate_status,
      `${method}.gate_status`,
    );
  const m09Events = real("M09").events;

  const receipts: MethodReceipt[] = [
    methodReceipt(
      "M01",
      "real_market_contract",
      `${requiredText(benchmarkData.fromDate, "benchmarkData.fromDate")}..${requiredText(benchmarkData.toDate, "benchmarkData.toDate")}`,
      [localBenchmark],
      [requiredText(benchmarkData.source, "benchmarkData.source")],
      "completed",
      localSourcesReady,
      checkBooleans(benchmarkChecks, "benchmark.checks"),
      "research_only_quality_gate",
      {
        alignedObservations: benchmarkData.alignedObservations,
        sourceAsOf: benchmarkData.asOf,
        requiredOutputChecks: "source, timestamp, baseline, cost, periods, uncertainty, boundary",
      },
    ),
    methodReceipt(
      "M02",
      "real_market_backtest",
      `${requiredText(benchmarkData.fromDate, "benchmarkData.fromDate")}..${requiredText(benchmarkData.toDate, "benchmarkData.toDate")}`,
      [localBenchmark, localStress, artifact(external("experiments/m02_results.json"))],
      [requiredText(benchmarkData.source, "benchmarkData.source"), "Yahoo Finance chart API"],
      "research_candidate",
      localSourcesReady && strategySourcesReady("M02", m02),
      checkBooleans(benchmarkChecks, "benchmark.checks") &&
        Number(stressSummary.variantCount) === expectedM02StressVariantKeys.size &&
        m02StressVariantRowsComplete,
      "research_only_no_outperformance",
      {
        baseline: requiredObject(m02Base.metric, "benchmark buy_hold.metric"),
        enriched: requiredObject(m02Portfolio.metric, "benchmark trend_breadth_gate.metric"),
        stress: m02Stress,
        historicalProxyRuns: m02.results,
      },
    ),
    methodReceipt(
      "M03",
      "real_market_diagnostic",
      sourceWindow(real("M03"), "2018-01-03..2026-09-08"),
      [
        artifact(external("experiments/real_market/m03_real_market.json")),
        artifact(external("experiments/real_market/real_market_summary.json")),
      ],
      ["Yahoo Finance chart API"],
      requiredText(real("M03").stage, "M03.stage"),
      realYahooReady("M03", real("M03")),
      checkBooleans(real("M03").checks, "M03.checks"),
      realGate("M03"),
      {
        signalCount: real("M03").signal_count,
        activeSignalMetrics: real("M03").net_metrics_on_active_signals,
      },
    ),
    methodReceipt(
      "M04",
      "real_market_diagnostic",
      sourceWindow(real("M04"), "2018-02-28..2026-09-09"),
      [
        artifact(external("experiments/real_market/m04_real_market.json")),
        artifact(external("experiments/real_market/real_market_summary.json")),
      ],
      ["Yahoo Finance chart API"],
      requiredText(real("M04").stage, "M04.stage"),
      realYahooReady("M04", real("M04")),
      checkBooleans(real("M04").checks, "M04.checks"),
      realGate("M04"),
      {
        trackingErrorRmseOos: real("M04").tracking_error_rmse_oos,
        regimeBreakRatio: real("M04").regime_break_ratio,
      },
    ),
    methodReceipt(
      "M05",
      "real_market_backtest",
      sourceWindow(m05, "2005-01-01..2026-09-09"),
      [
        artifact(external("experiments/m05_results.json")),
        artifact(external("experiments/manifest.json")),
      ],
      ["Yahoo Finance chart API"],
      requiredText(m05.stage, "m05.stage"),
      strategySourcesReady("M05", m05),
      m05Medium.length === 2 &&
        m05Medium.every(
          (row) => requiredObject(row.long_short, "M05.long_short").metrics !== undefined,
        ),
      "research_only_negative_or_unstable_delta",
      {
        mediumCost: m05Medium.map((row) => ({
          lookbackMonths: row.lookback_months,
          delta: row.delta_vs_long_only,
          metrics: requiredObject(row.long_short, "M05.long_short").metrics,
        })),
      },
    ),
    methodReceipt(
      "M06",
      "real_market_backtest",
      sourceWindow(m06, "2005-01-01..2026-09-09"),
      [
        artifact(external("experiments/m06_results.json")),
        artifact(external("experiments/manifest.json")),
      ],
      ["Yahoo Finance chart API"],
      requiredText(m06.stage, "m06.stage"),
      strategySourcesReady("M06", m06),
      m06Medium.length === 2 &&
        m06Medium.every((row) => requiredObject(row, "M06.row").metrics !== undefined),
      "research_only_high_turnover_and_drawdown",
      {
        mediumCost: m06Medium.map((row) => ({
          lookbackDays: row.lookback_days,
          metrics: row.metrics,
        })),
      },
    ),
    methodReceipt(
      "M07",
      "real_market_diagnostic",
      sourceWindow(m07, "2005-01-01..2026-09-09"),
      [
        artifact(external("experiments/m07_diagnostic.json")),
        artifact(external("experiments/manifest.json")),
      ],
      ["Yahoo Finance chart API"],
      requiredText(m07.stage, "m07.stage"),
      strategySourcesReady("M07", m07),
      m07Rows.length === 18,
      requiredText(m07.gate_status, "m07.gate_status"),
      {
        rows: m07Rows.length,
        maximumSignalObservations: Math.max(
          ...m07Rows.map((row) => Number((row as JsonObject).signal_observations ?? 0)),
        ),
      },
    ),
    methodReceipt(
      "M08",
      "real_market_diagnostic",
      sourceWindow(real("M08"), "2018-01-03..2026-09-09"),
      [
        artifact(external("experiments/real_market/m08_real_market.json")),
        artifact(external("experiments/real_market/real_market_summary.json")),
      ],
      ["Yahoo Finance chart API"],
      requiredText(real("M08").stage, "M08.stage"),
      realYahooReady("M08", real("M08")),
      checkBooleans(real("M08").checks, "M08.checks"),
      realGate("M08"),
      { netMetrics: real("M08").net_metrics, stress: real("M08").credit_relative_stress },
    ),
    methodReceipt(
      "M09",
      "real_market_diagnostic",
      "2025-03-07..2026-06-22 announced events",
      [
        artifact(external("experiments/real_market/m09_real_market.json")),
        artifact(external("experiments/real_market/real_market_summary.json")),
      ],
      ["S&P Global official announcements", "Yahoo Finance chart API"],
      requiredText(real("M09").stage, "M09.stage"),
      realYahooReady("M09", real("M09")) && eventSourcesReady,
      checkBooleans(real("M09").checks, "M09.checks"),
      realGate("M09"),
      { eventCount: Array.isArray(m09Events) ? m09Events.length : 0 },
    ),
    methodReceipt(
      "M10",
      "real_market_diagnostic",
      requiredText(real("M10").quote_timestamp ?? "2026-09-10 snapshot", "M10.quote_timestamp"),
      [
        artifact(external("experiments/real_market/m10_real_market.json")),
        artifact(external("experiments/real_market/real_market_summary.json")),
      ],
      ["Cboe delayed options quote API"],
      requiredText(real("M10").stage, "M10.stage"),
      cboeReady(real("M10")),
      checkBooleans(real("M10").checks, "M10.checks"),
      realGate("M10"),
      { put: real("M10").put, scenarios: real("M10").scenarios },
    ),
    methodReceipt(
      "M11",
      "real_market_diagnostic",
      requiredText(real("M11").quote_timestamp ?? "2026-09-10 snapshot", "M11.quote_timestamp"),
      [
        artifact(external("experiments/real_market/m11_real_market.json")),
        artifact(external("experiments/real_market/real_market_summary.json")),
      ],
      ["Cboe delayed options quote API"],
      requiredText(real("M11").stage, "M11.stage"),
      cboeReady(real("M11")),
      checkBooleans(real("M11").checks, "M11.checks"),
      realGate("M11"),
      {
        contractPair: real("M11").contract_pair,
        greeks: real("M11").greeks_sum,
        scenarios: real("M11").scenarios,
      },
    ),
    methodReceipt(
      "M12",
      "real_market_backtest",
      `${requiredText(benchmarkData.fromDate, "benchmarkData.fromDate")}..${requiredText(benchmarkData.toDate, "benchmarkData.toDate")}`,
      [localBenchmark, localStress],
      [requiredText(benchmarkData.source, "benchmarkData.source")],
      "research_candidate",
      localSourcesReady,
      checkBooleans(benchmarkChecks, "benchmark.checks") &&
        Boolean(benchmarkChecks.commonExposureBreadthGate),
      "research_only_drawdown_tradeoff_without_alpha",
      {
        baseline: requiredObject(m02Base.metric, "benchmark buy_hold.metric"),
        breadthGate: requiredObject(m02Portfolio.metric, "benchmark trend_breadth_gate.metric"),
        stress: m02Stress,
      },
    ),
  ];
  const ids = receipts.map((item) => item.method);
  if (ids.length !== STRATEGY_METHOD_IDS.length || new Set(ids).size !== ids.length) {
    throw new Error(`method coverage mismatch: ${ids.join(",")}`);
  }
  return Object.freeze(receipts);
}

function configuredRoot(value: string | undefined, environment: string, label: string): string {
  const raw = value?.trim() || process.env[environment]?.trim();
  if (!raw) {
    throw new Error(`${label} is required; pass it explicitly or set ${environment}`);
  }
  return path.resolve(raw);
}

export async function buildAllMethodsReceipt(
  options: AllMethodsReceiptOptions = {},
): Promise<AllMethodsReceipt> {
  const inputRoot = configuredRoot(
    options.inputRoot,
    "LCX_FINANCE_STRATEGY_INPUT_ROOT",
    "finance strategy input root",
  );
  const researchRoot = configuredRoot(
    options.researchRoot,
    "LCX_TRADER_STRATEGY_RESEARCH_ROOT",
    "trader strategy research root",
  );
  const benchmarkPath = path.join(inputRoot, "benchmark-20260910.json");
  const stressPath = path.join(inputRoot, "stress-matrix-12us-20260910.json");
  const strategyManifestPath = path.join(researchRoot, "experiments/manifest.json");
  const [benchmark, stress, strategyManifest, m02, m05, m06, m07, realSummary, ...realResults] =
    await Promise.all([
      readJson(benchmarkPath),
      readJson(stressPath),
      readJson(strategyManifestPath),
      readJson(path.join(researchRoot, "experiments/m02_results.json")),
      readJson(path.join(researchRoot, "experiments/m05_results.json")),
      readJson(path.join(researchRoot, "experiments/m06_results.json")),
      readJson(path.join(researchRoot, "experiments/m07_diagnostic.json")),
      readJson(path.join(researchRoot, "experiments/real_market/real_market_summary.json")),
      ...STRATEGY_METHOD_IDS.filter((id) =>
        ["M03", "M04", "M08", "M09", "M10", "M11"].includes(id),
      ).map((id) =>
        readJson(
          path.join(researchRoot, `experiments/real_market/${id.toLowerCase()}_real_market.json`),
        ),
      ),
    ]);
  const realById = Object.fromEntries(
    ["M03", "M04", "M08", "M09", "M10", "M11"].map((id, index) => [id, realResults[index]]),
  );
  const methods = buildMethods(
    benchmark,
    stress,
    strategyManifest,
    m02,
    m05,
    m06,
    m07,
    realSummary,
    realById,
    researchRoot,
    inputRoot,
    await readCboeSnapshot(researchRoot),
    await readNativeEvidence(researchRoot, strategyManifest, realSummary),
  );
  const checks = Object.freeze({
    completeCatalog:
      methods.length === STRATEGY_METHOD_IDS.length &&
      methods.every((item, index) => item.method === STRATEGY_METHOD_IDS[index]),
    everyMethodHasEvidence: methods.every((item) => item.checksPass),
    everyMethodHasSourceReceipt: methods.every(
      (item) => item.sourceReceiptsReady && item.sourceArtifacts.length > 0,
    ),
    everyMethodHasExplicitGate: methods.every((item) => item.gateStatus.length > 0),
    noProfitClaim: true as const,
    noModelLearningClaim: true as const,
    executionAuthority: "none" as const,
  });
  if (
    !checks.completeCatalog ||
    !checks.everyMethodHasEvidence ||
    !checks.everyMethodHasSourceReceipt ||
    !checks.everyMethodHasExplicitGate
  ) {
    throw new Error(`all-method contract failed: ${JSON.stringify(checks)}`);
  }
  return Object.freeze({
    schemaVersion: "lcx_finance_strategy_all_methods_v2",
    status: "completed",
    boundary: "research_only_no_execution",
    runAt: new Date().toISOString(),
    methodCount: methods.length,
    methods,
    checks,
  });
}

function parseCliOptions(args: readonly string[]): CliOptions {
  const options: { inputRoot?: string; researchRoot?: string; out?: string } = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (
      (flag !== "--input-root" && flag !== "--research-root" && flag !== "--out") ||
      !value?.trim() ||
      value.startsWith("--")
    ) {
      throw new Error(
        "Usage: finance-strategy-all-methods --input-root PATH --research-root PATH [--out PATH]",
      );
    }
    if (flag === "--input-root") {
      options.inputRoot = path.resolve(value);
    } else if (flag === "--research-root") {
      options.researchRoot = path.resolve(value);
    } else {
      options.out = path.resolve(value);
    }
  }
  return options;
}

function parseOutputPath(args: readonly string[]): string | undefined {
  return parseCliOptions(args).out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  Promise.resolve()
    .then(async () => {
      const options = parseCliOptions(process.argv.slice(2));
      const receipt = await buildAllMethodsReceipt(options);
      const json = `${JSON.stringify(receipt, null, 2)}\n`;
      if (options.out) {
        await fs.writeFile(options.out, json, "utf8");
      }
      process.stdout.write(
        options.out
          ? `all_method_receipt_ok methods=${receipt.methodCount} output=${options.out}\n`
          : json,
      );
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `all_method_receipt_blocked: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}

export const __test = {
  buildMethods,
  requiredText,
  sourceGroupReady,
  sourceGroupReadyForResult,
  localBenchmarkSourcesReady,
  cboeSourceReady,
  readCboeSnapshot,
  historicalRequirements,
  historicalSourcesReady,
  officialEventSourcesReady,
  readNativeEvidence,
  parseOutputPath,
  parseCliOptions,
};
