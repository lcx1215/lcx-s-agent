/**
 * One pass over a pool of instruments, recording what the signals said.
 *
 * Shared by the operator script and the agent tool on purpose. Two copies of a
 * sampler would drift, and then the script and the tool would disagree about
 * what the system believed on a given day - which is worse than either being
 * wrong, because the disagreement is invisible until someone compares them.
 *
 * Breadth is the point: a low-frequency judgement on one symbol needs years to
 * produce a usable sample, while the same judgement across forty symbols
 * produces a comparable number of observations in weeks.
 *
 * Deliberately deterministic - no model is called. Fifty instruments through a
 * model would be slow and rate-limited, and the resulting samples would not be
 * repeatable, so a calibration number computed over them would measure the
 * model's mood rather than the signal's accuracy.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { readFinanceBarLedger, type FinanceBar } from "./finance-bar-ledger.js";
import { chartStructureSignal, computeChartStructure } from "./finance-chart-structure.js";
import { resolveFinanceCredentialEnv } from "./finance-credential-env.js";
import { parseAvPublishedAgeDays, type NewsItem } from "./finance-evidence-window.js";
import { createFmpFreeBasicEodCollectionAdapter } from "./finance-free-market-collection-adapters.js";
import { analystTargetSignal } from "./finance-fundamental-signal.js";
import {
  MACRO_LOOKBACK_OBSERVATIONS,
  createPublicFredMacroSeriesSupplier,
  macroRouteFor,
  macroTrendSignal,
  type MacroObservation,
} from "./finance-macro-signal.js";
import { createFinanceMarketCollectionRegistry } from "./finance-market-collection-registry.js";
import {
  createFredMacroSeriesCollectionAdapter,
  runFinanceMarketCollectionRefresh,
} from "./finance-market-collection-registry.js";
import { newsSentimentSignal } from "./finance-news-sentiment-signal.js";
import { createRegisteredCapabilityAdapters } from "./finance-registered-capability-adapters.js";
import { fuseSignals, type FinanceSignal } from "./finance-signal-fusion.js";
import { financeResearchSamplesPath, resolveFinanceStateDir } from "./finance-state-dir.js";
import { readFinanceStrategyRuleLedger } from "./finance-strategy-rule-ledger.js";
import { createFinanceUncachedFetch } from "./finance-write-transport.js";

export type BatchRecord = Readonly<{
  asOf: string;
  instrument: string;
  direction: string;
  conviction: number;
  agreement: number;
  sources: readonly string[];
  lastPrice: number;
  /** Where the price came from: a live provider, the bar book, or nowhere. */
  priceSource: "live_eod" | "bar_ledger" | "none";
  target: number | null;
  refusals?: readonly string[];
}>;

export const DEFAULT_POOL = [
  "AAPL",
  "MSFT",
  "NVDA",
  "AMZN",
  "GOOGL",
  "META",
  "TSLA",
  "AVGO",
  "JPM",
  "V",
  "MA",
  "UNH",
  "XOM",
  "JNJ",
  "PG",
  "HD",
  "MRK",
  "ABBV",
  "CVX",
  "LLY",
  "PEP",
  "KO",
  "BAC",
  "PFE",
  "TMO",
  "COST",
  "WMT",
  "DIS",
  "CSCO",
  "MCD",
  "ABT",
  "DHR",
  "VZ",
  "ADBE",
  "NFLX",
  "CRM",
  "AMD",
  "INTC",
  "QCOM",
  "TXN",
] as const;

/**
 * The instruments an active rule actually trades.
 *
 * Sampling a hard-coded pool while trading a different one produces a track
 * record that cannot be used: the calibration numbers then describe symbols the
 * system never trades, so a threshold derived from them is derived from the
 * wrong universe. Link health flags this as `sample_universe_overlap`. Reading
 * the rule ledger means the two cannot drift apart.
 *
 * Falls back to an empty list, and callers keep their own fallback, so a ledger
 * that cannot be read never silently becomes "sample nothing".
 */
async function activeRuleInstruments(): Promise<string[]> {
  try {
    const directory = resolveFinanceStateDir({}).directory;
    const read = (await readFinanceStrategyRuleLedger(directory, {})) as {
      ledger?: { rules?: readonly unknown[] };
    };
    const out = new Set<string>();
    for (const row of read.ledger?.rules ?? []) {
      const rule = row as { state?: unknown; instruments?: unknown };
      if (rule.state !== "active" || !Array.isArray(rule.instruments)) {
        continue;
      }
      for (const symbol of rule.instruments) {
        if (typeof symbol === "string" && symbol.trim().length > 0) {
          out.add(symbol.trim().toUpperCase());
        }
      }
    }
    return [...out];
  } catch {
    return [];
  }
}

/**
 * Provider keys must not reach a log through an error message, because a fetch
 * error can carry the request URL - and these URLs carry the key.
 */
function scrub(text: string): string {
  return text
    .replace(/apikey=[^&\s"']+/giu, "apikey=***")
    .replace(/token=[^&\s"']+/giu, "token=***");
}

function keyFrom(env: Record<string, unknown>, name: string): string {
  const value = env[name];
  return typeof value === "string" ? value : "";
}

/** Keys already recorded, as instrument|day. */
export function recordedKeys(path: string): Set<string> {
  if (!existsSync(path)) {
    return new Set();
  }
  return new Set(
    readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .flatMap((line) => {
        try {
          const row = JSON.parse(line) as {
            instrument?: unknown;
            asOf?: unknown;
            lastPrice?: unknown;
          };
          // A sample with no price is not an observation that has been taken, it is an
          // observation that failed -- recorded while a provider was refusing this symbol,
          // carrying `lastPrice: 0`. Treating it as "already sampled" freezes that failure
          // permanently: every later run skips it, and the loop never recovers even after
          // the cause is fixed. Idempotency protects against counting the same observation
          // twice; it must not protect a blank one.
          if (
            typeof row.instrument === "string" &&
            typeof row.asOf === "string" &&
            Number(row.lastPrice) > 0
          ) {
            return [row.instrument.toUpperCase() + "|" + row.asOf.slice(0, 10)];
          }
          return [];
        } catch {
          return [];
        }
      }),
  );
}

/**
 * Macro series from FRED: the keyed adapter when a key is configured, the public CSV endpoint
 * otherwise.
 *
 * It used to be absent without a key, and that absence was silent by design -- "an instrument then
 * has one fewer source". But the key is a *supply* detail, not a statement about the series: FRED
 * serves these series without one, over the same host and path the repo already reads for index
 * history. So "no key" was costing every instrument a source while looking like nothing at all.
 *
 * What it must never do is fall back to a number that looks like the series: an unreadable endpoint
 * throws, and the caller's "macro leg failed" warning names the instrument.
 */
function defaultMacroFor(
  env: Record<string, unknown>,
): ((seriesId: string) => Promise<readonly MacroObservation[]>) | undefined {
  const apiKey = keyFrom(env, "FRED_API_KEY");
  if (apiKey.length === 0) {
    return createPublicFredMacroSeriesSupplier();
  }
  const adapter = createFredMacroSeriesCollectionAdapter({ apiKey });
  return async (seriesId) => {
    const rows = await adapter.collect(
      {
        collection: "macro_series",
        instrument: seriesId,
        seriesId,
        assetClass: "macro",
        asOf: new Date().toISOString(),
        limit: MACRO_LOOKBACK_OBSERVATIONS + 1,
      } as never,
      AbortSignal.timeout(30_000),
    );
    return (Array.isArray(rows) ? rows : []).flatMap((row) => {
      const data = (row as { data?: Record<string, unknown> }).data ?? {};
      const date = typeof data.date === "string" ? data.date : "";
      const value = Number(data.value);
      return date.length > 0 && Number.isFinite(value) ? [{ date, value }] : [];
    });
  };
}

export type NewsReading = Readonly<{ sourceId: string; items: readonly NewsItem[] }>;

/**
 * News sentiment from Alpha Vantage, when a key is configured.
 *
 * The cohort logic is not here and must not be duplicated here: `summarizeNewsCohort` already
 * windows by days, weights by recency and refuses thin cohorts. This only supplies the items;
 * `newsSentimentSignal` turns them into a source fusion can count. Absent without a key, which
 * leaves the instrument with one fewer source -- never with a fabricated one.
 */
function defaultNewsFor(
  env: Record<string, unknown>,
): ((instrument: string) => Promise<NewsReading>) | undefined {
  const apiKey = keyFrom(env, "ALPHA_VANTAGE_API_KEY");
  if (apiKey.length === 0) {
    return undefined;
  }
  return async (instrument) => {
    const fetchImpl = createFinanceUncachedFetch();
    const url =
      "https://www.alphavantage.co/query?function=NEWS_SENTIMENT&tickers=" +
      encodeURIComponent(instrument) +
      "&limit=50&apikey=" +
      encodeURIComponent(apiKey);
    const response = await fetchImpl(url, { headers: {} });
    const payload = JSON.parse(response.body) as {
      feed?: Array<{
        overall_sentiment_score?: number;
        ticker_sentiment?: Array<{ ticker?: string; ticker_sentiment_score?: string }>;
        time_published?: unknown;
      }>;
    };
    const asOfMs = Date.now();
    const items: NewsItem[] = [];
    for (const item of Array.isArray(payload.feed) ? payload.feed : []) {
      const match = (item.ticker_sentiment ?? []).find((entry) => entry.ticker === instrument);
      const raw = Number(match?.ticker_sentiment_score ?? item.overall_sentiment_score);
      // An article with no usable timestamp is dropped, not counted as fresh.
      const ageDays = parseAvPublishedAgeDays(item.time_published, asOfMs);
      if (Number.isFinite(raw) && ageDays !== null) {
        items.push({ ageDays, score: raw });
      }
    }
    return { sourceId: "alpha-vantage-news-sentiment", items };
  };
}

/**
 * Bars the system already recorded, used when a live provider will not serve the instrument.
 *
 * This is the loop reading back what it persisted. Free tiers are entitled to a subset of symbols
 * -- FMP answers HTTP 402 "Premium Query Parameter" for QQQ/GLD/TLT while serving SPY, and Alpaca
 * answers 200 with `bars: null` for the same instruments -- and a provider refusing a symbol is
 * not the same fact as the instrument having no price history. The bar book holds thousands of
 * bars for all of them. Sampling only from the network threw that away and reported `lastPrice: 0`,
 * which downstream reads as "no opinion" rather than "we did not look in our own book".
 */
function defaultBarFor(directory?: string): (instrument: string) => Promise<readonly FinanceBar[]> {
  const root = resolveFinanceStateDir({ directory }).directory;
  return async (instrument) => {
    try {
      const ledger = await readFinanceBarLedger(root, { instrument });
      return ledger.bars;
    } catch {
      // An unreadable book is a missing source, never a price.
      return [];
    }
  };
}

async function collectOne(params: {
  instrument: string;
  asOf: string;
  /**
   * Every registered EOD adapter, not one chosen here.
   *
   * The sampler used to hard-code FMP alone. FMP's free tier answers HTTP 402
   * "Premium Query Parameter" for QQQ/GLD/TLT while serving SPY, so sampling read as
   * "these instruments have no price" when the real answer was "this provider is not
   * entitled to them". The registry already ranks `china_reachable_us_eod_history`
   * (priority 10) above FMP (40) and it serves all of them; bypassing the registry threw
   * that away. Selection belongs to the registry, which orders by priority and support.
   */
  eodAdapters: readonly ReturnType<typeof createFmpFreeBasicEodCollectionAdapter>[];
  targetAdapters: ReturnType<typeof createRegisteredCapabilityAdapters>;
  /** Bars already in the book, used when no provider will serve this instrument. */
  barFor?: (instrument: string) => Promise<readonly FinanceBar[]>;
  /**
   * Macro series supplier, injectable so sampling is testable without the network. Absent when no
   * macro provider is configured, in which case the instrument simply gets no macro source — the
   * same answer as a series that cannot be read.
   */
  macroFor?: (seriesId: string) => Promise<readonly MacroObservation[]>;
  /**
   * News supplier. Unlike `macroFor` there is no public fallback: news sentiment needs a keyed
   * Alpha Vantage API, so this is absent unless one is configured, and the instrument then has
   * one fewer source. Injectable so sampling is testable without the network.
   */
  newsFor?: (instrument: string) => Promise<NewsReading>;
  warn: (message: string) => void;
}): Promise<BatchRecord> {
  const { instrument, asOf } = params;
  const signals: FinanceSignal[] = [];
  let lastPrice = 0;
  let target: number | null = null;
  let priceSource: "live_eod" | "bar_ledger" | "none" = "none";

  type PricedRow = { date: string; close: number; volume: number };
  const applyBars = (rows: readonly PricedRow[], sourceId: string): void => {
    if (rows.length === 0) {
      return;
    }
    const closes = rows.map((row) => row.close);
    const volumes = rows.map((row) => row.volume);
    lastPrice = closes[closes.length - 1] ?? 0;
    if (lastPrice <= 0) {
      return;
    }
    const structure = computeChartStructure(closes);
    if (!structure) {
      return;
    }
    const recentVolume = volumes.slice(-10).reduce((a, b) => a + b, 0) / 10;
    const priorVolume = volumes.slice(-20, -10).reduce((a, b) => a + b, 0) / 10;
    const ratio = priorVolume > 0 ? recentVolume / priorVolume : 1;
    signals.push(
      chartStructureSignal(structure, {
        sourceId,
        observedAt: asOf,
        baseConfidence: ratio >= 1.1 ? 0.7 : ratio >= 0.9 ? 0.6 : 0.5,
        ref: "trend=" + structure.trend + " volumeRatio=" + ratio.toFixed(2),
      }),
    );
  };

  try {
    const result = await runFinanceMarketCollectionRefresh({
      request: {
        collection: "eod_history",
        instrument,
        assetClass: "us_equity",
        asOf,
        limit: 250,
        fromDate: new Date(Date.parse(asOf) - 400 * 86_400_000).toISOString().slice(0, 10),
        toDate: asOf.slice(0, 10),
      } as never,
      adapters: params.eodAdapters,
    });
    // Name the provider that actually answered. A signal claiming "fmp-eod-structure" when
    // another adapter served it would credit the wrong source and, worse, make two
    // independent-looking sources out of one.
    const servedBy =
      (result.records ?? [])
        .map((r) => (r as { providerName?: unknown }).providerName)
        .find((name): name is string => typeof name === "string" && name.length > 0) ??
      "unknown-eod";
    const rows = (result.records ?? [])
      .map(
        (r) =>
          ((r as { data?: Record<string, unknown> }).data ?? {}) as Record<string, number | string>,
      )
      .filter((row) => Number(row.close) > 0 && typeof row.date === "string")
      .toSorted((a, b) => String(a.date).localeCompare(String(b.date)))
      .map((row) => ({
        date: String(row.date),
        close: Number(row.close),
        volume: Number(row.volume ?? 0),
      }));
    applyBars(rows, servedBy + "-eod-structure");
    if (lastPrice > 0) {
      priceSource = "live_eod";
    }
  } catch (error) {
    // Reported, not swallowed: a leg that fails for every instrument looks
    // exactly like a quiet market, and silence is the one failure this loop
    // cannot afford.
    params.warn("leg failed for " + instrument + ": " + scrub(String(error)).slice(0, 120));
  }

  // Fall back to the book only when no provider would serve the instrument. This is the
  // persisted-data leg of the loop, and it is deliberately second: a live close is fresher
  // than one already in the book, and using the book while a provider is merely slow would
  // quietly make every sample stale.
  if (lastPrice <= 0 && params.barFor !== undefined) {
    const bars = (await params.barFor(instrument))
      .filter((bar) => Number(bar.close) > 0 && typeof bar.date === "string")
      .toSorted((a, b) => a.date.localeCompare(b.date));
    if (bars.length > 0) {
      applyBars(
        bars.map((bar) => ({
          date: bar.date,
          close: bar.close,
          volume: Number(bar.volume ?? 0),
        })),
        "bar-ledger-eod-structure",
      );
    }
    if (lastPrice > 0) {
      priceSource = "bar_ledger";
      params.warn(
        "no provider would serve " +
          instrument +
          "; priced from " +
          bars.length +
          " bars already in the book, newest " +
          bars[bars.length - 1].date,
      );
    }
  }

  try {
    const result = await runFinanceMarketCollectionRefresh({
      request: {
        collection: "analyst_estimates",
        instrument,
        assetClass: "us_equity",
        asOf,
        limit: 3,
      } as never,
      adapters: params.targetAdapters,
    });
    const first = (result.records ?? [])[0] as
      | { data?: Record<string, number | string> }
      | undefined;
    const data = first?.data ?? {};
    if (lastPrice > 0 && Number(data.lastMonthAvgPriceTarget) > 0) {
      target = Number(data.lastMonthAvgPriceTarget);
      signals.push(
        analystTargetSignal(
          {
            currentPrice: lastPrice,
            avgTarget: target,
            analystCount: Number(data.lastMonthCount ?? 0),
            window: "lastMonth",
          },
          { observedAt: asOf },
        ),
      );
    }
  } catch (error) {
    params.warn("target leg failed for " + instrument + ": " + scrub(String(error)).slice(0, 120));
  }

  // Macro: the source that exists for instruments with no analysts. An ETF has no price targets,
  // so without this every instrument the rules trade could only ever be sampled as a refusal.
  const route = macroRouteFor(instrument);
  if (params.macroFor !== undefined && route !== undefined) {
    try {
      const observations = await params.macroFor(route.seriesId);
      const signal = macroTrendSignal({ route, observations, observedAt: asOf });
      // A series that has not moved is not a view, and neither is one that could not be read. Both
      // come back undefined and contribute nothing, rather than becoming a direction.
      if (signal !== undefined) {
        signals.push(signal);
      }
    } catch (error) {
      params.warn("macro leg failed for " + instrument + ": " + scrub(String(error)).slice(0, 120));
    }
  }

  // News: a third independent source, and the only one that reacts to events rather than to
  // price or to a published series. It is also the weakest, and says nothing at all on a thin
  // or neutral cohort.
  if (params.newsFor !== undefined) {
    try {
      const reading = await params.newsFor(instrument);
      const signal = newsSentimentSignal({
        sourceId: reading.sourceId,
        items: reading.items,
        observedAt: asOf,
      });
      if (signal !== undefined) {
        signals.push(signal);
      }
    } catch (error) {
      params.warn("news leg failed for " + instrument + ": " + scrub(String(error)).slice(0, 120));
    }
  }

  const fused = fuseSignals(signals, { minSources: 2, minAgreement: 0.6 });
  if (!fused.ok) {
    return {
      asOf,
      instrument,
      direction: "none",
      conviction: 0,
      agreement: 0,
      sources: [],
      lastPrice,
      priceSource,
      target,
      refusals: [...fused.refusals],
    };
  }
  return {
    asOf,
    instrument,
    direction: fused.conclusion.direction,
    conviction: Number(fused.conclusion.conviction.toFixed(4)),
    agreement: Number(fused.conclusion.agreement.toFixed(4)),
    sources: fused.conclusion.evidence.map((e) => e.sourceId),
    lastPrice,
    priceSource,
    target,
  };
}

export async function runResearchBatch(
  params: {
    instruments?: readonly string[];
    recordPath?: string;
    /** Finance state directory. Defaults the same way every other finance reader does. */
    directory?: string;
    env?: NodeJS.ProcessEnv;
    /** Macro series supplier. Defaults to FRED when a key is configured, otherwise no macro source. */
    macroFor?: (seriesId: string) => Promise<readonly MacroObservation[]>;
    /** News supplier. Defaults to Alpha Vantage when a key is configured, otherwise no news source. */
    newsFor?: (instrument: string) => Promise<NewsReading>;
    /** Bars already in the book. Defaults to the finance bar ledger; the last resort when no provider serves an instrument. */
    barFor?: (instrument: string) => Promise<readonly FinanceBar[]>;
    warn?: (message: string) => void;
  } = {},
): Promise<{
  asOf: string;
  recordPath: string;
  universeSource: string;
  requested: number;
  recorded: readonly BatchRecord[];
  skipped: number;
}> {
  const env = (resolveFinanceCredentialEnv(params.env ?? process.env) ?? {}) as Record<
    string,
    unknown
  >;
  const fmpKey = keyFrom(env, "FMP_API_KEY");
  // Resolved, not relative. `state/finance/...` is the right book only while the caller happens
  // to be started from the repository root: a scheduler starts elsewhere and would write a second
  // samples file next to the first, and the night run would settle the empty one.
  const recordPath =
    params.recordPath ??
    financeResearchSamplesPath(resolveFinanceStateDir({ directory: params.directory }).directory);
  const ruleUniverse = await activeRuleInstruments();
  const pool = ruleUniverse.length > 0 ? ruleUniverse : [...DEFAULT_POOL];
  const requested = (params.instruments ?? pool)
    .map((value) => value.trim().toUpperCase())
    .filter((value) => value.length > 0);

  const asOf = new Date().toISOString();
  // The whole registry, so the sampler uses what the system already has rather than one
  // adapter it happens to hold a key for. `runFinanceMarketCollectionRefresh` filters by
  // `supports()` and orders by priority.
  const eodAdapters = createFinanceMarketCollectionRegistry({
    fmpApiKey: keyFrom(env, "FMP_API_KEY"),
    alphaVantageApiKey: keyFrom(env, "ALPHA_VANTAGE_API_KEY"),
    massiveApiKey: keyFrom(env, "MASSIVE_API_KEY"),
    finnhubApiKey: keyFrom(env, "FINNHUB_API_KEY"),
    twelveDataApiKey: keyFrom(env, "TWELVE_DATA_API_KEY"),
    fredApiKey: keyFrom(env, "FRED_API_KEY"),
  });
  const targetAdapters = createRegisteredCapabilityAdapters({ fmpApiKey: fmpKey }).filter(
    (a) => a.id === "fmp_price_target_summary",
  );

  // Idempotent per instrument and day: a retry, a cron overlap, or a re-run
  // after a partial failure must not double-count an observation.
  const seen = recordedKeys(recordPath);
  const day = asOf.slice(0, 10);
  const todo = requested.filter((symbol) => !seen.has(symbol + "|" + day));
  const skipped = requested.length - todo.length;

  const warn =
    params.warn ??
    ((message: string) => {
      try {
        process.stderr.write(message + "\n");
      } catch {
        // A logging failure must never stop sampling.
      }
    });

  const recorded: BatchRecord[] = [];
  for (const instrument of todo) {
    recorded.push(
      await collectOne({
        instrument,
        asOf,
        eodAdapters,
        targetAdapters,
        macroFor: params.macroFor ?? defaultMacroFor(env),
        newsFor: params.newsFor ?? defaultNewsFor(env),
        barFor: params.barFor ?? defaultBarFor(params.directory),
        warn,
      }),
    );
  }

  if (recorded.length > 0) {
    mkdirSync(dirname(recordPath), { recursive: true });
    appendFileSync(recordPath, recorded.map((r) => JSON.stringify(r)).join("\n") + "\n");
  }

  return {
    asOf,
    recordPath,
    universeSource: ruleUniverse.length > 0 ? "active_rule" : "fallback_pool",
    requested: requested.length,
    recorded,
    skipped,
  };
}
