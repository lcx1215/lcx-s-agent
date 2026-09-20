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
 *     [--screen N] [--target N] [--refresh-assets] [--write-rule]
 */

import fs from "node:fs";
import path from "node:path";
import { resolveFinanceCredentialEnv } from "../../src/agents/finance-credential-env.js";
import { createChinaReachableUsEodHistoryCollectionAdapter } from "../../src/agents/finance-free-market-collection-adapters.js";
import { resolveFinanceStateDir } from "../../src/agents/finance-state-dir.js";
import {
  DEFAULT_UNIVERSE_THRESHOLDS,
  FINANCE_UNIVERSE_SELECTION_SCHEMA,
  filterUniverseAssets,
  logReturnSeries,
  rankByDollarVolume,
  selectDiversifiedUniverse,
  summariseUniverseSeries,
  universeRejectionReason,
  type UniverseAsset,
  type UniverseBar,
  type UniverseMetrics,
  type UniverseQuote,
} from "../../src/agents/finance-universe-selection.js";

const ASSETS_URL = "https://paper-api.alpaca.markets/v2/assets?status=active&asset_class=us_equity";
const SNAPSHOT_BATCH = 500;
const HISTORY_LIMIT = 1200;
const MAX_ASSET_AGE_DAYS = 7;
const CONCURRENCY = 6;

type Options = Readonly<{
  json: boolean;
  screen: number;
  target: number;
  refreshAssets: boolean;
  writeRule: boolean;
  directory?: string;
}>;

function parseArgs(argv: readonly string[]): Options {
  const options: {
    json: boolean;
    screen: number;
    target: number;
    refreshAssets: boolean;
    writeRule: boolean;
    directory?: string;
  } = {
    json: false,
    screen: 120,
    target: 8,
    refreshAssets: false,
    writeRule: false,
    directory: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--screen") {
      options.screen = Number(next);
      index += 1;
    } else if (arg === "--target") {
      options.target = Number(next);
      index += 1;
    } else if (arg === "--refresh-assets") {
      options.refreshAssets = true;
    } else if (arg === "--write-rule") {
      options.writeRule = true;
    } else if (arg === "--dir") {
      options.directory = next;
      index += 1;
    }
  }
  return options;
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

async function loadAssets(cachePath: string, refresh: boolean): Promise<UniverseAsset[]> {
  const fresh = (): boolean => {
    if (!fs.existsSync(cachePath)) {
      return false;
    }
    const ageMs = Date.now() - fs.statSync(cachePath).mtimeMs;
    return ageMs < MAX_ASSET_AGE_DAYS * 86_400_000;
  };
  if (!refresh && fresh()) {
    return JSON.parse(fs.readFileSync(cachePath, "utf8")) as UniverseAsset[];
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
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(raw));
  process.stderr.write(`fetched ${raw.length} assets in ${Date.now() - started}ms\n`);
  return raw;
}

async function loadQuotes(symbols: readonly string[]): Promise<Record<string, UniverseQuote>> {
  const headers = alpacaHeaders();
  const out: Record<string, UniverseQuote> = {};
  for (let index = 0; index < symbols.length; index += SNAPSHOT_BATCH) {
    const batch = symbols.slice(index, index + SNAPSHOT_BATCH);
    const response = await fetch(
      `https://data.alpaca.markets/v2/stocks/snapshots?symbols=${batch.join(",")}`,
      { headers, signal: AbortSignal.timeout(60_000) },
    );
    if (response.status !== 200) {
      continue;
    }
    const parsed = (await response.json()) as Record<
      string,
      { dailyBar?: { c?: number; v?: number } }
    >;
    for (const [symbol, value] of Object.entries(parsed)) {
      out[symbol] = { close: value?.dailyBar?.c, volume: value?.dailyBar?.v };
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
  const options = parseArgs(argv);
  const directory = options.directory ?? resolveFinanceStateDir().directory;
  const cachePath = path.join(directory, "alpaca-assets.json");

  const assets = await loadAssets(cachePath, options.refreshAssets);
  const candidates = filterUniverseAssets(assets);
  const symbols = candidates.map((asset) => asset.symbol);

  const quotes = await loadQuotes(symbols);
  const ranked = rankByDollarVolume(quotes);
  const screened = ranked.slice(0, options.screen).map((entry) => entry.symbol);

  const adapter = createChinaReachableUsEodHistoryCollectionAdapter();
  const asOf = new Date().toISOString();
  const series = new Map<string, UniverseBar[]>();
  const unreadable: string[] = [];

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
      const bars: UniverseBar[] = [];
      for (const row of rows) {
        const date = typeof row.data?.date === "string" ? row.data.date : "";
        const close = Number(row.data?.close);
        if (!/^\d{4}-\d{2}-\d{2}$/u.test(date) || !Number.isFinite(close) || close <= 0) {
          continue;
        }
        const volume = Number(row.data?.volume);
        bars.push({
          date,
          close,
          ...(Number.isFinite(volume) ? { volume } : {}),
        });
      }
      series.set(symbol, bars);
    } catch {
      unreadable.push(symbol);
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
  const selected = selectDiversifiedUniverse(
    ordered.map((entry) => ({
      symbol: entry.symbol,
      returns: logReturnSeries((series.get(entry.symbol) ?? []).map((bar) => bar.close)),
    })),
    { target: options.target, maxCorrelation: 0.9 },
  );

  const result = {
    schemaVersion: FINANCE_UNIVERSE_SELECTION_SCHEMA,
    directory,
    asOf,
    modelCalls: 0,
    assetCount: assets.length,
    candidateCount: candidates.length,
    screenedCount: screened.length,
    unreadableCount: unreadable.length,
    eligibleCount: ordered.length,
    selected,
    // Metrics of the selected symbols, straight from the screened set — never a `{ symbol }`
    // placeholder, which would make every numeric column silently unprintable.
    selectedMetrics: ordered.filter((entry) => selected.includes(entry.symbol)),
    thresholds: DEFAULT_UNIVERSE_THRESHOLDS,
    rejected: rejected.slice(0, 40),
  };

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
    fs.writeFileSync(outPath, `${JSON.stringify(declaration, null, 2)}\n`);
    process.stderr.write(`wrote DRAFT declaration (not activated): ${outPath}\n`);
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    [
      `assets=${result.assetCount} candidates=${result.candidateCount} screened=${result.screenedCount}`,
      `unreadable=${result.unreadableCount} eligible=${result.eligibleCount}`,
      `selected (${selected.length}): ${selected.join(", ")}`,
      "",
      ...result.selectedMetrics.map(
        (m) =>
          `  ${m.symbol.padEnd(6)} bars=${m.bars} vol=${m.annualisedVol.toFixed(3)} gap=${m.maxGapDays}d median$=${Math.round(m.medianDollarVolume)}`,
      ),
    ].join("\n") + "\n",
  );
}

void runUniverseSelect().catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
