/**
 * Chooses the trading universe from observed data and writes a DRAFT rule declaration.
 *
 * This deliberately stops at "draft". Selecting a universe is not the same as being allowed to
 * trade it, so activation stays a separate, explicit step.
 *
 * Pipeline, all observable, no model calls:
 *   venue tradable assets -> structural screen -> real dollar-volume screen
 *   -> EOD history the strategy actually trades on -> volatility / liquidity eligibility
 *   -> correlation-based diversification -> draft declaration
 *
 * Usage:
 *   node --import tsx scripts/operator/lcx-finance-universe-select.ts [--json] \
 *     [--screen N] [--refresh-assets] [--write-rule] [--write-snapshot]
 *
 * `--screen` bounds the candidate work sent to external data sources. Final membership is
 * determined by measured eligibility and diversification, not by a requested symbol count.
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { appendFinanceBars, type FinanceBarAppend } from "../../src/agents/finance-bar-ledger.js";
import { resolveFinanceCredentialEnv } from "../../src/agents/finance-credential-env.js";
import {
  isFinanceUsEquityDailyBarComplete,
  latestCompletedWeekdaySessionDate,
  financeUsEquityRegularCloseInstant,
} from "../../src/agents/finance-cycle-schedule.js";
import { createChinaReachableUsEodHistoryCollectionAdapter } from "../../src/agents/finance-free-market-collection-adapters.js";
import type { FinanceMarketCollectionItem } from "../../src/agents/finance-market-collection-registry.js";
import { resolveFinanceStateDir } from "../../src/agents/finance-state-dir.js";
import {
  DEFAULT_UNIVERSE_THRESHOLDS,
  DEFAULT_UNIVERSE_SCREEN_SIZE,
  FINANCE_UNIVERSE_SELECTION_SCHEMA,
  FINANCE_UNIVERSE_SELECTION_FRESHNESS_BASIS,
  FINANCE_UNIVERSE_SELECTION_SNAPSHOT_FILENAME,
  FINANCE_UNIVERSE_SELECTION_SOURCES,
  MAX_UNIVERSE_SCREEN_SIZE,
  filterUniverseAssets,
  logReturnSeries,
  orderSelectedUniverseMetrics,
  rankByDollarVolume,
  selectDiversifiedUniverseWithEvidence,
  summariseUniverseSeries,
  universeRejectionReason,
  type UniverseAsset,
  type UniverseBar,
  type UniverseMetrics,
  type UniverseQuote,
} from "../../src/agents/finance-universe-selection.js";
import { saveJsonFile } from "../../src/infra/json-file.js";

const ASSETS_URL = "https://paper-api.alpaca.markets/v2/assets?status=active&asset_class=us_equity";
const SNAPSHOT_BATCH = 500;
const HISTORY_LIMIT = 1200;
const MAX_ASSET_AGE_DAYS = 7;
const CONCURRENCY = 6;

export type ValidatedUniverseEodBatch = Readonly<{
  instrument: string;
  bars: readonly Readonly<{
    date: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume?: number;
  }>[];
  observedAt: string;
  providerName: string;
  sourceUrlOrArtifact: string;
}>;

type ValidatedUniverseEodHistory = Readonly<{
  seriesBars: readonly UniverseBar[];
  batches: readonly ValidatedUniverseEodBatch[];
  issues: readonly string[];
}>;

type FiledUniverseEodBatch = Readonly<{
  symbol: string;
  providerName: string;
  sourceUrlOrArtifact: string;
  observedAt: string;
  barCount: number;
  newBarCount: number;
  headRef: string | null;
}>;

function finiteNumericValue(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Keep usable close observations while separately preparing the complete OHLC subset to file. */
export function validateUniverseEodBatch(
  instrument: string,
  rows: readonly FinanceMarketCollectionItem[],
  asOf: string,
): ValidatedUniverseEodHistory {
  const expectedSymbol = instrument.toUpperCase();
  type OhlcvBar = ValidatedUniverseEodBatch["bars"][number];
  type SourceGroup = {
    providerName: string;
    sourceUrlOrArtifact: string;
    observedAt: string;
    observedAtMs: number;
    barsByDate: Map<string, OhlcvBar>;
  };
  const closeObservations = new Map<string, Set<string>>();
  const ohlcvObservations = new Map<string, Set<string>>();
  const sourceGroups = new Map<string, SourceGroup>();
  const issues: string[] = [];
  let additionalIssueCount = 0;
  const addIssue = (message: string): void => {
    if (issues.length < 20) {
      issues.push(message);
    } else {
      additionalIssueCount += 1;
    }
  };

  for (const row of rows) {
    const date = row.data.date;
    if (
      row.collection !== "eod_history" ||
      typeof date !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/u.test(date)
    ) {
      addIssue(`${expectedSymbol}: skipped EOD row with invalid identity or date`);
      continue;
    }
    if (row.data.symbol !== expectedSymbol) {
      addIssue(`${expectedSymbol}@${date}: skipped EOD row with symbol mismatch`);
      continue;
    }
    const close = finiteNumericValue(row.data.close);
    const closeInstant = financeUsEquityRegularCloseInstant(date);
    if (
      closeInstant === undefined ||
      !isFinanceUsEquityDailyBarComplete(date, asOf) ||
      close === undefined ||
      close <= 0
    ) {
      addIssue(`${expectedSymbol}@${date}: skipped invalid, future, or incomplete close row`);
      continue;
    }
    const volumeValue = row.data.volume;
    const volume = finiteNumericValue(volumeValue);
    const usableVolume = volume !== undefined && volume >= 0 ? volume : undefined;
    if (volumeValue !== undefined && usableVolume === undefined) {
      addIssue(`${expectedSymbol}@${date}: ignored invalid volume for close-based selection`);
    }
    const closeKey = JSON.stringify([close, usableVolume ?? null]);
    const closeValues = closeObservations.get(date) ?? new Set<string>();
    closeValues.add(closeKey);
    closeObservations.set(date, closeValues);

    const sourceTimestampMs = Date.parse(row.sourceTimestamp);
    const observedAtMs = Date.parse(row.observedAt);
    if (
      closeInstant === undefined ||
      !Number.isFinite(sourceTimestampMs) ||
      sourceTimestampMs !== Date.parse(closeInstant) ||
      sourceTimestampMs > Date.parse(asOf) ||
      !Number.isFinite(observedAtMs) ||
      typeof row.providerName !== "string" ||
      row.providerName.trim().length === 0 ||
      typeof row.sourceUrlOrArtifact !== "string" ||
      row.sourceUrlOrArtifact.trim().length === 0
    ) {
      addIssue(`${expectedSymbol}@${date}: close usable, but source attribution is incomplete`);
      continue;
    }

    const { open, high, low } = row.data;
    const typedVolume = typeof volumeValue === "number" ? volumeValue : undefined;
    const volumeIsValid =
      volumeValue === undefined ||
      (typedVolume !== undefined && Number.isFinite(typedVolume) && typedVolume >= 0);
    if (
      typeof open !== "number" ||
      !Number.isFinite(open) ||
      open <= 0 ||
      typeof high !== "number" ||
      !Number.isFinite(high) ||
      high <= 0 ||
      typeof low !== "number" ||
      !Number.isFinite(low) ||
      low <= 0 ||
      typeof row.data.close !== "number" ||
      !Number.isFinite(row.data.close) ||
      !volumeIsValid
    ) {
      addIssue(`${expectedSymbol}@${date}: close usable, but incomplete OHLCV was not filed`);
      continue;
    }
    if (low > Math.min(open, close) || high < Math.max(open, close)) {
      addIssue(`${expectedSymbol}@${date}: close usable, but contradictory OHLC was not filed`);
      continue;
    }
    const bar: OhlcvBar = {
      date,
      open,
      high,
      low,
      close: row.data.close,
      ...(typedVolume === undefined ? {} : { volume: typedVolume }),
    };
    const ohlcvValues = ohlcvObservations.get(date) ?? new Set<string>();
    ohlcvValues.add(JSON.stringify(bar));
    ohlcvObservations.set(date, ohlcvValues);
    const sourceKey = JSON.stringify([row.providerName, row.sourceUrlOrArtifact]);
    const group = sourceGroups.get(sourceKey) ?? {
      providerName: row.providerName,
      sourceUrlOrArtifact: row.sourceUrlOrArtifact,
      observedAt: row.observedAt,
      observedAtMs,
      barsByDate: new Map<string, OhlcvBar>(),
    };
    if (observedAtMs > group.observedAtMs) {
      group.observedAt = row.observedAt;
      group.observedAtMs = observedAtMs;
    }
    group.barsByDate.set(date, bar);
    sourceGroups.set(sourceKey, group);
  }

  const conflictedCloseDates = new Set<string>();
  const conflictedOhlcvDates = new Set<string>();
  for (const [date, values] of closeObservations) {
    if (values.size > 1) {
      conflictedCloseDates.add(date);
      addIssue(`${expectedSymbol}@${date}: conflicting close observations were excluded`);
    }
  }
  for (const [date, values] of ohlcvObservations) {
    if (values.size > 1) {
      conflictedOhlcvDates.add(date);
      addIssue(`${expectedSymbol}@${date}: conflicting OHLC observations were not filed`);
    }
  }

  const seriesBars = [...closeObservations]
    .filter(([date, values]) => !conflictedCloseDates.has(date) && values.size === 1)
    .map(([date, values]) => {
      const key = values.values().next().value as string;
      const [close, volume] = JSON.parse(key) as [number, number | null];
      return { date, close, ...(volume === null ? {} : { volume }) };
    })
    .toSorted((left, right) => left.date.localeCompare(right.date));
  const batches = [...sourceGroups.values()]
    .map((group) => ({
      instrument: expectedSymbol,
      bars: [...group.barsByDate]
        .filter(([date]) => !conflictedCloseDates.has(date) && !conflictedOhlcvDates.has(date))
        .map(([, bar]) => bar)
        .toSorted((left, right) => left.date.localeCompare(right.date)),
      observedAt: group.observedAt,
      providerName: group.providerName,
      sourceUrlOrArtifact: group.sourceUrlOrArtifact,
    }))
    .filter((batch) => batch.bars.length > 0);
  if (rows.length === 0) {
    addIssue(`${expectedSymbol}: no EOD rows were collected`);
  } else if (batches.length === 0) {
    addIssue(`${expectedSymbol}: no complete OHLCV rows were available to file`);
  }
  if (additionalIssueCount > 0) {
    issues.push(`${additionalIssueCount} additional EOD row issues omitted`);
  }
  return Object.freeze({
    seriesBars: Object.freeze(seriesBars),
    batches: Object.freeze(batches),
    issues: Object.freeze(issues),
  });
}

/** Append an already validated collection batch using the canonical bar ledger contract. */
export function appendUniverseEodBatch(
  directory: string,
  batch: ValidatedUniverseEodBatch,
): Promise<FinanceBarAppend> {
  return appendFinanceBars(directory, {
    instrument: batch.instrument,
    derivation: "ohlcv",
    provenance: {
      origin: batch.providerName,
      sourceUrlOrArtifact: batch.sourceUrlOrArtifact,
      note:
        `${String(batch.bars.length)} daily bars collected by the unattended universe selector; ` +
        "end-of-day, research-only, not execution-grade; already-recorded identical bars are not filed again",
    },
    observedAt: batch.observedAt,
    bars: [...batch.bars],
  });
}

export type UniverseSelectOptions = Readonly<{
  json: boolean;
  screen: number;
  refreshAssets: boolean;
  writeRule: boolean;
  writeSnapshot: boolean;
  directory?: string;
}>;

export function parseUniverseSelectArgs(argv: readonly string[]): UniverseSelectOptions {
  const options: {
    json: boolean;
    screen: number;
    refreshAssets: boolean;
    writeRule: boolean;
    writeSnapshot: boolean;
    directory?: string;
  } = {
    json: false,
    screen: DEFAULT_UNIVERSE_SCREEN_SIZE,
    refreshAssets: false,
    writeRule: false,
    writeSnapshot: false,
    directory: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--screen") {
      const screen = Number(next);
      if (!Number.isSafeInteger(screen) || screen < 1 || screen > MAX_UNIVERSE_SCREEN_SIZE) {
        throw new Error(`--screen must be a positive integer <= ${MAX_UNIVERSE_SCREEN_SIZE}`);
      }
      options.screen = screen;
      index += 1;
    } else if (arg === "--target") {
      throw new Error(
        "--target is no longer supported; final universe size is evidence-driven, and --screen is only a candidate-work ceiling",
      );
    } else if (arg === "--refresh-assets") {
      options.refreshAssets = true;
    } else if (arg === "--write-rule") {
      options.writeRule = true;
    } else if (arg === "--write-snapshot") {
      options.writeSnapshot = true;
    } else if (arg === "--dir") {
      options.directory = next;
      index += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return Object.freeze(options);
}

function alpacaHeaders(): Record<string, string> {
  const env = resolveFinanceCredentialEnv(process.env) as Record<string, unknown>;
  const keyId = typeof env.ALPACA_API_KEY_ID === "string" ? env.ALPACA_API_KEY_ID.trim() : "";
  const secret =
    typeof env.ALPACA_API_SECRET_KEY === "string" ? env.ALPACA_API_SECRET_KEY.trim() : "";
  if (!keyId || !secret) {
    throw new Error("Alpaca credentials are not configured");
  }
  return {
    "APCA-API-KEY-ID": keyId,
    "APCA-API-SECRET-KEY": secret,
    accept: "application/json",
  };
}

/**
 * Returns the cached asset list when it is both fresh and readable, and `null` otherwise.
 *
 * A cache that cannot be parsed is answered with `null`, not with an error. Freshness only looks
 * at existence and mtime, so a half-written cache - left behind because the previous run wrote it
 * non-atomically and was interrupted - would otherwise throw on every later run until somebody
 * deleted the file by hand. "Cannot read it" and "it is empty" have to be different answers, and
 * neither may be "the command is broken until you intervene".
 */
export function readFreshAssetCache(cachePath: string): UniverseAsset[] | null {
  if (!fs.existsSync(cachePath)) {
    return null;
  }
  const ageMs = Date.now() - fs.statSync(cachePath).mtimeMs;
  if (ageMs >= MAX_ASSET_AGE_DAYS * 86_400_000) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    return Array.isArray(parsed) ? (parsed as UniverseAsset[]) : null;
  } catch {
    process.stderr.write(`asset cache ${cachePath} could not be parsed; refetching\n`);
    return null;
  }
}

export function writeAssetCache(cachePath: string, assets: readonly UniverseAsset[]): void {
  // saveJsonFile writes a sibling temp file and renames it into place, so an interrupted run
  // leaves the previous cache intact instead of a truncated one.
  saveJsonFile(cachePath, assets);
}

async function loadAssets(cachePath: string, refresh: boolean): Promise<UniverseAsset[]> {
  if (!refresh) {
    const cached = readFreshAssetCache(cachePath);
    if (cached) {
      return cached;
    }
  }
  const started = Date.now();
  const response = await fetch(ASSETS_URL, {
    headers: alpacaHeaders(),
    signal: AbortSignal.timeout(120_000),
  });
  if (response.status !== 200) {
    throw new Error(`asset list returned ${response.status}`);
  }
  const raw = (await response.json()) as UniverseAsset[];
  writeAssetCache(cachePath, raw);
  process.stderr.write(`fetched ${raw.length} assets in ${Date.now() - started}ms\n`);
  return raw;
}

async function loadQuotes(
  symbols: readonly string[],
  asOf: string,
): Promise<Record<string, UniverseQuote>> {
  const headers = alpacaHeaders();
  const out: Record<string, UniverseQuote> = {};
  for (let index = 0; index < symbols.length; index += SNAPSHOT_BATCH) {
    const batch = symbols.slice(index, index + SNAPSHOT_BATCH);
    const response = await fetch(
      `https://data.alpaca.markets/v2/stocks/snapshots?symbols=${batch.join(",")}`,
      { headers, signal: AbortSignal.timeout(60_000) },
    );
    if (response.status !== 200) {
      throw new Error(`snapshot batch ${index / SNAPSHOT_BATCH + 1} returned ${response.status}`);
    }
    const parsed = (await response.json()) as Record<
      string,
      {
        dailyBar?: { t?: string; c?: number; v?: number };
        prevDailyBar?: { t?: string; c?: number; v?: number };
      }
    >;
    for (const [symbol, value] of Object.entries(parsed)) {
      // Use today's bar only after its regular session is complete; otherwise use the previous
      // completed bar. Partial current-session volume must never bias the candidate screen. Final
      // ranking still uses multi-year median dollar volume from complete EOD history.
      const current = value?.dailyBar;
      const previous = value?.prevDailyBar;
      const currentDate = typeof current?.t === "string" ? current.t.slice(0, 10) : "";
      const previousDate = typeof previous?.t === "string" ? previous.t.slice(0, 10) : "";
      const bar =
        currentDate && isFinanceUsEquityDailyBarComplete(currentDate, asOf)
          ? current
          : previousDate && isFinanceUsEquityDailyBarComplete(previousDate, asOf)
            ? previous
            : undefined;
      out[symbol] = {
        close: bar?.c,
        volume: bar?.v,
        ...(bar === current && currentDate
          ? { sessionDate: currentDate }
          : bar === previous && previousDate
            ? { sessionDate: previousDate }
            : {}),
      };
    }
  }
  return out;
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) {
        return;
      }
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

export async function runUniverseSelect(argv: readonly string[] = process.argv.slice(2)) {
  const options = parseUniverseSelectArgs(argv);
  const directory = options.directory ?? resolveFinanceStateDir().directory;
  const cachePath = path.join(directory, "alpaca-assets.json");

  const assets = await loadAssets(cachePath, options.refreshAssets);
  const candidates = filterUniverseAssets(assets);
  const symbols = candidates.map((asset) => asset.symbol);

  const asOf = new Date().toISOString();
  const quotes = await loadQuotes(symbols, asOf);
  const ranked = rankByDollarVolume(quotes);
  const sessionDateCounts = new Map<string, number>();
  for (const quote of Object.values(quotes)) {
    const sessionDate = quote.sessionDate;
    if (typeof sessionDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(sessionDate)) {
      continue;
    }
    sessionDateCounts.set(sessionDate, (sessionDateCounts.get(sessionDate) ?? 0) + 1);
  }
  const liquiditySessionDates = [...sessionDateCounts.keys()].toSorted();
  const latestLiquiditySessionDate = liquiditySessionDates.at(-1);
  if (!latestLiquiditySessionDate) {
    throw new Error("previous completed-session liquidity data is missing; no universe selected");
  }
  const expectedLiquiditySessionDate = latestCompletedWeekdaySessionDate(asOf);
  if (latestLiquiditySessionDate !== expectedLiquiditySessionDate) {
    throw new Error(
      `latest observed liquidity session ${latestLiquiditySessionDate} does not match expected completed session ${expectedLiquiditySessionDate}; no universe selected`,
    );
  }
  const latestSessionRanked = ranked.filter(
    (entry) => entry.sessionDate === latestLiquiditySessionDate,
  );
  if (latestSessionRanked.length === 0) {
    throw new Error(
      "latest completed-session liquidity data has no usable dollar-volume bars; no universe selected",
    );
  }
  const sessionDateDistribution = liquiditySessionDates.map((sessionDate) => ({
    sessionDate,
    quoteCount: sessionDateCounts.get(sessionDate) ?? 0,
  }));
  const excludedOlderSessionBarCount = sessionDateDistribution
    .filter((entry) => entry.sessionDate < latestLiquiditySessionDate)
    .reduce((count, entry) => count + entry.quoteCount, 0);
  const excludedOlderCandidateCount = ranked.filter((entry) => {
    const sessionDate = entry.sessionDate;
    return (
      typeof sessionDate === "string" &&
      /^\d{4}-\d{2}-\d{2}$/u.test(sessionDate) &&
      sessionDate < latestLiquiditySessionDate
    );
  }).length;
  const screened = latestSessionRanked.slice(0, options.screen).map((entry) => entry.symbol);

  const adapter = createChinaReachableUsEodHistoryCollectionAdapter();
  const series = new Map<string, UniverseBar[]>();
  const validatedHistory = new Map<string, readonly ValidatedUniverseEodBatch[]>();
  const unreadable: string[] = [];
  const historyCollectionFailures: { symbol: string; error: string }[] = [];
  const historyWriteFailures: { symbol: string; error: string }[] = [];
  const filedHistoryBatches: FiledUniverseEodBatch[] = [];
  let filedBarCount = 0;

  await mapWithConcurrency(screened, CONCURRENCY, async (symbol) => {
    try {
      const rows = await adapter.collect(
        {
          instrument: symbol,
          assetClass: "us_equity",
          collection: "eod_history",
          asOf,
          limit: HISTORY_LIMIT,
        },
        AbortSignal.timeout(60_000),
      );
      const history = validateUniverseEodBatch(symbol, rows, asOf);
      validatedHistory.set(symbol, history.batches);
      series.set(symbol, [...history.seriesBars]);
      historyCollectionFailures.push(...history.issues.map((error) => ({ symbol, error })));
      if (history.seriesBars.length === 0) {
        unreadable.push(symbol);
      }
    } catch (failure) {
      unreadable.push(symbol);
      historyCollectionFailures.push({
        symbol,
        error: failure instanceof Error ? failure.message : String(failure),
      });
    }
  });

  const metrics: UniverseMetrics[] = [];
  const rejected: { symbol: string; reason: string }[] = [];
  for (const symbol of screened) {
    const bars = series.get(symbol);
    if (!bars || bars.length === 0) {
      rejected.push({ symbol, reason: "no EOD history from the strategy's own data source" });
      continue;
    }
    const summary = summariseUniverseSeries(symbol, bars);
    metrics.push(summary);
    const reason = universeRejectionReason(summary, DEFAULT_UNIVERSE_THRESHOLDS);
    if (reason) {
      rejected.push({ symbol, reason });
    }
  }

  const eligible = metrics.filter(
    (entry) => universeRejectionReason(entry, DEFAULT_UNIVERSE_THRESHOLDS) === "",
  );
  const ordered = [...eligible].toSorted((a, b) => b.medianDollarVolume - a.medianDollarVolume);
  const selectionEvidence = selectDiversifiedUniverseWithEvidence(
    ordered.map((entry) => ({
      symbol: entry.symbol,
      returns: logReturnSeries((series.get(entry.symbol) ?? []).map((bar) => bar.close)),
    })),
    { maxCorrelation: 0.9 },
  );
  const selected = selectionEvidence.selected;
  const generatedAt = new Date().toISOString();
  if (latestLiquiditySessionDate !== latestCompletedWeekdaySessionDate(generatedAt)) {
    throw new Error(
      "latest completed session changed while selecting the universe; no snapshot or rule written",
    );
  }

  if (options.writeSnapshot) {
    for (const symbol of selected) {
      for (const batch of validatedHistory.get(symbol) ?? []) {
        try {
          const filed = await appendUniverseEodBatch(directory, batch);
          const newBarCount = batch.bars.length - filed.repeatsSkipped;
          filedBarCount += newBarCount;
          filedHistoryBatches.push({
            symbol,
            providerName: batch.providerName,
            sourceUrlOrArtifact: batch.sourceUrlOrArtifact,
            observedAt: batch.observedAt,
            barCount: batch.bars.length,
            newBarCount,
            headRef: filed.headRef,
          });
        } catch (failure) {
          historyWriteFailures.push({
            symbol,
            error: failure instanceof Error ? failure.message : String(failure),
          });
        }
      }
    }
  }

  const result = {
    schemaVersion: FINANCE_UNIVERSE_SELECTION_SCHEMA,
    asOf,
    generatedAt,
    modelCalls: 0,
    sources: FINANCE_UNIVERSE_SELECTION_SOURCES,
    freshnessBasis: FINANCE_UNIVERSE_SELECTION_FRESHNESS_BASIS,
    assetCount: assets.length,
    candidateCount: candidates.length,
    screenedCount: screened.length,
    screenLimit: options.screen,
    liquidityPreScreen: {
      basis: "latest_completed_regular_session",
      source: "alpaca_snapshot.dailyBar_or_prevDailyBar.close_times_volume",
      sessionDate: latestLiquiditySessionDate,
      sessionDateDistribution,
      excludedOlderSessionBarCount,
      excludedOlderCandidateCount,
    },
    unreadableCount: unreadable.length,
    historyCollectionFailures,
    eligibleCount: ordered.length,
    selected,
    selectionEvidence: {
      method: "liquidity_seed_then_iterative_minimum_worst_correlation",
      maxCorrelation: 0.9,
      selected: selectionEvidence.selectedEvidence,
      excluded: selectionEvidence.exclusions,
    },
    // Metrics of the selected symbols, straight from the screened set — never a `{ symbol }`
    // placeholder, which would make every numeric column silently unprintable.
    selectedMetrics: orderSelectedUniverseMetrics(selected, ordered),
    thresholds: DEFAULT_UNIVERSE_THRESHOLDS,
    rejected,
    canonicalBarPersistence: {
      status: options.writeSnapshot
        ? historyWriteFailures.length > 0
          ? filedHistoryBatches.length > 0
            ? "partial"
            : "failed"
          : historyCollectionFailures.length > 0
            ? "partial"
            : "complete"
        : "not_requested",
      instrumentCount: new Set(filedHistoryBatches.map((batch) => batch.symbol)).size,
      barCount: filedBarCount,
      instruments: filedHistoryBatches,
      failures: historyWriteFailures,
    },
  };

  const snapshotPersisted = options.writeSnapshot;
  if (snapshotPersisted) {
    saveJsonFile(path.join(directory, FINANCE_UNIVERSE_SELECTION_SNAPSHOT_FILENAME), result);
  }

  if (options.writeRule && selected.length > 0) {
    const ruleId = `trend_risk_normalised_auto_v1`;
    const declaration = {
      kind: "declared",
      ruleId,
      form: "cross_asset_trend",
      formVersion: "1",
      displayName: "跨资产风险归一化月度趋势（系统自选 universe）",
      instruments: selected,
      emits: "target_weights",
      schedule: { kind: "monthly", at: "last_trading_day", timezone: "America/New_York" },
      provenance: {
        origin:
          "system-selected universe (venue tradable list + observed dollar volume + correlation)",
        revision: asOf.slice(0, 10),
        license: "public method distillation; no private parameters claimed",
        readScope: "research_only",
        notes: "DRAFT: universe chosen by measured data, not by a curated list. Not activated.",
      },
      observedAt: asOf,
      body: {
        question:
          "跨资产 12 个月趋势信号，在扣除换手与滑点后，是否仍优于同市场同成本口径的等权买入持有基线？",
        stage: "research_candidate",
        universe: selected,
        frozenRule: {
          lookbackMonths: 12,
          signal: "每月最后一个可得交易日的收盘价除以 12 个日历月前同点收盘价，减 1",
          direction: "12 个月总回报 > 0 则持有；<= 0 则权重为 0（持现金）",
          noShort: "不做空",
          riskNormalisation: "权重正比于 1/年化波动率，再归一化",
          executionTiming: "信号在月末形成，下一个可交易时点执行",
          parameterFreeze: "参数运行前冻结",
        },
        data: { source: "china_reachable_us_eod_history", pointInTime: true, adjusted: true },
      },
    };
    const ruleDir = path.join(directory, "rule-declarations");
    fs.mkdirSync(ruleDir, { recursive: true });
    const outPath = path.join(ruleDir, `${ruleId}.json`);
    // saveJsonFile for the same reason as the asset cache: a draft declaration is read back by the
    // step that activates it, and a half-written file is not a draft anyone can review.
    saveJsonFile(outPath, declaration);
    process.stderr.write(`wrote DRAFT declaration (not activated): ${outPath}\n`);
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ...result, snapshotPersisted }, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    [
      `assets=${result.assetCount} candidates=${result.candidateCount} screened=${result.screenedCount}`,
      `unreadable=${result.unreadableCount} eligible=${result.eligibleCount}`,
      `selected (${selected.length}): ${selected.join(", ")}`,
      ...(snapshotPersisted ? ["current universe snapshot persisted atomically"] : []),
      ...(options.writeSnapshot && !snapshotPersisted
        ? ["universe snapshot withheld because canonical bar filing failed"]
        : []),
      "",
      ...result.selectedMetrics.map(
        (m) =>
          `  ${m.symbol.padEnd(6)} bars=${m.bars} vol=${m.annualisedVol.toFixed(3)} gap=${m.maxGapDays}d median$=${Math.round(m.medianDollarVolume)}`,
      ),
    ].join("\n") + "\n",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void runUniverseSelect().catch((error) => {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  });
}
