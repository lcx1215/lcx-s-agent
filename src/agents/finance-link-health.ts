/**
 * Is the finance plane wired end to end?
 *
 * Every layer of it can be correct on its own and still not work together: bars are collected and
 * filed, positions are recorded and projected, calls are settled and read back — and each of those
 * was true on the day a position was still being valued at the price it was bought at, because
 * nothing re-priced it from the bars being collected every day. That was found by comparing three
 * books by hand, not by anything the system said. This is that comparison, so the plane reports
 * its own wiring instead of waiting to be audited.
 *
 * Read-only. Nothing here writes a ledger, a mark, or a slot, and every count says which book it
 * came from — a zero read from the wrong directory and a zero read from an empty one are the same
 * number, and every count here is worthless if that cannot be told apart.
 */

import fs from "node:fs/promises";
import { readFinanceBarLedger } from "./finance-bar-ledger.js";
import { DEFAULT_OUTCOME_HORIZON_DAYS } from "./finance-outcome-backfill.js";
import { readFinancePositionLedger } from "./finance-position-ledger.js";
import {
  financeResearchSamplesPath,
  financeResearchScoredPath,
  resolveFinanceStateDir,
  type FinanceStateDirSource,
} from "./finance-state-dir.js";
import { readFinanceStrategyRuleLedger } from "./finance-strategy-rule-ledger.js";

export const FINANCE_LINK_HEALTH_SCHEMA = "lcx_finance_link_health_v1" as const;

export type FinanceLinkHealthSeverity = "error" | "warn" | "info";

export type FinanceLinkHealthCheck = Readonly<{
  id: string;
  severity: FinanceLinkHealthSeverity;
  ok: boolean;
  summary: string;
  detail: unknown;
}>;

export type FinanceLinkHealth = Readonly<{
  schemaVersion: typeof FINANCE_LINK_HEALTH_SCHEMA;
  ok: boolean;
  directory: string;
  resolvedFrom: FinanceStateDirSource;
  errorCount: number;
  warningCount: number;
  checks: readonly FinanceLinkHealthCheck[];
  nextAction: string;
}>;

/** How one open position is priced, against the day the bar book has reached. */
type MarkVerdict = Readonly<{
  instrument: string;
  markAt: string | null;
  markDate: string | null;
  latestBarDate: string | null;
  verdict: "current" | "stale" | "ahead_of_data" | "unmarked";
}>;

/** Read a JSON-lines file, keeping "absent" distinct from "present but empty". */
async function readLineCount(file: string): Promise<{ present: boolean; lines: number }> {
  try {
    const text = await fs.readFile(file, "utf8");
    return {
      present: true,
      lines: text.split("\n").filter((line) => line.trim().length > 0).length,
    };
  } catch {
    return { present: false, lines: 0 };
  }
}

function dayOf(instant: string): string {
  return instant.slice(0, 10);
}

function calendarDaysBehind(later: string, earlier: string): number {
  const ms = Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`);
  return Number.isFinite(ms) ? Math.round(ms / 86_400_000) : Number.NaN;
}

export async function readFinanceLinkHealth(
  options: Readonly<{ directory?: string; asOf?: string }> = {},
): Promise<FinanceLinkHealth> {
  const state = resolveFinanceStateDir({ directory: options.directory });
  const directory = state.directory;
  const today = options.asOf?.slice(0, 10) ?? new Date().toISOString().slice(0, 10);
  const checks: FinanceLinkHealthCheck[] = [];

  // 1. Which book. Every count below is meaningless without it.
  checks.push({
    id: "state_root",
    severity: "info",
    ok: true,
    summary: `finance state read from ${directory} (${state.source})`,
    detail: { directory, resolvedFrom: state.source },
  });

  // 2. The bars: what the plane is actually measuring, and how old the newest measurement is.
  const bars = await readFinanceBarLedger(directory);
  const latestByInstrument = new Map<string, { date: string; close: number }>();
  for (const bar of bars.bars) {
    const current = latestByInstrument.get(bar.instrument);
    if (current === undefined || bar.date > current.date) {
      latestByInstrument.set(bar.instrument, { date: bar.date, close: bar.close });
    }
  }
  const newestBarDate = [...latestByInstrument.values()]
    .map((item) => item.date)
    .toSorted()
    .at(-1);
  const barAge =
    newestBarDate === undefined ? Number.NaN : calendarDaysBehind(today, newestBarDate);
  checks.push({
    id: "bar_supply",
    severity: bars.bars.length === 0 ? "error" : barAge > 4 ? "warn" : "info",
    ok: bars.bars.length > 0 && barAge <= 4,
    summary:
      bars.bars.length === 0
        ? "no bars in the book: nothing to measure, price, or settle against"
        : `${latestByInstrument.size} instrument(s), newest bar ${newestBarDate}, ${barAge} calendar day(s) behind ${today}`,
    detail: {
      instrumentCount: latestByInstrument.size,
      barCount: bars.bars.length,
      newestBarDate: newestBarDate ?? null,
      barAgeDays: Number.isFinite(barAge) ? barAge : null,
      collapsedRepeats: bars.collapsedRepeats,
      divergentDates: [...bars.divergentDates],
    },
  });

  // 3. The rule universe: what the plane is allowed to trade.
  const rules = await readFinanceStrategyRuleLedger(directory);
  const universe = new Set<string>();
  for (const rule of rules.ledger.rules) {
    if (rule.state !== "active") {
      continue;
    }
    for (const instrument of rule.instruments) {
      universe.add(instrument.trim().toUpperCase());
    }
  }
  checks.push({
    id: "rule_universe",
    severity: universe.size === 0 ? "warn" : "info",
    ok: universe.size > 0,
    summary:
      universe.size === 0
        ? "no active rule declares any instrument: the day run will refuse, the night run will still settle"
        : `${universe.size} instrument(s) under an active rule`,
    detail: {
      activeRuleCount: rules.ledger.rules.filter((rule) => rule.state === "active").length,
      instruments: [...universe].toSorted(),
      databasePresent: rules.databasePresent,
    },
  });

  // 4. Held outside the universe, and held with nothing to price it from. Both were silent.
  const held = (await readFinancePositionLedger(directory)).ledger.positions.filter(
    (position) => position.quantity !== 0,
  );
  const orphanHoldings = held
    .filter((position) => !universe.has(position.instrument))
    .map((position) => position.instrument);
  const unpriceableHoldings = held
    .filter((position) => !latestByInstrument.has(position.instrument))
    .map((position) => position.instrument);
  checks.push({
    id: "orphan_holdings",
    severity: orphanHoldings.length > 0 ? "error" : "info",
    ok: orphanHoldings.length === 0,
    summary:
      orphanHoldings.length === 0
        ? "every open position is inside the rule universe"
        : `${orphanHoldings.join(", ")} held but no active rule covers it: it will never be rebalanced or re-priced by a cycle`,
    detail: { orphanHoldings, heldCount: held.length },
  });
  checks.push({
    id: "unpriceable_holdings",
    severity: unpriceableHoldings.length > 0 ? "error" : "info",
    ok: unpriceableHoldings.length === 0,
    summary:
      unpriceableHoldings.length === 0
        ? "every open position has bars to be priced from"
        : `${unpriceableHoldings.join(", ")} held with no bars: its mark can never be refreshed`,
    detail: { unpriceableHoldings },
  });

  // 5. Marks: priced with which day, and is that day one the book actually has?
  const marks = held.flatMap<MarkVerdict>((position) => {
    const bar = latestByInstrument.get(position.instrument);
    const markAt = position.markPriceAt;
    if (position.markPrice === undefined || markAt === undefined) {
      return [
        {
          instrument: position.instrument,
          markAt: null,
          markDate: null,
          latestBarDate: bar?.date ?? null,
          verdict: "unmarked",
        },
      ];
    }
    const markDate = dayOf(markAt);
    let verdict: MarkVerdict["verdict"];
    if (bar === undefined) {
      verdict = "stale";
    } else if (markDate < bar.date) {
      verdict = "stale";
    } else if (markDate > bar.date) {
      // A mark dated after the newest bar claims a price the book has no data for. That is the
      // shape a fill takes: traded at a historical close, stamped with the moment it was placed.
      verdict = "ahead_of_data";
    } else {
      verdict = "current";
    }
    return [
      {
        instrument: position.instrument,
        markAt,
        markDate,
        latestBarDate: bar?.date ?? null,
        verdict,
      },
    ];
  });
  const staleMarks = marks.filter((mark) => mark.verdict === "stale");
  const aheadMarks = marks.filter((mark) => mark.verdict === "ahead_of_data");
  checks.push({
    id: "mark_freshness",
    severity: staleMarks.length > 0 ? "error" : aheadMarks.length > 0 ? "warn" : "info",
    ok: staleMarks.length === 0,
    summary:
      staleMarks.length > 0
        ? `${staleMarks.map((mark) => mark.instrument).join(", ")} priced from a day the bar book has already moved past`
        : aheadMarks.length > 0
          ? `${aheadMarks.map((mark) => mark.instrument).join(", ")} priced from a day the bar book has no data for (a fill stamp, not a close)`
          : `every open position priced at its latest bar date${newestBarDate ? ` (${newestBarDate})` : ""}`,
    detail: { marks, staleCount: staleMarks.length, aheadOfDataCount: aheadMarks.length },
  });

  // 6. Settlement supply: are recorded calls being scored, or only ever recorded?
  //
  // A recorded call with no result is the normal state of a call still inside its horizon, not a
  // fault: it settles when it matures. Saying otherwise has this check call the loop broken every
  // day for a month after any call is recorded, which is how an actual break goes unnoticed — the
  // one report that matters arrives in a stream of reports that never did. What is worth
  // reporting is a call that is past its horizon and still has no result.
  const samples = await readLineCount(financeResearchSamplesPath(directory));
  const scored = await readLineCount(financeResearchScoredPath(directory));
  const sampleRows: {
    instrument: string;
    direction: string;
    asOf: string;
    horizonDays: number;
    lastPrice: number;
  }[] = [];
  try {
    const text = await fs.readFile(financeResearchSamplesPath(directory), "utf8");
    for (const line of text.split("\n")) {
      if (line.trim().length === 0) {
        continue;
      }
      const row = JSON.parse(line) as {
        instrument?: unknown;
        direction?: unknown;
        asOf?: unknown;
        horizonDays?: unknown;
        lastPrice?: unknown;
      };
      const horizonDays = Number(row.horizonDays);
      sampleRows.push({
        instrument: typeof row.instrument === "string" ? row.instrument.trim().toUpperCase() : "",
        direction: typeof row.direction === "string" ? row.direction.trim().toLowerCase() : "",
        asOf: typeof row.asOf === "string" ? row.asOf : "",
        horizonDays: Number.isFinite(horizonDays) ? horizonDays : DEFAULT_OUTCOME_HORIZON_DAYS,
        lastPrice: Number(row.lastPrice),
      });
    }
  } catch {
    sampleRows.length = 0;
  }

  // Only what settlement would actually score. A call the gate declined is reported and never
  // scored, so counting it as an unsettled result would report a refusal as a break — the exact
  // confusion the settlement itself refuses to make.
  const dueDates = sampleRows
    .filter(
      (row) =>
        (row.direction === "buy" || row.direction === "sell") &&
        Number.isFinite(row.lastPrice) &&
        row.lastPrice > 0 &&
        Number.isFinite(Date.parse(row.asOf)),
    )
    .map((row) => ({
      instrument: row.instrument,
      dueDay: dayOf(new Date(Date.parse(row.asOf) + row.horizonDays * 86_400_000).toISOString()),
    }));
  const matured = dueDates.filter((entry) => entry.dueDay <= today);
  const waiting = dueDates.filter((entry) => entry.dueDay > today);
  const earliestDue = waiting.map((entry) => entry.dueDay).toSorted()[0];
  // Refusals, not bets. They are recorded and never scored, so without this the count of calls
  // waiting to settle looks like calls went missing.
  const declinedCount = sampleRows.filter(
    (row) => row.direction !== "buy" && row.direction !== "sell",
  ).length;
  // Maturity is compared by day and settlement accumulates, so this counts calls that are due and
  // unaccounted for — not a per-call reconciliation.
  const unsettled = Math.max(0, matured.length - scored.lines);
  checks.push({
    id: "settlement_supply",
    severity: unsettled > 0 ? "warn" : "info",
    ok: unsettled === 0,
    summary:
      unsettled > 0
        ? `${matured.length} call(s) past their horizon, ${scored.lines} scored: ${unsettled} with no result`
        : matured.length === 0
          ? `${samples.lines} recorded: ${waiting.length} inside their horizon${earliestDue ? `, earliest settles ${earliestDue}` : ""}${declinedCount > 0 ? `, ${declinedCount} declined rather than bet` : ""} — nothing due yet`
          : `${samples.lines} recorded, ${scored.lines} settled${declinedCount > 0 ? `, ${declinedCount} declined rather than bet` : ""}`,
    detail: {
      samplesFile: financeResearchSamplesPath(directory),
      scoredFile: financeResearchScoredPath(directory),
      samplesPresent: samples.present,
      scoredPresent: scored.present,
      sampleCount: samples.lines,
      scoredCount: scored.lines,
      maturedCount: matured.length,
      waitingCount: waiting.length,
      declinedCount,
      earliestDueDay: earliestDue,
    },
  });

  // 6b. Whether what is being settled is what is being traded. A reflection loop can run
  //     perfectly over a set of instruments the plane never touches: the samples are recorded by
  //     hand, so the hit rate they produce says nothing about the book the rules actually run.
  //
  //     Why it stays that way is not a missing setting. The sampler has two sources: chart
  //     structure, which any priced instrument has, and analyst targets, which an ETF does not.
  //     Fusion wants two independent sources before it will state a direction, so every
  //     instrument in the rule universe — all ETFs — is sampled as a refusal and never as a call.
  //     Measured: SPY refuses on "1 distinct source(s) support buy, 2 required", and TLT, GLD and
  //     EEM on "no source expressed a direction". The plane is not misconfigured; it declines to
  //     bet on instruments it cannot form a view on, which is the right answer, and it means the
  //     reflection loop has no calls to settle from the book it trades until a source exists that
  //     covers those instruments. Do not "fix" this by lowering the source count.
  const sampleUniverse = [
    ...new Set(sampleRows.map((row) => row.instrument).filter((name) => name.length > 0)),
  ].toSorted();
  const insideUniverse = sampleUniverse.filter((instrument) => universe.has(instrument));
  const outsideUniverse = sampleUniverse.filter((instrument) => !universe.has(instrument));
  // With no active rule there is no universe to be outside of, and "every call is outside it"
  // would then be true of every call and say nothing. An empty rule book is `rule_universe`'s
  // finding to make; this one compares, and there is nothing to compare against.
  const nothingToCompare = universe.size === 0;
  checks.push({
    id: "sample_universe_overlap",
    severity:
      !nothingToCompare && sampleUniverse.length > 0 && insideUniverse.length === 0
        ? "warn"
        : "info",
    ok: !(!nothingToCompare && sampleUniverse.length > 0 && insideUniverse.length === 0),
    summary: nothingToCompare
      ? `no active rule universe to compare ${sampleUniverse.length} recorded instrument(s) against`
      : sampleUniverse.length === 0
        ? "no recorded calls to compare against the rule universe"
        : insideUniverse.length === 0
          ? `every recorded call (${outsideUniverse.join(", ")}) is outside the rule universe: the track record being settled is not the book being traded`
          : `${insideUniverse.length} of ${sampleUniverse.length} recorded instrument(s) are inside the rule universe`,
    detail: {
      sampleInstruments: sampleUniverse,
      insideUniverse,
      outsideUniverse,
      universeInstruments: [...universe].toSorted(),
    },
  });

  // 7. Has the unattended loop actually fired, on both slots?
  let lastFired: { day?: string; night?: string } = {};
  let schedulerPresent = false;
  try {
    const parsed = JSON.parse(
      await fs.readFile(`${directory}/daily-cycle-scheduler.json`, "utf8"),
    ) as { lastFired?: { day?: string; night?: string } };
    schedulerPresent = true;
    lastFired = parsed.lastFired ?? {};
  } catch {
    schedulerPresent = false;
  }
  const nightNeverFired = schedulerPresent && lastFired.night === undefined;
  checks.push({
    id: "scheduler_slots",
    severity: !schedulerPresent ? "warn" : nightNeverFired ? "warn" : "info",
    ok: schedulerPresent && !nightNeverFired,
    summary: !schedulerPresent
      ? "no scheduler state: the unattended loop has never recorded a firing"
      : nightNeverFired
        ? `day last fired ${lastFired.day ?? "never"}, night has never fired`
        : `day last fired ${lastFired.day ?? "never"}, night ${lastFired.night ?? "never"}`,
    detail: { schedulerPresent, lastFired, nightEverFired: !nightNeverFired },
  });

  const errors = checks.filter((check) => check.severity === "error");
  const warnings = checks.filter((check) => check.severity === "warn");

  return Object.freeze({
    schemaVersion: FINANCE_LINK_HEALTH_SCHEMA,
    ok: errors.length === 0,
    directory,
    resolvedFrom: state.source,
    errorCount: errors.length,
    warningCount: warnings.length,
    checks: Object.freeze(checks),
    nextAction:
      errors.length > 0
        ? `Fix the ${errors.length} failing check(s): ${errors.map((check) => check.id).join(", ")}.`
        : warnings.length > 0
          ? `Wiring holds; ${warnings.map((check) => check.id).join(", ")} still worth reading.`
          : "Wiring holds end to end.",
  });
}
