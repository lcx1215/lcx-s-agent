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
import { runFinanceMarketCollectionRefresh } from "./finance-market-collection-registry.js";
import { createRegisteredCapabilityAdapters } from "./finance-registered-capability-adapters.js";
import { fuseSignals, type FinanceSignal } from "./finance-signal-fusion.js";

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

async function collectOne(params: {
  instrument: string;
  asOf: string;
  eodAdapter: ReturnType<typeof createFmpFreeBasicEodCollectionAdapter>;
  targetAdapters: ReturnType<typeof createRegisteredCapabilityAdapters>;
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
  } catch {
    // A missing leg simply leaves the pool short for this instrument.
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
  } catch {
    // Same: a missing leg leaves the pool short.
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
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<{
  asOf: string;
  recordPath: string;
  requested: number;
  recorded: readonly BatchRecord[];
  skipped: number;
}> {
  const env = (resolveFinanceCredentialEnv(params.env ?? process.env) ?? {}) as Record<
    string,
    unknown
  >;
  const fmpKey = keyFrom(env, "FMP_API_KEY");
  const recordPath = params.recordPath ?? "state/finance/research-samples.jsonl";
  const requested = (params.instruments ?? [...DEFAULT_POOL])
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

  const recorded: BatchRecord[] = [];
  for (const instrument of todo) {
    recorded.push(await collectOne({ instrument, asOf, eodAdapter, targetAdapters }));
  }

  if (recorded.length > 0) {
    mkdirSync(dirname(recordPath), { recursive: true });
    appendFileSync(recordPath, recorded.map((r) => JSON.stringify(r)).join("\n") + "\n");
  }

  return {
    asOf,
    recordPath,
    requested: requested.length,
    recorded,
    skipped,
  };
}
