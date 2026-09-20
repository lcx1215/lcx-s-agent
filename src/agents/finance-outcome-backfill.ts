/**
 * Close the loop on recorded calls: turn "what was claimed" into "what happened".
 *
 * The ledger already stores conviction and target at decision time. What it never stored was the
 * result, so every downstream calibration had nothing to calibrate against. This module supplies
 * the missing half and hands it to `buildReflection` in the shape that expects.
 *
 * One judgement is worth stating because it changes the numbers. Samples whose direction is
 * `none` were REFUSED, not wrong — the gate declined to bet. Counting a declined call as a loss
 * would drag the hit rate down for a reason that has nothing to do with judgement, and a
 * reflection built on that would "correct" a model for being correctly cautious. So refusals are
 * reported separately and never enter `scored`.
 *
 * There is no model call here either. It is arithmetic over prices that already exist.
 */

import { createChinaReachableUsEodHistoryCollectionAdapter } from "./finance-free-market-collection-adapters.js";
import type { ScoredSample } from "./finance-reflection.js";

export const DEFAULT_OUTCOME_HORIZON_DAYS = 30;

export type ResearchSample = Readonly<{
  asOf: string;
  instrument: string;
  direction: string;
  conviction: number;
  lastPrice: number;
  target?: number;
  horizonDays?: number;
}>;

export type OutcomeBackfillResult = Readonly<{
  /** Closed calls, ready for `buildReflection`. */
  scored: readonly ScoredSample[];
  /** Calls still inside their horizon. */
  pending: readonly { instrument: string; dueAt: string }[];
  /** Refused calls. Reported, never scored: declining is not the same as being wrong. */
  declined: readonly { instrument: string; reason: string }[];
  issues: readonly string[];
}>;

export type Bar = Readonly<{ date: string; close: number }>;

function dayAfter(iso: string, days: number): string {
  const parsed = Date.parse(iso);
  return new Date(parsed + days * 24 * 60 * 60 * 1_000).toISOString();
}

/** First bar at or after `iso`; returns undefined when the horizon is beyond the data. */
function closeAtOrAfter(bars: readonly Bar[], iso: string): Bar | undefined {
  const day = iso.slice(0, 10);
  return bars.find((bar) => bar.date >= day);
}

export async function backfillOutcomes(params: {
  samples: readonly ResearchSample[];
  asOf: string;
  defaultHorizonDays?: number;
  /**
   * Price series supplier. Injectable so settlement is testable without the network;
   * when omitted the reachable market adapter is used.
   */
  seriesFor?: (instrument: string) => Promise<readonly Bar[]>;
}): Promise<OutcomeBackfillResult> {
  const horizon = params.defaultHorizonDays ?? DEFAULT_OUTCOME_HORIZON_DAYS;
  const asOfMs = Date.parse(params.asOf);
  const issues: string[] = [];
  const scored: ScoredSample[] = [];
  const pending: { instrument: string; dueAt: string }[] = [];
  const declined: { instrument: string; reason: string }[] = [];

  if (!Number.isFinite(asOfMs)) {
    issues.push(`asOf is not a valid ISO datetime: ${params.asOf}`);
    return Object.freeze({ scored, pending, declined, issues });
  }

  const actionable: ResearchSample[] = [];
  for (const sample of params.samples) {
    const direction = sample.direction.trim().toLowerCase();
    if (direction !== "buy" && direction !== "sell") {
      declined.push({
        instrument: sample.instrument.toUpperCase(),
        reason: `direction="${sample.direction}" is not a bet; excluded from hit rate`,
      });
      continue;
    }
    if (!Number.isFinite(sample.lastPrice) || sample.lastPrice <= 0) {
      issues.push(`${sample.instrument}: lastPrice missing or non-positive`);
      continue;
    }
    actionable.push(sample);
  }

  const due = actionable.map((sample) => ({
    sample,
    dueAt: dayAfter(sample.asOf, sample.horizonDays ?? horizon),
  }));
  const closed = due.filter((entry) => Date.parse(entry.dueAt) <= asOfMs);
  for (const entry of due) {
    if (Date.parse(entry.dueAt) > asOfMs) {
      pending.push({ instrument: entry.sample.instrument.toUpperCase(), dueAt: entry.dueAt });
    }
  }
  if (closed.length === 0) {
    return Object.freeze({ scored, pending, declined, issues });
  }

  const adapter = createChinaReachableUsEodHistoryCollectionAdapter();
  // `readonly` because `seriesFor` supplies an immutable series, and nothing downstream mutates
  // it: settling a sample only reads a bar. Declaring a mutable array here is a lie that turns
  // into a type error the moment an injected series is returned as-is.
  const loadBars = async (instrument: string): Promise<readonly Bar[]> => {
    if (params.seriesFor) {
      return params.seriesFor(instrument);
    }
    const rows = await adapter.collect(
      {
        instrument,
        assetClass: "us_equity",
        collection: "eod_history",
        asOf: params.asOf,
        limit: 8000,
      },
      AbortSignal.timeout(60_000),
    );
    return rows
      .map((row) => ({
        // A non-string date stringified would be "[object Object]", which then fails the filter
        // below and reads as "no price series" — a data problem reported as an absence.
        date: typeof row.data.date === "string" ? row.data.date : "",
        close: Number(row.data.close),
      }))
      .filter(
        (row) =>
          /^\d{4}-\d{2}-\d{2}$/u.test(row.date) && Number.isFinite(row.close) && row.close > 0,
      );
  };

  const barsByInstrument = new Map<string, readonly Bar[]>();
  for (const instrument of new Set(closed.map((entry) => entry.sample.instrument.toUpperCase()))) {
    try {
      const bars = await loadBars(instrument);
      barsByInstrument.set(
        instrument,
        bars.toSorted((a, b) => a.date.localeCompare(b.date)),
      );
    } catch (error) {
      issues.push(`${instrument}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (const entry of closed) {
    const instrument = entry.sample.instrument.toUpperCase();
    const bars = barsByInstrument.get(instrument);
    if (!bars || bars.length === 0) {
      issues.push(`${instrument}: no price series to settle against`);
      continue;
    }
    const exitBar = closeAtOrAfter(bars, entry.dueAt);
    if (!exitBar) {
      // The horizon is past but the market has not traded since; that is not a settled call.
      pending.push({ instrument, dueAt: entry.dueAt });
      continue;
    }
    const entryPrice = entry.sample.lastPrice;
    const exitPrice = exitBar.close;
    const signed =
      entry.sample.direction.trim().toLowerCase() === "buy"
        ? (exitPrice - entryPrice) / entryPrice
        : (entryPrice - exitPrice) / entryPrice;
    scored.push({
      instrument,
      asOf: entry.sample.asOf,
      direction: entry.sample.direction.trim().toLowerCase() as "buy" | "sell",
      conviction: entry.sample.conviction,
      outcome: signed > 0 ? 1 : 0,
      movePct: Number((signed * 100).toFixed(4)),
    });
  }

  return Object.freeze({ scored, pending, declined, issues });
}
