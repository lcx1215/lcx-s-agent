/**
 * Is the finance plane actually wired end to end?
 *
 * Every layer of it can be correct on its own and still not work together: bars are collected and
 * filed, positions are recorded and projected, calls are settled and read back — and each of those
 * was true on the day a position was still being valued at the price it was bought at, because
 * nothing re-priced it from the bars that were being collected every day. That was found by
 * comparing three books by hand, not by anything the system said. This is that comparison,
 * automated, so the plane reports its own wiring instead of waiting to be audited.
 *
 * Read-only. It never writes a ledger, a mark, or a slot, and it says which directory it read so
 * an empty count can be told apart from a book that was read from the wrong place.
 */

import fs from "node:fs/promises";
import { readFinanceBarLedger } from "../../src/agents/finance-bar-ledger.js";
import { readFinancePositionLedger } from "../../src/agents/finance-position-ledger.js";
import {
  financeResearchSamplesPath,
  financeResearchScoredPath,
  resolveFinanceStateDir,
} from "../../src/agents/finance-state-dir.js";
import { readFinanceStrategyRuleLedger } from "../../src/agents/finance-strategy-rule-ledger.js";

type Severity = "error" | "warn" | "info";

type Check = Readonly<{
  id: string;
  severity: Severity;
  ok: boolean;
  summary: string;
  detail: unknown;
}>;

/** How one open position is priced, against the day the bar book has reached. */
type MarkVerdict = Readonly<{
  instrument: string;
  markAt: string | null;
  markDate: string | null;
  latestBarDate: string | null;
  verdict: "current" | "stale" | "ahead_of_data" | "unmarked";
}>;

/** Reads a JSON-lines file and keeps "absent" distinct from "present but empty". */
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

function argValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const state = resolveFinanceStateDir({ directory: argValue(args, "--dir") });
  const directory = state.directory;

  const checks: Check[] = [];
  const push = (check: Check): void => {
    checks.push(check);
  };

  // 1. Which book. Every count below is meaningless without it: a zero read from the wrong
  //    directory and a zero read from an empty one look identical in the number alone.
  push({
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
  const today = new Date().toISOString().slice(0, 10);
  const barAge =
    newestBarDate === undefined ? Number.NaN : calendarDaysBehind(today, newestBarDate);
  push({
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
  push({
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
  push({
    id: "orphan_holdings",
    severity: orphanHoldings.length > 0 ? "error" : "info",
    ok: orphanHoldings.length === 0,
    summary:
      orphanHoldings.length === 0
        ? "every open position is inside the rule universe"
        : `${orphanHoldings.join(", ")} held but no active rule covers it: it will never be rebalanced or re-priced by a cycle`,
    detail: { orphanHoldings, heldCount: held.length },
  });
  push({
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
    let verdict: "current" | "stale" | "ahead_of_data";
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
  push({
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

  // 6. Settlement supply: are the recorded calls being scored, or only ever recorded?
  const samples = await readLineCount(financeResearchSamplesPath(directory));
  const scored = await readLineCount(financeResearchScoredPath(directory));
  push({
    id: "settlement_supply",
    severity: samples.lines > 0 && scored.lines === 0 ? "warn" : "info",
    ok: !(samples.lines > 0 && scored.lines === 0),
    summary:
      samples.lines > 0 && scored.lines === 0
        ? `${samples.lines} call(s) recorded and none scored: calibration can only ever say it has no history`
        : `${samples.lines} call(s) recorded, ${scored.lines} settled`,
    detail: {
      samplesFile: financeResearchSamplesPath(directory),
      scoredFile: financeResearchScoredPath(directory),
      samplesPresent: samples.present,
      scoredPresent: scored.present,
      sampleCount: samples.lines,
      scoredCount: scored.lines,
    },
  });

  // 7. Has the unattended loop actually fired, on both slots?
  let scheduler: { day?: string; night?: string } = {};
  let schedulerPresent = false;
  try {
    scheduler = JSON.parse(
      await fs.readFile(`${directory}/daily-cycle-scheduler.json`, "utf8"),
    ) as {
      day?: string;
      night?: string;
    };
    schedulerPresent = true;
  } catch {
    schedulerPresent = false;
  }
  const lastFired = (scheduler as { lastFired?: { day?: string; night?: string } }).lastFired ?? {};
  const nightNeverFired = schedulerPresent && lastFired.night === undefined;
  push({
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
  const ok = errors.length === 0;

  const result = {
    ok,
    schemaVersion: "lcx_finance_link_health_v1" as const,
    directory,
    resolvedFrom: state.source,
    errorCount: errors.length,
    warningCount: warnings.length,
    checks,
    nextAction:
      errors.length > 0
        ? `Fix the ${errors.length} failing check(s): ${errors.map((check) => check.id).join(", ")}.`
        : warnings.length > 0
          ? `Wiring holds; ${warnings.map((check) => check.id).join(", ")} still worth reading.`
          : "Wiring holds end to end.",
    liveTouched: false,
  };

  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    for (const check of checks) {
      const mark =
        check.severity === "error" ? "FAIL" : check.severity === "warn" ? "warn" : " ok ";
      process.stdout.write(`${mark}  ${check.id.padEnd(22)}${check.summary}\n`);
    }
    process.stdout.write(`\n${result.nextAction}\n`);
  }

  // A failing link is worth a non-zero exit: this is meant to be run by something.
  if (!ok) {
    process.exitCode = 1;
  }
}

await main();
