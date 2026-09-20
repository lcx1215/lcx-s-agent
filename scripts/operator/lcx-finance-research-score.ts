/**
 * Score recorded research samples against what actually happened.
 *
 * This is the other half of the calibration loop. The batch run records what the
 * system claimed and how sure it sounded; this reads those records back once
 * enough time has passed, checks the price at the end of the horizon, and turns
 * the pair into a Brier score.
 *
 * Two rules keep the number honest:
 *
 * 1. Refusals are excluded from the score but reported. A refusal made no claim,
 *    so scoring it would punish the system for declining - and a system that is
 *    punished for declining learns to stop declining. Its refusal rate is
 *    reported separately, because a pool that refuses everything is useless
 *    even though its score looks clean.
 * 2. Immature records are reported as pending, not skipped silently. Silently
 *    dropping them makes a small sample look like a finished result.
 *
 * Usage:
 *   node --import tsx scripts/operator/lcx-finance-research-score.ts \
 *     [--record PATH] [--horizon-days 30]
 */

import { readFileSync } from "node:fs";
import { resolveFinanceCredentialEnv } from "../../src/agents/finance-credential-env.js";
import { createFmpFreeBasicEodCollectionAdapter } from "../../src/agents/finance-free-market-collection-adapters.js";
import { runFinanceMarketCollectionRefresh } from "../../src/agents/finance-market-collection-registry.js";

type Sample = {
  asOf: string;
  instrument: string;
  direction: string;
  conviction: number;
  agreement: number;
  sources: string[];
  lastPrice: number;
  target: number | null;
  refusals?: string[];
};

function readArg(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const recordPath = readArg(args, "--record") ?? "state/finance/research-samples.jsonl";
  const horizonDays = Number(readArg(args, "--horizon-days") ?? 30);

  let lines: string[] = [];
  try {
    lines = readFileSync(recordPath, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0);
  } catch {
    process.stdout.write("no sample file at " + recordPath + "\n");
    return;
  }
  const samples = lines.flatMap((line) => {
    try {
      return [JSON.parse(line) as Sample];
    } catch {
      return [];
    }
  });

  const env = resolveFinanceCredentialEnv(process.env) as Record<string, unknown>;
  const fmpKey = typeof env.FMP_API_KEY === "string" ? env.FMP_API_KEY : "";
  const eodAdapter = createFmpFreeBasicEodCollectionAdapter({ apiKey: fmpKey });
  const priceCache = new Map<string, Array<{ date: string; close: number }>>();

  const nowMs = Date.now();
  let mature = 0;
  let pending = 0;
  let refused = 0;
  let hits = 0;
  let claimedSum = 0;
  let brierSum = 0;

  for (const sample of samples) {
    if (sample.direction === "none") {
      refused += 1;
      continue;
    }
    const startMs = Date.parse(sample.asOf);
    const dueMs = startMs + horizonDays * 86_400_000;
    if (nowMs < dueMs) {
      pending += 1;
      continue;
    }
    let series = priceCache.get(sample.instrument);
    if (!series) {
      try {
        const result = await runFinanceMarketCollectionRefresh({
          request: {
            collection: "eod_history",
            instrument: sample.instrument,
            assetClass: "us_equity",
            asOf: new Date(nowMs).toISOString(),
            limit: 250,
            fromDate: isoDay(startMs),
            toDate: isoDay(nowMs),
          } as never,
          adapters: [eodAdapter],
        });
        series = (result.records ?? [])
          .map(
            (r) =>
              ((r as { data?: Record<string, unknown> }).data ?? {}) as Record<
                string,
                number | string
              >,
          )
          .filter((row) => Number(row.close) > 0 && typeof row.date === "string")
          .map((row) => ({ date: String(row.date), close: Number(row.close) }))
          .toSorted((a, b) => a.date.localeCompare(b.date));
        priceCache.set(sample.instrument, series);
      } catch {
        priceCache.set(sample.instrument, []);
        series = [];
      }
    }
    // First close at or after the horizon date.
    const targetDay = isoDay(dueMs);
    const at = series.find((row) => row.date >= targetDay);
    if (!at) {
      pending += 1;
      continue;
    }

    const movedUp = at.close > sample.lastPrice;
    const outcome = sample.direction === "buy" ? (movedUp ? 1 : 0) : movedUp ? 0 : 1;
    mature += 1;
    hits += outcome;
    claimedSum += sample.conviction;
    brierSum += (sample.conviction - outcome) ** 2;
  }

  const brier = mature > 0 ? brierSum / mature : null;
  const hitRate = mature > 0 ? hits / mature : null;
  const meanClaimed = mature > 0 ? claimedSum / mature : null;

  process.stdout.write(
    JSON.stringify(
      {
        recordPath,
        horizonDays,
        total: samples.length,
        refused,
        pending,
        mature,
        hitRate: hitRate === null ? null : Number(hitRate.toFixed(4)),
        meanClaimedConviction: meanClaimed === null ? null : Number(meanClaimed.toFixed(4)),
        brier: brier === null ? null : Number(brier.toFixed(4)),
        overconfidenceGap:
          meanClaimed === null || hitRate === null
            ? null
            : Number((meanClaimed - hitRate).toFixed(4)),
        note:
          mature === 0
            ? "no mature samples yet; run again after the horizon passes"
            : "brier below 0.25 is what always guessing 50/50 would score",
      },
      null,
      2,
    ) + "\n",
  );
}

await main();
