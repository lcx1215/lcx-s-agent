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
import { chartStructureSignal, computeChartStructure } from "./finance-chart-structure.js";
import { resolveFinanceCredentialEnv } from "./finance-credential-env.js";
import { createFmpFreeBasicEodCollectionAdapter } from "./finance-free-market-collection-adapters.js";
import { analystTargetSignal } from "./finance-fundamental-signal.js";
import {
  MACRO_LOOKBACK_OBSERVATIONS,
  macroRouteFor,
  macroTrendSignal,
  type MacroObservation,
} from "./finance-macro-signal.js";
import {
  createFredMacroSeriesCollectionAdapter,
  runFinanceMarketCollectionRefresh,
} from "./finance-market-collection-registry.js";
import { createRegisteredCapabilityAdapters } from "./finance-registered-capability-adapters.js";
import { fuseSignals, type FinanceSignal } from "./finance-signal-fusion.js";
import { financeResearchSamplesPath, resolveFinanceStateDir } from "./finance-state-dir.js";
import { readFinanceStrategyRuleLedger } from "./finance-strategy-rule-ledger.js";

export type BatchRecord = Readonly<{
  asOf: string;
  instrument: string;
  direction: string;
  conviction: number;
  agreement: number;
  sources: readonly string[];
  lastPrice: number;
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
          const row = JSON.parse(line) as { instrument?: unknown; asOf?: unknown };
          if (typeof row.instrument === "string" && typeof row.asOf === "string") {
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
 * Macro series from FRED, when a key is configured.
 *
 * Absent otherwise, and that is not a failure: an instrument then has one fewer source, the same
 * as an instrument whose series could not be read. What it must never do is fall back to a number
 * that looks like the series.
 */
function defaultMacroFor(
  env: Record<string, unknown>,
): ((seriesId: string) => Promise<readonly MacroObservation[]>) | undefined {
  const apiKey = keyFrom(env, "FRED_API_KEY");
  if (apiKey.length === 0) {
    return undefined;
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

async function collectOne(params: {
  instrument: string;
  asOf: string;
  eodAdapter: ReturnType<typeof createFmpFreeBasicEodCollectionAdapter>;
  targetAdapters: ReturnType<typeof createRegisteredCapabilityAdapters>;
  /**
   * Macro series supplier, injectable so sampling is testable without the network. Absent when no
   * macro provider is configured, in which case the instrument simply gets no macro source — the
   * same answer as a series that cannot be read.
   */
  macroFor?: (seriesId: string) => Promise<readonly MacroObservation[]>;
  warn: (message: string) => void;
}): Promise<BatchRecord> {
  const { instrument, asOf } = params;
  const signals: FinanceSignal[] = [];
  let lastPrice = 0;
  let target: number | null = null;

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
      adapters: [params.eodAdapter],
    });
    const rows = (result.records ?? [])
      .map(
        (r) =>
          ((r as { data?: Record<string, unknown> }).data ?? {}) as Record<string, number | string>,
      )
      .filter((row) => Number(row.close) > 0 && typeof row.date === "string")
      .toSorted((a, b) => String(a.date).localeCompare(String(b.date)));
    const closes = rows.map((row) => Number(row.close));
    const volumes = rows.map((row) => Number(row.volume ?? 0));
    lastPrice = closes[closes.length - 1] ?? 0;
    const structure = computeChartStructure(closes);
    if (structure) {
      const recentVolume = volumes.slice(-10).reduce((a, b) => a + b, 0) / 10;
      const priorVolume = volumes.slice(-20, -10).reduce((a, b) => a + b, 0) / 10;
      const ratio = priorVolume > 0 ? recentVolume / priorVolume : 1;
      signals.push(
        chartStructureSignal(structure, {
          sourceId: "fmp-eod-structure",
          observedAt: asOf,
          baseConfidence: ratio >= 1.1 ? 0.7 : ratio >= 0.9 ? 0.6 : 0.5,
          ref: "trend=" + structure.trend + " volumeRatio=" + ratio.toFixed(2),
        }),
      );
    }
  } catch (error) {
    // Reported, not swallowed: a leg that fails for every instrument looks
    // exactly like a quiet market, and silence is the one failure this loop
    // cannot afford.
    params.warn("leg failed for " + instrument + ": " + scrub(String(error)).slice(0, 120));
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
  const eodAdapter = createFmpFreeBasicEodCollectionAdapter({ apiKey: fmpKey });
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
        eodAdapter,
        targetAdapters,
        macroFor: params.macroFor ?? defaultMacroFor(env),
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
