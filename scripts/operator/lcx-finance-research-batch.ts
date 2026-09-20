/**
 * Accumulate research samples across a pool of instruments.
 *
 * Why this exists separately from the single research turn: sample size is the
 * binding constraint on knowing whether any of this works, and a low-frequency
 * strategy cannot wait years for one symbol to produce enough observations. The
 * only lever that actually moves is breadth - run the same judgement across
 * many instruments and collect one record per instrument per run.
 *
 * So this deliberately does NOT call the model. A pool of fifty would mean
 * fifty model calls per run, which is slow, rate-limited, and expensive, and
 * the resulting samples would be unrepeatable - the same inputs would not give
 * the same answer twice, so a calibration number computed over them would be
 * measuring the model's mood rather than the signal's accuracy.
 *
 * This path is deterministic: price structure and the analyst target, fused by
 * the same rules the single turn uses. Same inputs, same output, comparable
 * across a thousand observations. The model is for interpreting a shortlist,
 * not for generating samples.
 *
 * Records are appended as JSONL so a later run can fill in what actually
 * happened and score the calibration. Nothing is placed.
 *
 * Usage:
 *   node --import tsx scripts/operator/lcx-finance-research-batch.ts \
 *     --instruments AAPL,MSFT,NVDA --record PATH
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  chartStructureSignal,
  computeChartStructure,
} from "../../src/agents/finance-chart-structure.js";
import { resolveFinanceCredentialEnv } from "../../src/agents/finance-credential-env.js";
import { createFmpFreeBasicEodCollectionAdapter } from "../../src/agents/finance-free-market-collection-adapters.js";
import { analystTargetSignal } from "../../src/agents/finance-fundamental-signal.js";
import { runFinanceMarketCollectionRefresh } from "../../src/agents/finance-market-collection-registry.js";
import { createRegisteredCapabilityAdapters } from "../../src/agents/finance-registered-capability-adapters.js";
import { fuseSignals, type FinanceSignal } from "../../src/agents/finance-signal-fusion.js";

type Recorded = {
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

async function collectOne(params: {
  instrument: string;
  asOf: string;
  eodAdapter: ReturnType<typeof createFmpFreeBasicEodCollectionAdapter>;
  targetAdapters: ReturnType<typeof createRegisteredCapabilityAdapters>;
}): Promise<Recorded> {
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
    // a missing leg simply leaves the pool short for this instrument
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
    // same: a missing leg leaves the pool short
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

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const raw = readArg(args, "--instruments") ?? "";
  const instruments = raw
    .split(",")
    .map((value) => value.trim().toUpperCase())
    .filter((value) => value.length > 0);
  if (instruments.length === 0) {
    process.stdout.write("Usage: --instruments AAPL,MSFT --record PATH\n");
    return;
  }
  const recordPath = readArg(args, "--record") ?? "state/finance/research-samples.jsonl";

  const env = resolveFinanceCredentialEnv(process.env) as Record<string, unknown>;
  const fmpKey = typeof env.FMP_API_KEY === "string" ? env.FMP_API_KEY : "";
  const asOf = new Date().toISOString();
  const eodAdapter = createFmpFreeBasicEodCollectionAdapter({ apiKey: fmpKey });
  const targetAdapters = createRegisteredCapabilityAdapters({ fmpApiKey: fmpKey }).filter(
    (a) => a.id === "fmp_price_target_summary",
  );

  const records: Recorded[] = [];
  for (const instrument of instruments) {
    const record = await collectOne({ instrument, asOf, eodAdapter, targetAdapters });
    records.push(record);
    process.stdout.write(
      record.instrument.padEnd(6) +
        " " +
        record.direction.padEnd(5) +
        " conviction=" +
        record.conviction.toFixed(3) +
        " agreement=" +
        record.agreement.toFixed(2) +
        (record.refusals ? "  [" + record.refusals.join("; ") + "]" : "") +
        "\n",
    );
  }

  mkdirSync(dirname(recordPath), { recursive: true });
  appendFileSync(recordPath, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const acted = records.filter((r) => r.direction !== "none").length;
  process.stdout.write(
    "\nrecorded " +
      records.length +
      " to " +
      recordPath +
      " (" +
      acted +
      " with a direction, " +
      (records.length - acted) +
      " refused)\n",
  );
}

await main();
